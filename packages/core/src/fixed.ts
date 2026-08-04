/**
 * Fixed-point conventions — spec §7.7.
 *
 * | Quantity          | Representation                                    |
 * |-------------------|---------------------------------------------------|
 * | USDC amounts      | uint128, 6 decimals (ERC-20 interface)            |
 * | Arc native gas    | 18 decimals — DIFFERENT from the ERC-20 interface |
 * | Prices / sqrt     | Q64.64 in uint128                                 |
 * | Rates, APR        | basis points in uint32                            |
 *
 * On Arc, USDC is both the ERC-20 token (6dp) and the native gas asset (18dp).
 * Mixing the two rails is the documented integration error for this chain: a
 * gas quote returned in wei is 1e12x larger than the same value expressed in
 * the token interface. Everything crossing that boundary goes through
 * {@link usdcToNative} / {@link nativeToUsdc}, which make the lossy direction
 * loud instead of silent.
 */

export const USDC_DECIMALS = 6 as const;
export const ARC_NATIVE_DECIMALS = 18 as const;

/** 1e12 — the factor between the 6dp token rail and the 18dp gas rail. */
export const USDC_TO_NATIVE_SCALE = 10n ** BigInt(ARC_NATIVE_DECIMALS - USDC_DECIMALS);

export const MAX_UINT32 = 4_294_967_295;
export const MAX_UINT128 = 2n ** 128n - 1n;

const Q64_SHIFT = 64n;
const Q64_ONE = 1n << Q64_SHIFT;
const Q64_MASK = Q64_ONE - 1n;

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Assert `n` fits the uint32 the contracts store bps in. Returns `n`. */
export function assertUint32(n: number): number {
  if (!Number.isFinite(n)) throw new RangeError(`expected a finite integer, got ${n}`);
  if (!Number.isInteger(n)) throw new RangeError(`expected an integer, got ${n}`);
  if (n < 0 || n > MAX_UINT32) throw new RangeError(`value ${n} does not fit uint32`);
  return n;
}

/** Assert `n` fits the uint128 that `VenueState.deployedAssets` uses. Returns `n`. */
export function assertUint128(n: bigint): bigint {
  if (n < 0n || n > MAX_UINT128) throw new RangeError(`value ${n} does not fit uint128`);
  return n;
}

// ---------------------------------------------------------------------------
// The 6-vs-18 boundary
// ---------------------------------------------------------------------------

/**
 * Widen a 6dp USDC amount to the 18dp native gas rail. Always exact.
 * @throws if the result would not fit uint128.
 */
export function usdcToNative(units: bigint): bigint {
  if (units < 0n) throw new RangeError(`negative USDC amount: ${units}`);
  return assertUint128(units * USDC_TO_NATIVE_SCALE);
}

/**
 * Narrow an 18dp native amount to the 6dp USDC rail.
 *
 * This direction is lossy: anything below 1e12 wei has no representation in
 * the token interface. The remainder is returned as `dust` rather than
 * discarded, so callers must decide explicitly whether to round it away.
 */
export function nativeToUsdc(wei: bigint): { units: bigint; dust: bigint } {
  if (wei < 0n) throw new RangeError(`negative native amount: ${wei}`);
  return { units: wei / USDC_TO_NATIVE_SCALE, dust: wei % USDC_TO_NATIVE_SCALE };
}

/**
 * Narrow to the 6dp rail, refusing to lose anything.
 * @throws if the native amount is not an exact multiple of 1e12 wei.
 */
export function nativeToUsdcExact(wei: bigint): bigint {
  const { units, dust } = nativeToUsdc(wei);
  if (dust !== 0n) {
    throw new RangeError(
      `native amount ${wei} has ${dust} wei of dust and cannot be expressed exactly in ${USDC_DECIMALS}dp USDC`,
    );
  }
  return units;
}

// ---------------------------------------------------------------------------
// Decimal strings
// ---------------------------------------------------------------------------

const DECIMAL_RE = /^(\d+)(?:\.(\d*))?$/;

function parseDecimal(input: string, decimals: number, label: string): bigint {
  const s = input.trim();
  if (s.startsWith('-')) throw new RangeError(`negative ${label} amount: ${input}`);
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new SyntaxError(`invalid ${label} amount: ${JSON.stringify(input)}`);
  const whole = m[1] ?? '0';
  const frac = m[2] ?? '';
  if (frac.length > decimals) {
    throw new RangeError(
      `${label} amount ${input} has ${frac.length} decimal places; the interface carries ${decimals} — refusing to truncate (precision loss)`,
    );
  }
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

function formatDecimal(units: bigint, decimals: number): string {
  if (units < 0n) throw new RangeError(`negative amount: ${units}`);
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** Parse a human decimal string into 6dp USDC units. Throws on excess precision. */
export const parseUsdc = (input: string): bigint => parseDecimal(input, USDC_DECIMALS, 'USDC');

/** Render 6dp USDC units as a human decimal string, trailing zeros trimmed. */
export const formatUsdc = (units: bigint): string => formatDecimal(units, USDC_DECIMALS);

/** Parse a human decimal string into 18dp Arc native units (wei). */
export const parseNative = (input: string): bigint =>
  parseDecimal(input, ARC_NATIVE_DECIMALS, 'native');

/** Render 18dp Arc native units as a human decimal string. */
export const formatNative = (wei: bigint): string => formatDecimal(wei, ARC_NATIVE_DECIMALS);

// ---------------------------------------------------------------------------
// Basis points
// ---------------------------------------------------------------------------

/**
 * Convert a fractional rate to basis points, rounded to nearest.
 * `0.03 -> 300`. A 900% APR is `90_000`, which is why bps needs uint32 and not
 * uint16: yields in thin pools routinely exceed 655%.
 */
export function rateToBps(rate: number): number {
  if (!Number.isFinite(rate)) throw new RangeError(`expected a finite rate, got ${rate}`);
  if (rate < 0) throw new RangeError(`negative rate: ${rate}`);
  return assertUint32(Math.round(rate * 10_000));
}

/** Convert basis points back to a fractional rate. `300 -> 0.03`. */
export function bpsToRate(bps: number): number {
  return assertUint32(bps) / 10_000;
}

// ---------------------------------------------------------------------------
// Q64.64
// ---------------------------------------------------------------------------

/**
 * Encode a price as Q64.64. The fraction carries 53 bits — everything a
 * double has — so this is lossless with respect to its input.
 */
export function toQ64_64(x: number): bigint {
  if (!Number.isFinite(x)) throw new RangeError(`expected a finite price, got ${x}`);
  if (x < 0) throw new RangeError(`negative price: ${x}`);
  const whole = Math.floor(x);
  const frac = x - whole;
  const q = (BigInt(whole) << Q64_SHIFT) | (BigInt(Math.round(frac * 2 ** 53)) << 11n);
  return assertUint128(q);
}

/** Decode a Q64.64 price back to a double. */
export function fromQ64_64(q: bigint): number {
  assertUint128(q);
  return Number(q >> Q64_SHIFT) + Number(q & Q64_MASK) / 2 ** 64;
}
