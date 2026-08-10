'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Wallet } from 'lucide-react';

import { ARC_TESTNET } from '@/lib/chain';
import { shortAddress, useWallet } from '@/lib/wallet';
import type { DiscoveredWallet } from '@/lib/eip6963';

/**
 * The header's wallet control.
 *
 * Three states, and the middle one is not an error: a first-time visitor is
 * always on the wrong chain, because no wallet ships Arc testnet. It is
 * offered as a one-click fix rather than reported as a fault.
 */
export function ConnectWallet() {
  const { wallets, address, onArc, chainId, connecting, error, connect, switchToArc, disconnect } =
    useWallet();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onAway = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onAway);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onAway);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const choose = async (wallet: DiscoveredWallet) => {
    setOpen(false);
    await connect(wallet);
  };

  if (address && !onArc) {
    return (
      <button
        type="button"
        onClick={() => void switchToArc()}
        className="inline-flex min-h-11 items-center gap-2 rounded border border-warning/50 bg-warning/5 px-3 text-sm text-warning transition-colors hover:bg-warning/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
      >
        <AlertTriangle className="h-4 w-4" aria-hidden />
        <span>Switch to Arc</span>
        <span className="tabular text-xs opacity-70">chain {chainId ?? '—'}</span>
      </button>
    );
  }

  if (address) {
    return (
      <div className="relative" ref={boxRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex min-h-11 items-center gap-2 rounded border border-border px-3 text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
        >
          <span
            className="h-1.5 w-1.5 rounded-full bg-success"
            aria-hidden
          />
          <span className="tabular">{shortAddress(address)}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        </button>

        {open && (
          <div className="absolute right-0 z-40 mt-1 w-56 rounded border border-border bg-card p-1 shadow-sm">
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Connected to {ARC_TESTNET.name}
            </p>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                disconnect();
              }}
              className="w-full rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => (wallets.length === 1 ? void choose(wallets[0]) : setOpen((v) => !v))}
        disabled={connecting || wallets.length === 0}
        aria-expanded={open}
        className="inline-flex min-h-11 items-center gap-2 rounded border border-border px-3 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
      >
        <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden />
        {connecting ? 'Connecting…' : wallets.length === 0 ? 'No wallet found' : 'Connect'}
      </button>

      {open && wallets.length > 1 && (
        <div className="absolute right-0 z-40 mt-1 w-56 rounded border border-border bg-card p-1 shadow-sm">
          {wallets.map((wallet) => (
            <button
              key={wallet.info.uuid}
              type="button"
              onClick={() => void choose(wallet)}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {wallet.info.icon && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={wallet.info.icon} alt="" className="h-4 w-4" aria-hidden />
              )}
              {wallet.info.name}
            </button>
          ))}
        </div>
      )}

      {error && (
        <p role="alert" className="absolute right-0 mt-1 w-64 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
