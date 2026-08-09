'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

/**
 * A quiet icon toggle, not a playful sun/moon animation — the crossfade is
 * the only motion, and it rides the same transition the rest of the theme
 * swap uses (see `.theme-transitioning` in globals.css).
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const toggle = () => {
    const root = document.documentElement;
    root.classList.add('theme-transitioning');
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
    window.setTimeout(() => root.classList.remove('theme-transitioning'), 220);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={mounted ? `Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme` : 'Toggle theme'}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
    >
      {mounted && resolvedTheme === 'dark' ? (
        <Sun className="h-4 w-4" aria-hidden />
      ) : (
        <Moon className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}
