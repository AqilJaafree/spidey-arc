/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConnectWallet } from './ConnectWallet';
import type { DiscoveredWallet } from '@/lib/eip6963';

const state = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@/lib/wallet', () => ({
  useWallet: () => state.current,
  shortAddress: (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`,
}));

const ADDRESS = '0x9e5fdE1f7484096A9beCDBb956A05834eC581195';

const wallet = (name: string, uuid: string): DiscoveredWallet =>
  ({ info: { uuid, name, rdns: `io.${name}`, icon: '' }, provider: {} }) as DiscoveredWallet;

function setup(over: Record<string, unknown> = {}) {
  const connect = vi.fn();
  const switchToArc = vi.fn();
  const disconnect = vi.fn();
  state.current = {
    wallets: [],
    address: null,
    chainId: null,
    onArc: false,
    connecting: false,
    error: null,
    connect,
    switchToArc,
    disconnect,
    walletClient: null,
    ...over,
  };
  render(<ConnectWallet />);
  return { connect, switchToArc, disconnect, user: userEvent.setup() };
}

describe('disconnected', () => {
  it('says so plainly when no wallet is installed', () => {
    setup();
    const button = screen.getByRole('button', { name: /no wallet found/i });
    expect(button).toBeDisabled();
  });

  // One wallet needs no picker — a menu with a single row is a click tax.
  it('connects straight away when exactly one wallet is present', async () => {
    const { connect, user } = setup({ wallets: [wallet('Rabby', 'a')] });
    await user.click(screen.getByRole('button', { name: /connect/i }));
    expect(connect).toHaveBeenCalledOnce();
  });

  it('offers a choice when several are present', async () => {
    const { connect, user } = setup({
      wallets: [wallet('Rabby', 'a'), wallet('MetaMask', 'b')],
    });
    await user.click(screen.getByRole('button', { name: /connect/i }));

    expect(screen.getByRole('button', { name: 'MetaMask' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rabby' }));
    expect(connect).toHaveBeenCalledOnce();
  });

  it('reports a declined connection without alarm', () => {
    setup({ wallets: [wallet('Rabby', 'a')], error: 'Connection declined in the wallet.' });
    expect(screen.getByRole('alert')).toHaveTextContent(/declined/i);
  });
});

describe('wrong chain', () => {
  // The expected first state for every visitor: no wallet ships Arc. It is
  // offered as a one-click fix, not reported as a fault.
  it('offers the switch rather than blocking', async () => {
    const { switchToArc, user } = setup({ address: ADDRESS, chainId: 1, onArc: false });
    const button = screen.getByRole('button', { name: /switch to arc/i });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(switchToArc).toHaveBeenCalledOnce();
  });

  it('names the chain the wallet is actually on', () => {
    setup({ address: ADDRESS, chainId: 84532, onArc: false });
    expect(screen.getByText(/chain 84532/)).toBeInTheDocument();
  });
});

describe('connected', () => {
  it('shows a truncated address', () => {
    setup({ address: ADDRESS, chainId: 5_042_002, onArc: true });
    expect(screen.getByText('0x9e5f…1195')).toBeInTheDocument();
  });

  it('disconnects from the menu', async () => {
    const { disconnect, user } = setup({ address: ADDRESS, chainId: 5_042_002, onArc: true });
    await user.click(screen.getByRole('button', { name: /0x9e5f/ }));
    await user.click(screen.getByRole('button', { name: /disconnect/i }));
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('closes the menu on Escape', async () => {
    const { user } = setup({ address: ADDRESS, chainId: 5_042_002, onArc: true });
    await user.click(screen.getByRole('button', { name: /0x9e5f/ }));
    expect(screen.getByText(/connected to/i)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText(/connected to/i)).not.toBeInTheDocument();
  });
});
