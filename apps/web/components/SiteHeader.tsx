'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { ConnectWallet } from './ConnectWallet';
import { ThemeToggle } from './ThemeToggle';

const LINKS = [
  { href: '/', label: 'Analysis' },
  { href: '/vault', label: 'Vault' },
];

export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 md:px-6 lg:px-8">
        <div className="flex items-center gap-5">
          <p className="hidden text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase sm:block">
            USDC LP Vault
          </p>
          <nav className="flex items-center gap-1" aria-label="Sections">
            {LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? 'page' : undefined}
                  className={`inline-flex min-h-11 items-center rounded-sm px-3 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none ${
                    active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <ConnectWallet />
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
