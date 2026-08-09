/**
 * The minimum Solana JSON-RPC needed to read DLMM bins.
 *
 * Deliberately not `@solana/web3.js`. Two account reads and one filtered
 * program scan do not justify pulling that dependency — and, more to the
 * point, an SDK issues its own HTTP, which would sit outside the fixture layer
 * and leave the bin reader unreplayable offline. Everything here goes through
 * `postJson`, so a recorded scan replays byte-for-byte.
 */

import { postJson, type GetJsonOptions } from './http.js';
import { BIN_ARRAY_SIZE } from './meteoraBins.js';

export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
export const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/**
 * Which endpoint the bin reader talks to: option, then env, then the public node.
 *
 * An explicit `rpcUrl` always wins — a caller that named an endpoint meant it.
 *
 * `SOLANA_RPC_URL` exists because of a cadence hazard, not a preference. The
 * public default is fine for a keeper's periodic scan or a one-off `record`
 * capture: a full `topK: 8` enrichment took 6.8s with no 429s. It is not fine
 * for a server loop. `packages/api/src/poolCache.ts` holds pools for 60s and
 * defaults to every adapter, Meteora included, so a running API server issues
 * 1 + 3K = 25 RPC calls a minute — 8 of them `getProgramAccounts` scans, the
 * most expensive method there is, at ~7-10s each. That is roughly 11,500
 * program scans a day against a free endpoint, and a substantial duty cycle of
 * it. `poolCache.ts`'s own header rejects refetching per keystroke as "rude to
 * the upstream APIs"; this is worse than the thing that comment rejects. A
 * deployment running that loop must point `SOLANA_RPC_URL` at an endpoint it is
 * entitled to hammer.
 */
export function resolveRpcUrl(explicit?: string): string {
  // Trimmed and treated as absent when blank: deploy platforms hand over an
  // unset variable as an empty string, and `''` would otherwise resolve to a
  // request against the relative-URL nothing.
  const fromEnv = process.env.SOLANA_RPC_URL?.trim();
  return explicit ?? (fromEnv || DEFAULT_SOLANA_RPC);
}

/** `getMultipleAccounts` accepts at most 100 keys per call. */
const MAX_ACCOUNTS_PER_CALL = 100;

/** `BinArray.lb_pair`, from the IDL. */
const BIN_ARRAY_LB_PAIR_OFFSET = 24;

/**
 * Copies rather than views.
 *
 * `Buffer.from(str, 'base64')` returns a view onto Node's pooled memory, so its
 * `buffer` is shared with unrelated allocations. `meteoraBins` reads through a
 * `DataView`, and a caller who forgets `byteOffset` would silently decode
 * someone else's bytes. Owning the buffer removes that trap at the source.
 */
export const decodeBase64 = (data: string): Uint8Array =>
  Uint8Array.from(Buffer.from(data, 'base64'));

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Discovery without PDA derivation.
 *
 * These two filters identify every `BinArray` of one pool, which means no
 * base58 codec, no ed25519 and no seed math anywhere in this file — gPA hands
 * back `pubkey` already base58-encoded.
 */
export const binArrayFilters = (poolAddress: string): unknown[] => [
  { dataSize: BIN_ARRAY_SIZE },
  { memcmp: { offset: BIN_ARRAY_LB_PAIR_OFFSET, bytes: poolAddress } },
];

type RpcResponse<T> = { result?: T; error?: { code: number; message: string } };
type AccountValue = { data: [string, string]; owner: string } | null;

/**
 * Seam for tests, shaped exactly like {@link postJson}.
 *
 * Production passes nothing. Without it the error and batching paths could only
 * be exercised against a live endpoint, which is the offline-coverage gap this
 * transport exists to close — a fixture cannot be recorded for a response the
 * network will not produce on demand, such as `-32602`.
 */
export type RpcTransport = (
  url: string,
  body: unknown,
  options: GetJsonOptions,
) => Promise<unknown>;

export type SolanaRpcOptions = {
  rpcUrl?: string;
  signal?: AbortSignal;
  transport?: RpcTransport;
};

async function call<T>(method: string, params: unknown[], options: SolanaRpcOptions): Promise<T> {
  const url = resolveRpcUrl(options.rpcUrl);
  const send = options.transport ?? postJson;
  const body = (await send(
    url,
    { jsonrpc: '2.0', id: 1, method, params },
    { namespace: 'meteora-rpc', signal: options.signal },
  )) as RpcResponse<T>;
  // A JSON-RPC error arrives as HTTP 200, so `postJson` cannot catch it. Naming
  // the method here is the difference between a keeper log that identifies the
  // failing call and one that says only "-32602".
  if (body.error) throw new Error(`${method} failed: ${body.error.code} ${body.error.message}`);
  if (body.result === undefined) throw new Error(`${method} returned no result`);
  return body.result;
}

/**
 * Account data for several keys at once, `null` where an account is missing.
 *
 * `dataSlice` is passed through because the `LbPair` read needs six bytes out
 * of 904 and there is no reason to move the rest.
 */
export async function getMultipleAccounts(
  addresses: readonly string[],
  options: SolanaRpcOptions & { dataSlice?: { offset: number; length: number } } = {},
): Promise<Array<Uint8Array | null>> {
  const out: Array<Uint8Array | null> = [];
  for (const batch of chunk(addresses, MAX_ACCOUNTS_PER_CALL)) {
    const config: Record<string, unknown> = { encoding: 'base64' };
    if (options.dataSlice) config['dataSlice'] = options.dataSlice;
    const result = await call<{ value: AccountValue[] }>(
      'getMultipleAccounts',
      [batch, config],
      options,
    );
    // Sequential, and appended in batch order: callers pair these positionally
    // with the addresses they asked for, and a missing account holds its slot
    // as `null` rather than shortening the array.
    for (const value of result.value ?? []) {
      out.push(value === null ? null : decodeBase64(value.data[0]));
    }
  }
  return out;
}

export type DiscoveredBinArray = { address: string; index: number };

/**
 * Every bin-array address belonging to one pool, with its index.
 *
 * `dataSlice` is what makes this affordable: without it, a busy pool returns
 * 202 accounts of 10,136 bytes — 2.8MB. Slicing to the eight bytes of `index`
 * brings the same scan down to about 49KB, and gPA hands back addresses
 * already base58-encoded, so no PDA derivation and no ed25519 are needed.
 */
export async function discoverBinArrays(
  poolAddress: string,
  options: SolanaRpcOptions = {},
): Promise<DiscoveredBinArray[]> {
  const result = await call<Array<{ pubkey: string; account: { data: [string, string] } }>>(
    'getProgramAccounts',
    [
      DLMM_PROGRAM_ID,
      {
        encoding: 'base64',
        dataSlice: { offset: 8, length: 8 },
        filters: binArrayFilters(poolAddress),
      },
    ],
    options,
  );

  return (result ?? []).map((row) => {
    const bytes = decodeBase64(row.account.data[0]);
    // Signed, and with the offsets spelled out: an eight-byte slice is short
    // enough that a bare `bytes.buffer` would usually happen to work, which is
    // exactly how that bug survives to a longer read.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { address: row.pubkey, index: Number(view.getBigInt64(0, true)) };
  });
}
