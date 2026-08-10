/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SiteHeader } from './SiteHeader';

const path = vi.hoisted(() => ({ current: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => path.current }));
vi.mock('./ConnectWallet', () => ({ ConnectWallet: () => <div>connect</div> }));
vi.mock('./ThemeToggle', () => ({ ThemeToggle: () => <div>theme</div> }));

describe('SiteHeader', () => {
  it('links both sections', () => {
    path.current = '/';
    render(<SiteHeader />);
    expect(screen.getByRole('link', { name: 'Analysis' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Vault' })).toHaveAttribute('href', '/vault');
  });

  it('marks the current section for assistive tech, not just visually', () => {
    path.current = '/vault';
    render(<SiteHeader />);
    expect(screen.getByRole('link', { name: 'Vault' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Analysis' })).not.toHaveAttribute('aria-current');
  });

  it('carries the wallet control on every page', () => {
    path.current = '/';
    render(<SiteHeader />);
    expect(screen.getByText('connect')).toBeInTheDocument();
  });
});
