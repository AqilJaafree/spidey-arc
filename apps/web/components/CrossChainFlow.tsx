'use client';

import { motion, useReducedMotion } from 'motion/react';

import { ROUTE_LABEL, type Route } from '@/lib/venues';
import { usdc } from '@/lib/vault';

/**
 * The hub and its two spokes, animated only where something is moving.
 *
 * Arc holds no venue of its own, so every route leaves the chain — and Arc
 * pushes in one transaction while pulling nothing back. That asymmetry is the
 * shape of the system, and a static box diagram states it badly: capital that
 * is burned here and not yet minted there is *neither* place, and no arrow
 * drawn once can say so.
 *
 * The dash travels a path when, and only when, that venue carries
 * `FLAG_PENDING_HOOK`. Motion is therefore load-bearing: if the line is
 * moving, capital is genuinely in flight. Nothing here animates on a timer.
 */
export function CrossChainFlow({ routes, hubAssets }: { routes: Route[]; hubAssets: bigint }) {
  const reduced = useReducedMotion();

  return (
    <figure className="rounded border border-border bg-card p-6">
      <figcaption className="mb-1 text-sm font-semibold">Routes</figcaption>
      <p className="mb-5 text-xs text-muted-foreground">
        Arc pushes out in one transaction. Every return is initiated on the far side.
      </p>

      <svg
        viewBox="0 0 360 190"
        className="w-full text-muted-foreground"
        role="img"
        aria-label={`Arc hub with ${routes.length} routes: ${routes
          .map((r) => `${r.chain} ${ROUTE_LABEL[r.status]}`)
          .join(', ')}`}
      >
        {/* --- hub -------------------------------------------------------- */}
        <rect
          x="110" y="6" width="140" height="42" rx="3"
          className="fill-none stroke-current opacity-40"
        />
        <text x="180" y="24" textAnchor="middle" className="fill-foreground text-[11px] font-medium">
          Arc hub
        </text>
        <text x="180" y="39" textAnchor="middle" className="fill-current text-[10px] tabular">
          {usdc(hubAssets)}
        </text>

        {routes.map((route, index) => {
          const x = index === 0 ? 66 : 294;
          const path = `M 180 48 V 78 H ${x} V 116`;
          const live = route.status === 'inFlight';

          return (
            <g key={route.venueId}>
              <path d={path} className="fill-none stroke-current opacity-25" strokeWidth={1} />

              {live && (
                <motion.path
                  d={path}
                  className="fill-none stroke-warning"
                  strokeWidth={1.5}
                  strokeDasharray="10 84"
                  strokeLinecap="round"
                  initial={{ strokeDashoffset: 94 }}
                  animate={reduced ? { strokeDashoffset: 47 } : { strokeDashoffset: 0 }}
                  transition={
                    reduced
                      ? { duration: 0 }
                      : { duration: 1.8, repeat: Infinity, ease: 'linear' }
                  }
                />
              )}

              <text
                x={index === 0 ? 96 : 264}
                y={72}
                textAnchor={index === 0 ? 'start' : 'end'}
                className="fill-current text-[9px] tabular"
              >
                domain {route.cctpDomain}
              </text>

              {/* --- spoke ------------------------------------------------- */}
              <rect
                x={x - 62} y="116" width="124" height="62" rx="3"
                className={`fill-none stroke-current ${
                  route.status === 'unregistered' ? 'opacity-20' : 'opacity-40'
                }`}
                strokeDasharray={route.status === 'unregistered' ? '3 3' : undefined}
              />
              <text x={x} y="134" textAnchor="middle" className="fill-foreground text-[10px] font-medium">
                {route.chain}
              </text>
              <text x={x} y="148" textAnchor="middle" className="fill-current text-[9px]">
                {route.lands}
              </text>
              <text
                x={x} y="166" textAnchor="middle"
                className={`text-[10px] tabular ${live ? 'fill-warning' : 'fill-current'}`}
              >
                {route.deployed > 0n ? usdc(route.deployed) : ''} {ROUTE_LABEL[route.status]}
              </text>
            </g>
          );
        })}
      </svg>

      {routes.some((r) => r.status === 'inFlight') && (
        <p className="mt-4 border-t border-border pt-4 text-xs leading-relaxed text-warning">
          Capital is burned on Arc and not yet minted at the destination — claimable in neither
          place. The vault still books it as deployed, and the flag is what says otherwise.
        </p>
      )}
    </figure>
  );
}
