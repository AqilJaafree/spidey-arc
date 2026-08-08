/**
 * Whether this process may write, decided before it does anything else.
 *
 * A scheduler sees one bit. Left to fall back, a typo'd `REPORTR_KEY` on
 * Railway produces a green tick every fifteen minutes, a log full of
 * correct-looking reads, and a NAV mark that quietly ages past MAX_NAV_AGE —
 * at which point `claimWithdraw` starts reverting and the first symptom is a
 * user who cannot withdraw. That is worse than the outage the tick exists to
 * prevent, because an outage at least shows red.
 *
 * So read-only is something you ask for, never something you fall into. A
 * missing key with no `KEEPER_READ_ONLY` is refused before the first RPC call,
 * which turns the typo into a failed deploy inside the first fifteen minutes —
 * the cheapest moment there is to notice it.
 *
 * Shared by both entry points rather than written twice: they must refuse on
 * exactly the same conditions, and two copies of a rule is how the two stop
 * agreeing.
 */

/** What the entry point is allowed to do, and the key if it may write. */
export type ReporterMode =
  | { readOnly: false; key: `0x${string}` }
  | { readOnly: true };

/**
 * `1`, `true`, `yes` — anything non-empty, really, except the two spellings
 * that plainly mean "no". `KEEPER_READ_ONLY=0` selecting read-only would be a
 * worse surprise than any strictness this avoids.
 */
function flagged(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

export function reporterMode(env: NodeJS.ProcessEnv = process.env): ReporterMode {
  const key = (env.REPORTER_KEY ?? '').trim();

  // Both set: read-only wins. The flag is an explicit statement of intent, and
  // the two mistakes are not symmetric — a stale flag beside a good key means
  // no post, which every run announces in its own log and a config change
  // fixes, while honouring the key anyway means a dry run someone asked for
  // posts a real mark to a live vault and holds it for a cooldown. Prefer the
  // loud, reversible failure to the quiet, irreversible one.
  if (flagged(env.KEEPER_READ_ONLY)) return { readOnly: true };

  if (key) return { readOnly: false, key: key as `0x${string}` };

  throw new Error(
    'REPORTER_KEY is not set. Set REPORTER_KEY to post, or KEEPER_READ_ONLY=1 to run ' +
      'read-only on purpose. Refusing to start: a keeper that silently posts nothing ' +
      'looks identical to one that is working.',
  );
}
