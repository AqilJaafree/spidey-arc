import { describe, expect, it } from 'vitest';
import { runJobs, tickExitCode, type Job } from './tick.js';

const ok = (name: string, detail = 'fine'): Job => ({ name, run: async () => detail });
const bad = (name: string, message: string): Job => ({
  name, run: async () => { throw new Error(message); },
});

describe('runJobs', () => {
  it('runs every job and reports each outcome', async () => {
    expect(await runJobs([ok('nav', 'no post: cooldown'), ok('sweep', '0 outstanding')])).toEqual([
      { name: 'nav', ok: true, detail: 'no post: cooldown' },
      { name: 'sweep', ok: true, detail: '0 outstanding' },
    ]);
  });

  it('runs later jobs even when an earlier one throws', async () => {
    // The property the whole module exists for: a stale NAV mark and an
    // unminted burn are independent failures, and one bad RPC must not cause
    // both.
    const r = await runJobs([bad('nav', 'arc rpc down'), ok('sweep', '0 outstanding')]);
    expect(r[0]).toEqual({ name: 'nav', ok: false, detail: 'arc rpc down' });
    expect(r[1]).toEqual({ name: 'sweep', ok: true, detail: '0 outstanding' });
  });

  it('reports every failure, not just the first', async () => {
    const r = await runJobs([bad('nav', 'arc down'), bad('sweep', 'base down')]);
    expect(r.map((x) => x.ok)).toEqual([false, false]);
    expect(r.map((x) => x.detail)).toEqual(['arc down', 'base down']);
  });

  it('handles a job that throws a non-Error', async () => {
    const r = await runJobs([{ name: 'odd', run: async () => { throw 'a string'; } }]);
    expect(r[0]!.ok).toBe(false);
    expect(r[0]!.detail).toContain('a string');
  });

  it('runs the jobs in order, one at a time', async () => {
    // Sequential, not concurrent: the jobs share RPC endpoints and a signing
    // key, and two transactions from one key in flight together is a nonce
    // collision.
    const seen: string[] = [];
    const trace = (name: string): Job => ({
      name,
      run: async () => {
        seen.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, 5));
        seen.push(`end ${name}`);
        return 'done';
      },
    });
    await runJobs([trace('first'), trace('second')]);
    expect(seen).toEqual(['start first', 'end first', 'start second', 'end second']);
  });

  it('is fine with no jobs at all', async () => {
    expect(await runJobs([])).toEqual([]);
  });
});

describe('tickExitCode', () => {
  it('is zero when every job succeeded', () => {
    expect(tickExitCode([{ name: 'nav', ok: true, detail: '' }])).toBe(0);
  });

  it('is non-zero when any job failed', () => {
    expect(tickExitCode([
      { name: 'nav', ok: true, detail: '' },
      { name: 'sweep', ok: false, detail: 'base down' },
    ])).toBe(1);
  });

  it('is zero for an empty run', () => {
    // Nothing attempted is not a failure — it is a tick with no work.
    expect(tickExitCode([])).toBe(0);
  });
});
