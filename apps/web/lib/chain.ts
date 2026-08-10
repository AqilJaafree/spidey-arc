/**
 * Arc testnet, and the contracts the vault page talks to.
 *
 * One definition, used by the viem client, the wallet's `wallet_addEthereumChain`
 * payload and the explorer links — so a chain detail cannot be right in one
 * place and wrong in another.
 */

import { defineChain } from 'viem';

export const ARC_EXPLORER = 'https://testnet.arcscan.app';

/**
 * Chain 5042002.
 *
 * The native currency is USDC at 18 decimals, and the ERC-20 at
 * `0x3600…0000` is a shim over the same balance at 6. Gas and deposits are
 * therefore the same asset seen two ways, which is worth telling the user
 * rather than letting them discover it.
 */
export const ARC_TESTNET = defineChain({
  id: 5_042_002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.arc.network'] } },
  blockExplorers: { default: { name: 'Arcscan', url: ARC_EXPLORER } },
  // Verified present rather than assumed: `eth_getCode` at the canonical
  // address returns real bytecode on Arc testnet. It matters because the panel
  // reads a dozen slots per refresh, and without it that is a dozen round
  // trips against a public RPC.
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
  testnet: true,
});

/** Deployed 2026-08-06 under `0x9e5fdE…1195`. See README. */
export const CONTRACTS = {
  vault: '0x93Cd367f8ABEF789e8F6Bb1ce79eB0AB0153122f',
  scoreOracle: '0xb7DB9Ee5Ee46EB608d9a3A4DCc843230dD63b621',
  router: '0x09Bb87E6Ca168D6eD85e0682A39b22431600c9A8',
  usdc: '0x3600000000000000000000000000000000000000',
} as const;

export function explorerTx(hash: string): string {
  return `${ARC_EXPLORER}/tx/${hash}`;
}

export function explorerAddress(address: string): string {
  return `${ARC_EXPLORER}/address/${address}`;
}

// ---------------------------------------------------------------------------
// ABIs — pared to what this page calls, plus every error it may have to explain
// ---------------------------------------------------------------------------

export const USDC_ABI = [
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  { type: 'error', name: 'ERC20InsufficientBalance', inputs: [
    { name: 'sender', type: 'address' }, { name: 'balance', type: 'uint256' },
    { name: 'needed', type: 'uint256' },
  ] },
  { type: 'error', name: 'ERC20InsufficientAllowance', inputs: [
    { name: 'spender', type: 'address' }, { name: 'allowance', type: 'uint256' },
    { name: 'needed', type: 'uint256' },
  ] },
] as const;

export const VAULT_ABI = [
  // --- reads ---------------------------------------------------------------
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'idleAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'deployedAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'coverageBps', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'unaccountedBalance', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MAX_NAV_AGE', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  {
    type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'previewRedeemShares', stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function', name: 'caps', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'depositCapAssets', type: 'uint128' },
      { name: 'perVenueCapAssets', type: 'uint128' },
    ],
  },
  {
    type: 'function', name: 'nav', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'deployedAssets', type: 'uint128' },
      { name: 'updatedAt', type: 'uint64' },
      { name: 'epoch', type: 'uint64' },
    ],
  },
  {
    type: 'function', name: 'assets', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'idle', type: 'uint128' }, { name: 'pending', type: 'uint128' }],
  },
  {
    type: 'function', name: 'queue', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'epoch', type: 'uint16' }, { name: 'lastSettledEpoch', type: 'uint16' }],
  },
  {
    type: 'function', name: 'pendingOf', stateMutability: 'view',
    inputs: [{ name: 'holder', type: 'address' }],
    outputs: [
      { name: 'assets', type: 'uint128' },
      { name: 'epoch', type: 'uint16' },
      { name: 'flags', type: 'uint8' },
    ],
  },

  // --- writes --------------------------------------------------------------
  {
    type: 'function', name: 'deposit', stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }, { name: 'receiver', type: 'address' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    type: 'function', name: 'requestWithdraw', stateMutability: 'nonpayable',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'requestId', type: 'uint256' }],
  },
  {
    type: 'function', name: 'claimWithdraw', stateMutability: 'nonpayable',
    inputs: [{ name: 'requestId', type: 'uint256' }],
    outputs: [{ name: 'owed', type: 'uint256' }],
  },

  // --- errors, so a revert arrives decoded rather than as a hex blob -------
  { type: 'error', name: 'SynchronousRedemptionDisabled', inputs: [] },
  { type: 'error', name: 'ZeroShares', inputs: [] },
  { type: 'error', name: 'AmountTooLarge', inputs: [] },
  { type: 'error', name: 'DepositCapExceeded', inputs: [
    { name: 'attempted', type: 'uint256' }, { name: 'cap', type: 'uint256' },
  ] },
  { type: 'error', name: 'InsufficientIdle', inputs: [
    { name: 'requested', type: 'uint256' }, { name: 'available', type: 'uint256' },
  ] },
  { type: 'error', name: 'NavStale', inputs: [
    { name: 'updatedAt', type: 'uint64' }, { name: 'maxAge', type: 'uint64' },
  ] },
  { type: 'error', name: 'NavCooldown', inputs: [{ name: 'readyAt', type: 'uint64' }] },
  { type: 'error', name: 'EpochNotSettled', inputs: [
    { name: 'requestEpoch', type: 'uint16' }, { name: 'lastSettled', type: 'uint16' },
  ] },
  { type: 'error', name: 'NothingToClaim', inputs: [{ name: 'holder', type: 'address' }] },
  { type: 'error', name: 'NotRequestOwner', inputs: [{ name: 'requestId', type: 'uint256' }] },
  { type: 'error', name: 'ClaimPendingFirst', inputs: [
    { name: 'pendingEpoch', type: 'uint16' }, { name: 'currentEpoch', type: 'uint16' },
  ] },
] as const;
