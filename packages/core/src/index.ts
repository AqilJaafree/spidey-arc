/**
 * @spidey/core — the scoring engine (spec Layer 2).
 *
 * Pure math and pure decisions. No network, no clock reads that are not
 * injectable, no venue-specific knowledge. Adapters produce
 * {@link NormalizedPool}; this package turns those into a ranking for a
 * specific deposit size.
 */

export * from './fixed.js';
export * from './types.js';
export * from './rank.js';

export * from './math/concentration.js';
export * from './math/feeApr.js';
export * from './math/dilution.js';
export * from './math/entry.js';
export * from './math/switchRule.js';
export * from './math/hygiene.js';
