/**
 * HTTP with fixture record/replay.
 *
 * Adapters are network code, and network code makes tests flaky and demos
 * fragile. Every response an adapter fetches can be captured to `fixtures/`
 * and replayed byte-for-byte, so the same code path runs live in the demo and
 * offline in CI.
 *
 * Mode comes from `SPIDEY_FETCH_MODE`:
 *   live     — network only (default)
 *   record   — network, then write the response to fixtures/
 *   fixture  — fixtures only; a missing fixture is an error, never a silent
 *              fallback to the network
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

export type FetchMode = 'live' | 'record' | 'fixture';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `packages/adapters/src` → repo root. */
export const FIXTURE_DIR = resolve(HERE, '../../../fixtures');

export function fetchMode(): FetchMode {
  const raw = process.env.SPIDEY_FETCH_MODE;
  if (raw === 'record' || raw === 'fixture' || raw === 'live') return raw;
  return 'live';
}

/**
 * Stable, filesystem-safe name for a request.
 *
 * Gzipped because these are committed: DefiLlama's `/pools` alone is ~11MB of
 * JSON, and a repo carrying that raw is a repo nobody wants to clone. That one
 * response compresses to 2.07MB, which is most of the 2.35MB the whole fixture
 * set currently weighs. The ratio is the argument, not any particular ceiling —
 * the set grows with every venue added, and gzip is what keeps it tolerable
 * rather than small.
 */
export function fixtureName(namespace: string, url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
  return join(namespace, `${hash}.json.gz`);
}

/**
 * Fixture name for a POST.
 *
 * JSON-RPC sends every call to the same URL, so hashing the URL alone would
 * give one fixture for every possible request. The body has to be part of the
 * key. `POST` is in the hashed material so a POST and a GET to one URL cannot
 * land on the same file.
 */
export function postFixtureName(namespace: string, url: string, body: unknown): string {
  const hash = createHash('sha256')
    .update(`POST\n${url}\n${JSON.stringify(body)}`)
    .digest('hex')
    .slice(0, 12);
  return join(namespace, `${hash}.json.gz`);
}

export class FixtureMissingError extends Error {
  constructor(path: string, url: string) {
    super(
      `no fixture at ${path} for ${url} — run \`pnpm capture\` with SPIDEY_FETCH_MODE=record to create it (refusing to fall back to the network in fixture mode)`,
    );
    this.name = 'FixtureMissingError';
  }
}

export type GetJsonOptions = {
  /** Fixture subdirectory, normally the adapter id. */
  namespace: string;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

async function readFixture(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(gunzipSync(await readFile(path)).toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeFixture(path: string, body: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, gzipSync(Buffer.from(JSON.stringify(body), 'utf8'), { level: 9 }));
}

/**
 * The one request loop, shared by {@link getJson} and {@link postJson}.
 *
 * GET and POST differ only in how the fixture is keyed and what `RequestInit`
 * goes on the wire. Everything that is easy to get subtly wrong — the timeout
 * controller, honouring a caller's abort, which statuses are worth retrying,
 * the backoff, writing the fixture only on a clean response — lives here once,
 * so the two cannot drift apart.
 *
 * `label` is only ever used to build the error message, so a failure names the
 * verb that failed.
 */
async function requestJson<T>(
  label: 'GET' | 'POST',
  url: string,
  path: string,
  options: GetJsonOptions,
  init: RequestInit,
): Promise<T> {
  const { timeoutMs = 20_000, retries = 2, signal } = options;
  const mode = fetchMode();

  if (mode === 'fixture') {
    const cached = await readFixture(path);
    if (cached === null) throw new FixtureMissingError(path, url);
    return cached as T;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    const onAbort = () => timer.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: timer.signal });
      if (response.ok) {
        const body = (await response.json()) as T;
        if (mode === 'record') await writeFixture(path, body);
        return body;
      }
      lastError = new Error(`${label} ${url} failed: ${response.status} ${response.statusText}`);
      // Retries are for transient failures only: a 4xx is a bug in our request
      // and retrying it just burns the venue's rate limit. `break` rather than
      // `throw` because a throw here would land in the catch below, which
      // cannot tell a dead request from a flaky one and would retry it anyway.
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
      // An explicit caller abort is not a transient failure.
      if (signal?.aborted) throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} ${url} failed`);
}

/** GET JSON, honouring the fixture mode. */
export async function getJson<T = unknown>(url: string, options: GetJsonOptions): Promise<T> {
  return requestJson<T>('GET', url, join(FIXTURE_DIR, fixtureName(options.namespace, url)), options, {
    headers: { accept: 'application/json', ...options.headers },
  });
}

/**
 * POST JSON, honouring the same fixture mode as {@link getJson}.
 *
 * Exists so RPC reads replay offline. `uniswapV3` is the one adapter that
 * talks to a chain and the one adapter with no fixtures and no offline
 * coverage; that is not a coincidence, and this is how the Meteora bin reader
 * avoids repeating it.
 */
export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  options: GetJsonOptions,
): Promise<T> {
  return requestJson<T>(
    'POST',
    url,
    join(FIXTURE_DIR, postFixtureName(options.namespace, url, body)),
    options,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
    },
  );
}
