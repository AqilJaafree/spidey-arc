/**
 * Live smoke test: run every adapter, rank at a few sizes, print what the
 * dashboards say next to what we say.
 *
 * Not a test — a demo harness for §12. `pnpm --filter @spidey/adapters smoke`
 */

import { rank } from '@spidey/core';
import { collectPools, ALL_ADAPTERS } from '../src/index.js';

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(2)}%`);

async function main(): Promise<void> {
  const started = Date.now();
  console.log(`Running ${ALL_ADAPTERS.length} adapters: ${ALL_ADAPTERS.map((a) => a.id).join(', ')}\n`);

  const { pools, skipped, failures } = await collectPools(ALL_ADAPTERS, {
    symbols: ['USDC'],
    limit: 40,
  });

  console.log(`Collected ${pools.length} pools in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const f of failures) console.log(`  ADAPTER FAILED  ${f.adapter}: ${f.error}`);

  const byFidelity = new Map<string, number>();
  for (const p of pools) byFidelity.set(p.activeTvlFidelity, (byFidelity.get(p.activeTvlFidelity) ?? 0) + 1);
  console.log('  fidelity:', Object.fromEntries(byFidelity));
  console.log(`  skipped: ${skipped.length}`);
  for (const s of skipped.slice(0, 5)) console.log(`    ${s.adapter} ${s.poolId.slice(0, 10)}: ${s.reason}`);

  // The headline claim: in-range TVL vs displayed TVL (§1).
  const measured = pools
    .filter((p) => p.activeTvlUsd !== null && p.tvlUsd > 0)
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, 8);

  if (measured.length > 0) {
    console.log('\n── In-range liquidity vs headline TVL (§1: "often 2–10% of displayed TVL") ──');
    for (const p of measured) {
      const share = ((p.activeTvlUsd as number) / p.tvlUsd) * 100;
      console.log(
        `  ${p.dex.padEnd(18)} ${p.pair.join('/').padEnd(14)} ` +
          `headline ${usd(p.tvlUsd).padStart(14)}  in-range(±${p.activeTvlDeltaBps}bp) ${usd(p.activeTvlUsd as number).padStart(12)}  ${share.toFixed(2)}%`,
      );
    }
  }

  for (const depositUsd of [1_000, 100_000, 5_000_000]) {
    const result = rank(pools, { depositUsd, expectedHoldDays: 7, rangeDeltaBps: 10 });
    console.log(`\n── rank(A = ${usd(depositUsd)}) ──`);
    console.log(`  ranked ${result.ranked.length}, excluded ${result.excluded.length}`);
    for (const row of result.ranked.slice(0, 5)) {
      console.log(
        `  ${row.dex.padEnd(18)} ${row.pair.join('/').padEnd(14)} ` +
          `headline ${pct(row.headlineAprBps).padStart(10)}  yours ${pct(row.yourAprBps).padStart(10)}  ` +
          `[${row.flags.join(',') || 'clean'}]`,
      );
    }
    const d = result.headlineDisagreement;
    console.log(`  headline winner: ${d.headlineWinnerPoolId?.slice(0, 12)} | ours: ${d.ourWinnerPoolId?.slice(0, 12)} | disagrees: ${d.disagrees}`);
  }

  const excludedSample = rank(pools, { depositUsd: 100_000 }).excluded.slice(0, 4);
  if (excludedSample.length > 0) {
    console.log('\n── Excluded, with reasons (§6) ──');
    for (const row of excludedSample) {
      console.log(`  ${row.dex.padEnd(18)} ${row.pair.join('/').padEnd(14)} ${row.reason}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
