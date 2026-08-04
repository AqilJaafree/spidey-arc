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
 * JSON, and a repo carrying that raw is a repo nobody wants to clone. Gzip
 * takes the full fixture set from ~16MB to under 2MB with no loss.
 */
export function fixtureName(namespace: string, url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
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
 * GET JSON, honouring the fixture mode.
 *
 * Retries are for transient failures only: a 4xx is a bug in our request and
 * retrying it just burns the venue's rate limit.
 */
export async function getJson<T = unknown>(url: string, options: GetJsonOptions): Promise<T> {
  const { namespace, timeoutMs = 20_000, retries = 2, signal, headers } = options;
  const mode = fetchMode();
  const path = join(FIXTURE_DIR, fixtureName(namespace, url));

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
      const response = await fetch(url, {
        signal: timer.signal,
        headers: { accept: 'application/json', ...headers },
      });
      if (!response.ok) {
        const retryable = response.status >= 500 || response.status === 429;
        const error = new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
        if (!retryable) throw error;
        lastError = error;
      } else {
        const body = (await response.json()) as T;
        if (mode === 'record') await writeFixture(path, body);
        return body;
      }
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
  throw lastError instanceof Error ? lastError : new Error(`GET ${url} failed`);
}
