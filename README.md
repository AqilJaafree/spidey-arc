# USDC LP Vault — cross-chain yield router

Aggregators rank USDC LP venues on fees over *displayed* TVL. Only in-range liquidity earns fees, and your own deposit changes the denominator — so **the best pool is a function of how much you deposit**, and no dashboard asks you for that.

This scores venues with dilution- and cost-aware math, then routes capital only when the yield gain repays the cost of moving it.

---

## Deployed contracts

### Arc testnet — chain 5042002 · [explorer](https://testnet.arcscan.app)

| Contract | Address |
|---|---|
| `LPVault` | `0xF54C48505D246a1af07C3a8883232B5170DbBA49` |
| `ScoreOracle` | `0xFbe3F0746Bd73f4879Eb960cf07d1f50C78067FB` |
| `Router` | `0xcBDf1E1a8E88f3776653A29c118F38446b37c99E` |
| USDC (ERC-20 shim) | `0x3600000000000000000000000000000000000000` |

### Base Sepolia — chain 84532

| Contract | Address |
|---|---|
| `LPVault` | `0x44dBDe83F339D23368abce56Cc1ABA2B257f1B0b` |
| `ScoreOracle` | `0x2d39A8e4C50a2E049C805e99428b11A90106F6e1` |
| `Router` | `0x82d2BfB316ae89050406c01970dc4e704Def9c5A` |
| `UniV3Executor` | `0x23300360B14D995eFd8d1072685C4dA39AEf5f81` |

### Solana devnet

| Program | Address |
|---|---|
| `MeteoraReceiver` | `FnQGhy6uoFQ3tUuTZ5gwNJhMi1dELcAR7MobwgVLdA4y` |

**Base Sepolia** is the complete stack — fully wired, and it runs the whole cycle including routing into a live Uniswap position.

**Arc** is the intended hub and runs the custody cycle today: deposit, request, settle, claim, all verified on-chain. It deliberately has **no venue registered**, because its Router reaches executors with a direct contract call, which cannot cross a chain, and Arc has no local venue. Registering one anyway would make the vault look configured while `deployIdle` reverts — which is exactly how an earlier Arc deployment came to look operable when it was not. See [Known gaps](#known-gaps).

Arc source verification: `LPVault` and `ScoreOracle` are verified; `Router` is submitted and still indexing. Re-run with:

```bash
forge verify-contract <address> src/LPVault.sol:LPVault \
  --verifier blockscout --verifier-url https://testnet.arcscan.app/api \
  --chain-id 5042002 --constructor-args $(cast abi-encode \
  "c(address,address,address,address)" $USDC $OWNER $REPORTER $OPERATOR)
```

---

## What it finds

Live data, at the time of writing:

| Pool | Venue | Displayed TVL | Actually in range | Share |
|---|---|---:|---:|---:|
| SOL/USDC | Orca | $25.5M | $115k (±4bp) | **0.45%** |
| WETH/USDC | Uniswap v3 (Base) | $112M | $8.76M (±60bp) | 7.81% |
| USDC/USDT | Orca | $1.18M | $638k (±1bp) | 53.9% |

From 0.45% to 54% depending on venue and range width — which is precisely why one headline number cannot rank these.

## Quickstart

```bash
pnpm install
pnpm test          # 178 TypeScript tests
pnpm api           # scoring engine on :8787
pnpm web           # UI on :3000

cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge test         # 103 tests, including gas-budget conformance
```

Nothing needs an API key. The UI needs the API running.

## The rule that shapes everything

> If a venue cannot supply in-range liquidity, it is **excluded from ranking, not approximated**. An approximated denominator reintroduces the bug we exist to fix.

So adapters report `null` when they cannot measure, every number carries the range width it was measured at, and unrankable pools appear in a separate table **with a reason** rather than being silently dropped. Where data is modelled rather than observed, the row says so.

## Architecture

```
  packages/core      scoring math + rank(A). Pure — no I/O.
  packages/adapters  Orca, Uniswap v3, Raydium, DefiLlama → NormalizedPool
  packages/api       Hono HTTP surface, TTL-cached
  packages/keeper    Merkle tree builder + rebalance planner
  apps/web           Next.js comparison UI
  contracts/         LPVault (ERC-4626) + ScoreOracle + Router + UniV3Executor
  solana/            MeteoraReceiver — two-stage CCTP hook (Anchor)
```

Three contracts do the work:

- **`LPVault`** — ERC-4626 over USDC. Synchronous `withdraw`/`redeem` **revert**: capital in a pool on another chain cannot be returned in the same transaction, so the only exit is `requestWithdraw` → `settleEpoch` → `claimWithdraw`.
- **`ScoreOracle`** — one Merkle root per epoch instead of N venue rows. The leaf set is published off-chain so anyone can rebuild the tree and check the root.
- **`Router`** — refuses to move capital unless the APR gain repays the cost of moving over the expected holding period, with hysteresis to stop the vault flip-flopping.

No off-chain party holds a key that can move user funds. The reporter posts scores and NAV; only the Router moves capital, and only when the on-chain payback inequality holds.

## The full cycle, run with real money

On Base Sepolia, against the real Uniswap v3 USDC/WETH pool:

```
  postScores      root built by @spidey/keeper, verified on-chain
  deposit 5 USDC  → 5e9 spUSDC shares
  deployIdle      → LIVE Uniswap v3 position, tokenId 81593
  requestWithdraw → shares burn, payout fixed
  returnToVault   → position unwound and closed at a loss
  coverageBps     → 9970, the 15bp of slippage recognized
  settleEpoch
  claimWithdraw   → 4.985 USDC, the depositor taking the real loss
```

## Measured budgets

Arc charges gas in USDC, so these are literal cents of user yield.

| Operation | On-chain | Budget |
|---|---:|---:|
| `deposit` | 80,881 | 90,000 |
| `requestWithdraw` | 53,316 | 60,000 |
| `claimWithdraw` | 66,235 | 70,000 |

| Solana instruction | Devnet | Budget |
|---|---:|---:|
| `on_cctp_receive` (stage 1) | 6,052 CU | 20,000 |
| `deploy_position` (stage 2) | 12,353 CU | 250,000 |

## Tests

| Suite | Count |
|---|---:|
| TypeScript (`vitest`) | 178 |
| Contracts, offline (`forge`) | 103 |
| Invariants (mutation-tested) | 12 |
| Fork, live Base Sepolia | 8 |
| Solana unit + property | 20 |
| Solana on-chain (validator + devnet) | 15 |

The invariant suite was verified by deliberately breaking the contract six ways; each was caught by multiple independent invariants. A green suite proves nothing until you show it can fail.

## Bugs found

Ten, of which nine are fixed. Every one needed a *sequence* — single-call tests passed throughout. Full detail in `docs/status-report.md`.

| # | Bug | Found by |
|---|---|---|
| 1 | Payback formula off by 10,139× | reading the spec against its own worked example |
| 2 | Second deposit could never reach a venue | asking what a second deposit does |
| 3 | Profitable venue could not be exited | asking what happens when it works |
| 4 | Withdrawal shortfall → first-come-first-served | invariant suite, run 579 |
| 5 | Payback rule bypassed by overstating size | case studies |
| 6 | `.unwrap()` panic in the must-not-fail path | reading spec §5.4 |
| 7 | **Capital was one-way** — deployed funds unrecoverable | running the flow on Base Sepolia |
| 8 | Surplus stranded after the last holder exits | running the flow |
| 9 | Unaccounted tokens ambiguous while deployed | probing untested sequences |
| 10 | Realized loss blocked withdrawals entirely | running the flow |
| — | Deposit front-running a NAV gain | **quantified, not fixed** |

Three are worth knowing beyond the fix:

**#7 proved itself with real money.** `deployIdle` sent capital out and `rebalance` moved it between venues; nothing returned it. 20 USDC is still stuck in the first Base Sepolia deployment — that Router has no function able to retrieve it.

**#10 was worse than losing money.** A live position returned 4.985 of 5 USDC; the missing 0.015 stayed on the venue's book, so the vault looked solvent, no haircut applied, and `claimWithdraw` reverted. The depositor could not be paid *at all*.

**The invariant suite missed #9.** `idleNeverExceedsRealBalance` checks only the idle leg, so it stayed green while equity double-counted an unrecorded return — 2,000 claimed against 1,000 real tokens. Fixed by measuring the whole system.

## Spec corrections

Three claims in the specification do not survive contact:

1. **§5.3's `rebalance` snippet** is wrong twice — an extra `/10_000` and integer truncation. Do not show it.
2. **§5.4's stage-1 snippet** contains a panic in the one function that must not fail.
3. **§1's "900% → ~350% once you add $5k"** is not reproducible from §7.3, which gives ~554%. Reaching 350% needs ~$12.6k. This line sets up the entire pitch.

Also worth stating plainly: **Arc's native gas is 18 decimals, not 6.** Several public sources say 6; that is wallet display metadata. A live account reads `48,985,422,856,585,913,771` natively and `48,985,422` through the ERC-20 — the same $48.99, exactly 1e12 apart.

## Known gaps

- **No cross-chain execution.** `Router.rebalance` reaches an executor with a direct contract call, which cannot cross a chain, so the Arc Router can never drive an executor elsewhere. Closing it needs an async executor whose `enter()` initiates a CCTP burn and returns immediately. `IVenueExecutor` declares `isSynchronous()` for exactly this, and the Router never calls it.
- **Stage 2's Meteora CPI is absent.** Validation, accounting, token custody and retry semantics are complete and tested on devnet — tokens really move. The missing hop is `add_liquidity_by_strategy`.
- **No automation.** No daemon, no scheduler, no signer, no alerting. Every on-chain action so far was manual.
- **Arc cannot route, only custody.** Deposit and withdrawal work; `deployIdle` reverts because no venue can honestly be registered without a reachable executor. The deploy script now says so on stdout rather than leaving it to be discovered.
- **Stale NAV defeats the haircut** for unrealized losses. The realized case is fixed (#10); a venue that has lost value the reporter has not marked down still looks solvent.
- **Meteora has no adapter.** The legacy REST host is retired — Cloudflare 404s every path with `cf-cache-status: HIT`. Real bin data needs on-chain reads.
- **No `tick-level` fidelity.** Both live venues report `current-tick-liquidity`, exact only within the current tick interval.

## Deploying

Signing uses an encrypted Foundry keystore, so no private key is read from the environment or written to disk in the clear.

```bash
cd contracts
cp .env.example .env          # addresses pre-filled and verified

cast wallet new ~/.foundry/keystores spidey-deployer
# fund the printed address: faucet.circle.com → Arc Testnet

forge script script/DeployBaseSepolia.s.sol \
  --rpc-url https://base-sepolia-rpc.publicnode.com \
  --account spidey-deployer --broadcast
```

Arc deployment costs ~0.117 USDC; Base Sepolia ~0.000046 ETH; the Solana program 1.354 SOL of rent, recoverable with `solana program close`.

## API

```bash
curl 'localhost:8787/compare?size=10000'          # headline vs yours
curl 'localhost:8787/rank?size=1000000&hold=30'   # ranked for a size
curl 'localhost:8787/pools?stable=false'          # normalized rows
curl 'localhost:8787/health'
```

## Fixtures

Adapter tests replay committed gzipped captures, so they run offline and deterministically:

```bash
SPIDEY_FETCH_MODE=fixture pnpm test     # offline, the default
SPIDEY_FETCH_MODE=record pnpm capture   # re-record from live APIs
```

A missing fixture in `fixture` mode is an error — it never silently falls back to the network.

## Toolchain notes

`anchor build` fails out of the box — the default platform-tools (v1.48, rustc 1.84) cannot parse dependencies requiring `edition2024`. Use the newer cached tools:

```bash
rustup toolchain link solana ~/.cache/solana/v1.54/platform-tools/rust
cargo-build-sbf --tools-version v1.54 --manifest-path programs/meteora-receiver/Cargo.toml
anchor idl build > target/idl/meteora_receiver.json
```

Optional environment: `BASE_RPC_URL`, `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `OPTIMISM_RPC_URL` override the public endpoints. `PORT` sets the API port. `NEXT_PUBLIC_API_URL` tells the UI where the API is.
