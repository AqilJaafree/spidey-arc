# USDC LP Vault — cross-chain yield router

Aggregators rank USDC LP venues on fees over *displayed* TVL. Only in-range liquidity earns fees, and your own deposit changes the denominator — so **the best pool is a function of how much you deposit**, and no dashboard asks you for that.

This scores venues with dilution- and cost-aware math, then routes capital only when the yield gain repays the cost of moving it.

---

## Deployed contracts

### Arc testnet — chain 5042002 · [explorer](https://testnet.arcscan.app)

| Contract | Address |
|---|---|
| `LPVault` | `0x6501D3c8D48F73905ea8744EB3D11208CaC1B0fb` |
| `ScoreOracle` | `0x6ca24B702A930f0255817C8063eA0A068a3Bb27C` |
| `Router` | `0xFC39214E583633a89D3e646abF3fd111C2A08DDA` |
| `CctpBridgeExecutor` | `0x60DcC29Ae69dc22A4d914194704651E3f75e5537` |
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

**Arc** is the hub. It runs the custody cycle (deposit, request, settle, claim) and **bridges to Base Sepolia over CCTP v2** — venue 2 is wired to the Base vault above.

All three Arc contracts are source-verified on the explorer, so the deployed bytecode is reproducible from this repo.

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
  packages/keeper    Merkle tree builder, rebalance planner, CCTP relayer
  apps/web           Next.js comparison UI
  contracts/         LPVault (ERC-4626) + ScoreOracle + Router + UniV3Executor
  solana/            MeteoraReceiver — two-stage CCTP hook (Anchor)
```

Three contracts do the work:

- **`LPVault`** — ERC-4626 over USDC. Synchronous `withdraw`/`redeem` **revert**: capital in a pool on another chain cannot be returned in the same transaction, so the only exit is `requestWithdraw` → `settleEpoch` → `claimWithdraw`.
- **`ScoreOracle`** — one Merkle root per epoch instead of N venue rows. The leaf set is published off-chain so anyone can rebuild the tree and check the root.
- **`Router`** — refuses to move capital unless the APR gain repays the cost of moving over the expected holding period, with hysteresis to stop the vault flip-flopping.

No off-chain party holds a key that can move user funds. The reporter posts scores and NAV; only the Router moves capital, and only when the on-chain payback inequality holds.

## Arc → Base Sepolia, over CCTP

`Router.rebalance` reaches an executor with a direct contract call, and a direct call cannot cross a chain. A remote venue therefore needs a *local* executor that starts a bridge and returns, with the far side completing later — which is what `CctpBridgeExecutor` is, and what `IVenueExecutor.isSynchronous()` was declared for long before anything returned `false`.

A live burn on Arc, 2 USDC toward the Base Sepolia vault:

```
  deployIdle(venue 2)
    └─ CctpBridgeExecutor.enter()
       └─ TokenMessengerV2.depositForBurn(2000000, domain 6, → 0x44dbde83…)

  MessageTransmitterV2  MessageSent      destination 6, recipient = Base vault
  TokenMessengerV2      DepositForBurn
  CctpBridgeExecutor    BridgeInitiated  venue 2 → domain 6
  Router                BridgeInFlight   venue 2, 2000000
  LPVault               flags = 5        ACTIVE | PENDING_HOOK
```

**`FLAG_PENDING_HOOK` finally does something.** §5.1 reserved it and nothing set it until an async executor existed. It matters because during a bridge the capital is genuinely nowhere claimable — burned on Arc, not yet minted on Base — and `deployedAssets` alone cannot express that. `confirmArrival` clears it once the destination mints.

**The asymmetry is not hidden.** `enter` works; `exit` reverts `ExitMustBeInitiatedOnDestination`, because nothing on Arc can reach into a position on Base and pull it back. Returning zero instead would let `returnToVault` succeed while no capital moved — which reads as a completed exit and is the more dangerous lie.

### The return leg

Capital comes back as a CCTP **mint**, not an executor transfer — so nothing calls back and `returnToVault` has nothing to trigger on. `recordBridgeArrival` books it instead, bounded by `unaccountedBalance()`: a keeper cannot conjure idle by asserting an arrival that never happened, which would break solvency outright.

```
  Arc                                          Base Sepolia
  ───                                          ────────────
  deployIdle ──burn──► MessageSent
                          │
                          └──attestation──► receiveMessage ──► USDC mints
                                                                    │
        MessageSent ◄──burn── depositForBurn ◄──────────────────────┘
             │
             └──attestation──► receiveMessage ──► USDC mints at the vault
                                                       │
                             recordBridgeArrival ◄──────┘
                               books it, clears PENDING_HOOK
```

**Completed on-chain, end to end.** 2 USDC left Arc, minted on Base, burned back, minted home, and was booked:

```
  deployedAssets  2000000 → 0
  idle                  0 → 2000000
  PENDING_HOOK       true → false
  unaccounted     2000000 → 0
  coverageBps                10000
```

The depositor then exited normally — `requestWithdraw` → `settleEpoch` → `claimWithdraw` — receiving the full 2.00 principal back, and the vault emptied cleanly to `totalAssets = 0, totalSupply = 0`. Capital that crossed two chains and came home is indistinguishable, to a depositor, from capital that never left.

A round trip is four transactions across two chains and two attestations. The relaying is manual here — see [Known gaps](#known-gaps).

### App Kit, and where it belongs

§4 names `@circle-fin/app-kit` as the tool for "Arc ↔ EVM leg movement", and it knows Arc natively — its `ArcTestnet` definition carries chainId 5042002, `testnet.arcscan.app`, and `nativeCurrency.decimals: 18`, independently corroborating the decimal split this repo established by probing the chain.

It is a **TypeScript SDK**, so it runs in a keeper, not in a transaction. `Router.rebalance` decides and moves capital *within one transaction*, and a Solidity contract cannot call a TypeScript SDK. The two are layers, not alternatives:

```
  on-chain    Router → CctpBridgeExecutor → TokenMessengerV2   the burn
  off-chain   keeper → App Kit                                 attest + mint
```

§13 asked whether App Kit's `bridge()` exposes hook data, "or whether the Solana leg must drop to the raw `TokenMessengerV2` interface while EVM legs stay on App Kit". The answer is broader than the question: **every leg the Router drives is raw**, because the Router is a contract. App Kit's job is the half that happens *between* transactions — which is exactly the half that was manual.

`packages/keeper/src/relay.ts` also keeps an independent attestation fetcher alongside App Kit's happy path. A keeper that crashes mid-bridge leaves funds burned and attested but unminted; without a way to fetch and submit an attestation directly, that capital is stranded on a technicality.

**Pick the finality tier deliberately.** `minFinalityThreshold` 2000 (standard) waits for hard finality, which on Base Sepolia is 13–19 minutes; 1000 (fast) settles in seconds for a fee. §7.5's payback rule already prices the wait, so the engine should choose — the contract only bounds the fee.

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

- **No daemon runs the relayer.** `packages/keeper` can fetch attestations, wait for finality and drive App Kit's `bridge()`, and it is tested against the real burns from the round trip — but nothing schedules it. Somebody still has to call it.
- **No bridge executor on Base.** The return leg was initiated with the owner's `rescueUnaccounted` and a manual `depositForBurn`. Base wants its own `CctpBridgeExecutor` pointed at Arc so the Router drives the return rather than the owner sweeping.
- **Stage 2's Meteora CPI is absent.** Validation, accounting, token custody and retry semantics are complete and tested on devnet — tokens really move. The missing hop is `add_liquidity_by_strategy`.
- **No automation.** No daemon, no scheduler, no signer, no alerting. Every on-chain action so far was manual.
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
