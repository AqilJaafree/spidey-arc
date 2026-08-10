/**
 * One-off runner: finish a burn nobody minted, on Solana.
 *
 * `bridgeUsdc` burns, waits and mints in one flow, so it cannot resume a burn
 * that already happened — and `Router.deployIdle` burns without minting by
 * design: `CctpBridgeExecutor` is asynchronous, the far side completes later, and
 * `setVenuePending` marks the gap on-chain. That gap is what this closes.
 *
 * `sweepBridges` is the job that ought to do this and cannot: it speaks viem's
 * `PublicClient`/`WalletClient` and this message is bound for domain 5, so it
 * counts the burn and names it rather than finishing it.
 *
 *   cd packages/keeper && EVM_PRIVATE_KEY=0x… SOLANA_PRIVATE_KEY=… \
 *     BURN_TX=0x… ../../node_modules/.bin/tsx scripts/run-finish-mint.ts
 *
 * The mint is permissionless — `receiveMessage` verifies Circle's attestation,
 * not the caller — so the Solana key here pays fees and signs; it does not
 * authorise the transfer. The recipient is fixed inside the attested message
 * (`Router`'s route set it), and nothing on this side can redirect it.
 */

import { createKeeperWallet } from '../src/appkit.js';
import { fetchAttestation, CCTP_DOMAINS } from '../src/relay.js';
import { ArcTestnet, SolanaDevnet } from '@circle-fin/app-kit/chains';

const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
if (!evmPrivateKey) throw new Error('set EVM_PRIVATE_KEY (App Kit builds both adapters eagerly)');
const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;
if (!solanaPrivateKey) throw new Error('set SOLANA_PRIVATE_KEY — signs and pays for the mint on Solana');

const burnTx = process.env.BURN_TX;
if (!burnTx) throw new Error('set BURN_TX — the source-chain burn to finish');

const sourceDomain = Number(process.env.SOURCE_DOMAIN ?? CCTP_DOMAINS['arc-testnet']);

console.log(`finish the mint for burn ${burnTx}`);
console.log(`  source domain ${sourceDomain} (arc-testnet) -> solana-devnet\n`);

const attestation = await fetchAttestation(sourceDomain, burnTx);
console.log(`  attestation status: ${attestation.status}`);
if (attestation.status !== 'complete' || !attestation.message || !attestation.attestation) {
  throw new Error(`not ready to mint: ${attestation.status}`);
}
console.log(`  eventNonce        : ${attestation.eventNonce}`);

const wallet = createKeeperWallet({ evmPrivateKey, solanaPrivateKey });
const solana = wallet.adapterFor('solana-devnet') as unknown as {
  action: (name: string, params: unknown) => Promise<unknown>;
};
console.log(`  signing as        : ${await wallet.getAddress('solana-devnet')}\n`);

const result = await solana.action('cctp.v2.receiveMessage', {
  eventNonce: attestation.eventNonce,
  attestation: attestation.attestation,
  message: attestation.message,
  fromChain: ArcTestnet,
  toChain: SolanaDevnet,
});

console.log('  receiveMessage result:');
console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2).slice(0, 800));
