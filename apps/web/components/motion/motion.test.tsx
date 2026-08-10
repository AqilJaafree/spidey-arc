/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AnimatedContent } from './AnimatedContent';
import { CountUp } from './CountUp';

const reduced = vi.hoisted(() => ({ current: false }));
vi.mock('motion/react', async () => {
  const actual = await vi.importActual<typeof import('motion/react')>('motion/react');
  return { ...actual, useReducedMotion: () => reduced.current };
});

const money = (n: number) => `$${n.toFixed(2)}`;

describe('CountUp', () => {
  it('always exposes the true value to a screen reader', () => {
    reduced.current = false;
    const { container } = render(<CountUp value={1234.5} format={money} />);
    // The animated text is aria-hidden; the settled figure sits beside it in
    // an sr-only span, so assistive tech is never read a number mid-flight.
    expect(container.querySelector('.sr-only')).toHaveTextContent('$1234.50');
    expect(container.querySelector('[aria-hidden]')).toBeInTheDocument();
  });

  it('renders the final value immediately under reduced motion', () => {
    reduced.current = true;
    const { container } = render(<CountUp value={42} format={money} />);
    expect(container.textContent).toBe('$42.00$42.00');
  });

  it('starts from the current value, not from zero', () => {
    // A balance that dives to zero every fifteen-second refresh would read as
    // alarm rather than information.
    reduced.current = false;
    const { container } = render(<CountUp value={99.5} format={money} />);
    expect(container.textContent).not.toContain('$0.00');
  });
});

describe('AnimatedContent', () => {
  it('renders its children', () => {
    reduced.current = false;
    render(
      <AnimatedContent>
        <p>inside</p>
      </AnimatedContent>,
    );
    expect(screen.getByText('inside')).toBeInTheDocument();
  });

  it('drops out of the way entirely under reduced motion', () => {
    reduced.current = true;
    const { container } = render(
      <AnimatedContent className="marker">
        <p>inside</p>
      </AnimatedContent>,
    );
    const wrapper = container.querySelector('.marker')!;
    expect(wrapper.getAttribute('style')).toBeNull();
  });
});
