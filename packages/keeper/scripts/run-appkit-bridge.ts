/**
 * One-off runner: drive a real CCTP bridge through App Kit.
 *
 * This is the thing `bridge-out-smoke.sh` + the manual receiveMessage did by
 * hand, collapsed into one `bridgeUsdc()` call — App Kit does the burn, waits
 * for Circle's attestation, and submits the destination mint itself.
 *
 *   cd packages/keeper && EVM_PRIVATE_KEY=0x… \
 *   FROM=arc-testnet TO=base-sepolia AMOUNT=0.5 \
 *   ../../node_modules/.bin/tsx scripts/run-appkit-bridge.ts
 *
 * The key is read from the environment and never logged. Pull it from the
 * keystore at call time:
 *   EVM_PRIVATE_KEY=$(cast wallet dk spidey-deployer --unsafe-password "$PW")
 */

import { createKeeperWallet, bridgeUsdc } from '../src/index.js';
import type { RelayChain } from '../src/relay.js';

const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
if (!evmPrivateKey) throw new Error('set EVM_PRIVATE_KEY (0x-prefixed)');

// Needed only when a leg is on Solana. A JSON byte array (id.json), base58, or
// base64 — whatever the Solana tooling handed you. The adapter builds eagerly,
// so a bad key fails here, not mid-bridge.
const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY;

const from = (process.env.FROM ?? 'arc-testnet') as RelayChain;
const to = (process.env.TO ?? 'base-sepolia') as RelayChain;
const amount = process.env.AMOUNT ?? '0.5';
const recipient = process.env.RECIPIENT; // default: keeper's own address on `to`

const wallet = createKeeperWallet({
  evmPrivateKey,
  ...(solanaPrivateKey ? { solanaPrivateKey } : {}),
});

const fromAddr = await wallet.getAddress(from);
const toAddr = await wallet.getAddress(to);
console.log(`bridge ${amount} USDC  ${from} (${fromAddr})  ->  ${to} (${recipient ?? toAddr})`);
console.log('speed: FAST (App Kit default)\n');

const outcome = await bridgeUsdc(wallet, {
  from,
  to,
  amount,
  ...(recipient ? { recipient } : {}),
});

console.log('\nstate:', outcome.state);
for (const s of outcome.steps) {
  console.log(`  ${s.state.padEnd(8)} ${s.name}${s.txHash ? '  ' + s.txHash : ''}`);
}
console.log('\nsource burn tx:', outcome.sourceTxHash ?? '(none)');
console.log('dest   mint tx:', outcome.destinationTxHash ?? '(none)');

if (outcome.state !== 'success') process.exitCode = 1;
