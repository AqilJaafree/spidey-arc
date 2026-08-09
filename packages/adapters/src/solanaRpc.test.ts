import { describe, expect, it } from 'vitest';
import {
  binArrayFilters,
  chunk,
  decodeBase64,
  discoverBinArrays,
  getMultipleAccounts,
} from './solanaRpc.js';

describe('base64 account data', () => {
  it('round-trips bytes', () => {
    expect(Array.from(decodeBase64('AAECAw=='))).toEqual([0, 1, 2, 3]);
  });
});

describe('bin array discovery filters', () => {
  it('pins the size and the lb_pair offset', () => {
    // dataSize 10136 is BinArray; lb_pair sits at 24. Both from the IDL.
    expect(binArrayFilters('POOL')).toEqual([
      { dataSize: 10_136 },
      { memcmp: { offset: 24, bytes: 'POOL' } },
    ]);
  });
});

describe('chunk', () => {
  it('splits to respect getMultipleAccounts’ 100-account limit', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
  });
});

/**
 * A recording transport.
 *
 * The seam exists so the error and batching paths have offline coverage — the
 * whole point of routing this file through `postJson` is that nothing about the
 * bin reader needs a network to be tested, and that has to include the RPC
 * envelope itself.
 */
type Call = { url: string; body: { method: string; params: unknown[] } };

function recorder(reply: (call: Call, nth: number) => unknown) {
  const calls: Call[] = [];
  const transport = async (url: string, body: unknown): Promise<unknown> => {
    const call = { url, body: body as Call['body'] };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
  return { calls, transport };
}

/** What an `getMultipleAccounts` row looks like on the wire. */
const account = (data: string) => ({ data: [data, 'base64'], owner: 'owner' });

describe('JSON-RPC errors surface', () => {
  it('throws naming the method, the code and the message', async () => {
    const { transport } = recorder(() => ({
      error: { code: -32602, message: 'Invalid params' },
    }));

    // A keeper only ever sees the log line, so the method has to be in it.
    await expect(getMultipleAccounts(['A'], { transport })).rejects.toThrow(
      /getMultipleAccounts.*-32602.*Invalid params/,
    );
  });

  it('throws on a missing result rather than reading it as no accounts', async () => {
    const { transport } = recorder(() => ({}));
    await expect(getMultipleAccounts(['A'], { transport })).rejects.toThrow(/no result/);
  });
});

describe('getMultipleAccounts', () => {
  it('batches at 100 and keeps the requested order', async () => {
    const { calls, transport } = recorder((call) => {
      const batch = call.body.params[0] as string[];
      // Echo each address back as its own account data, so a reordered or
      // dropped batch is visible in the assertion below.
      return { result: { value: batch.map((a) => account(Buffer.from(a).toString('base64'))) } };
    });

    const addresses = Array.from({ length: 250 }, (_, i) => `addr-${i}`);
    const out = await getMultipleAccounts(addresses, { transport });

    expect(calls.map((c) => (c.body.params[0] as string[]).length)).toEqual([100, 100, 50]);
    expect(out).toHaveLength(250);
    // Positional pairing with the input is what a later task relies on.
    expect(out.map((bytes) => Buffer.from(bytes as Uint8Array).toString('utf8'))).toEqual(addresses);
  });

  it('reports a missing account as null, not as an absent row', async () => {
    const { transport } = recorder(() => ({
      result: { value: [null, account('AAECAw==')] },
    }));

    const out = await getMultipleAccounts(['gone', 'here'], { transport });
    expect(out[0]).toBeNull();
    expect(Array.from(out[1] as Uint8Array)).toEqual([0, 1, 2, 3]);
  });

  it('forwards dataSlice when given, and omits it when not', async () => {
    const { calls, transport } = recorder(() => ({ result: { value: [null] } }));

    // Six bytes out of 904 is the whole reason the option exists: active_id at
    // 76 and bin_step at 80 sit inside one slice.
    await getMultipleAccounts(['A'], { transport, dataSlice: { offset: 76, length: 6 } });
    expect(calls[0]?.body.params[1]).toEqual({
      encoding: 'base64',
      dataSlice: { offset: 76, length: 6 },
    });

    await getMultipleAccounts(['A'], { transport });
    expect(calls[1]?.body.params[1]).toEqual({ encoding: 'base64' });
  });
});

/** `BinArray.index` is an i64 LE at offset 8 of the account. */
function indexData(index: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64LE(index);
  return buf.toString('base64');
}

describe('discoverBinArrays', () => {
  it('pairs each address with its decoded index, negatives included', async () => {
    const { calls, transport } = recorder(() => ({
      result: [
        { pubkey: 'above', account: { data: [indexData(7n), 'base64'] } },
        // A live SOL-USDC read returned -92: pools below their initial price
        // have negative array indices, and a u64 read would give 1.8e19.
        { pubkey: 'below', account: { data: [indexData(-92n), 'base64'] } },
      ],
    }));

    const found = await discoverBinArrays('POOL', { transport });

    expect(found).toEqual([
      { address: 'above', index: 7 },
      { address: 'below', index: -92 },
    ]);
    // The scan is only affordable because it asks for the 8 bytes of `index`.
    expect(calls[0]?.body.method).toBe('getProgramAccounts');
    expect(calls[0]?.body.params[1]).toEqual({
      encoding: 'base64',
      dataSlice: { offset: 8, length: 8 },
      filters: binArrayFilters('POOL'),
    });
  });

  it('returns nothing for a pool with no bin arrays', async () => {
    const { transport } = recorder(() => ({ result: [] }));
    expect(await discoverBinArrays('POOL', { transport })).toEqual([]);
  });
});
