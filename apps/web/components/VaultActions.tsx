'use client';

import { useState } from 'react';
import { ArrowRight, Check, Loader2 } from 'lucide-react';
import type { Address, Hash } from 'viem';

import { CONTRACTS, USDC_ABI, VAULT_ABI, explorerTx } from '@/lib/chain';
import { publicClient, useWallet } from '@/lib/wallet';
import {
  claimReadiness,
  depositReadiness,
  encodeRequestId,
  formatShares,
  formatUsdc,
  parseShares,
  parseUsdc,
  refusalFromError,
  requestReadiness,
  usdc as fmtUsdc,
  type Refusal,
} from '@/lib/vault';
import type { VaultData } from '@/lib/useVaultData';

type Props = { data: VaultData; address: Address; onDone: () => void };

type Step = { label: string; hash?: Hash };

/**
 * Every action runs the same three beats: decide locally, simulate against the
 * node, then send. The middle beat is what makes the first one honest — the
 * local predicates mirror `LPVault` but can drift, and a simulation cannot.
 *
 * `send` is a closure rather than a description of a call, so each caller keeps
 * viem's ABI inference. Passing `{abi, functionName, args}` through a shared
 * signature would erase it, and the argument types on these calls are the thing
 * most worth having checked.
 */
function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const run = async (label: string, send: () => Promise<Hash>) => {
    setBusy(true);
    setRefusal(null);
    try {
      const hash = await send();
      setSteps((s) => [...s, { label, hash }]);
      await publicClient.waitForTransactionReceipt({ hash });
      onDone();
    } catch (cause) {
      setRefusal(
        refusalFromError(cause) ?? {
          code: 'Unknown',
          title: 'The transaction did not go through',
          detail: (cause as Error).message?.split('\n')[0] ?? 'No reason was returned.',
        },
      );
      throw cause;
    } finally {
      setBusy(false);
    }
  };

  return { busy, steps, refusal, run };
}

function Blocked({ reason }: { reason: Refusal }) {
  return (
    <div
      role="status"
      className="mt-3 rounded border border-warning/40 bg-warning/5 p-3 text-sm"
    >
      <p className="font-medium text-warning">{reason.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{reason.detail}</p>
    </div>
  );
}

function Receipts({ steps }: { steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1">
      {steps.map((step) => (
        <li key={step.hash} className="flex items-center gap-2 text-xs text-muted-foreground">
          <Check className="h-3.5 w-3.5 text-success" aria-hidden />
          <span>{step.label}</span>
          {step.hash && (
            <a
              href={explorerTx(step.hash)}
              target="_blank"
              rel="noreferrer"
              className="tabular underline decoration-border underline-offset-4 hover:text-foreground"
            >
              {step.hash.slice(0, 10)}…
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

const FIELD =
  'tabular min-h-11 w-full rounded border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
const BUTTON =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none';

export function DepositCard({ data, address, onDone }: Props) {
  const [input, setInput] = useState('');
  const { busy, steps, refusal, run } = useAction(onDone);
  const { walletClient } = useWallet();

  let amount = 0n;
  let parseError: string | null = null;
  try {
    amount = parseUsdc(input);
  } catch (cause) {
    parseError = (cause as Error).message;
  }

  const holder = data.holder!;
  const readiness = depositReadiness(data.vault, holder, amount);

  const deposit = async () => {
    const account = walletClient?.account;
    if (!account || !walletClient) return;

    // Two transactions when an allowance is needed, and the second is only
    // attempted if the first lands — `run` rethrows so this short-circuits.
    if (readiness.needsApproval) {
      await run('Approved the vault to move USDC', async () => {
        const { request } = await publicClient.simulateContract({
          address: CONTRACTS.usdc as Address,
          abi: USDC_ABI,
          functionName: 'approve',
          args: [CONTRACTS.vault as Address, amount],
          account,
        });
        return walletClient.writeContract(request);
      });
    }

    await run(`Deposited ${formatUsdc(amount)} USDC`, async () => {
      const { request } = await publicClient.simulateContract({
        address: CONTRACTS.vault as Address,
        abi: VAULT_ABI,
        functionName: 'deposit',
        args: [amount, address],
        account,
      });
      return walletClient.writeContract(request);
    });
  };

  return (
    <section className="rounded border border-border bg-card p-5">
      <h3 className="text-sm font-semibold">Deposit</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        You hold {fmtUsdc(holder.usdcBalance)} USDC. Arc pays gas in USDC too, so a deposit and its
        fee come out of the same balance.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="deposit-amount">
          Amount in USDC
        </label>
        <input
          id="deposit-amount"
          className={FIELD}
          inputMode="decimal"
          placeholder="0.00"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          type="button"
          className={BUTTON}
          disabled={busy || !readiness.ok || parseError !== null}
          onClick={() => void deposit().catch(() => {})}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {readiness.needsApproval ? 'Approve & deposit' : 'Deposit'}
        </button>
      </div>

      {parseError && (
        <Blocked reason={{ code: 'Precision', title: 'Too many decimals', detail: parseError }} />
      )}
      {!parseError && amount > 0n && readiness.reason && <Blocked reason={readiness.reason} />}
      {refusal && <Blocked reason={refusal} />}
      <Receipts steps={steps} />
    </section>
  );
}

export function RequestCard({ data, onDone }: Props) {
  const [input, setInput] = useState('');
  const { busy, steps, refusal, run } = useAction(onDone);
  const { walletClient } = useWallet();

  let shares = 0n;
  let parseError: string | null = null;
  try {
    shares = parseShares(input);
  } catch (cause) {
    parseError = (cause as Error).message;
  }

  const holder = data.holder!;
  const readiness = requestReadiness(data.vault, holder, shares);

  return (
    <section className="rounded border border-border bg-card p-5">
      <h3 className="text-sm font-semibold">Request withdrawal</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        You hold {formatShares(holder.shares)} spUSDC. Requesting burns them now and fixes your
        payout at today&apos;s price — you stop earning at that moment and are insulated from later
        moves. It becomes collectable once the operator settles epoch {data.vault.epoch}.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="request-shares">
          Shares to redeem
        </label>
        <input
          id="request-shares"
          className={FIELD}
          inputMode="decimal"
          placeholder="0.000000000"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          type="button"
          className="inline-flex min-h-11 items-center rounded border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onClick={() => setInput(formatShares(holder.shares))}
        >
          Max
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={busy || !readiness.ok || parseError !== null}
          onClick={() =>
            void run(`Requested ${formatShares(shares)} spUSDC`, async () => {
              const account = walletClient!.account!;
              const { request } = await publicClient.simulateContract({
                address: CONTRACTS.vault as Address,
                abi: VAULT_ABI,
                functionName: 'requestWithdraw',
                args: [shares],
                account,
              });
              return walletClient!.writeContract(request);
            }).catch(() => {})
          }
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          Request
        </button>
      </div>

      {parseError && (
        <Blocked reason={{ code: 'Precision', title: 'Too many decimals', detail: parseError }} />
      )}
      {!parseError && shares > 0n && readiness.reason && <Blocked reason={readiness.reason} />}
      {refusal && <Blocked reason={refusal} />}
      <Receipts steps={steps} />
    </section>
  );
}

export function ClaimCard({ data, address, onDone }: Props) {
  const { busy, steps, refusal, run } = useAction(onDone);
  const { walletClient } = useWallet();
  const holder = data.holder!;
  const readiness = claimReadiness(data.vault, holder, data.now);

  if (holder.pendingAssets === 0n) return null;

  const requestId = encodeRequestId(address, holder.pendingEpoch);

  return (
    <section className="rounded border border-border bg-card p-5">
      <h3 className="text-sm font-semibold">Claim</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        {fmtUsdc(holder.pendingAssets)} queued in epoch {holder.pendingEpoch}.
      </p>

      {readiness.haircutBps > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-warning">
          Coverage is {(10_000 - readiness.haircutBps) / 100}%, so this pays{' '}
          {fmtUsdc(readiness.payout)} rather than the full {fmtUsdc(holder.pendingAssets)}. The
          shortfall is shared across everyone in the queue instead of landing on whoever claims
          last.
        </p>
      )}

      <button
        type="button"
        className={`${BUTTON} mt-4`}
        disabled={busy || !readiness.ok}
        onClick={() =>
          void run(`Claimed ${formatUsdc(readiness.payout)} USDC`, async () => {
            const account = walletClient!.account!;
            const { request } = await publicClient.simulateContract({
              address: CONTRACTS.vault as Address,
              abi: VAULT_ABI,
              functionName: 'claimWithdraw',
              args: [requestId],
              account,
            });
            return walletClient!.writeContract(request);
          }).catch(() => {})
        }
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        Claim {fmtUsdc(readiness.payout)}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </button>

      {readiness.reason && <Blocked reason={readiness.reason} />}
      {refusal && <Blocked reason={refusal} />}
      <Receipts steps={steps} />
    </section>
  );
}
