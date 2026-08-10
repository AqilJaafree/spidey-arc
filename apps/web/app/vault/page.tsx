'use client';

import { useCallback, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

import { CrossChainFlow } from '@/components/CrossChainFlow';
import { ClaimCard, DepositCard, RequestCard } from '@/components/VaultActions';
import { SiteHeader } from '@/components/SiteHeader';
import { AnimatedContent } from '@/components/motion/AnimatedContent';
import { CountUp } from '@/components/motion/CountUp';
import { ARC_TESTNET, CONTRACTS, explorerAddress } from '@/lib/chain';
import { useVaultData } from '@/lib/useVaultData';
import { formatShares, humanDuration } from '@/lib/vault';
import { useWallet } from '@/lib/wallet';

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

function Figure({ label, value, note }: { label: string; value: bigint; note?: string }) {
  const asNumber = useCallback(() => Number(value) / 1e6, [value])();
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5 text-lg">
        <CountUp value={asNumber} format={money} />
      </dd>
      {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function Plain({ label, value, note }: { label: string; value: string; note?: string }) {
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
        <section className="mb-8 max-w-2xl space-y-3">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight text-balance md:text-4xl">
            The vault, on Arc
          </h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            ERC-4626 over USDC. Exits go through a queue — capital in a position on another chain
            cannot come back in the same transaction.
          </p>
          <p className="text-xs text-muted-foreground">
            chain {ARC_TESTNET.id} ·{' '}
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
          <div className="space-y-4">
            <AnimatedContent>
              <section className="rounded border border-border bg-card p-6">
                <h2 className="mb-4 text-sm font-semibold">Vault state</h2>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                  <Figure label="Total assets" value={data.vault.totalAssets} />
                  <Figure label="Idle" value={data.vault.idle} note="on Arc" />
                  <Figure label="Deployed" value={data.vault.deployed} note="reported" />
                  <Plain
                    label="Coverage"
                    value={`${data.vault.coverageBps / 100}%`}
                    note={data.vault.coverageBps === 10_000 ? 'paid in full' : 'haircut'}
                  />
                  <Figure label="Queued" value={data.vault.pending} note="owed out" />
                  <Plain
                    label="Epoch"
                    value={`${data.vault.epoch}`}
                    note={`settled to ${data.vault.lastSettledEpoch}`}
                  />
                  <Figure label="Deposit cap" value={data.vault.depositCap} />
                  <Plain
                    label="Mark age"
                    value={humanDuration(navAge)}
                    note={`bound ${humanDuration(data.vault.maxNavAge)}`}
                  />
                </dl>

                {navExpired && data.vault.deployed > 0n && (
                  <p className="mt-5 border-t border-border pt-4 text-xs leading-relaxed text-warning">
                    The mark is past its {humanDuration(data.vault.maxNavAge)} bound. Harmless
                    while idle covers the queue; a larger claim will be refused. A NAV report
                    clears it.
                  </p>
                )}
              </section>
            </AnimatedContent>

            <AnimatedContent delay={0.06}>
              <CrossChainFlow routes={data.routes} hubAssets={data.vault.totalAssets} />
            </AnimatedContent>

            {!address && (
              <AnimatedContent delay={0.12}>
                <p className="rounded border border-border bg-muted/30 p-5 text-sm text-muted-foreground">
                  Connect a wallet to deposit or withdraw. Everything above is read from the chain.
                </p>
              </AnimatedContent>
            )}

            {address && !onArc && (
              <AnimatedContent delay={0.12}>
                <p className="rounded border border-warning/40 bg-warning/5 p-5 text-sm text-warning">
                  Wrong chain. Switch in the header — no wallet ships Arc, so it will offer to add
                  it first.
                </p>
              </AnimatedContent>
            )}

            {address && onArc && data.holder && (
              <>
                <AnimatedContent delay={0.12}>
                  <section className="rounded border border-border bg-card p-6">
                    <h2 className="mb-4 text-sm font-semibold">Your position</h2>
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
                      <Plain
                        label="Shares"
                        value={formatShares(data.holder.shares)}
                        note="spUSDC · 9 dp"
                      />
                      <Figure label="Wallet" value={data.holder.usdcBalance} note="USDC · 6 dp" />
                      <Figure
                        label="Queued"
                        value={data.holder.pendingAssets}
                        note={
                          data.holder.pendingAssets > 0n
                            ? `epoch ${data.holder.pendingEpoch}`
                            : 'nothing pending'
                        }
                      />
                    </dl>
                  </section>
                </AnimatedContent>

                <AnimatedContent delay={0.18}>
                  <DepositCard data={data} address={address} onDone={reload} />
                </AnimatedContent>
                <AnimatedContent delay={0.24}>
                  <RequestCard data={data} address={address} onDone={reload} />
                </AnimatedContent>
                <AnimatedContent delay={0.3}>
                  <ClaimCard data={data} address={address} onDone={reload} />
                </AnimatedContent>
              </>
            )}
          </div>
        )}
      </main>

    </>
  );
}
