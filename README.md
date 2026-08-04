# USDC LP Vault — cross-chain yield router

Comparing USDC LP opportunities across chains is broken in three ways: aggregators rank on fees over *displayed* TVL when only in-range liquidity earns fees; nobody models the dilution your own deposit causes; and nobody prices the cost of moving capital against your holding period.

This repo scores USDC LP venues with dilution- and cost-aware math. **The ranking is a function of your deposit size**, which is the thing no dashboard asks you for.

Full specification: [`usdc-lp-vault-spec.md`](./usdc-lp-vault-spec.md).
Day-1 design and deviations: [`docs/superpowers/specs/2026-08-04-usdc-lp-vault-day1-design.md`](./docs/superpowers/specs/2026-08-04-usdc-lp-vault-day1-design.md).

## What's built

Day 1 of the spec's §11 build plan: the scoring engine, an HTTP API, and the comparison UI. Contracts (Day 2) and the Solana receiver (Day 3) are not started.

```
packages/core      §7 math + rank(A). Pure — no I/O.
packages/adapters  Orca, Uniswap v3, Raydium, DefiLlama → NormalizedPool.
packages/api       Hono HTTP surface, TTL-cached.
apps/web           Next.js comparison UI.
fixtures/          gzipped API captures for offline replay.
```

## Quickstart

```bash
pnpm install
pnpm test          # 151 tests
pnpm api           # scoring engine on :8787
pnpm web           # UI on :3000
```

The UI needs the API running. Both work with no API keys.

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

## Known gaps

- **Meteora has no adapter.** The legacy `dlmm-api.meteora.ag` REST host is retired — Cloudflare returns 404 on every path with `cf-cache-status: HIT`, so it is gone rather than rate-limiting. Real bin-level data needs on-chain reads via `@meteora-ag/dlmm`.
- **No `tick-level` fidelity yet.** Both live venues report `current-tick-liquidity`, exact only within the current tick interval. True tick-level needs a Graph gateway key or on-chain tick-array reads.
- **Hourly series are unavailable from every public source**, so §7.6's estimator hygiene (EWMA, winsorization, persistence weighting) is implemented and unit-tested but inert on live data. Affected rows carry a `point estimate` flag.
- **Uniswap's RPC reads are not fixture-backed**, so that adapter needs network even in fixture mode.
