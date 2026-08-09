# USDC LP Vault — cross-chain yield router

Aggregators rank USDC LP venues on fees over *displayed* TVL. Only in-range liquidity earns fees, and your own deposit changes the denominator — so **the best pool is a function of how much you deposit**, and no dashboard asks you for that.

This scores venues with dilution- and cost-aware math, then routes capital only when the yield gain repays the cost of moving it.

---

## Deployed contracts

Deployer `0x9e5fdE1f7484096A9beCDBb956A05834eC581195`, owner/keeper/reporter throughout.

### Arc testnet — chain 5042002 · [explorer](https://testnet.arcscan.app)

| Contract | Address |
|---|---|
| `LPVault` | `0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f` |
| `ScoreOracle` | `0xb7DB9Ee5Ee46EB608d9a3A4DCc843230dD63b621` |
| `Router` | `0x09Bb87E6Ca168D6eD85e0682A39b22431600c9A8` |
| `CctpBridgeExecutor` (venue 2) | `0x9eE4C1FFe609a4848053fD76071abBe69A63DB1c` |
| USDC (ERC-20 shim) | `0x3600000000000000000000000000000000000000` |

### Base Sepolia — chain 84532

| Contract | Address |
|---|---|
| `LPVault` | `0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f` |
| `ScoreOracle` | `0xb7DB9Ee5Ee46EB608d9a3A4DCc843230dD63b621` |
| `Router` | `0x09Bb87E6Ca168D6eD85e0682A39b22431600c9A8` |
| `UniV3Executor` (venue 1) | `0xcFb9E14567F37410857798F983c398612497cDe2` |
| **`CctpReturnRelay`** | `0x280aD956FFFd3ABba3db59397BE7c4d4d04D32D4` |

The Base `LPVault`/`ScoreOracle`/`Router` share their Arc addresses — deterministic `CREATE` from the same deployer at the same nonces on a fresh account on each chain. They are separate contracts on separate chains.

### Solana devnet

| Program | Address |
|---|---|
| `MeteoraReceiver` | `FLfdxZbnkMFCRAgGDTkMzZn3i2X2EKZhYBep6seHjqNp` |

Redeployed 2026-08-07 with the live DLMM CPI, and again the same day with the exit (`withdraw_position`); upgrade authority `8sHRx1C6…`. The prior id (`FnQGhy6u…`) was deployed under an authority we don't hold, so it could be neither upgraded nor closed.

**Base Sepolia** is the complete stack — fully wired, and it runs the whole cycle including routing into a live Uniswap position.

**Arc** is the hub. It runs the custody cycle (deposit, request, settle, claim) and **bridges to Base Sepolia over CCTP v2**. Venue 2's route mints into the **`CctpReturnRelay`**, not the Base vault — so capital Arc sends out lands somewhere whose only exit is back to Arc, under the keeper, with no owner discretion over the destination.

These contracts are the current bytecode in this repo, including the `NavStale` haircut gate and the `isSynchronous` rebalance guard. They are not yet source-verified on the explorer.

---

## What it finds

Live data, at the time of writing:

| Pool | Venue | Displayed TVL | Actually in range | Share |
|---|---|---:|---:|---:|
| SOL/USDC | Orca | $25.5M | $115k (±4bp) | **0.45%** |
| WETH/USDC | Uniswap v3 (Base) | $112M | $8.76M (±60bp) | 7.81% |
| PUMP/USDC | Meteora (DLMM) | $1.04M | $37.9k (±500bp) | 3.64% |
| SOL/USDC | Meteora (DLMM) | $5.06M | $947k (±100bp) | 18.7% |
| USDC/USDT | Orca | $1.18M | $638k (±1bp) | 53.9% |

From 0.45% to 54% depending on venue and range width — which is precisely why one headline number cannot rank these. The two Meteora rows are the same venue, the same day and the same query: one pool holds 18.7% of its headline TVL within a percent of the price, the other 3.6% within five percent.

## Quickstart

```bash
pnpm install
pnpm test          # 393 TypeScript tests
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
  packages/adapters  Meteora, Orca, Uniswap v3, Raydium, DefiLlama → NormalizedPool
  packages/api       Hono HTTP surface, TTL-cached
  packages/keeper    Merkle tree builder, rebalance planner, CCTP relayer
  apps/web           Next.js comparison UI
  contracts/         LPVault (ERC-4626) + ScoreOracle + Router + UniV3Executor
  solana/            MeteoraReceiver — two-stage CCTP hook, DLMM in and out (Anchor)
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
                                                               into the RELAY
                                                                    │
        MessageSent ◄──burn── relay.returnHome() ◄──────────────────┘
             │                 keeper-only, destination pinned
             └──attestation──► receiveMessage ──► USDC mints at the vault
                                                       │
                             recordBridgeArrival ◄──────┘
                               books it, clears PENDING_HOOK
```

**Completed on-chain, end to end, through the relay.** 1 USDC left Arc, minted into the `CctpReturnRelay` on Base, was burned home by `returnHome()` — keeper-only, with the destination pinned to Arc, so the owner never touched the money — minted at the Arc vault, and was booked:

```
  venue 2 book    1000000 → 0
  idle                  0 → 1000000
  PENDING_HOOK       true → false
  coverageBps                10000
```

The five transactions, 2026-08-06:

| Leg | Chain | Tx |
|---|---|---|
| `deployIdle` → burn | Arc | `0x74d5dab5…09b8` |
| `receiveMessage` → mint to relay | Base | `0x1d844be0…ce99` |
| `relay.returnHome` → burn home | Base | `0x28dc5510…153d` |
| `receiveMessage` → mint to vault | Arc | `0x1cd17e83…16f1` |
| `recordBridgeArrival` → book | Arc | `0xd7d8a7e6…6bfa` |

A round trip is four cross-chain transactions plus a keeper `returnHome`, over two attestations. The relaying is manual here — see [Known gaps](#known-gaps). An earlier round trip (2 USDC, before the relay existed) minted into the Base vault and was brought home by the owner's `rescueUnaccounted` plus a manual bridge; the relay removes that owner step.

### App Kit, and where it belongs

§4 names `@circle-fin/app-kit` as the tool for "Arc ↔ EVM leg movement", and it knows Arc natively — its `ArcTestnet` definition carries chainId 5042002, `testnet.arcscan.app`, and `nativeCurrency.decimals: 18`, independently corroborating the decimal split this repo established by probing the chain.

It is a **TypeScript SDK**, so it runs in a keeper, not in a transaction. `Router.rebalance` decides and moves capital *within one transaction*, and a Solidity contract cannot call a TypeScript SDK. The two are layers, not alternatives:

```
  on-chain    Router → CctpBridgeExecutor → TokenMessengerV2   the burn
  off-chain   keeper → App Kit                                 attest + mint
```

§13 asked whether App Kit's `bridge()` exposes hook data, "or whether the Solana leg must drop to the raw `TokenMessengerV2` interface while EVM legs stay on App Kit". The answer is broader than the question: **every leg the Router drives is raw**, because the Router is a contract. App Kit's job is the half that happens *between* transactions — which is exactly the half that was manual.

`packages/keeper/src/appkit.ts` implements it; `packages/keeper/scripts/` holds the runners that drive it live. One `bridge()` call replaces the four manual steps — burn, poll Iris, `receiveMessage`, repeat in reverse. Run live on this deployment, Arc → Base Sepolia, 0.5 USDC:

```
  approve            success  0x701d8010…
  burn        (Arc)  success  0xe91519cd…
  fetchAttestation   success
  mint       (Base)  success  0xeb0a6c10…
```

One call, FAST — against the three manual `cast`/`curl` steps *per leg* the round trip above took by hand, and the 15+ minutes `SLOW` costs. Balances moved as expected: Arc 18.82 → 18.32 USDC, Base 0 → 0.50.

`relay.ts` keeps an independent attestation fetcher alongside App Kit's happy path. A keeper that crashes mid-bridge leaves funds burned and attested but unminted; without a way to fetch and submit an attestation directly, that capital is stranded on a technicality.

**App Kit still cannot tell the vault.** Capital returns as a mint, so nothing calls back — `bridgeAndBook` pairs the bridge with `Router.recordBridgeArrival`, and deliberately does not book unless the bridge reports `success`. Booking a pending bridge would credit capital that has not arrived, which is exactly the unbacked-idle case the on-chain bound rejects.

Run live, Base → Arc, 0.5 USDC: burn `0x8b5f0951…`, mint to the vault `0x9c4914e3…`, then `recordBridgeArrival` `0xdfea5029…`. The FAST fee showed up and the bound caught it — 500,000 sent, **499,935** arrived, so the callback booked the vault's actual `unaccountedBalance()`, not the nominal amount. Booking the nominal 500,000 would have reverted `NoSuchArrival(500000, 499935)`. Vault idle 1.000000 → 1.499935.

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
| `withdraw_position` (the exit) | 178,394 CU | 250,000 |
| `retire_position` | 24,487 CU | 40,000 |
| `adopt_position` (migration) | 7,750 CU | 20,000 |
| `release_credit` | 12,834 CU | 20,000 |

The exit is the only instruction here that will not fit in Solana's 200,000 CU
default — two DLMM CPIs plus their event CPIs — so the caller must raise the
limit. `withdraw-dlmm.ts` asks for 600,000.

## Tests

| Suite | Count |
|---|---:|
| TypeScript (`vitest`) | 393 |
| Contracts, offline (`forge`) | 103 |
| Invariants (mutation-tested) | 12 |
| Fork, live Base Sepolia | 8 |
| Solana unit + property | 31 |
| Solana on-chain (validator) | 23 passing, 3 skipped |

The invariant suite was verified by deliberately breaking the contract six ways; each was caught by multiple independent invariants. A green suite proves nothing until you show it can fail.

The three skipped Solana tests need a live DLMM program, which a local validator has none of; they are skipped loudly, naming where the behaviour is proven instead, rather than deleted or left red. The same rule caught two things worth having: the exit's signer test originally failed client-side as an unknown signer and would have passed with the on-chain constraint deleted, and `position_range`'s tests could not detect an off-by-one until they asserted *acceptance* rather than only rejection. Both were found by mutating the code and checking the test failed.

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

  `pnpm keeper:tick` now closes most of that by hand or on a cron: `sweep-bridges` scans each chain's `DepositForBurn` logs, mints whatever Circle has attested and the destination never minted, and books the Arc arrivals through `recordBridgeArrival`. Two limits are worth knowing. **The Solana leg stays manual** — the sweep speaks viem clients only, and a Solana return needs the other signing scheme entirely, so burns bound for devnet are counted and named in the summary rather than finished. And **the lookback is only as long as the RPC allows**: the tick asks for seven days and the public endpoints give ~1.4 days on Arc and ~2.8 on Base, which every run logs as `CAPPED`. A sweep down longer than its own window forgets those burns — the capital is not lost, but nothing books it until a human widens the window or finishes it by hand.
- ~~**No bridge executor on Base.**~~ **Built, deployed, and a full round trip run through it.** `CctpReturnRelay` is the Base-side return leg: the owner pins the route to Arc once, the keeper chooses only when and how much, and `sweep` refuses the bridge asset — so USDC that lands there has exactly one exit. It replaces `rescueUnaccounted(to)` under the owner's key, which had two structural problems: `to` was arbitrary, and its `onlyWhenNothingDeployed` guard blocked the hub's capital from coming home whenever the Base stack held a position of its own. It is deployed on Base Sepolia (`0x280aD9…`), venue 2's Arc-side route points at it, and 1 USDC has made the complete Arc → relay → Arc trip non-custodially (see [the return leg](#the-return-leg)). What is still manual: nothing schedules the keeper's `returnHome` or the two `receiveMessage` calls — the relaying is by hand.
- ~~**Stage 2's Meteora CPI is absent.**~~ **Live on devnet.** The receiver deploys one-sided USDC into a real Meteora DLMM position through its own CPIs, end to end. `add_liquidity_by_strategy_one_side` is wired via Anchor's `declare_program!` over a minimal `idls/dlmm.json` (the full fetch stays as `lb_clmm.devnet.json`). **One-sided by design** — the receiver holds a single token, same strategy every chain — which is also the only viable design: the add CPI signs as the `Credit` PDA (the USDC authority), and DLMM requires that signer to be the position's *owner*, so the position must be program-created (`init_position` CPIs `initialize_position` with the PDA as owner). A keeper-owned position could never receive the vault's USDC.

  Proven, 2026-08-07: `scripts/deposit-dlmm.ts` put 0.3 USDC one-sided into pool `XZgB99jbwsZyCZF7h5tLGPgXYGdZ9bX8UqLQV3upwZw` (Circle USDC = token_y) — position owned by the credit PDA, pool USDC reserve up by exactly that. Two devnet gotchas the script now handles: `InitializeBinArray` needs a raised compute budget, and `bin_array_lower`/`bin_array_upper` must be **distinct** arrays (DLMM borrows both mutably), so the range straddles two 70-bin arrays below the active bin.

- ~~**No `remove_liquidity` CPI.**~~ **Live on devnet.** `withdraw_position` claims fees and removes 10,000 bps over the position's full range in one transaction, then re-marks `credit.amount` from the *measured* vault balance rather than any declared number — so impermanent loss and earned fees show up honestly instead of as a counter custody cannot back. That is LPVault bug #10 read backwards.

  Full exit is a constant, not an argument. The position's range lives in `Credit`, written by `init_position`, so a partial removal that left liquidity behind while the books said `deployed == 0` is not expressible. Fees are claimed inside the same instruction because only the `Credit` PDA can sign as position owner — a fee left behind at exit would be unreachable forever, the same one-way door this closes, one step smaller. The non-USDC side goes straight to a vault-authority-owned account and never enters program custody.

  Proven, 2026-08-07, on the position `deposit-dlmm.ts` opened: 0.3 USDC out of bins [-355, -336] in pool `XZgB99jbwsZyCZF7h5tLGPgXYGdZ9bX8UqLQV3upwZw` (`3rFbxHQM…`), then all 0.4 USDC released to the vault authority (`3CnqG99X…`), leaving the vault empty and the credit zeroed. The other side returned zero, correctly — active bin was -335, so the position sat entirely below it and had never traded through.

  A credit is no longer bound to one position for life. `init_position` and `adopt_position` refuse a second position, because overwriting the pointer orphans the first and only the `Credit` PDA can sign as its owner — but that left a credit married to whatever range it first opened at, useless once the active bin walked away. `retire_position` closes an empty position and, when it is the recorded one, clears the pointer so a fresh range can be opened. It deliberately does *not* pin the position account: half its job is reclaiming positions the credit owns but never adopted, created by attempts that failed before adding liquidity. DLMM already refuses one this PDA does not own (`InvalidPositionOwner`) and one still holding liquidity (`NonEmptyPosition`); a local copy of those rules is a copy that can drift.

  Proven, 2026-08-07: both devnet positions closed — the recorded one (`2cCPiVzU…`) and an unadopted orphan whose bin arrays both resolved to index -5, the double-mutable-borrow that killed it at birth (`NCHQ9oNG…`). 0.1148 SOL of rent recovered and the pointer cleared. That orphan was expected to be unclosable for the same reason it was abandoned; `close_position` turns out not to borrow the arrays the way `add_liquidity` does. Attempting it beat reasoning about it.

  Two things the live run settled that the tests could not. `claim_fee` does **not** revert on a position with no accrued fees, so the exit needs no conditional escape. And `adopt_position` — the one-time migration for the credit that predates the position fields — could not have worked as first written: Anchor deserializes an account *before* it applies `realloc`, so `Account<Credit>` failed `AccountDidNotDeserialize` against precisely the short account it existed to grow (`3K98dczw…` after the rewrite). Nothing but contact with the real account would have shown that.

  </details>
- **Automation, partly.** `pnpm keeper:tick` is one stateless pass over two jobs: post the vault's NAV mark, and sweep up CCTP burns nobody minted — finishing them and booking the arrivals, so capital that is home stops being counted as deployed. Every run rediscovers its work, so a missed tick self-heals and a restart needs no reconciliation; `usedNonces` on the destination makes a double-mint impossible without any local state.

  Read-only has to be asked for. `KEEPER_READ_ONLY=1` reads and decides without writing; a missing `REPORTER_KEY` *without* it refuses to start, before the first RPC call. That asymmetry is deliberate — a typo'd variable name on a schedule would otherwise log plausible reads every fifteen minutes while the mark aged out, and the first symptom would be a withdrawal that reverts. A failed deploy is the cheaper failure.

  What it does **not** do: initiate any capital move — planner output is logged, not executed — or alert anyone. A crashed service is silent until someone looks, and the useful alert is on *consecutive* failures of the same job: a permanent bug and a transient RPC outage are indistinguishable within one tick, and only the run history separates them. Its two coverage limits, the manual Solana leg and the RPC-bound lookback, are above.
- **Stale NAV defeats the haircut** for unrealized losses, *within a six-hour window*. `claimWithdraw` now reverts `NavStale` rather than paying at par out of a mark older than `MAX_NAV_AGE`, so the defeat is bounded rather than indefinite — but inside the window a venue that has lost value the reporter has not marked down still looks solvent.

  **`pnpm keeper:report-nav` now refreshes the mark**, which narrows the liveness dependency without closing it. The obvious fix — re-post the current number to reset the clock — would have been worse than the bug: it converts the safe failure (refuse to pay) into the unsafe one (pay at par out of a loss nobody marked down). So the command *verifies* instead. The hub's deployed capital is USDC held by `CctpReturnRelay` on Base, not an LP position, so its value is a balance read rather than an estimate; an unchanged mark is a finding, and a failed read exits non-zero rather than posting anything. The contract's own bounds are read from the vault each run, so the keeper cannot propose a step the chain rejects.

  What is still missing is a **scheduler** — nothing runs it hourly. And the posting branch has not executed against a live vault: as of 2026-08-08 the hub's `deployedAssets` is 0, so the run exercises the reads, the bounds and the early return, not the write. The failure path is proven (a dead RPC exits 1 naming the failed call). In-flight burns count as zero until burn-log scanning lands, which understates assets and therefore caps *downward* — the direction that haircuts rather than overpays, and it logs `capped` when it happens.
- ~~**Meteora has no adapter.**~~ **Built, and reading real bins.** The legacy REST host is still retired; the current one (`dlmm.datapi.meteora.ag`) supplies the listing, and the denominator comes from the chain — `BinArray` accounts over plain Solana JSON-RPC, no DLMM SDK, so the reads replay from fixtures like every other adapter.
- ~~**No `tick-level` fidelity.**~~ **Meteora reaches it, for a rationed few pools per scan.** Constant-sum bins make it the only source that can answer "how much is in range at ±δ" for an arbitrary δ rather than one tick interval, and the only one that produces a real `liquidityHistogram`. But bins are on-chain accounts costing three RPC calls per pool, so only the top 8 pools that clear a $1M TVL and $100k daily-volume floor get read; **every other Meteora row is `unavailable`**, and says so. Orca and Uniswap v3 remain the two venues with a denominator on every row.

  A floor cleared is not a deposit absorbed. The floors are on *headline* TVL, because the quantity that actually matters — in-range liquidity — is only knowable after the read the floor exists to ration. PUMP/USDC clears $1M headline while holding $37,904 at ±500bp, 27x smaller. A floor sized from the deposit is the honest version and is not built.

## Deploying

Signing uses an encrypted Foundry keystore, so no private key is read from the environment or written to disk in the clear.

```bash
cd contracts
cp .env.example .env          # RPCs + USDC addresses, pre-filled and verified

cast wallet import spidey-deployer --interactive   # paste key, set a password
# fund the printed address: faucet.circle.com → Arc Testnet + Base Sepolia,
# plus a Sepolia ETH faucet for Base gas
```

Deploy the hub, the Base stack, and the return relay. `--sender` must be the
keystore address, or the script's `msg.sender` defaults to Foundry's and the
post-deploy `setRouter`/`setCaps` calls revert `NotOwner`:

```bash
S=--sender\ 0xYourDeployer

# 1. Arc hub
ARC_RPC_URL=https://rpc.testnet.arc.network \
USDC_ADDRESS=0x3600000000000000000000000000000000000000 \
forge script script/Deploy.s.sol --rpc-url arc_testnet --account spidey-deployer $S --broadcast

# 2. Base stack (self-contained, live Uniswap v3 venue)
forge script script/DeployBaseSepolia.s.sol --rpc-url base_sepolia --account spidey-deployer $S --broadcast

# 3. Return relay on Base, pinned to the Arc vault from step 1
ARC_VAULT=0x…arc-vault forge script script/DeployReturnRelay.s.sol \
  --rpc-url base_sepolia --account spidey-deployer $S --broadcast

# 4. Wire venue 2 on Arc, routing at the relay from step 3
ARC_VAULT=0x…arc-vault ARC_ROUTER=0x…arc-router BASE_RELAY=0x…relay \
  forge script script/WireBaseVenue.s.sol --rpc-url arc_testnet --account spidey-deployer $S --broadcast
```

Arc deployment costs ~0.14 USDC; Base Sepolia ~0.00006 ETH; the Solana program 1.354 SOL of rent, recoverable with `solana program close`.

**Moving USDC on Arc needs `cast send`, not `forge script`.** Arc's USDC calls a blocklist *precompile* (`0x18…01`) on every transfer, and that precompile has no EVM bytecode to fork — so any Arc token movement reverts `StackUnderflow` in a local simulation, which is what `forge script` and fork tests run. Deploys and wiring simulate fine (no transfer); the deposit → deploy → burn flow goes through `script/bridge-out-smoke.sh`, and the return leg through `script/return-finish.sh`.

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

`SOLANA_RPC_URL` overrides the endpoint Meteora's bin reader uses, and **anything running the API for real should set it.** The public node is fine for a keeper's periodic scan or a `record` capture — a full 8-pool enrichment took 6.8s with no rate limiting. It is not fine for a server: the pool cache expires after 60s, so a live API issues 25 RPC calls a minute, 8 of them `getProgramAccounts` scans at ~7-10s each. That is ~11,500 program scans a day against a free endpoint.
