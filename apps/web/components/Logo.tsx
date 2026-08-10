import Image from 'next/image';

import logo from '@/public/spidey-logo.png';

/**
 * The web mark.
 *
 * The asset is white line art on an opaque black square, which is a problem on
 * a light surface and would otherwise arrive as a black tile. Rather than ship
 * a second cut-out file to keep in sync, the background is removed in the
 * browser:
 *
 *   - dark surface — `screen` blends black to nothing, leaving white lines.
 *   - light surface — `invert()` flips it to black lines on white, then
 *     `multiply` blends the white away.
 *
 * Both are exact for pure black and pure white, which is what this asset is.
 * If it ever gains an anti-aliased grey halo, that halo will tint, and the
 * honest fix then is a real transparent PNG rather than more blend modes.
 */
export function Logo({ size = 28, className = '' }: { size?: number; className?: string }) {
  return (
    <Image
      src={logo}
      alt=""
      aria-hidden
      width={size}
      height={size}
      priority
      className={`shrink-0 select-none [mix-blend-mode:multiply] [filter:invert(1)] dark:[mix-blend-mode:screen] dark:[filter:none] ${className}`}
    />
  );
}
