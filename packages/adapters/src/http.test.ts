import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureMissingError, fixtureName, postFixtureName, postJson } from './http.js';

describe('POST fixtures key on the body, not just the URL', () => {
  it('gives two different RPC calls to one URL two different fixtures', () => {
    const url = 'https://rpc.example/';
    const a = postFixtureName('solana-rpc', url, { method: 'getAccountInfo', params: ['A'] });
    const b = postFixtureName('solana-rpc', url, { method: 'getAccountInfo', params: ['B'] });
    expect(a).not.toBe(b);
  });

  it('is stable for the same call, so a re-record overwrites rather than accumulates', () => {
    const url = 'https://rpc.example/';
    const body = { method: 'getAccountInfo', params: ['A'] };
    expect(postFixtureName('solana-rpc', url, body)).toBe(postFixtureName('solana-rpc', url, body));
  });

  it('stays inside its namespace directory', () => {
    expect(postFixtureName('solana-rpc', 'https://rpc.example/', {})).toMatch(/^solana-rpc\//);
  });

  it('does not collide with the GET fixture for the same URL', () => {
    const url = 'https://rpc.example/';
    expect(postFixtureName('solana-rpc', url, {})).not.toBe(fixtureName('solana-rpc', url));
  });
});

/**
 * The env var and `globalThis.fetch` are process-global, and a sibling test file
 * was already caught leaking `SPIDEY_FETCH_MODE` into whatever ran after it.
 * Every test below states the mode it needs and hands both back, so this file is
 * order-independent in either direction.
 */
const realFetch = globalThis.fetch;
const modeBefore = process.env.SPIDEY_FETCH_MODE;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (modeBefore === undefined) delete process.env.SPIDEY_FETCH_MODE;
  else process.env.SPIDEY_FETCH_MODE = modeBefore;
});

function jsonResponse(status: number, statusText: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => ({}),
  } as Response;
}

describe('postJson honours the fixture contract', () => {
  /**
   * The property the whole module exists for. A fixture-mode run that quietly
   * falls through to the network is worse than a failing one: CI goes green
   * against live data and the fixture is never noticed missing. Proving it means
   * proving `fetch` was never reached, not just that the call rejected.
   */
  it('never reaches the network in fixture mode, even for an unrecorded body', async () => {
    process.env.SPIDEY_FETCH_MODE = 'fixture';
    const spy = vi.fn(() => {
      throw new Error('postJson reached the network in fixture mode');
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    await expect(
      postJson('https://rpc.example/', { method: 'getAccountInfo', params: ['never-recorded'] }, { namespace: 'nope' }),
    ).rejects.toThrow(FixtureMissingError);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('postJson inherits getJson retry policy', () => {
  it('does not retry a 4xx, because the request is the bug and retrying burns the rate limit', async () => {
    process.env.SPIDEY_FETCH_MODE = 'live';
    const spy = vi.fn(async () => jsonResponse(400, 'Bad Request'));
    globalThis.fetch = spy as unknown as typeof fetch;

    await expect(
      postJson('https://rpc.example/', { method: 'getAccountInfo' }, { namespace: 'nope', retries: 2 }),
    ).rejects.toThrow(/400/);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  // `retries: 1` keeps this to a single 250ms backoff — enough to prove the
  // retry happened without paying the default 250ms + 500ms.
  it('does retry a 5xx, which is the venue failing rather than us', async () => {
    process.env.SPIDEY_FETCH_MODE = 'live';
    const spy = vi.fn(async () => jsonResponse(500, 'Internal Server Error'));
    globalThis.fetch = spy as unknown as typeof fetch;

    await expect(
      postJson('https://rpc.example/', { method: 'getAccountInfo' }, { namespace: 'nope', retries: 1 }),
    ).rejects.toThrow(/500/);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});
