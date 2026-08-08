/**
 * @spidey/keeper — the off-chain half of the Arc hub.
 *
 * The scoring engine proposes and the contracts dispose (§3). This package is
 * what carries a proposal across that boundary: it builds the Merkle tree the
 * `ScoreOracle` will verify against, decides whether the switch rule is
 * satisfied, and mirrors the Router's own integer check so it never submits a
 * transaction the chain will reject.
 *
 * It holds no key that can move user funds. Its authority is limited to
 * posting scores and proposing moves that the Router independently re-checks.
 */

export * from './merkle.js';
export * from './plan.js';
export * from './relay.js';
export * from './appkit.js';
export * from './nav.js';
export * from './navSources.js';
export * from './tick.js';
export * from './venueChain.js';
export * from './messages.js';
export * from './jobs/reportNav.js';
export * from './jobs/sweepBridges.js';
