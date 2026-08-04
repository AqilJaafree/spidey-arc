/**
 * Capture live venue responses to `fixtures/` so tests and demos can replay
 * them byte-for-byte.
 *
 *   SPIDEY_FETCH_MODE=record pnpm capture
 *
 * Fixtures are committed. They are the difference between a demo that works
 * on conference wifi and one that does not.
 */

import { ALL_ADAPTERS, FIXTURE_DIR, fetchMode } from '../src/index.js';

async function main(): Promise<void> {
  if (fetchMode() !== 'record') {
    console.error(
      'Refusing to run outside record mode — set SPIDEY_FETCH_MODE=record.\n' +
        'This avoids overwriting good fixtures with a live run that half-failed.',
    );
    process.exit(1);
  }

  console.log(`Recording into ${FIXTURE_DIR}\n`);
  let failures = 0;

  for (const adapter of ALL_ADAPTERS) {
    process.stdout.write(`  ${adapter.id.padEnd(14)} `);
    try {
      const { pools, skipped } = await adapter.listPools({ symbols: ['USDC'], limit: 60 });
      const withDenominator = pools.filter((p) => p.activeTvlUsd !== null).length;
      console.log(`${pools.length} pools (${withDenominator} with in-range TVL), ${skipped.length} skipped`);
    } catch (error) {
      failures += 1;
      console.log(`FAILED: ${(error as Error).message.slice(0, 120)}`);
    }
  }

  console.log(failures === 0 ? '\nAll adapters recorded.' : `\n${failures} adapter(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
