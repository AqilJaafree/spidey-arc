# USDC LP Vault — cross-chain yield router

Comparing USDC LP opportunities across chains is broken in three ways: aggregators rank on fees over *displayed* TVL when only in-range liquidity earns fees; nobody models the dilution your own deposit causes; and nobody prices the cost of moving capital against your holding period.

This repo scores USDC LP venues with dilution- and cost-aware math. **The ranking is a function of your deposit size**, which is the thing no dashboard asks you for.

Full specification: [`usdc-lp-vault-spec.md`](./usdc-lp-vault-spec.md).
Day-1 design and deviations: [`docs/superpowers/specs/2026-08-04-usdc-lp-vault-day1-design.md`](./docs/superpowers/specs/2026-08-04-usdc-lp-vault-day1-design.md).

## What's built

Days 1–3 of the build plan: the scoring engine, an HTTP API, the comparison UI, the Arc hub contracts, and the Solana CCTP receiver.

```
packages/core      scoring math + rank(A). Pure — no I/O.
packages/adapters  Orca, Uniswap v3, Raydium, DefiLlama → NormalizedPool.
packages/api       Hono HTTP surface, TTL-cached.
packages/keeper    Merkle tree builder + rebalance planner.
apps/web           Next.js comparison UI.
contracts/         LPVault (ERC-4626) + ScoreOracle + Router + UniV3Executor.
solana/            MeteoraReceiver — two-stage CCTP hook (Anchor).
design/            UI design brief.
fixtures/          gzipped API captures for offline replay.
```

## Quickstart

```bash
pnpm install
pnpm test          # 178 TypeScript tests
pnpm api           # scoring engine on :8787
pnpm web           # UI on :3000

cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge test         # 48 contract tests, incl. gas-budget conformance

# The Uniswap v3 executor runs against a real Base Sepolia fork:
BASE_SEPOLIA_RPC_URL=https://base-sepolia-rpc.publicnode.com forge test \
  --match-contract UniV3ExecutorForkTest
```

The UI needs the API running. Nothing needs an API key.

## What it finds

Live, at the time of writing:

| Pool | Venue | Headline TVL | Actually in range | Share |
|---|---|---|---|---|
| SOL/USDC | Orca | $25.5M | $115k (±4bp) | 0.45% |
| WETH/USDC | Uniswap v3 (Base) | $112M | $8.76M (±60bp) | 7.81% |
| USDC/USDT | Orca | $1.18M | $638k (±1bp) | 53.9% |

The spec's §1 claim is that in-range liquidity is "often 2–10% of displayed TVL". On live data it ranges from 0.45% to 54% depending on venue and range width — which is precisely why a single headline number cannot rank these.

## The rule that shapes everything

§6: *"If a venue cannot supply `activeTvlUsd`, it is excluded from ranking, not approximated. An approximated denominator reintroduces the bug we exist to fix."*

So adapters report `activeTvlUsd: null` when they cannot measure it, every number carries the range width it was measured at, and pools that cannot be scored appear in a separate table **with a reason** rather than being silently dropped. Where data is modelled rather than observed, the row says so.

## Contracts

Three contracts on Arc, the hub chain where USDC is the native gas asset:

- **`LPVault`** — ERC-4626 over USDC. Synchronous `withdraw`/`redeem` **revert**: capital sitting in a Solana LP position cannot be redeemed in the same transaction on Arc, so the only exit is `requestWithdraw` → `settleEpoch` → `claimWithdraw`. NAV is reported by a bounded reporter (max 500bp move per step, 1h cooldown) and out-of-bounds reports are rejected, never clamped.
- **`ScoreOracle`** — one Merkle root per epoch instead of N venue rows. The leaf set is published off-chain and its URI is emitted, so anyone can rebuild the tree and check the root.
- **`Router`** — the switch rule. Refuses to move capital unless the APR gain repays the cost of moving over the expected holding period, with hysteresis κ = 1.75 to stop the vault flip-flopping.

No off-chain party holds a key that can move user funds. The reporter posts scores and NAV; only the Router can move capital, and only when the on-chain payback inequality holds.

### Gas: budgets vs. what the chain actually charged

Arc charges gas in USDC, so these are literal cents of user yield.

`contracts/test/GasBudget.t.sol` asserts the spec's targets, so a regression fails the build. But those tests measure **execution gas** via `gasleft()`. A real transaction also pays the 21,000-gas intrinsic cost plus calldata, and — specific to Arc — reads through a USDC contract that is not a normal ERC-20. Both columns below are real:

| Operation | **Measured on Arc** | Budget | Headroom |
|---|---:|---:|---:|
| `deposit` (steady state) | **80,881** | 90,000 | 9,119 |
| `requestWithdraw` (steady state) | **53,316** | 60,000 | 6,684 |
| `claimWithdraw` | **66,235** | 70,000 | 3,765 |
| `settleEpoch` | 33,582 | — | — |
| `deposit` (first ever, cold) | 132,121 | 90,000 | over, once per vault |
| `requestWithdraw` (first ever per holder) | 70,329 | 60,000 | over, once per holder |

Every budget is met in steady state. The two "first ever" rows are cold-storage costs paid once — the same shape as any contract's first write into a fresh slot.

**`requestWithdraw` misses its budget on-chain**, and the reason is worth knowing before setting any other budget on this chain.

Arc's USDC ERC-20 at `0x3600…0000` is a shim over the native balance, not a storage-backed token. Measured on the live chain:

| Call | est. gas | minus 21k intrinsic |
|---|---:|---:|
| `deployedAssets()` — pure SLOAD | 23,883 | 2,883 |
| `idleAssets()` — one `USDC.balanceOf` | 33,477 | 12,477 |
| `USDC.balanceOf` alone | 32,162 | 11,162 |

A `balanceOf` costs **~11,000 gas on Arc against ~2,100 for a conventional ERC-20** — roughly 5×.

#### Getting `requestWithdraw` under budget: two steps

**Step one — stop reading the shim.** Caching `totalAssets()` was the obvious move and turned out to be worthless: instrumenting the vault showed `balanceOf` is already called **exactly once** per deposit and per withdrawal request. There was no repetition to remove. So `idle` is now tracked in vault storage and the hot paths never call the token. A test asserts zero `balanceOf` reads on both, since a regression silently adds ~11,000 gas.

That alone took `requestWithdraw` from 79,407 to 72,955 — less than the 11,162 removed, because splitting `pending` out of the queue slot added a slot access back. Still over budget, and no amount of further micro-optimization would close it:

```
intrinsic transaction                21,000
new request slot (0 -> non-zero)     22,100   <- the problem
_burn: holder + totalSupply          10,000
one packed state slot                 5,000
event                                 2,000
                                     ------
                                     60,100   > 60,000 budget
```

**Step two — stop allocating a slot per request.** A fresh slot costs 22,100 gas *every time*. Keyed by holder instead, it costs that once and 5,000 thereafter. The record now carries an `INITIALIZED` bit that is set on a holder's first request and **never cleared**, so the word stays non-zero even when nothing is owed — §8.1's own instruction ("Never write zero. Initialize counters to 1, not 0, and treat 1 as empty") applied to the withdrawal record.

The request id is *derived* from `(holder, epoch)` rather than stored, so the id counter disappears too — a whole slot write removed for information both sides already had.

| Operation | original | after step 1 | after step 2 | budget |
|---|---:|---:|---:|---:|
| `requestWithdraw` | 79,407 | 72,955 | **53,264** | 60,000 |

Confirmed on-chain that the sentinel works: a request made *after* a claim still costs 53,229, because the slot never went back to zero.

**The trade-off**, stated plainly: a holder has at most one outstanding request. A second request in the same epoch adds to it and returns the same id. A request made while an older *settled* one is unclaimed reverts with `ClaimPendingFirst`, so a claim can never be silently overwritten.

#### A side effect worth having, and a gap it exposed

Tracking `idle` closes the ERC-4626 donation vector outright. Share price is computed from accounted assets, so sending tokens to the vault no longer moves it — verified on-chain: a live 1 USDC donation left `totalAssets` unchanged and surfaced as `unaccountedBalance`. Previously this leaned on the virtual-share offset alone.

That change also exposed a gap, found by walking into it on testnet. A donation into a vault with **no shares outstanding** was unreachable: `syncIdle()` would credit equity nobody holds a claim on, and there was no other exit. `rescueUnaccounted(to)` now closes it — owner-only and bounded to `unaccountedBalance()`, so it can never reach depositor assets. A fuzz test asserts exactly that.

### Positions are pooled, one per venue

Depositors never own a position. They hold ERC-4626 shares (`spUSDC`) representing a pro-rata claim on everything the vault holds; the vault opens **one position per venue** and every depositor shares it.

```
  alice $1,000 ─┐
  bob   $3,000 ─┼─► LPVault ──► Router ──► executor ──► ONE position per venue
  carol $6,000 ─┘   (shares)

  alice holds 10% of shares → 10% of whatever that position is worth
```

`UniV3Executor` did not honour that. It reverted `PositionAlreadyOpen` whenever a venue already held a position, so the vault could deploy to a venue exactly **once, ever** — every depositor after the first would have their capital stranded in the vault with no path to the pool it was ranked into. `LPVault.recordDeploy` accumulates per venue and was happy to be called again; only the executor said no.

Found by asking what a second deposit does, and confirmed on a live Base Sepolia fork before being fixed. `enter` now tops up the existing position with `increaseLiquidity` instead of minting a rival one — minting a second would fragment a venue's liquidity across NFTs the exit path does not track. The tick range is fixed by the first deposit; a later deposit wanting a different range must exit and re-enter, which is a routing decision and belongs off-chain.

### The Uniswap v3 strategy, run for real

`UniV3Executor` swaps half the USDC into the paired token and mints a concentrated position, then unwinds and returns USDC to the vault. It is tested against a **live fork of Base Sepolia** using the real factory, position manager, swap router and the USDC/WETH 0.3% pool — every address verified on-chain before being written down.

A $100 round trip on the real pool returns **99.70 USDC — exactly 30 bps lost**, which is precisely two half-swaps through a 0.3% pool. That number is the check that the split and range math are right.

Following the spec's rule that the program validates bounds rather than recomputing strategy, every tick range, swap split and slippage floor arrives as calldata. An unbounded swap (`amountOutMinimum == 0`) is rejected outright — that is a free lunch for anyone watching the mempool, and the engine always has a price, so it always has a floor.

### Cross-language Merkle conformance

The keeper builds score trees in TypeScript; `ScoreOracle` verifies them in Solidity. If those two ever drift, the keeper posts a root the contract cannot verify against, every `rebalance` reverts, and the vault silently stops rebalancing — a failure that looks like "the market had no opportunities" rather than like a bug.

Both directions are pinned. The TypeScript leaves are asserted against values computed independently with `cast` from the Solidity ABI encoding, and the contract is asserted to accept a root and proofs generated by the TypeScript — including the odd-node case, where implementations that duplicate the last leaf diverge from ones that promote it.

### Arc testnet facts, verified

The spec listed these as "open items to verify before committing". Checked directly against the live chain rather than taken from docs:

| Item | Result |
|---|---|
| Chain ID | **5042002** (`0x4cef52`), reth v1.11.3 |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` (Blockscout — supports source verification) |
| CCTP domain | **26** |
| USDC ERC-20 | `0x3600000000000000000000000000000000000000` — 6 decimals |
| TokenMessengerV2 | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` |
| MessageTransmitterV2 | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` |
| Native gas decimals | **18**, not 6 |
| Cancun opcodes | **Supported.** `TSTORE`/`TLOAD`, `MCOPY` and `BLOBBASEFEE` all execute. The reentrancy guard uses transient storage (~100 gas vs ~5,000). |

The decimal split is not a footnote — it is the same money behind two interfaces, exactly 1e12 apart. A live account reads:

```
native  eth_getBalance     48,985,422,856,585,913,771   (18dp) = 48.985 USDC
erc20   balanceOf()                     48,985,422      (6dp)  = 48.985 USDC
```

Several public sources report Arc's native currency as "USDC, 6 decimals". That is wallet display metadata. At 6dp the fee for a 48,950-gas transaction would read as $1.37 billion. `packages/core/src/fixed.ts` makes the lossy direction of that conversion loud rather than silent, and its round-trip test is the first test in the repo.

### Deployed on Arc testnet

Live on chain 5042002, **source-verified** on [testnet.arcscan.app](https://testnet.arcscan.app) — the deployed bytecode is reproducible from this repo at solc 0.8.28, optimizer on, 20,000 runs.

| Contract | Address |
|---|---|
| `LPVault` | [`0x98A00fcD947e7afe01ef9092a5f7E0724D9419Bc`](https://testnet.arcscan.app/address/0x98A00fcD947e7afe01ef9092a5f7E0724D9419Bc) |
| `ScoreOracle` | [`0x63378527cA676f77AA7b218b30a36352769F7C16`](https://testnet.arcscan.app/address/0x63378527cA676f77AA7b218b30a36352769F7C16) |
| `Router` | [`0x733CC4C4f8D65Ec104cFDdCb94b77998F74c397D`](https://testnet.arcscan.app/address/0x733CC4C4f8D65Ec104cFDdCb94b77998F74c397D) |
| USDC (ERC-20 shim) | [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000) |

Wiring confirmed by reading the chain, not the deploy log:

```
LPVault.asset()        -> 0x3600…0000   (USDC, 6dp)
LPVault.router()       -> 0x733CC4C4…   (Router)
LPVault.symbol()       -> spUSDC, 9 decimals  (6 asset + 3 virtual-share offset)
Router.vault()         -> 0x98A00fcD…   (LPVault)
Router.scoreOracle()   -> 0x63378527…   (ScoreOracle)
LPVault.coverageBps()  -> 10000         (fully solvent)
```

Deployment costs ~0.117 USDC across five transactions. Re-verify after any redeploy with:

```bash
forge verify-contract <address> src/LPVault.sol:LPVault \
  --verifier blockscout --verifier-url https://testnet.arcscan.app/api \
  --chain-id 5042002 \
  --constructor-args $(cast abi-encode "c(address,address,address,address)" \
    0x3600000000000000000000000000000000000000 $OWNER $REPORTER $OPERATOR)
```

### Live on Base Sepolia — a complete, working stack

Arc is the hub, but `Router.rebalance` reaches an executor with a **direct contract call**, which cannot cross a chain. The Arc Router can therefore never drive an executor on another chain, and the cross-chain leg needs an async executor that does not exist yet.

So the whole stack is also deployed locally on Base Sepolia, where the routing logic runs end to end against a real Uniswap v3 pool:

| Contract | Address |
|---|---|
| `LPVault` | `0x4f581A4cEb0c1448f1eC60410b01953D8d5DC184` |
| `ScoreOracle` | `0xcEd07b12523095C4267Fa3aDfD8A79d15dF79023` |
| `Router` | `0x39f05803Cd46DBCee98b86Ce1c0bFaaeeA9712Ff` |
| `UniV3Executor` | `0x660b01E478E9107546b772F3912966AB4e2B0309` |

Deployment cost **0.000046 ETH**. Unlike the Arc deployment, this one is fully wired: venue 1 registered, executor set, caps 10k/5k USDC.

The full cycle, run with real money:

```
  postScores      root built by @spidey/keeper, verified on-chain
  deposit 10 USDC → 10e9 spUSDC shares
  deployIdle      → LIVE Uniswap v3 position, tokenId 81591
                    USDC/WETH 0.3%, ticks [195540, 195960]
  requestWithdraw → shares burn, payout fixed
  returnToVault   → position unwound, capital home
  settleEpoch
  claimWithdraw   → 10.0000 USDC returned
```

### Deploying

Signing uses an encrypted Foundry keystore, so no private key is ever read from the environment or written to disk in the clear.

```bash
cd contracts
cp .env.example .env          # addresses are pre-filled and verified

# One-time: create the deployer keystore (prompts for a password)
cast wallet new ~/.foundry/keystores spidey-deployer

# Fund the printed address at faucet.circle.com → Arc Testnet (1 USDC/day)

forge script script/Deploy.s.sol \
  --rpc-url https://rpc.testnet.arc.network \
  --account spidey-deployer \
  --broadcast
```

A simulated run against live Arc costs **7,064,561 gas at 41.5 gwei ≈ 0.293 USDC**, so a single faucet claim covers the whole deployment with room to spare.

## API

```bash
curl 'localhost:8787/compare?size=10000'          # headline vs yours, side by side
curl 'localhost:8787/rank?size=1000000&hold=30'   # ranked for a size and hold period
curl 'localhost:8787/pools?stable=false'          # normalized rows
curl 'localhost:8787/health'
```

## Fixtures

Adapter tests replay committed gzipped captures, so they run offline and deterministically:

```bash
SPIDEY_FETCH_MODE=fixture pnpm test     # offline (the default for tests)
SPIDEY_FETCH_MODE=record pnpm capture   # re-record from live APIs
```

In `fixture` mode a missing fixture is an error — it never silently falls back to the network.

## Optional environment

| Variable | Effect |
|---|---|
| `BASE_RPC_URL` | Preferred Base RPC. Public endpoints are used otherwise. |
| `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `OPTIMISM_RPC_URL` | Same, for other EVM legs. |
| `PORT` | API port (default 8787). |
| `NEXT_PUBLIC_API_URL` | Where the UI looks for the API. |

## A solvency bug the invariant suite found

The vault has a stateful invariant suite (`contracts/test/invariant/`) driven by a handler that constrains the fuzzer to sequences a real user or keeper could produce. Ghost variables track what the totals *should* be, computed independently — checking the vault's numbers against its own numbers would prove nothing.

At run 579 of a deep pass, this failed:

```
invariant_pendingIsBackedByAssets
  pending (31,239,968,266) > idle + deployed (30,515,949,293)
```

The vault owed withdrawal requesters ~$724 more than it held anywhere.

**Mechanism.** `requestWithdraw` fixes a payout at the share price current when the holder asks. A loss afterwards shrinks the vault's assets but leaves that fixed claim untouched. This README previously called it "borne by remaining holders" — which understated it twice:

1. Remaining equity is not reduced but **clamped to zero**. Holders are wiped out, not diluted.
2. The residual shortfall then lands entirely on **whoever claims last**. Early claimers are paid in full; late ones revert with `InsufficientIdle` and get nothing. Transaction ordering decides who eats a loss that belongs to everyone.

The 500bp-per-epoch NAV guard does not prevent this: it bounds each *step*, not the cumulative drawdown.

**Fix.** `coverageBps()` scales every claim by what the vault can actually cover, sharing the loss pro-rata. In the reproduction, two holders each owed $1,000 against $1,600 of assets now receive $800 each, in either claim order — where before the first claimer took $1,000 and the second took nothing. It needs no extra storage and is computed live rather than stored, so a haircut cannot outlive the loss that caused it.

**Known limitation**, pinned by a test rather than left implicit: coverage is computed from what the vault *believes* it holds, including `nav.deployedAssets`. If a venue has lost capital and the reporter has not yet marked it down, the vault looks solvent and no haircut applies. §5.1's 500bp cap sharpens this — it bounds an honest markdown as tightly as a malicious one, so the protection against a compromised reporter is also a delay on telling the truth.

**The suite was mutation-tested**, because a green invariant suite proves nothing until you show it can fail. Six deliberate bugs — dropping the idle debit on claim, skipping the pending credit on request, forgetting to credit returned capital, disabling the haircut, double-counting it, rounding it up — were each caught by multiple independent invariants.

## Solana: the two-stage CCTP receiver

`solana/programs/meteora-receiver` implements §5.4. The split into two stages is not stylistic — it is forced by §10.1:

> "Under CCTP v2 the destination hook must succeed for funds to mint. If it reverts... the receive path fails while the source-side burn is already irreversible. V2 removed V1's replacement and rescue entry points."

So **stage 1 must be incapable of failing**, and stage 2 carries every fragile thing and may be retried forever.

### A third spec bug

§5.4's own stage-1 sketch reads:

```rust
credit.amount = credit.amount.checked_add(params.amount).unwrap();
```

`.unwrap()` panics on overflow — the exact outcome §10.1 says must be impossible, since a panic here strands an already-burned transfer permanently. The implementation uses `saturating_add`. At 6 decimals a `u64` saturates past 18 trillion USDC, so the clamp is unreachable with real money; were it ever reached, clamping costs bookkeeping precision while panicking costs the funds.

Stage 1's whole computation is expressed as a function that returns a value rather than a `Result` — the "cannot fail" requirement encoded in a type, then proven across the full `u64` space by property test.

### Live on devnet

```
Program    FnQGhy6uoFQ3tUuTZ5gwNJhMi1dELcAR7MobwgVLdA4y
Authority  6aYhp5SwU8to5ca8wjukJ9y5Tn3rByVVCJKmqotNoeHv
Size       179,712 bytes (194,088 allocated)
Rent       1.352 SOL
```

Deployed for **1.354 SOL** against a 2.895 SOL default, by two changes: `opt-level = "z"` + `panic = "abort"` + `strip` cut the binary 13.6%, and `--max-len` allocates 8% headroom instead of Solana's default 2×. The rent is recoverable with `solana program close`.

### Real token custody

Stage 2 now moves actual SPL tokens. Until it did, the program was pure bookkeeping — it tracked `amount` and `deployed` and never held or moved a single token, so a CCTP mint into its vault would have sat there untouched while the counters climbed. Accounting that cannot be settled is worse than no accounting.

The vault is a program-owned token account whose authority is the `credit` PDA, so only this program can move the funds, and the destination is **pinned at init**. A permissionless instruction that let its caller name the destination would be a drain, not a deploy — there is a devnet test asserting an attacker-chosen account receives nothing.

### Compute units, measured on-chain

| Instruction | local validator | **devnet** | §9.3 budget |
|---|---:|---:|---:|
| `on_cctp_receive` (stage 1) | 3,841 CU | **6,052 CU** | 20,000 |
| `deploy_position` (stage 2) | 3,711 CU | 12,353 CU | 250,000 |

Stage 2 roughly doubled when the SPL transfer became real — the earlier figure measured a function that moved nothing.

The devnet figures are higher because they were measured after the size optimization — `opt-level = "z"` trades cycles for bytes, costing ~2,000 CU to save ~28KB. On Solana that is the right trade: CU is a per-transaction cost with 15k of headroom here, while program size is permanent rent.

Stage 1's number is final — it does no CPI by design, so it will not grow. **Stage 2's is not meaningful yet**: the Meteora `add_liquidity_by_strategy` CPI is not implemented, and that CPI is essentially the entire 250k budget.

### Tests

- **20 unit + property tests** (`cargo test`) over the pure decision rules, including `stage1_never_panics` across the full `u64` space and `stage2_survives_extreme_bin_ids` at the `i32` boundaries where a naive `active - target` overflows.
- **15 on-chain tests**, run against both a local validator and live devnet, including the property the design exists for: *a failed stage 2 leaves the credit intact and retryable*.

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=.keys/deployer.json \
  npx ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts"
```

### Toolchain note

`anchor build` fails out of the box here: the default platform-tools (v1.48, rustc 1.84) cannot parse dependencies that now require `edition2024`. Build with the newer cached tools instead:

```bash
rustup toolchain link solana ~/.cache/solana/v1.54/platform-tools/rust
cargo-build-sbf --tools-version v1.54 --manifest-path programs/meteora-receiver/Cargo.toml
anchor idl build > target/idl/meteora_receiver.json   # IDL uses the host toolchain
```

`anchor-spl` is deliberately not a dependency — it pulls `solana-program → blake3 → cpufeatures 0.3`, which reintroduces the same conflict. It will need pinning when stage 2's CPI lands.

## Two bugs found by running the flow, not reading the code

### Capital was one-way

`Router` had `deployIdle` (vault → venue) and `rebalance` (venue → venue). **Neither returns capital to the vault**, and `rebalance` cannot be bent into it — it requires a distinct destination venue and a positive APR edge.

So once deployed, capital could never come home. `claimWithdraw` pays from idle and `settleEpoch` assumes the capital returned, but nothing could return it: **every deposit that had been deployed was unrecoverable.**

This demonstrated itself with real money. The first Base Sepolia deployment took a 20 USDC deposit into a live Uniswap position, and that capital is still stuck there — the deployed Router has no function that can retrieve it.

`returnToVault` fixes it. Deliberately no payback test and no dwell: there is no destination venue to compare against, and gating an exit on profitability is how a vault traps its depositors.

### Surplus stranded after the last holder leaves

A venue can return more than it was given. That surplus lands in `idle` as accounted equity — and if every holder has since exited, it becomes unclaimable: no shares exist to redeem against it, `rescueUnaccounted` cannot reach it because it *is* accounted, and a new depositor does not inherit it either, since the virtual-share offset that blocks the donation attack also correctly refuses to hand them somebody else's residual.

Observed live: a 10 USDC deposit round-tripped and returned 14.6, leaving 4.6 stranded. (That surplus was thin-pool round-trip slippage in the test, not yield — but the stranding is real either way.)

`sweepOrphanedIdle` recovers it, guarded on `totalSupply() == 0` *and* no pending claims, so it can never touch depositor funds.

## Case studies: sequences, not single calls

Every bug in this project needed a *sequence*. Single-call tests passed throughout. `contracts/test/CaseStudies.t.sol` probes orderings a live vault hits within days; two of them found real bugs.

| Case | Result |
|---|---|
| 1. Venue earned fees, then exits | **BUG — could not exit at all** |
| 2. Deposit immediately before a NAV gain | exposure quantified, not fixed |
| 3. Churn A→B→A | dwell blocks the return leg ✓ |
| 4. Partial return | remainder stays deployed ✓ |
| 5. Bank run — everyone exits at once | all paid, vault empties cleanly ✓ |
| 6. Paused venue | blocks new capital, releases what's there ✓ |
| 7. 50 dust deposits | rounding never favours the depositor ✓ |
| 8. Deposit exactly at the cap | succeeds, next one fails ✓ |
| 9. Keeper names a big amount, little moves | **BUG — payback rule bypassed** |
| 10. NAV rises after a request | gain goes to holders who stayed ✓ |

### Bug: a profitable venue could not be exited

`recordReturn` required `amount <= venue.deployedAssets`. A venue that earned fees returns *more* than its book value, so the call reverted — **the vault tolerated losses and broke on gains**, which is the one outcome it exists to produce. The book is now reduced by at most what the venue held and the excess is recognized as profit.

### Bug: the payback rule could be bypassed by overstating the size

`rebalance` validated the economics against the caller's claimed `amount`, then moved whatever the venue actually returned. A keeper could name $1,000,000 — repaying a $2 move in 0.02 days, clearing easily — while only $1,000 moved, where the true payback is 24 days and should be refused. That is exactly the churn §5.3's rule exists to prevent, bypassed by lying about the size. The economics are now re-checked against what actually came back.

### Not fixed: depositing just before a NAV gain

NAV lands in one transaction, so anyone watching the reporter can deposit immediately before it and capture value they were never at risk for. Measured: a depositor doubling the vault right before a +5% report captures ~half the gain. The 500bp per-epoch cap bounds the size; the real defences are a private mempool or a deposit fee, neither of which is in scope here. Recorded with a test rather than left to be discovered.

## Two spec bugs found while implementing

**The `rebalance` payback formula does not work as written.** The specification's inline snippet computes

```solidity
uint256 paybackDays = (365 * estCostUsdc * 10_000) / (amount * deltaApyBps / 10_000);
```

For the specification's *own* worked example — $1,000 at ΔAPR 3%, cost $2 — that yields **243,333 days** where the same document says ~24. The extra `/10_000` inflates it by ~10,139×, so every rebalance would fail the "no edge" check and the vault would never move capital. Separately, evaluating `paybackDays` as an integer destroys the signal exactly where the vault most wants to act: at $50,000 the true payback is 0.49 days, which truncates to 0.

`Router.checkPayback` cross-multiplies the inequality instead of evaluating the quotient, which removes the division entirely — no truncation, and one `DIV` cheaper. Both forms are pinned by tests against the spec's table.

**The "900% → ~350%" example is not reproducible.** Noted in Day 1 and still open: the dilution formula gives ~554% for a $5k deposit, not 350%. Reaching 350% needs ~$12.6k. This line is the setup for the whole pitch, so it needs correcting before the demo.

## Known gaps

- **Stage 2's Meteora CPI is not implemented.** Validation, accounting, token custody and retry semantics are complete and tested on devnet — tokens really move from the program-owned vault to the pinned destination. What is missing is the last hop: `add_liquidity_by_strategy`. It needs bin arrays derived from the runtime active bin, and a stub returning success would make the program look finished while doing nothing.
- **Meteora has no adapter.** The legacy `dlmm-api.meteora.ag` REST host is retired — Cloudflare returns 404 on every path with `cf-cache-status: HIT`, so it is gone rather than rate-limiting. Real bin-level data needs on-chain reads via `@meteora-ag/dlmm`.
- **No `tick-level` fidelity yet.** Both live venues report `current-tick-liquidity`, exact only within the current tick interval. True tick-level needs a Graph gateway key or on-chain tick-array reads.
- **Hourly series are unavailable from every public source**, so §7.6's estimator hygiene (EWMA, winsorization, persistence weighting) is implemented and unit-tested but inert on live data. Affected rows carry a `point estimate` flag.
- **Uniswap's RPC reads are not fixture-backed**, so that adapter needs network even in fixture mode.
- **Contracts are not deployed.** They build, test and hold to budget locally, but deploying to Arc testnet needs a funded key (`faucet.circle.com` dispenses 1 USDC/day) and the USDC ERC-20 address on Arc. The deploy script is ready.
- **No App Kit bridge leg.** The Uniswap v3 executor is written and fork-tested, and the keeper's planner decides moves via the switch rule, but the actual Arc ↔ Base Sepolia hop through `@circle-fin/app-kit` (v1.11.0, real) is not wired. It needs Circle credentials. Everything on either side of that hop exists.
- **Withdrawals fix their payout at request time**, not at settlement. A requester stops earning the moment they ask to leave and is insulated from later NAV moves; the trade-off is that a NAV drop between request and settlement is borne by remaining holders, bounded by the 500bp per-step cap. Full ERC-7540 settlement semantics would remove that.
- **The venue bitmaps cover ids 0–255**, since they are single `uint256` words. `VenueState.venueId` is a `uint16`, so ids above 255 would register but never appear in the active/paused sets.
