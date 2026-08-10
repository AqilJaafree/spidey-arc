/**
 * The vault's rules, mirrored off-chain so the page can refuse before the
 * wallet is ever asked to sign.
 *
 * Every function here restates something `LPVault` already enforces. That
 * duplication is deliberate and is the point of the module: a revert reaches
 * the user as an opaque hex blob after they have approved a transaction and
 * spent gas, whereas the same rule evaluated here reaches them as a sentence
 * before they commit to anything. It is the exclusion table's discipline
 * applied to transactions — name the reason, never approximate it.
 *
 * The duplication has one hazard, and it is worth stating plainly: these
 * predicates can drift from the contract. They are therefore written to mirror
 * `LPVault` clause by clause rather than to be independently clever, and the
 * tests quote the contract's own ordering. The chain remains the authority;
 * this is a courtesy, and every action is still simulated against the node
 * before it is sent.
 */

import { formatUnits, getAddress, parseUnits } from 'viem';

/** USDC through the ERC-20 shim. */
export const USDC_DECIMALS = 6;

/**
 * `spUSDC`.
 *
 * ERC-4626 reports `asset decimals + _decimalsOffset()`, and `LPVault` uses a
 * 3-place offset for OZ's virtual-share mitigation — so 9, not 6. The live
 * vault's 1e9 shares against ~1 USDC of equity is the arithmetic in the open.
 */
export const SHARE_DECIMALS = 9;

const BPS = 10_000n;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Everything the panel reads from `LPVault` that is not per-holder. */
export type VaultState = {
  totalAssets: bigint;
  idle: bigint;
  deployed: bigint;
  /** Aggregate owed to withdrawal requesters. */
  pending: bigint;
  coverageBps: number;
  epoch: number;
  lastSettledEpoch: number;
  depositCap: bigint;
  navUpdatedAt: bigint;
  maxNavAge: bigint;
};

export type HolderState = {
  shares: bigint;
  usdcBalance: bigint;
  /** Allowance granted to the vault on the USDC shim. */
  allowance: bigint;
  pendingAssets: bigint;
  pendingEpoch: number;
};

/** A refusal, in the terms the person reading it can act on. */
export type Refusal = { code: string; title: string; detail: string };

export type Readiness = {
  ok: boolean;
  reason?: Refusal;
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Trailing zeros dropped: `1.5`, not `1.500000`. */
function trim(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

export function formatUsdc(value: bigint): string {
  return trim(formatUnits(value, USDC_DECIMALS));
}

export function formatShares(value: bigint): string {
  return trim(formatUnits(value, SHARE_DECIMALS));
}

/** `$1,234.56`, for figures being read rather than re-entered. */
export function usdc(value: bigint): string {
  const n = Number(formatUnits(value, USDC_DECIMALS));
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

/**
 * A typed amount as USDC base units.
 *
 * Throws rather than truncating on excess precision. Silently dropping a digit
 * would mean the number the user typed and the number that gets sent differ,
 * which is exactly the class of surprise this page exists to avoid.
 */
export function parseUsdc(input: string): bigint {
  const text = input.trim();
  if (text === '') return 0n;
  const decimals = text.split('.')[1]?.length ?? 0;
  if (decimals > USDC_DECIMALS) {
    throw new RangeError(`USDC has six decimal places; "${text}" asks for ${decimals}`);
  }
  return parseUnits(text, USDC_DECIMALS);
}

export function parseShares(input: string): bigint {
  const text = input.trim();
  if (text === '') return 0n;
  const decimals = text.split('.')[1]?.length ?? 0;
  if (decimals > SHARE_DECIMALS) {
    throw new RangeError(`shares have nine decimal places; "${text}" asks for ${decimals}`);
  }
  return parseUnits(text, SHARE_DECIMALS);
}

/** `4 days`, `6 hours`, `12 minutes` — for ages that are being judged. */
export function humanDuration(seconds: bigint): string {
  const s = seconds < 0n ? 0n : seconds;
  const units: [bigint, string][] = [
    [86_400n, 'day'],
    [3_600n, 'hour'],
    [60n, 'minute'],
  ];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = s / size;
      return `${n} ${name}${n === 1n ? '' : 's'}`;
    }
  }
  return `${s} second${s === 1n ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Request ids
// ---------------------------------------------------------------------------

/**
 * `LPVault.encodeRequestId`, restated.
 *
 * The contract derives this rather than storing it, so the UI has to build the
 * same number to claim. `(uint160(holder) << 16) | epoch`.
 */
export function encodeRequestId(holder: string, epoch: number): bigint {
  return (BigInt(getAddress(holder)) << 16n) | BigInt(epoch);
}

export function decodeRequestId(id: bigint): { holder: string; epoch: number } {
  const holder = getAddress(`0x${(id >> 16n).toString(16).padStart(40, '0')}`);
  return { holder, epoch: Number(id & 0xffffn) };
}

// ---------------------------------------------------------------------------
// Deposit
// ---------------------------------------------------------------------------

export type DepositReadiness = Readiness & { needsApproval: boolean };

export function depositReadiness(
  vault: VaultState,
  holder: HolderState,
  amount: bigint,
): DepositReadiness {
  const needsApproval = holder.allowance < amount;

  if (amount <= 0n) {
    return {
      ok: false,
      needsApproval: false,
      reason: {
        code: 'ZeroAmount',
        title: 'Enter an amount',
        detail: 'A deposit of nothing mints no shares, and the vault rejects it.',
      },
    };
  }

  if (amount > holder.usdcBalance) {
    return {
      ok: false,
      needsApproval,
      reason: {
        code: 'InsufficientBalance',
        title: 'More than your balance',
        detail: `You hold ${usdc(holder.usdcBalance)} and are trying to deposit ${usdc(amount)}.`,
      },
    };
  }

  // Mirrors LPVault.deposit: the cap is checked against total assets plus the
  // incoming amount, not against the amount alone.
  const after = vault.totalAssets + amount;
  if (after > vault.depositCap) {
    const headroom = vault.depositCap > vault.totalAssets ? vault.depositCap - vault.totalAssets : 0n;
    return {
      ok: false,
      needsApproval,
      reason: {
        code: 'DepositCapExceeded',
        title: 'Over the deposit cap',
        detail:
          `The vault caps total assets at ${usdc(vault.depositCap)} and holds ` +
          `${usdc(vault.totalAssets)}, so it can take ${usdc(headroom)} more. The cap exists so ` +
          `the vault does not become the dilution problem it is built to detect.`,
      },
    };
  }

  return { ok: true, needsApproval };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export function requestReadiness(
  vault: VaultState,
  holder: HolderState,
  shares: bigint,
): Readiness {
  if (shares <= 0n) {
    return {
      ok: false,
      reason: {
        code: 'ZeroShares',
        title: 'Enter an amount',
        detail: 'Requesting zero shares would burn nothing and queue nothing.',
      },
    };
  }

  if (shares > holder.shares) {
    return {
      ok: false,
      reason: {
        code: 'InsufficientShares',
        title: 'More shares than you hold',
        detail: `You hold ${formatShares(holder.shares)} spUSDC.`,
      },
    };
  }

  // LPVault refuses a new request while a settled one from an earlier epoch is
  // unclaimed: merging across epochs would move money between settlement
  // batches, and overwriting would lose a claim outright.
  if (holder.pendingAssets > 0n && holder.pendingEpoch !== vault.epoch) {
    return {
      ok: false,
      reason: {
        code: 'ClaimPendingFirst',
        title: 'Claim your settled withdrawal first',
        detail:
          `You have ${usdc(holder.pendingAssets)} waiting from epoch ${holder.pendingEpoch}, and ` +
          `the vault is now on epoch ${vault.epoch}. A holder has one outstanding request at a ` +
          `time, so that one has to be collected before another is made.`,
      },
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export type ClaimReadiness = Readiness & {
  /** What the claim would actually pay, after any haircut. */
  payout: bigint;
  /** 0 when fully covered. */
  haircutBps: number;
};

/**
 * `LPVault.claimWithdraw`, clause by clause and in its order.
 *
 * The ordering matters as much as the clauses: coverage is only consulted when
 * idle falls short of the queue, and the mark's age is only consulted inside
 * that branch. Evaluating them unconditionally would report a stale-NAV block
 * on a vault that is paying claims perfectly well.
 */
export function claimReadiness(
  vault: VaultState,
  holder: HolderState,
  now: bigint,
): ClaimReadiness {
  const owed = holder.pendingAssets;

  if (owed <= 0n) {
    return {
      ok: false,
      payout: 0n,
      haircutBps: 0,
      reason: {
        code: 'NothingToClaim',
        title: 'Nothing queued',
        detail: 'You have no outstanding withdrawal request.',
      },
    };
  }

  if (holder.pendingEpoch > vault.lastSettledEpoch) {
    return {
      ok: false,
      payout: 0n,
      haircutBps: 0,
      reason: {
        code: 'EpochNotSettled',
        title: `Epoch ${holder.pendingEpoch} is still open`,
        detail:
          `Withdrawals are asynchronous by design — capital in a position on another chain ` +
          `cannot be returned in the same transaction. The operator closes the epoch once that ` +
          `capital is back on Arc, and the claim becomes collectable then.`,
      },
    };
  }

  let coverage = BPS;

  if (vault.idle < vault.pending) {
    // Nothing deployed means nothing unverified, so age cannot matter — and
    // blocking here would strand the queue after a full write-off.
    if (vault.deployed !== 0n) {
      const age = now - vault.navUpdatedAt;
      if (age > vault.maxNavAge) {
        return {
          ok: false,
          payout: 0n,
          haircutBps: 0,
          reason: {
            code: 'NavStale',
            title: 'The mark is too old to pay against',
            detail:
              `The vault holds less idle USDC than it owes, so what it can cover depends on the ` +
              `reported value of capital still deployed — and that mark was last updated ` +
              `${humanDuration(age)} ago, past the ${humanDuration(vault.maxNavAge)} bound. ` +
              `Paying at par out of an unrefreshed number would hand a loss nobody has marked ` +
              `to whoever claims last, so the vault holds instead. A fresh NAV report clears it.`,
          },
        };
      }
    }

    const available = vault.idle + vault.deployed;
    coverage = available >= vault.pending ? BPS : (available * BPS) / vault.pending;
  }

  const payout = coverage === BPS ? owed : (owed * coverage) / BPS;

  if (vault.idle < payout) {
    return {
      ok: false,
      payout,
      haircutBps: Number(BPS - coverage),
      reason: {
        code: 'InsufficientIdle',
        title: 'The vault cannot cover this yet',
        detail:
          `The claim is ${usdc(payout)} against ${usdc(vault.idle)} idle. Capital a venue still ` +
          `carries on its book counts toward coverage, so no haircut applies — but book value is ` +
          `not cash, and only cash pays a claim. Either the capital returns, or the residual is ` +
          `written off so the haircut can do its job.`,
      },
    };
  }

  return { ok: true, payout, haircutBps: Number(BPS - coverage) };
}

// ---------------------------------------------------------------------------
// Reverts
// ---------------------------------------------------------------------------

const REFUSALS: Record<string, (args: readonly unknown[]) => Omit<Refusal, 'code'>> = {
  SynchronousRedemptionDisabled: () => ({
    title: 'Instant withdrawal is disabled',
    detail:
      'Capital sitting in a position on another chain cannot be redeemed in the same ' +
      'transaction. Rather than pretend otherwise, the vault routes every exit through ' +
      'request and claim.',
  }),
  DepositCapExceeded: (args) => ({
    title: 'Over the deposit cap',
    detail: `That would take the vault to ${usdc(args[0] as bigint)} against a cap of ${usdc(
      args[1] as bigint,
    )}.`,
  }),
  ZeroShares: () => ({
    title: 'Too small to mint a share',
    detail: 'The amount rounds to zero shares at the current price.',
  }),
  ClaimPendingFirst: (args) => ({
    title: 'Claim your settled withdrawal first',
    detail: `A request from epoch ${args[0]} is unclaimed and the vault is on epoch ${args[1]}.`,
  }),
  EpochNotSettled: (args) => ({
    title: `Epoch ${args[0]} is still open`,
    detail: `The operator has settled up to epoch ${args[1]}. Yours becomes claimable after that.`,
  }),
  NothingToClaim: () => ({
    title: 'Nothing queued',
    detail: 'This address has no outstanding withdrawal request.',
  }),
  NotRequestOwner: () => ({
    title: 'Not your request',
    detail: 'A request can only be claimed by the address that made it.',
  }),
  NavStale: (args) => ({
    title: 'The mark is too old to pay against',
    detail:
      `Deployed capital was last marked ${humanDuration(BigInt(args[1] as bigint))} ago at most, ` +
      'and the vault refuses to pay a shortfall out of a number nobody has refreshed. A fresh ' +
      'NAV report clears it.',
  }),
  InsufficientIdle: (args) => ({
    title: 'The vault cannot cover this yet',
    detail: `The claim asks ${usdc(args[0] as bigint)} against ${usdc(args[1] as bigint)} idle.`,
  }),
  NavCooldown: () => ({
    title: 'Too soon after the last report',
    detail: 'NAV can be reported at most once an hour.',
  }),
  AmountTooLarge: () => ({
    title: 'Amount out of range',
    detail: 'The request exceeds what a single withdrawal record can hold.',
  }),
  ERC20InsufficientAllowance: () => ({
    title: 'Approval needed',
    detail: 'The vault has not been approved to move this much USDC yet.',
  }),
  ERC20InsufficientBalance: () => ({
    title: 'Not enough USDC',
    detail: 'The wallet does not hold the amount being deposited.',
  }),
};

/**
 * A contract error as a sentence.
 *
 * Unmapped names fall back to the raw name rather than to a guess. An
 * invented explanation for an error nobody anticipated is worse than an
 * unfamiliar word, because it cannot be checked against the source.
 */
export function explainRefusal(name: string, args: readonly unknown[]): Refusal {
  const build = REFUSALS[name];
  if (!build) {
    return {
      code: name,
      title: `The vault refused: ${name}`,
      detail:
        'This refusal has no plain-language mapping yet. The name is the contract error ' +
        'verbatim, so it can be looked up in the source.',
    };
  }
  return { code: name, ...build(args) };
}

/** Walk a viem error chain for a decoded custom error. */
export function refusalFromError(error: unknown): Refusal | null {
  let cursor: unknown = error;
  const seen = new Set<unknown>();

  while (cursor && typeof cursor === 'object' && !seen.has(cursor)) {
    seen.add(cursor);
    const node = cursor as { data?: { errorName?: string; args?: readonly unknown[] }; cause?: unknown };
    const name = node.data?.errorName;
    if (typeof name === 'string') return explainRefusal(name, node.data?.args ?? []);
    cursor = node.cause;
  }
  return null;
}
