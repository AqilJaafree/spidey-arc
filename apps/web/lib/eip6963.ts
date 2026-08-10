/**
 * Wallet discovery and chain selection, without a wallet library.
 *
 * EIP-6963 replaced the `window.ethereum` scramble with an announcement
 * protocol: the page asks, every installed wallet answers with its own
 * provider and identity, and nothing has to win a race for a single global.
 * That is the whole mechanism, and it is small enough that a vendor modal
 * would be more code than this, not less.
 *
 * The event target is injected rather than reached for. `window` is not
 * available while Next renders on the server, and a test that cannot dispatch
 * an announcement cannot check that discovery works.
 */

import type { Chain } from 'viem';

export type Eip1193Provider = {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
  on(event: string, handler: (...args: never[]) => void): void;
  removeListener(event: string, handler: (...args: never[]) => void): void;
};

export type WalletInfo = {
  uuid: string;
  name: string;
  rdns: string;
  icon: string;
};

export type DiscoveredWallet = {
  info: WalletInfo;
  provider: Eip1193Provider;
};

type AnnounceEvent = Event & { detail?: DiscoveredWallet };

/**
 * A live list of the wallets that have announced themselves.
 *
 * Keyed by uuid because wallets re-announce on every request — several times
 * per page load, once per component that asks — and a list that grew a row per
 * announcement would show the same wallet four times.
 */
export function createProviderStore(target: EventTarget) {
  const wallets = new Map<string, DiscoveredWallet>();
  const listeners = new Set<() => void>();

  const onAnnounce = (event: Event) => {
    const detail = (event as AnnounceEvent).detail;
    if (!detail?.info?.uuid) return;
    if (wallets.has(detail.info.uuid)) return;
    wallets.set(detail.info.uuid, detail);
    for (const listener of listeners) listener();
  };

  target.addEventListener('eip6963:announceProvider', onAnnounce);

  return {
    /** Ask every installed wallet to announce itself. */
    discover() {
      target.dispatchEvent(new Event('eip6963:requestProvider'));
    },
    list(): DiscoveredWallet[] {
      return [...wallets.values()];
    },
    byRdns(rdns: string): DiscoveredWallet | undefined {
      return [...wallets.values()].find((w) => w.info.rdns === rdns);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      target.removeEventListener('eip6963:announceProvider', onAnnounce);
      listeners.clear();
      wallets.clear();
    },
  };
}

export type ProviderStore = ReturnType<typeof createProviderStore>;

function toHex(id: number): string {
  return `0x${id.toString(16)}`;
}

/** EIP-1193: the chain is not one the wallet knows about. */
const CHAIN_NOT_ADDED = 4902;

/**
 * Put the wallet on `chain`, adding it first if necessary.
 *
 * Adding is the expected path rather than the exceptional one — no wallet
 * ships Arc testnet, so a first-time visitor always lands here. Which is why
 * the add payload carries the full chain description: a wallet that adds Arc
 * with no explorer or a wrong native symbol is a wallet that will display
 * every subsequent balance wrong.
 *
 * A rejection propagates. Reporting success after the user declined would
 * leave the page reading state from a chain it is not on.
 */
export async function ensureChain(provider: Eip1193Provider, chain: Chain): Promise<void> {
  const wanted = toHex(chain.id);
  const current = (await provider.request({ method: 'eth_chainId' })) as string;
  if (current?.toLowerCase() === wanted) return;

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: wanted }],
    });
  } catch (error) {
    if ((error as { code?: number })?.code !== CHAIN_NOT_ADDED) throw error;

    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: wanted,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [...chain.rpcUrls.default.http],
          blockExplorerUrls: chain.blockExplorers
            ? [chain.blockExplorers.default.url]
            : undefined,
        },
      ],
    });
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: wanted }],
    });
  }
}
