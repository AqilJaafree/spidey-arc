/**
 * Adapter contract — spec Layer 1.
 *
 * An adapter's only job is to turn one venue's API into `NormalizedPool` rows.
 * It performs I/O and venue-specific arithmetic; it makes no ranking decisions
 * and holds no opinion about what is good. Everything downstream of
 * `listPools()` is pure (`@spidey/core`).
 *
 * The rule an adapter must never break (§6): if it cannot measure in-range
 * liquidity, it reports `activeTvlUsd: null` and
 * `activeTvlFidelity: 'unavailable'`. It does not guess. A guessed denominator
 * reintroduces the exact bug this system exists to fix.
 */

import type { NormalizedPool } from '@spidey/core';

export type AdapterContext = {
  /**
   * Restrict to pools whose symbols all appear here, uppercased. Empty means
   * no filter. Day 1 targets the USDC universe.
   */
  symbols?: string[];
  /** Cap on rows returned, applied after filtering. */
  limit?: number;
  /** Injected clock so captured fixtures replay deterministically. */
  now?: number;
  signal?: AbortSignal;
};

export type AdapterResult = {
  /** Successfully normalized rows. */
  pools: NormalizedPool[];
  /**
   * Pools the adapter saw but could not normalize, with the reason. Surfaced
   * rather than swallowed — silent drops hide coverage gaps.
   */
  skipped: Array<{ poolId: string; reason: string }>;
};

export type VenueAdapter = {
  /** Stable id, also used as the fixture filename. */
  readonly id: string;
  /** Human label for the UI. */
  readonly label: string;
  /** Best fidelity this adapter can reach for `activeTvlUsd`. */
  readonly bestFidelity: NormalizedPool['activeTvlFidelity'];
  listPools(ctx?: AdapterContext): Promise<AdapterResult>;
};

/** Symbols treated as USD-pegged when deriving a USD price from pool state. */
export const USD_SYMBOLS = new Set(['USDC', 'USDT', 'USDG', 'PYUSD', 'DAI', 'USDE', 'FDUSD']);

export const isUsdSymbol = (symbol: string): boolean => USD_SYMBOLS.has(symbol.toUpperCase());

/**
 * Symbols that behave like USD without being on the canonical list —
 * yield-bearing wrappers and the like. Matched by shape rather than
 * enumerated, since new ones appear constantly.
 */
const USD_LIKE_PATTERN = /^(?:[a-z]{0,3})?(?:USD[CTGSE]?|DAI|PYUSD|FDUSD|USDE)\d*$/i;

export const isUsdLikeSymbol = (symbol: string): boolean =>
  isUsdSymbol(symbol) || USD_LIKE_PATTERN.test(symbol);

/**
 * A stable/stable pair — the universe §7.4 identifies as where the edge
 * actually lives: "selecting pairs where `f × turnover` dominates `σ`, which
 * is exactly the stable/stable and correlated-pair universe. This is why the
 * USDC thesis holds."
 *
 * The demo defaults to this rather than to whatever memecoin pool prints the
 * largest number, because a USDC vault cannot take directional risk on
 * GMEx/USDC no matter what its headline APR says.
 */
export const isStablePair = (pair: readonly string[]): boolean =>
  pair.length === 2 && pair.every((s) => isUsdLikeSymbol(s));
