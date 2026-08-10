import { describe, expect, it, vi } from 'vitest';
import { createProviderStore, ensureChain, type Eip1193Provider } from './eip6963';
import { ARC_TESTNET } from './chain';

function announce(target: EventTarget, uuid: string, name: string, provider: unknown) {
  const event = new Event('eip6963:announceProvider');
  Object.assign(event, { detail: { info: { uuid, name, rdns: `test.${name}`, icon: '' }, provider } });
  target.dispatchEvent(event);
}

/** A wallet that records what it was asked, and can be told to refuse. */
function fakeWallet(options: { chainId?: string; unknownChain?: boolean } = {}) {
  const calls: { method: string; params?: unknown }[] = [];
  let chainId = options.chainId ?? '0x1';
  let added = false;

  const provider: Eip1193Provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case 'eth_chainId':
          return chainId;
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return ['0x9e5fdE1f7484096A9beCDBb956A05834eC581195'];
        case 'wallet_addEthereumChain':
          added = true;
          return null;
        case 'wallet_switchEthereumChain': {
          if (options.unknownChain && !added) {
            const error = new Error('Unrecognized chain ID') as Error & { code: number };
            error.code = 4902;
            throw error;
          }
          chainId = (params as { chainId: string }[])[0].chainId;
          return null;
        }
        default:
          return null;
      }
    },
    on: () => {},
    removeListener: () => {},
  };

  return { provider, calls, get chainId() { return chainId; } };
}

describe('createProviderStore', () => {
  it('collects wallets that announce themselves', () => {
    const target = new EventTarget();
    const store = createProviderStore(target);

    announce(target, 'a', 'Rabby', fakeWallet().provider);
    announce(target, 'b', 'MetaMask', fakeWallet().provider);

    expect(store.list().map((w) => w.info.name)).toEqual(['Rabby', 'MetaMask']);
  });

  // Wallets re-announce whenever anyone asks, so the same uuid arrives many
  // times per page. Without dedupe the picker grows a duplicate row per ask.
  it('does not list the same wallet twice', () => {
    const target = new EventTarget();
    const store = createProviderStore(target);
    const wallet = fakeWallet().provider;

    announce(target, 'a', 'Rabby', wallet);
    announce(target, 'a', 'Rabby', wallet);

    expect(store.list()).toHaveLength(1);
  });

  it('notifies subscribers when a wallet appears', () => {
    const target = new EventTarget();
    const store = createProviderStore(target);
    const seen = vi.fn();
    store.subscribe(seen);

    announce(target, 'a', 'Rabby', fakeWallet().provider);

    expect(seen).toHaveBeenCalledOnce();
  });

  it('asks wallets to announce themselves', () => {
    const target = new EventTarget();
    const heard = vi.fn();
    target.addEventListener('eip6963:requestProvider', heard);

    createProviderStore(target).discover();

    expect(heard).toHaveBeenCalledOnce();
  });

  it('stops listening when torn down', () => {
    const target = new EventTarget();
    const store = createProviderStore(target);
    store.destroy();

    announce(target, 'a', 'Rabby', fakeWallet().provider);

    expect(store.list()).toHaveLength(0);
  });
});

describe('ensureChain', () => {
  it('does nothing when already on the right chain', async () => {
    const wallet = fakeWallet({ chainId: '0x4cef52' }); // 5042002
    await ensureChain(wallet.provider, ARC_TESTNET);
    expect(wallet.calls.map((c) => c.method)).toEqual(['eth_chainId']);
  });

  it('switches when the wallet already knows Arc', async () => {
    const wallet = fakeWallet({ chainId: '0x1' });
    await ensureChain(wallet.provider, ARC_TESTNET);
    expect(wallet.calls.map((c) => c.method)).toEqual(['eth_chainId', 'wallet_switchEthereumChain']);
    expect(wallet.chainId).toBe('0x4cef52');
  });

  // The expected first run for every user: no wallet ships Arc, so switching
  // fails 4902 and the chain has to be added before it can be switched to.
  it('adds Arc first when the wallet has never heard of it', async () => {
    const wallet = fakeWallet({ chainId: '0x1', unknownChain: true });
    await ensureChain(wallet.provider, ARC_TESTNET);

    expect(wallet.calls.map((c) => c.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'wallet_switchEthereumChain',
    ]);
    expect(wallet.chainId).toBe('0x4cef52');
  });

  it('describes Arc completely enough for a wallet to add it', async () => {
    const wallet = fakeWallet({ chainId: '0x1', unknownChain: true });
    await ensureChain(wallet.provider, ARC_TESTNET);

    const add = wallet.calls.find((c) => c.method === 'wallet_addEthereumChain');
    const [params] = add!.params as [Record<string, unknown>];
    expect(params.chainId).toBe('0x4cef52');
    expect(params.rpcUrls).toContain('https://rpc.testnet.arc.network');
    // Arc's gas token is USDC at 18 native decimals — the same asset the vault
    // takes at 6 through the ERC-20 shim.
    expect(params.nativeCurrency).toMatchObject({ symbol: 'USDC', decimals: 18 });
  });

  it('surfaces a rejected switch rather than reporting success', async () => {
    const wallet = fakeWallet({ chainId: '0x1' });
    const rejecting: Eip1193Provider = {
      ...wallet.provider,
      async request(args) {
        if (args.method === 'wallet_switchEthereumChain') {
          const error = new Error('User rejected') as Error & { code: number };
          error.code = 4001;
          throw error;
        }
        return wallet.provider.request(args);
      },
    };
    await expect(ensureChain(rejecting, ARC_TESTNET)).rejects.toThrow(/rejected/i);
  });
});
