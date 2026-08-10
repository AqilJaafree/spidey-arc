'use client';

import { useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

import { ClaimCard, DepositCard, RequestCard } from '@/components/VaultActions';
import { SiteHeader } from '@/components/SiteHeader';
import { ARC_TESTNET, CONTRACTS, explorerAddress } from '@/lib/chain';
import { useVaultData } from '@/lib/useVaultData';
import { formatShares, humanDuration, usdc } from '@/lib/vault';
import { useWallet } from '@/lib/wallet';

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5 text-lg">{value}</dd>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

export default function VaultPage() {
  const { address, onArc } = useWallet();
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, error, loading } = useVaultData(address && onArc ? address : null, refreshKey);

  const reload = () => setRefreshKey((k) => k + 1);

  const navAge = data ? data.now - data.vault.navUpdatedAt : 0n;
  const navExpired = data ? navAge > data.vault.maxNavAge : false;

  return (
    <>
      <SiteHeader />

      <main className="mx-auto max-w-4xl px-4 py-10 md:px-6 lg:px-8">
        <section className="mb-10 max-w-2xl space-y-3">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight text-balance md:text-4xl">
            The vault, on Arc
          </h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            An ERC-4626 vault over USDC. Deposits mint spUSDC; exits go through a queue, because
            capital sitting in a position on another chain cannot be returned in the same
            transaction. Every action below is simulated against the chain before your wallet is
            asked to sign, so a refusal arrives as a sentence rather than as a failed transaction.
          </p>
          <p className="text-xs text-muted-foreground">
            {ARC_TESTNET.name} · chain {ARC_TESTNET.id} ·{' '}
            <a
              href={explorerAddress(CONTRACTS.vault)}
              target="_blank"
              rel="noreferrer"
              className="tabular underline decoration-border underline-offset-4 hover:text-foreground"
            >
              {CONTRACTS.vault}
            </a>
          </p>
        </section>

        {error && (
          <div
            role="alert"
            className="mb-6 flex items-start gap-3 rounded border border-destructive/40 bg-destructive/5 p-5"
          >
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
            <div className="flex-1">
              <p className="font-medium">Could not read the vault</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{error}</p>
            </div>
            <button
              type="button"
              onClick={reload}
              className="inline-flex min-h-11 items-center gap-2 rounded border border-border px-4 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Retry
            </button>
          </div>
        )}

        {loading && !data && (
          <div className="h-40 animate-pulse rounded border border-border bg-muted/40" />
        )}

        {data && (
          <>
            <section className="mb-8 rounded border border-border bg-card p-6">
              <h2 className="mb-4 text-sm font-semibold">Vault state</h2>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                <Figure label="Total assets" value={usdc(data.vault.totalAssets)} />
                <Figure
                  label="Idle"
                  value={usdc(data.vault.idle)}
                  note="on Arc, available now"
                />
                <Figure
                  label="Deployed"
                  value={usdc(data.vault.deployed)}
                  note="reported, at venues"
                />
                <Figure
                  label="Coverage"
                  value={`${data.vault.coverageBps / 100}%`}
                  note={data.vault.coverageBps === 10_000 ? 'claims paid in full' : 'claims haircut'}
                />
                <Figure label="Queued" value={usdc(data.vault.pending)} note="owed to requesters" />
                <Figure
                  label="Epoch"
                  value={`${data.vault.epoch}`}
                  note={`settled through ${data.vault.lastSettledEpoch}`}
                />
                <Figure label="Deposit cap" value={usdc(data.vault.depositCap)} />
                <Figure
                  label="Mark age"
                  value={humanDuration(navAge)}
                  note={`bound ${humanDuration(data.vault.maxNavAge)}`}
                />
              </dl>

              {navExpired && data.vault.deployed > 0n && (
                <p className="mt-5 border-t border-border pt-4 text-xs leading-relaxed text-warning">
                  The mark on deployed capital is older than the {humanDuration(data.vault.maxNavAge)}{' '}
                  bound. While idle covers everything queued this changes nothing — but a claim
                  larger than idle will be refused rather than paid at par out of a number nobody
                  has refreshed. A NAV report clears it.
                </p>
              )}
            </section>

            {!address && (
              <p className="rounded border border-border bg-muted/30 p-5 text-sm text-muted-foreground">
                Connect a wallet to deposit or withdraw. The figures above are read from the chain
                and need no connection.
              </p>
            )}

            {address && !onArc && (
              <p className="rounded border border-warning/40 bg-warning/5 p-5 text-sm text-warning">
                Your wallet is on another chain. Switch to {ARC_TESTNET.name} using the button in
                the header — no wallet ships Arc by default, so it will offer to add it first.
              </p>
            )}

            {address && onArc && data.holder && (
              <>
                <section className="mb-8 rounded border border-border bg-card p-6">
                  <h2 className="mb-4 text-sm font-semibold">Your position</h2>
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
                    <Figure
                      label="Shares"
                      value={formatShares(data.holder.shares)}
                      note="spUSDC, 9 decimals"
                    />
                    <Figure label="Wallet USDC" value={usdc(data.holder.usdcBalance)} />
                    <Figure
                      label="Queued"
                      value={usdc(data.holder.pendingAssets)}
                      note={
                        data.holder.pendingAssets > 0n
                          ? `epoch ${data.holder.pendingEpoch}`
                          : 'nothing pending'
                      }
                    />
                  </dl>
                </section>

                <div className="space-y-4">
                  <DepositCard data={data} address={address} onDone={reload} />
                  <RequestCard data={data} address={address} onDone={reload} />
                  <ClaimCard data={data} address={address} onDone={reload} />
                </div>
              </>
            )}
          </>
        )}
      </main>

      <footer className="mt-12 border-t border-border bg-muted/30">
        <div className="mx-auto max-w-4xl px-4 py-8 md:px-6 lg:px-8">
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Shares are ERC-4626 at nine decimals — six from USDC plus a three-place virtual-share
            offset that blocks the first-depositor inflation attack. Arc&apos;s native gas token is
            USDC at eighteen decimals over the same balance the vault reads at six.
          </p>
        </div>
      </footer>
    </>
  );
}
