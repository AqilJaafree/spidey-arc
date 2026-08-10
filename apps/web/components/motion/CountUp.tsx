'use client';

import { useEffect, useRef, useState } from 'react';
import { useInView, useMotionValue, useSpring, useReducedMotion } from 'motion/react';

/**
 * A figure that settles into place instead of snapping.
 *
 * Adapted from React Bits' CountUp. Two departures, both required by this
 * project's brief rather than by taste:
 *
 *   - It counts from the *previous* value, not from zero. These figures
 *     refresh every fifteen seconds, and a balance that dives to zero and
 *     climbs back each time would be alarming rather than informative. On
 *     first paint there is no previous value, so it does start at zero.
 *   - `prefers-reduced-motion` skips the animation entirely and renders the
 *     final value, per the accessibility floor in PRODUCT.md.
 *
 * The value is also written to the DOM as text on every frame, so a screen
 * reader and a test both see a real number rather than a canvas.
 */
export function CountUp({
  value,
  format,
  className,
  duration = 0.8,
}: {
  value: number;
  format: (n: number) => string;
  className?: string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: false, margin: '0px' });
  const reduced = useReducedMotion();

  const motionValue = useMotionValue(0);
  const spring = useSpring(motionValue, {
    damping: 30,
    stiffness: 120,
    duration: duration * 1000,
  });

  const [display, setDisplay] = useState(() => format(value));
  const started = useRef(false);

  useEffect(() => {
    if (reduced) {
      setDisplay(format(value));
      return;
    }
    if (!inView && !started.current) return;
    started.current = true;
    motionValue.set(value);
  }, [value, inView, reduced, motionValue, format]);

  useEffect(() => {
    if (reduced) return;
    return spring.on('change', (latest) => setDisplay(format(latest)));
  }, [spring, format, reduced]);

  // The final value is the accessible one; the animated text is decoration
  // over it, so assistive tech is never read a number mid-transition.
  return (
    <span ref={ref} className={className}>
      <span aria-hidden>{display}</span>
      <span className="sr-only">{format(value)}</span>
    </span>
  );
}
