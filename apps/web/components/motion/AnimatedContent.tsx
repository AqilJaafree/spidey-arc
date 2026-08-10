'use client';

import { motion, useReducedMotion } from 'motion/react';
import type { ReactNode } from 'react';

/**
 * Enter once, from slightly below, on a short ease.
 *
 * Adapted from React Bits' AnimatedContent, with the blur and scale removed.
 * The brief rejects decorative motion, so what survives is the part that does
 * work: a stagger that tells you the cards are a sequence rather than a wall.
 * Under `prefers-reduced-motion` nothing moves at all.
 */
export function AnimatedContent({
  children,
  delay = 0,
  distance = 8,
  className,
}: {
  children: ReactNode;
  delay?: number;
  distance?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();

  if (reduced) return <div className={className}>{children}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: distance }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay, ease: [0.22, 0.61, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
