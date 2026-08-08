/**
 * One pass of the keeper's work, and what it means for the pass to have failed.
 *
 * Stateless on purpose. A stateful daemon that dies mid-operation has to
 * reconcile on restart, and reconciliation is where this class of software
 * rots. A tick that rediscovers its work every run is restart-safe by
 * construction, a missed run self-heals on the next one, and the thing you run
 * by hand to debug is the thing production runs.
 */

/** A unit of keeper work. `run` resolves to a one-line summary for the log. */
export type Job = { name: string; run: () => Promise<string> };

export type JobResult = { name: string; ok: boolean; detail: string };

/**
 * Run every job, whatever the others do.
 *
 * Sequential rather than parallel: the jobs share RPC endpoints and a signing
 * key, and two transactions from one key in flight together is a nonce
 * collision.
 *
 * Nothing here rethrows. A stale NAV mark and an unminted burn are independent
 * failures, and stopping at the first would let one bad RPC cause both — the
 * caller decides what a failed job means, from the full picture.
 */
export async function runJobs(jobs: readonly Job[]): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (const job of jobs) {
    try {
      results.push({ name: job.name, ok: true, detail: await job.run() });
    } catch (e) {
      results.push({
        name: job.name, ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

/**
 * Non-zero if any job failed.
 *
 * The only signal a scheduler sees, so it has to mean "something needs a
 * human" and nothing else. An empty run is zero: no work is not a failure.
 */
export function tickExitCode(results: readonly JobResult[]): number {
  return results.some((r) => !r.ok) ? 1 : 0;
}
