/**
 * The Solana devnet leg of the relayer — spec §4.
 *
 * App Kit was never the constraint here: `BridgeChain.Solana_Devnet` sits in
 * the same CCTP-v2 set as `Arc_Testnet` and `Base_Sepolia`, and Circle ships a
 * Solana adapter. What was missing was the wiring, and one specific thing the
 * wiring must not get wrong.
 *
 * A keeper key is not one address. The same 32 bytes derive a different
 * account on an EVM chain than on Solana, and the two are not interchangeable
 * — an EVM adapter cannot sign a Solana transaction at all. So every place
 * that used to say "the adapter" now has to ask "which chain", and the failure
 * mode if it doesn't is the quiet kind: a bridge built against the wrong
 * signer, or an address that reads as absent rather than wrong.
 */

import { describe, expect, it } from 'vitest';
import { BridgeChain } from '@circle-fin/app-kit';
import { CCTP_DOMAINS, chainTypeOf, RELAY_CHAINS } from './relay.js';
import { BRIDGE_CHAINS, bridgeUsdc, createKeeperWallet } from './appkit.js';

/**
 * Deterministic test keys. The EVM one is Anvil's account 0, published in
 * every Foundry tutorial; the Solana one is derived from the seed 1..32. Both
 * are public by construction and hold nothing.
 */
const EVM_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EVM_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const SOLANA_KEY =
  '2Ana1pUpv2ZbMVkwF5FXapYeBEjdxDatLn7nvJkhgTSdZd8hbDHTd21as7EAsg7ypityqfsw2pMQKJcVDVcAEsd';
const SOLANA_ADDRESS = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj';

const bothKeys = { evmPrivateKey: EVM_KEY, solanaPrivateKey: SOLANA_KEY };

describe('Solana devnet is a chain the relayer knows', () => {
  it('carries CCTP domain 5', () => {
    expect(CCTP_DOMAINS['solana-devnet']).toBe(5);
    // The two already-live legs, unchanged.
    expect(CCTP_DOMAINS['arc-testnet']).toBe(26);
    expect(CCTP_DOMAINS['base-sepolia']).toBe(6);
  });

  it('maps to App Kit’s own chain, not a hand-rolled definition', () => {
    expect(BRIDGE_CHAINS['solana-devnet']).toBe(BridgeChain.Solana_Devnet);
  });

  it('is enumerable, so a caller can ask what the relayer supports', () => {
    expect(RELAY_CHAINS).toContain('solana-devnet');
    expect(RELAY_CHAINS).toContain('arc-testnet');
    expect(RELAY_CHAINS).toContain('base-sepolia');
  });
});

describe('chain type decides which signer applies', () => {
  it('separates Solana from EVM', () => {
    expect(chainTypeOf('solana-devnet')).toBe('solana');
    expect(chainTypeOf('arc-testnet')).toBe('evm');
    expect(chainTypeOf('base-sepolia')).toBe('evm');
  });
});

describe('one keeper, two signing schemes', () => {
  it('derives the EVM address on an EVM chain', async () => {
    const wallet = createKeeperWallet(bothKeys);
    const address = await wallet.getAddress('base-sepolia');
    expect(address.toLowerCase()).toBe(EVM_ADDRESS.toLowerCase());
  });

  it('derives the Solana address on Solana — a different account entirely', async () => {
    const wallet = createKeeperWallet(bothKeys);
    const address = await wallet.getAddress('solana-devnet');
    expect(address).toBe(SOLANA_ADDRESS);
    expect(address).not.toMatch(/^0x/);
  });

  it('picks a different adapter per chain type', () => {
    const wallet = createKeeperWallet(bothKeys);
    expect(wallet.adapterFor('solana-devnet')).not.toBe(wallet.adapterFor('base-sepolia'));
    expect(wallet.adapterFor('arc-testnet')).toBe(wallet.adapterFor('base-sepolia'));
  });

  /**
   * The failure that must be loud. A keeper configured with only an EVM key
   * has no way to sign on Solana, and handing App Kit the viem adapter for a
   * Solana chain does not fail at the type level — it fails somewhere inside a
   * bridge, after a burn may already have happened.
   */
  it('refuses a Solana leg when no Solana key was supplied', async () => {
    const evmOnly = createKeeperWallet({ evmPrivateKey: EVM_KEY });
    expect(() => evmOnly.adapterFor('solana-devnet')).toThrow(/solana/i);
    await expect(evmOnly.getAddress('solana-devnet')).rejects.toThrow(/solana/i);
  });

  /**
   * The default endpoint is the public devnet RPC, which is rate-limited
   * enough to drop a polling keeper's transactions. An operator has to be able
   * to hand in their own without this package depending on web3.js.
   */
  it('passes a caller-supplied Solana connection through to the adapter', () => {
    // Proof the field is not silently dropped on the way: the SDK validates
    // it, so something that is not a `Connection` is rejected at construction.
    // Were the passthrough missing, this would quietly build a keeper pointed
    // at the default endpoint and no one would learn until it rate-limited.
    expect(() =>
      createKeeperWallet({
        ...bothKeys,
        solanaConnection: { rpcEndpoint: 'https://example-rpc.invalid' },
      }),
    ).toThrow(/Connection/i);
  });

  it('still serves EVM chains when no Solana key was supplied', async () => {
    const evmOnly = createKeeperWallet({ evmPrivateKey: EVM_KEY });
    const address = await evmOnly.getAddress('arc-testnet');
    expect(address.toLowerCase()).toBe(EVM_ADDRESS.toLowerCase());
  });
});

describe('a bridge signs each side with that side’s adapter', () => {
  /** Captures what App Kit would have been asked to do. */
  function capturingWallet() {
    const wallet = createKeeperWallet(bothKeys);
    const calls: Array<{ from: any; to: any; amount: string }> = [];
    wallet.kit = {
      bridge: async (params: any) => {
        calls.push(params);
        return { state: 'success', amount: params.amount, steps: [] };
      },
    } as any;
    return { wallet, calls };
  }

  it('uses the Solana adapter on the Solana side of an Arc → Solana bridge', async () => {
    const { wallet, calls } = capturingWallet();

    await bridgeUsdc(wallet, {
      from: 'arc-testnet',
      to: 'solana-devnet',
      amount: '2',
      recipient: SOLANA_ADDRESS,
    });

    const call = calls[0]!;
    expect(call.from.chain).toBe(BridgeChain.Arc_Testnet);
    expect(call.to.chain).toBe(BridgeChain.Solana_Devnet);
    expect(call.from.adapter).toBe(wallet.adapterFor('arc-testnet'));
    expect(call.to.adapter).toBe(wallet.adapterFor('solana-devnet'));
    expect(call.from.adapter).not.toBe(call.to.adapter);
  });

  it('uses the Solana adapter on the source side coming home', async () => {
    const { wallet, calls } = capturingWallet();

    await bridgeUsdc(wallet, { from: 'solana-devnet', to: 'arc-testnet', amount: '2' });

    const call = calls[0]!;
    expect(call.from.adapter).toBe(wallet.adapterFor('solana-devnet'));
    expect(call.to.adapter).toBe(wallet.adapterFor('arc-testnet'));
  });

  /**
   * A Solana recipient is base58, not hex. Typing it `0x${string}` did not
   * merely mislabel it — it made the correct value unexpressible.
   */
  it('carries a base58 recipient through unchanged', async () => {
    const { wallet, calls } = capturingWallet();

    await bridgeUsdc(wallet, {
      from: 'arc-testnet',
      to: 'solana-devnet',
      amount: '5',
      recipient: SOLANA_ADDRESS,
    });

    expect(calls[0]!.to.recipientAddress).toBe(SOLANA_ADDRESS);
  });
});
