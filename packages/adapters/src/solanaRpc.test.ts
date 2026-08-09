import { afterAll, describe, expect, it } from 'vitest';
import {
  binArrayFilters,
  chunk,
  decodeBase64,
  discoverBinArrays,
  getMultipleAccounts,
  resolveRpcUrl,
  DEFAULT_SOLANA_RPC,
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

describe('endpoint resolution', () => {
  const previous = process.env.SOLANA_RPC_URL;
  afterAll(() => {
    // Restored, not left set: vitest runs the files in a worker inside one
    // process, and an earlier task in this branch found a real intra-file leak
    // from exactly this pattern. A stray endpoint here would silently redirect
    // any later test that resolves one.
    if (previous === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = previous;
  });

  it('lets an explicit rpcUrl win over SOLANA_RPC_URL', async () => {
    process.env.SOLANA_RPC_URL = 'https://from-env.example';
    const { calls, transport } = recorder(() => ({ result: { value: [null] } }));

    // A caller that named an endpoint meant it — the env var is a deployment
    // default, not an override of the code.
    await getMultipleAccounts(['A'], { transport, rpcUrl: 'https://explicit.example' });
    expect(calls[0]?.url).toBe('https://explicit.example');
  });

  it('uses SOLANA_RPC_URL when no option is given', async () => {
    process.env.SOLANA_RPC_URL = 'https://from-env.example';
    const { calls, transport } = recorder(() => ({ result: [] }));

    // The scan path too, not just account reads: gPA is the expensive call and
    // the whole reason the override exists.
    await discoverBinArrays('POOL', { transport });
    expect(calls[0]?.url).toBe('https://from-env.example');
  });

  it('falls back to the public endpoint when the var is unset or blank', () => {
    delete process.env.SOLANA_RPC_URL;
    expect(resolveRpcUrl()).toBe(DEFAULT_SOLANA_RPC);

    // Deploy platforms hand over an unset variable as an empty string, and `''`
    // would otherwise be honoured as an endpoint.
    process.env.SOLANA_RPC_URL = '   ';
    expect(resolveRpcUrl()).toBe(DEFAULT_SOLANA_RPC);
  });
});

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

  /**
   * The positional-pairing guarantee, as the only failure that breaks it.
   *
   * `for (const value of result.value ?? [])` shortened `out` when the response
   * carried fewer values than the batch asked for. Every address after the gap
   * pairs with a neighbour's bytes, and the caller — `createRpcBinSource`, which
   * indexes `needed[i]` against `datas[i]` — has no way to see it. One batch
   * holds 100 keys and a bin read asks for at most five, so this is unreachable
   * today; the docblock promises it anyway.
   */
  it('throws rather than shortening the array when the RPC returns fewer values', async () => {
    const { transport } = recorder(() => ({ result: { value: [account('AAECAw==')] } }));
    await expect(getMultipleAccounts(['a', 'b', 'c'], { transport })).rejects.toThrow(
      /returned 1 values for 3 addresses/,
    );
  });

  it('throws on more values than asked for too, not just fewer', async () => {
    const { transport } = recorder(() => ({
      result: { value: [account('AAECAw=='), account('AAECAw==')] },
    }));
    await expect(getMultipleAccounts(['a'], { transport })).rejects.toThrow(
      /returned 2 values for 1 addresses/,
    );
  });

  it('throws on a result with no value array rather than reading it as no accounts', async () => {
    const { transport } = recorder(() => ({ result: {} }));
    await expect(getMultipleAccounts(['a'], { transport })).rejects.toThrow(
      /returned 0 values for 1 addresses/,
    );
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
