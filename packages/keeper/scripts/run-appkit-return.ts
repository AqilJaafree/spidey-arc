/**
 * One-off runner: the return leg through App Kit's `bridgeAndBook`.
 *
 * Bridges USDC Base -> Arc into the vault, then books it on-chain with
 * `Router.recordBridgeArrival`. The second half is the one App Kit cannot do —
 * capital returns as a CCTP *mint*, so no executor calls back and the Router
 * has to be told. `bridgeAndBook` injects that step.
 *
 *   cd packages/keeper && EVM_PRIVATE_KEY=0x… AMOUNT=0.5 \
 *   ../../node_modules/.bin/tsx scripts/run-appkit-return.ts
 *
 * The bookArrival callback reads the vault's ACTUAL unaccountedBalance and
 * books that, not the requested amount: a FAST transfer takes a fee on the
 * destination, so the mint is slightly under 0.5, and recordBridgeArrival is
 * bounded by what genuinely arrived.
 */

import { execFileSync } from 'node:child_process';
import { createKeeperWallet, bridgeAndBook } from '../src/index.js';

const evmPrivateKey = process.env.EVM_PRIVATE_KEY;
if (!evmPrivateKey) throw new Error('set EVM_PRIVATE_KEY (0x-prefixed)');

const AMOUNT = process.env.AMOUNT ?? '0.5';
const ARC_RPC = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const ARC_VAULT = '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f';
const ARC_ROUTER = '0x09Bb87E6Ca168D6eD85e0682A39b22431600c9A8';
const VENUE = 2;

const wallet = createKeeperWallet({ evmPrivateKey });

const cast = (args: string[]): string =>
  execFileSync('cast', args, { encoding: 'utf8' }).trim();

// recordBridgeArrival is bounded by unaccountedBalance() and never moves USDC,
// so it is safe on a normal signed tx (the Arc blocklist precompile only bites
// on transfers, and only in local simulation).
const bookArrival = async (venueId: number, _requested: bigint): Promise<void> => {
  const unaccounted = BigInt(
    cast(['call', ARC_VAULT, 'unaccountedBalance()(uint256)', '--rpc-url', ARC_RPC]).split(' ')[0],
  );
  if (unaccounted === 0n) throw new Error('nothing arrived to book');
  console.log(`\nbooking ${unaccounted} base-units (vault unaccountedBalance)`);
  const out = cast([
    'send', ARC_ROUTER,
    // See run-solana-return.ts: FINALIZE=true only when the position is closed.
    'recordBridgeArrival(uint16,uint256,bool)',
    String(venueId), String(unaccounted), String(process.env.FINALIZE === 'true'),
    '--rpc-url', ARC_RPC, '--private-key', evmPrivateKey, '--json',
  ]);
  console.log('  recordBridgeArrival tx:', JSON.parse(out).transactionHash);
};

console.log(`return ${AMOUNT} USDC  base-sepolia -> arc-testnet vault ${ARC_VAULT}\n`);

const outcome = await bridgeAndBook(
  wallet,
  {
    from: 'base-sepolia',
    to: 'arc-testnet',
    amount: AMOUNT,
    recipient: ARC_VAULT,
    venueId: VENUE,
  },
  bookArrival,
);

console.log('\nstate:', outcome.state);
for (const s of outcome.steps) {
  console.log(`  ${s.state.padEnd(8)} ${s.name}${s.txHash ? '  ' + s.txHash : ''}`);
}
console.log('source burn tx:', outcome.sourceTxHash ?? '(none)');
console.log('dest   mint tx:', outcome.destinationTxHash ?? '(none)');
if (outcome.state !== 'success') process.exitCode = 1;
