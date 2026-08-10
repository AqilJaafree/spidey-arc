/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ClaimCard, DepositCard, RequestCard } from './VaultActions';
import type { VaultData } from '@/lib/useVaultData';
import { routeStates } from '@/lib/venues';

const simulate = vi.hoisted(() => vi.fn());
const write = vi.hoisted(() => vi.fn());
const wait = vi.hoisted(() => vi.fn());

vi.mock('@/lib/wallet', () => ({
  publicClient: {
    simulateContract: simulate,
    waitForTransactionReceipt: wait,
  },
  useWallet: () => ({
    walletClient: { account: { address: ADDRESS }, writeContract: write },
  }),
}));

const ADDRESS = '0x9e5fdE1f7484096A9beCDBb956A05834eC581195' as const;
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const SHARES = (n: number) => BigInt(Math.round(n * 1e9));

function data(over: Partial<VaultData['vault']> = {}, holder: Partial<VaultData['holder']> = {}) {
  return {
    vault: {
      totalAssets: USDC(1.5), idle: USDC(1), deployed: USDC(0.5), pending: 0n,
      coverageBps: 10_000, epoch: 1, lastSettledEpoch: 0,
      depositCap: USDC(100_000), navUpdatedAt: 1_786_339_000n, maxNavAge: 21_600n,
      ...over,
    },
    routes: routeStates([]),
    holder: {
      shares: SHARES(1), usdcBalance: USDC(50), allowance: 0n,
      pendingAssets: 0n, pendingEpoch: 0,
      ...holder,
    },
    now: 1_786_339_887n,
    blockNumber: 1n,
  } as VaultData;
}

describe('DepositCard', () => {
  it('will not submit an empty amount', () => {
    render(<DepositCard data={data()} address={ADDRESS} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: /deposit/i })).toBeDisabled();
  });

  it('asks for approval first when there is no allowance', async () => {
    const user = userEvent.setup();
    render(<DepositCard data={data()} address={ADDRESS} onDone={() => {}} />);
    await user.type(screen.getByLabelText(/amount in usdc/i), '10');
    expect(screen.getByRole('button', { name: /approve & deposit/i })).toBeEnabled();
  });

  it('skips approval when the allowance already covers it', async () => {
    const user = userEvent.setup();
    render(
      <DepositCard data={data({}, { allowance: USDC(50) })} address={ADDRESS} onDone={() => {}} />,
    );
    await user.type(screen.getByLabelText(/amount in usdc/i), '10');
    expect(screen.getByRole('button', { name: /^deposit$/i })).toBeInTheDocument();
  });

  it('explains a balance it cannot fund, before signing', async () => {
    const user = userEvent.setup();
    render(<DepositCard data={data()} address={ADDRESS} onDone={() => {}} />);
    await user.type(screen.getByLabelText(/amount in usdc/i), '999');

    expect(screen.getByText(/more than your balance/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deposit/i })).toBeDisabled();
    expect(simulate).not.toHaveBeenCalled();
  });

  // USDC has six places. Truncating silently would send a number the user
  // did not type, which is the one surprise this page exists to remove.
  it('refuses more precision than USDC has', async () => {
    const user = userEvent.setup();
    render(<DepositCard data={data()} address={ADDRESS} onDone={() => {}} />);
    await user.type(screen.getByLabelText(/amount in usdc/i), '1.0000001');
    expect(screen.getByText(/too many decimals/i)).toBeInTheDocument();
  });

  it('names the headroom when the cap is the blocker', async () => {
    const user = userEvent.setup();
    render(
      <DepositCard
        data={data({ totalAssets: USDC(99_995), depositCap: USDC(100_000) })}
        address={ADDRESS}
        onDone={() => {}}
      />,
    );
    await user.type(screen.getByLabelText(/amount in usdc/i), '10');
    expect(screen.getByText(/over the deposit cap/i)).toBeInTheDocument();
    expect(screen.getByText(/\$5\.00/)).toBeInTheDocument();
  });
});

describe('RequestCard', () => {
  it('fills the field from the holder balance', async () => {
    const user = userEvent.setup();
    render(<RequestCard data={data()} address={ADDRESS} onDone={() => {}} />);
    await user.click(screen.getByRole('button', { name: /max/i }));
    expect(screen.getByLabelText(/shares to redeem/i)).toHaveValue('1');
  });

  it('blocks more shares than are held', async () => {
    const user = userEvent.setup();
    render(<RequestCard data={data()} address={ADDRESS} onDone={() => {}} />);
    await user.type(screen.getByLabelText(/shares to redeem/i), '5');
    expect(screen.getByText(/more shares than you hold/i)).toBeInTheDocument();
  });

  it('blocks a second request while a settled one is unclaimed', async () => {
    const user = userEvent.setup();
    render(
      <RequestCard
        data={data({ epoch: 2 }, { pendingAssets: USDC(5), pendingEpoch: 1 })}
        address={ADDRESS}
        onDone={() => {}}
      />,
    );
    await user.type(screen.getByLabelText(/shares to redeem/i), '0.5');
    expect(screen.getByText(/claim your settled withdrawal first/i)).toBeInTheDocument();
  });

  it('simulates before it writes', async () => {
    simulate.mockResolvedValueOnce({ request: {} });
    write.mockResolvedValueOnce('0xabc');
    wait.mockResolvedValueOnce({});

    const user = userEvent.setup();
    render(<RequestCard data={data()} address={ADDRESS} onDone={() => {}} />);
    await user.type(screen.getByLabelText(/shares to redeem/i), '1');
    await user.click(screen.getByRole('button', { name: /^request$/i }));

    expect(simulate).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(simulate.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
  });
});

describe('ClaimCard', () => {
  it('renders nothing when there is no request', () => {
    const { container } = render(
      <ClaimCard data={data()} address={ADDRESS} onDone={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('names the operator wait while the epoch is open', () => {
    render(
      <ClaimCard
        data={data({ pending: USDC(1) }, { pendingAssets: USDC(1), pendingEpoch: 1 })}
        address={ADDRESS}
        onDone={() => {}}
      />,
    );
    expect(screen.getByText(/epoch 1 is still open/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /claim/i })).toBeDisabled();
  });

  // The live blocker: idle short of the queue, and the mark past six hours.
  it('predicts a stale mark instead of spending a transaction on it', () => {
    render(
      <ClaimCard
        data={data(
          { pending: USDC(100), idle: USDC(99), lastSettledEpoch: 1, navUpdatedAt: 1_785_994_244n },
          { pendingAssets: USDC(100), pendingEpoch: 1 },
        )}
        address={ADDRESS}
        onDone={() => {}}
      />,
    );
    expect(screen.getByText(/too old to pay against/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /claim/i })).toBeDisabled();
  });

  it('shows the haircut before signing, not after', () => {
    render(
      <ClaimCard
        data={data(
          {
            pending: USDC(100), idle: USDC(99), deployed: 0n,
            lastSettledEpoch: 1, coverageBps: 9_900,
          },
          { pendingAssets: USDC(100), pendingEpoch: 1 },
        )}
        address={ADDRESS}
        onDone={() => {}}
      />,
    );
    expect(screen.getByText(/coverage is 99%/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /claim \$99\.00/i })).toBeEnabled();
  });
});
