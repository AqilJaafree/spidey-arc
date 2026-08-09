import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Libre_Caslon_Text } from 'next/font/google';
import { ThemeProvider } from 'next-themes';
import './globals.css';

const caslon = Libre_Caslon_Text({
  subsets: ['latin'],
  weight: ['400', '700'],
  style: ['normal', 'italic'],
  variable: '--font-caslon',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'USDC LP Vault — what you actually earn',
  description:
    'Dilution- and cost-aware scoring for USDC LP venues across chains. Ranking is a function of your position size.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable} ${caslon.variable}`}
    >
      <body className="min-h-dvh">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
