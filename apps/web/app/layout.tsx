import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'USDC LP Vault — what you actually earn',
  description:
    'Dilution- and cost-aware scoring for USDC LP venues across chains. Ranking is a function of your position size.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
