# USDC LP Vault — cross-chain yield router

Comparing USDC LP opportunities across chains is broken in three ways: aggregators rank on fees over *displayed* TVL when only in-range liquidity earns fees; nobody models the dilution your own deposit causes; and nobody prices the cost of moving capital against your holding period.

This repo scores USDC LP venues with dilution- and cost-aware math. **The ranking is a function of your deposit size**, which is the thing no dashboard asks you for.

Full specification: [`usdc-lp-vault-spec.md`](./usdc-lp-vault-spec.md).
Day-1 design and deviations: [`docs/superpowers/specs/2026-08-04-usdc-lp-vault-day1-design.md`](./docs/superpowers/specs/2026-08-04-usdc-lp-vault-day1-design.md).

## What's built

Days 1 and 2 of the build plan: the scoring engine, an HTTP API, the comparison UI, and the Arc hub contracts. The Solana receiver (Day 3) is not started.

```
packages/core      scoring math + rank(A). Pure — no I/O.
packages/adapters  Orca, Uniswap v3, Raydium, DefiLlama → NormalizedPool.
packages/api       Hono HTTP surface, TTL-cached.
packages/keeper    Merkle tree builder + rebalance planner.
apps/web           Next.js comparison UI.
contracts/         LPVault (ERC-4626) + ScoreOracle + Router + UniV3Executor.
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

### Gas, measured against the spec's budgets

Arc charges gas in USDC, so these are literal cents of user yield. Costed at the 27.95 gwei effective price observed on Arc testnet:

| Operation | Used | Budget | | Cost on Arc |
|---|---:|---:|---:|---:|
| `deposit` | 40,020 | 90,000 | 44% | $0.0011 |
| `postScores` | 4,510 | 30,000 | 15% | $0.0001 |
| `rebalance` (EVM→EVM) | 110,605 | 180,000 | 61% | $0.0031 |
| `requestWithdraw` | 32,406 | 60,000 | 54% | $0.0009 |
| `claimWithdraw` | 8,781 | 70,000 | 12% | $0.0002 |

These are asserted in `contracts/test/GasBudget.t.sol`, so a regression fails the build rather than showing up in a report nobody reads.

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

## Two spec bugs found while implementing

**The `rebalance` payback formula does not work as written.** The specification's inline snippet computes

```solidity
uint256 paybackDays = (365 * estCostUsdc * 10_000) / (amount * deltaApyBps / 10_000);
```

For the specification's *own* worked example — $1,000 at ΔAPR 3%, cost $2 — that yields **243,333 days** where the same document says ~24. The extra `/10_000` inflates it by ~10,139×, so every rebalance would fail the "no edge" check and the vault would never move capital. Separately, evaluating `paybackDays` as an integer destroys the signal exactly where the vault most wants to act: at $50,000 the true payback is 0.49 days, which truncates to 0.

`Router.checkPayback` cross-multiplies the inequality instead of evaluating the quotient, which removes the division entirely — no truncation, and one `DIV` cheaper. Both forms are pinned by tests against the spec's table.

**The "900% → ~350%" example is not reproducible.** Noted in Day 1 and still open: the dilution formula gives ~554% for a $5k deposit, not 350%. Reaching 350% needs ~$12.6k. This line is the setup for the whole pitch, so it needs correcting before the demo.

## Known gaps

- **Meteora has no adapter.** The legacy `dlmm-api.meteora.ag` REST host is retired — Cloudflare returns 404 on every path with `cf-cache-status: HIT`, so it is gone rather than rate-limiting. Real bin-level data needs on-chain reads via `@meteora-ag/dlmm`.
- **No `tick-level` fidelity yet.** Both live venues report `current-tick-liquidity`, exact only within the current tick interval. True tick-level needs a Graph gateway key or on-chain tick-array reads.
- **Hourly series are unavailable from every public source**, so §7.6's estimator hygiene (EWMA, winsorization, persistence weighting) is implemented and unit-tested but inert on live data. Affected rows carry a `point estimate` flag.
- **Uniswap's RPC reads are not fixture-backed**, so that adapter needs network even in fixture mode.
- **Contracts are not deployed.** They build, test and hold to budget locally, but deploying to Arc testnet needs a funded key (`faucet.circle.com` dispenses 1 USDC/day) and the USDC ERC-20 address on Arc. The deploy script is ready.
- **No App Kit bridge leg.** The Uniswap v3 executor is written and fork-tested, and the keeper's planner decides moves via the switch rule, but the actual Arc ↔ Base Sepolia hop through `@circle-fin/app-kit` (v1.11.0, real) is not wired. It needs Circle credentials. Everything on either side of that hop exists.
- **Withdrawals fix their payout at request time**, not at settlement. A requester stops earning the moment they ask to leave and is insulated from later NAV moves; the trade-off is that a NAV drop between request and settlement is borne by remaining holders, bounded by the 500bp per-step cap. Full ERC-7540 settlement semantics would remove that.
- **The venue bitmaps cover ids 0–255**, since they are single `uint256` words. `VenueState.venueId` is a `uint16`, so ids above 255 would register but never appear in the active/paused sets.
