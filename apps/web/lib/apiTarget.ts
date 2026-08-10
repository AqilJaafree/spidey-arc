/**
 * Where the scoring engine is, and whether the person looking at a failure can
 * do anything about it.
 *
 * `/vault` reads Arc straight from the browser and needs no engine. `/` does,
 * and the engine is a long-lived process rather than a function — a cold scan
 * of 207 pools takes ~8.4s, which is why it is not deployed beside the site.
 * So on a deployed build "could not reach it" is a normal state, and the
 * advice it offers has to differ from a developer's.
 */

export const ENGINE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8787';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

/**
 * Compared as a parsed hostname, not a substring. `localhost.attacker.example`
 * contains the word and is not local.
 */
export function engineIsLocal(url: string = ENGINE_URL): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
