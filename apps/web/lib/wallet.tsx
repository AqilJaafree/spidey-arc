'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';

import { ARC_TESTNET } from './chain';
import {
  createProviderStore,
  ensureChain,
  type DiscoveredWallet,
  type Eip1193Provider,
  type ProviderStore,
} from './eip6963';

/**
 * Reads go straight to the public RPC and never through a wallet.
 *
 * A page that reads through the connected wallet shows nothing until someone
 * connects, which would make the vault's state a reward for connecting rather
 * than the thing you consult before deciding to.
 */
export const publicClient: PublicClient = createPublicClient({
  chain: ARC_TESTNET,
  transport: http(undefined, { batch: true }),
});

/** Which wallet was last used, so a return visit reconnects silently. */
const LAST_WALLET_KEY = 'spidey.wallet.rdns';

type WalletState = {
  wallets: DiscoveredWallet[];
  address: Address | null;
  chainId: number | null;
  onArc: boolean;
  connecting: boolean;
  error: string | null;
  connect: (wallet: DiscoveredWallet) => Promise<void>;
  switchToArc: () => Promise<void>;
  disconnect: () => void;
  walletClient: WalletClient | null;
};

const WalletContext = createContext<WalletState | null>(null);

let store: ProviderStore | null = null;
function providerStore(): ProviderStore | null {
  if (typeof window === 'undefined') return null;
  store ??= createProviderStore(window);
  return store;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [active, setActive] = useState<DiscoveredWallet | null>(null);
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Discovery, and the silent reconnect that rides on it.
  useEffect(() => {
    const s = providerStore();
    if (!s) return;

    const sync = () => setWallets(s.list());
    const unsubscribe = s.subscribe(sync);
    s.discover();
    sync();

    return unsubscribe;
  }, []);

  const adopt = useCallback(async (wallet: DiscoveredWallet, accounts: string[]) => {
    setActive(wallet);
    setAddress((accounts[0] as Address) ?? null);
    const id = (await wallet.provider.request({ method: 'eth_chainId' })) as string;
    setChainId(Number.parseInt(id, 16));
  }, []);

  // Reconnect without prompting. `eth_accounts` reports an existing
  // authorization; `eth_requestAccounts` would open the wallet on page load,
  // which is a popup nobody asked for.
  useEffect(() => {
    if (active || wallets.length === 0) return;
    const remembered = window.localStorage.getItem(LAST_WALLET_KEY);
    if (!remembered) return;

    const wallet = wallets.find((w) => w.info.rdns === remembered);
    if (!wallet) return;

    void (async () => {
      try {
        const accounts = (await wallet.provider.request({ method: 'eth_accounts' })) as string[];
        if (accounts?.length) await adopt(wallet, accounts);
      } catch {
        // A wallet that will not answer a silent query is simply not connected.
        window.localStorage.removeItem(LAST_WALLET_KEY);
      }
    })();
  }, [wallets, active, adopt]);

  // Follow the wallet rather than assume it stays put. Both of these fire
  // without any action on this page — a user switching account in the
  // extension is the common case, and a stale address would show one person's
  // balance while transacting as another.
  useEffect(() => {
    if (!active) return;
    const provider = active.provider;

    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[];
      if (!accounts?.length) {
        setActive(null);
        setAddress(null);
        window.localStorage.removeItem(LAST_WALLET_KEY);
      } else {
        setAddress(accounts[0] as Address);
      }
    };
    const onChain = (...args: never[]) => {
      setChainId(Number.parseInt(args[0] as unknown as string, 16));
    };

    provider.on('accountsChanged', onAccounts);
    provider.on('chainChanged', onChain);
    return () => {
      provider.removeListener('accountsChanged', onAccounts);
      provider.removeListener('chainChanged', onChain);
    };
  }, [active]);

  const connect = useCallback(
    async (wallet: DiscoveredWallet) => {
      setConnecting(true);
      setError(null);
      try {
        const accounts = (await wallet.provider.request({
          method: 'eth_requestAccounts',
        })) as string[];
        if (!accounts?.length) throw new Error('the wallet returned no account');

        await ensureChain(wallet.provider, ARC_TESTNET);
        await adopt(wallet, accounts);
        window.localStorage.setItem(LAST_WALLET_KEY, wallet.info.rdns);
      } catch (cause) {
        setError(connectionMessage(cause));
      } finally {
        setConnecting(false);
      }
    },
    [adopt],
  );

  const switchToArc = useCallback(async () => {
    if (!active) return;
    setError(null);
    try {
      await ensureChain(active.provider, ARC_TESTNET);
      const id = (await active.provider.request({ method: 'eth_chainId' })) as string;
      setChainId(Number.parseInt(id, 16));
    } catch (cause) {
      setError(connectionMessage(cause));
    }
  }, [active]);

  const disconnect = useCallback(() => {
    setActive(null);
    setAddress(null);
    setChainId(null);
    setError(null);
    window.localStorage.removeItem(LAST_WALLET_KEY);
  }, []);

  const walletClient = useMemo(() => {
    if (!active || !address) return null;
    return createWalletClient({
      account: address,
      chain: ARC_TESTNET,
      transport: custom(active.provider as Eip1193Provider),
    });
  }, [active, address]);

  const value = useMemo<WalletState>(
    () => ({
      wallets,
      address,
      chainId,
      onArc: chainId === ARC_TESTNET.id,
      connecting,
      error,
      connect,
      switchToArc,
      disconnect,
      walletClient,
    }),
    [wallets, address, chainId, connecting, error, connect, switchToArc, disconnect, walletClient],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error('useWallet must be used inside <WalletProvider>');
  return context;
}

/** EIP-1193: the user dismissed the prompt. Not an error worth alarming about. */
function connectionMessage(cause: unknown): string {
  const code = (cause as { code?: number })?.code;
  if (code === 4001) return 'Connection declined in the wallet.';
  const message = (cause as Error)?.message;
  return message ? message.split('\n')[0] : 'Could not connect.';
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
