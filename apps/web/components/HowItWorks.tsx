import { CONTRACTS, explorerAddress } from '@/lib/chain';

/**
 * Four steps, no equation.
 *
 * The formula this replaces was accurate and inert. What a reader needs is the
 * order things happen in and where the judgement sits — the arithmetic is one
 * scroll up, drawn.
 */
const STEPS = [
  {
    n: '01',
    title: 'Measure what actually earns',
    body: 'Only liquidity in range collects fees. Adapters read it per venue and report null when they cannot — an excluded pool, never an estimated one.',
  },
  {
    n: '02',
    title: 'Price it at your size',
    body: 'Your deposit joins the denominator, so the rate depends on how much you add. Every venue is scored at the size you asked for, not at an ideal one.',
  },
  {
    n: '03',
    title: 'Rank, then refuse to churn',
    body: 'Moving capital costs gas, slippage and a bridge. The Router re-checks on-chain that the yield gain repays that cost over the expected hold, with hysteresis so it cannot flip-flop.',
  },
  {
    n: '04',
    title: 'Deposit, and exit through a queue',
    body: 'The vault is ERC-4626 over USDC on Arc. Capital sitting in a position on another chain cannot return in one transaction, so withdrawals are request-then-claim rather than a promise it cannot keep.',
  },
];

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-heading"
      className="mt-10 scroll-mt-20 space-y-4"
    >
      <h2 id="how-heading" className="text-lg font-medium">
        How it works
      </h2>

      <ol className="grid gap-px overflow-hidden rounded border border-border bg-border sm:grid-cols-2">
        {STEPS.map((step) => (
          <li key={step.n} className="bg-card p-5">
            <p className="tabular text-xs text-muted-foreground">{step.n}</p>
            <h3 className="mt-1 text-sm font-semibold">{step.title}</h3>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>

      <p className="text-xs text-muted-foreground">
        The vault runs on Arc testnet at{' '}
        <a
          href={explorerAddress(CONTRACTS.vault)}
          target="_blank"
          rel="noreferrer"
          className="tabular underline decoration-border underline-offset-4 hover:text-foreground"
        >
          {CONTRACTS.vault.slice(0, 10)}…{CONTRACTS.vault.slice(-6)}
        </a>
        . Scores are posted as one Merkle root per epoch, so anyone can rebuild the tree and check
        it.
      </p>
    </section>
  );
}
