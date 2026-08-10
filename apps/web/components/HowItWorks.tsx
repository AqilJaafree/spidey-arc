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
    title: 'We check what is really earning',
    body: 'A pool only pays fees on money parked at the current price. We measure that part, not the headline total. If a pool will not tell us, we leave it out rather than guess.',
  },
  {
    n: '02',
    title: 'We price it for your amount',
    body: 'Your deposit shares the fees with everyone already there, so a big deposit earns a lower rate than a small one. Every pool is scored for the amount you typed in.',
  },
  {
    n: '03',
    title: 'We only move when it pays for itself',
    body: 'Switching pools costs fees. Before moving your money the contract checks on-chain that the extra interest covers that cost within the time you plan to stay. If it does not, nothing moves.',
  },
  {
    n: '04',
    title: 'Putting money in, and taking it out',
    body: 'Deposits go into a vault on Arc and you get shares back. Withdrawals are a two-step request and claim, because money working in a pool on another blockchain cannot come back instantly.',
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
        This is a test network, so the money is not real. The vault is at{' '}
        <a
          href={explorerAddress(CONTRACTS.vault)}
          target="_blank"
          rel="noreferrer"
          className="tabular underline decoration-border underline-offset-4 hover:text-foreground"
        >
          {CONTRACTS.vault.slice(0, 10)}…{CONTRACTS.vault.slice(-6)}
        </a>
        . Every score we publish is recorded on-chain, so anyone can check our working.
      </p>
    </section>
  );
}
