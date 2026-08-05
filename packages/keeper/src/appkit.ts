/**
 * App Kit wiring — spec §4's "Cross-chain USDC" row, made real.
 *
 * `relay.ts` describes what the keeper must do; this is the part that
 * actually does it. One `bridge()` call replaces the four manual steps a
 * round trip previously took: burn, poll Iris for the attestation, submit
 * `receiveMessage` on the destination, and repeat in reverse.
 *
 * # The boundary this module owns
 *
 * This is the only file in the repo that touches a private key. A keeper that
 * signs is a keeper that can lose funds, so that surface is kept in one place
 * rather than threaded through helpers — everything else takes an already
 * constructed `AppKit` and adapters.
 *
 * Note what App Kit still cannot do: tell the vault. Capital returns as a
 * CCTP *mint*, so no executor calls back and `Router.returnToVault` has
 * nothing to trigger on. `Router.recordBridgeArrival` closes that, and it is
 * the keeper's job to call it — see {@link bridgeAndBook}.
 */

import { AppKit, BridgeChain, TransferSpeed } from '@circle-fin/app-kit';
import { ArcTestnet, BaseSepolia, SolanaDevnet } from '@circle-fin/app-kit/chains';
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2';
import { createSolanaAdapterFromPrivateKey } from '@circle-fin/adapter-solana';

import { chainTypeOf, type RelayChain } from './relay.js';

/** Our chain names mapped to App Kit's. */
export const BRIDGE_CHAINS: Record<RelayChain, BridgeChain> = {
  'arc-testnet': BridgeChain.Arc_Testnet,
  'base-sepolia': BridgeChain.Base_Sepolia,
  'solana-devnet': BridgeChain.Solana_Devnet,
};

/** App Kit's own chain definitions, so we never hand-roll chain metadata. */
const CHAIN_DEFINITIONS: Record<RelayChain, unknown> = {
  'arc-testnet': ArcTestnet,
  'base-sepolia': BaseSepolia,
  'solana-devnet': SolanaDevnet,
};

/** Anything App Kit will accept as a signer for one chain type. */
type Adapter = { getAddress: (chain: unknown) => Promise<string> };

export type KeeperKeys = {
  /** 32-byte hex, for every EVM chain. */
  evmPrivateKey: string;
  /**
   * Base58, base64 or a JSON byte array — whatever the Solana tooling handed
   * you. Optional: a keeper that never touches Solana should not be forced to
   * hold a key for it, and asking for one it does not have fails loudly.
   */
  solanaPrivateKey?: string;
  /**
   * A pre-built `@solana/web3.js` `Connection`.
   *
   * Omit it and the adapter falls back to the chain definition's own
   * endpoint, which for Solana devnet is the public
   * `https://api.devnet.solana.com` — fine for a one-off relay, rate-limited
   * enough to drop transactions under a keeper's polling. Typed loosely so
   * this package does not take a direct dependency on web3.js just to pass
   * the object through.
   */
  solanaConnection?: unknown;
};

export type KeeperWallet = {
  kit: AppKit;
  /**
   * The signer for a chain.
   *
   * There is no single "the adapter" any more, and that is the point: an EVM
   * adapter cannot sign a Solana transaction. Passing the wrong one does not
   * fail at the type level — App Kit takes an adapter and a chain — so it
   * would surface somewhere inside a bridge, potentially after a burn.
   */
  adapterFor: (chain: RelayChain) => Adapter;
  /**
   * The signing address on a given chain.
   *
   * Async and chain-scoped because that is what the adapter actually offers:
   * one key derives different addresses on different chain types, so an EVM
   * address and a Solana address are not interchangeable. A bare `address`
   * property reads as correct and silently yields `undefined`.
   */
  getAddress: (chain: RelayChain) => Promise<string>;
};

/**
 * Build a signing keeper from its keys.
 *
 * @param keys Read them from an encrypted keystore or a secret manager at call
 *        time — never from a file in the repo, and never log them.
 */
export function createKeeperWallet(keys: KeeperKeys): KeeperWallet {
  const evm = createViemAdapterFromPrivateKey({
    privateKey: keys.evmPrivateKey,
  }) as unknown as Adapter;

  // Built eagerly so a malformed key fails at construction, where it is
  // cheap, rather than at the first bridge.
  const solana = keys.solanaPrivateKey
    ? (createSolanaAdapterFromPrivateKey({
        privateKey: keys.solanaPrivateKey,
        ...(keys.solanaConnection ? { connection: keys.solanaConnection as never } : {}),
      }) as unknown as Adapter)
    : undefined;

  const adapterFor = (chain: RelayChain): Adapter => {
    if (chainTypeOf(chain) !== 'solana') return evm;
    if (!solana) {
      throw new Error(
        `${chain} needs a Solana signer, but this keeper was built without solanaPrivateKey — an EVM key cannot sign on Solana`,
      );
    }
    return solana;
  };

  return {
    kit: new AppKit(),
    adapterFor,
    getAddress: async (chain) => adapterFor(chain).getAddress(CHAIN_DEFINITIONS[chain]),
  };
}

export type BridgeRequest = {
  from: RelayChain;
  to: RelayChain;
  /** Human units — "2" means 2 USDC. */
  amount: string;
  /**
   * Where it lands. Defaults to the keeper's own address on `to`.
   *
   * A plain string, because the destination decides the format: hex on an EVM
   * chain, base58 on Solana. Typing this `0x${string}` did not merely mislabel
   * a Solana recipient — it made the correct value unexpressible.
   */
  recipient?: string;
  /**
   * FAST settles in seconds for a fee; SLOW waits for hard finality, which on
   * Base Sepolia is 13–19 minutes.
   *
   * This is a routing decision, not a default: §7.5's payback rule already
   * prices the wait, so the engine that decided the move should decide the
   * speed too. FAST is the default here only because a keeper reacting to a
   * yield differential is, by construction, in a hurry.
   */
  speed?: TransferSpeed;
};

/** One transaction inside a bridge — approve, burn, mint. */
export type BridgeStepOutcome = {
  name: string;
  state: 'pending' | 'success' | 'error' | 'noop';
  txHash?: string;
  explorerUrl?: string;
};

export type BridgeOutcome = {
  state: 'pending' | 'success' | 'error';
  amount: string;
  /**
   * Every transaction the bridge performed.
   *
   * A bridge is not one transaction, and the result does not pretend it is:
   * hashes live per step, not on `source`/`destination`, which carry only
   * addresses and chain definitions. Assuming `source.transactionHash`
   * silently yields `undefined` — it reads as "no hash available" rather
   * than "wrong field", which is how it survives a passing run.
   */
  steps: BridgeStepOutcome[];
  /** Convenience: the burn on the source chain. */
  sourceTxHash?: string;
  /** Convenience: the mint on the destination chain. */
  destinationTxHash?: string;
};

/**
 * Move USDC between chains. App Kit handles the burn, the attestation wait
 * and the destination mint as one operation.
 */
export async function bridgeUsdc(
  wallet: KeeperWallet,
  request: BridgeRequest,
): Promise<BridgeOutcome> {
  // Each side is signed by that side's adapter. On an Arc ↔ Solana bridge
  // these are two different keys deriving two different accounts, so reusing
  // one for both is not a shortcut — it is a bridge built against a signer
  // that cannot sign.
  const from = { adapter: wallet.adapterFor(request.from), chain: BRIDGE_CHAINS[request.from] };
  const toAdapter = wallet.adapterFor(request.to);
  const to = request.recipient
    ? {
        adapter: toAdapter,
        chain: BRIDGE_CHAINS[request.to],
        recipientAddress: request.recipient,
      }
    : { adapter: toAdapter, chain: BRIDGE_CHAINS[request.to] };

  const result = await (wallet.kit as unknown as {
    bridge: (p: unknown) => Promise<{
      state: 'pending' | 'success' | 'error';
      amount: string;
      steps?: Array<{
        name: string;
        state: 'pending' | 'success' | 'error' | 'noop';
        txHash?: string;
        explorerUrl?: string;
      }>;
    }>;
  }).bridge({
    from,
    to,
    amount: request.amount,
    config: { transferSpeed: request.speed ?? TransferSpeed.FAST },
  });

  const steps = (result.steps ?? []).map((s) => ({
    name: s.name,
    state: s.state,
    txHash: s.txHash,
    explorerUrl: s.explorerUrl,
  }));

  return {
    state: result.state,
    amount: result.amount,
    steps,
    sourceTxHash: findStepHash(steps, ['burn', 'deposit', 'approve']),
    destinationTxHash: findStepHash(steps, ['mint', 'receive', 'claim']),
  };
}

/** First step whose name mentions one of `keywords` and that has a hash. */
function findStepHash(steps: BridgeStepOutcome[], keywords: string[]): string | undefined {
  for (const keyword of keywords) {
    const hit = steps.find((s) => s.txHash && s.name.toLowerCase().includes(keyword));
    if (hit) return hit.txHash;
  }
  return undefined;
}

/**
 * The full return leg: bridge the capital home, then tell the vault.
 *
 * The second half is the one App Kit cannot do and the one that is easy to
 * forget. Until `recordBridgeArrival` runs, the funds sit at the vault as
 * unaccounted balance while the venue's book still claims them — the vault
 * believing itself deployed while the money is already home. `PENDING_HOOK`
 * stays set, so the state is at least visible, but nothing clears on its own.
 *
 * @param bookArrival Submits `Router.recordBridgeArrival(venueId, amount)`.
 *        Injected rather than built here so this module keeps its single
 *        signing responsibility and stays testable without a chain.
 */
export async function bridgeAndBook(
  wallet: KeeperWallet,
  request: BridgeRequest & { venueId: number },
  bookArrival: (venueId: number, amountUsdc6: bigint) => Promise<void>,
): Promise<BridgeOutcome> {
  const outcome = await bridgeUsdc(wallet, request);

  if (outcome.state !== 'success') {
    // Deliberately does not book. A pending bridge that gets booked would
    // credit the vault with capital that has not arrived, which is exactly
    // the unbacked-idle case `recordBridgeArrival`'s on-chain bound exists
    // to reject — better to leave it for a later sweep than to submit a
    // transaction that should revert.
    return outcome;
  }

  await bookArrival(request.venueId, toUsdc6(outcome.amount));
  return outcome;
}

/**
 * Convert App Kit's decimal string to USDC base units.
 *
 * @dev USDC is 6dp through the ERC-20 interface everywhere, including Arc —
 *      where the *native* balance is 18dp for the same money (§7.7). App Kit
 *      speaks the token interface, so 6 is right here; the 18dp rail only
 *      appears when paying gas.
 */
export function toUsdc6(amount: string): bigint {
  const [whole = '0', frac = ''] = amount.split('.');
  if (frac.length > 6) {
    throw new RangeError(
      `${amount} has ${frac.length} decimal places; USDC carries 6 — refusing to truncate`,
    );
  }
  return BigInt(whole + frac.padEnd(6, '0'));
}
