import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * StockPilot brand mark — Mark D, "Stencil Frame".
 *
 * A solid rounded square (the cockpit aperture) with a single S
 * carved out of it as negative space, plus a small "pip" waypoint at
 * the upper-right terminal of the S. Black & white only — fills with
 * `currentColor` so the mark adapts to light/dark themes by simply
 * using the parent text color (foreground in light mode, background
 * inversion in dark mode is handled by Tailwind's color tokens at
 * each callsite).
 *
 * The mark is geometric and constructed in a 100x100 viewBox so it
 * stays sharp at any size from 16px favicons up to splash screens.
 */
export function IconMark({
  className,
  size = 22,
  withWordmark = true,
}: {
  className?: string;
  size?: number;
  /** Render the "StockPilot" wordmark next to the glyph. Defaults to true. */
  withWordmark?: boolean;
}) {
  if (!withWordmark) {
    return <BrandGlyph size={size} className={className} />;
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 font-display font-semibold tracking-tight',
        className,
      )}
    >
      <BrandGlyph size={size} />
      <span className="text-[14px] tracking-[-0.02em]">
        Stock<span className="font-medium opacity-60">Pilot</span>
      </span>
    </span>
  );
}

/**
 * The pure glyph (no wordmark). Useful for iOS/Android icons,
 * splash screens, loaders, and tight spaces.
 */
export function BrandGlyph({
  size = 22,
  className,
  animated = false,
  title,
}: {
  size?: number;
  className?: string;
  /** When true, the carved S draws/erases on a 3.6s loop (favicon, loader). */
  animated?: boolean;
  title?: string;
}) {
  // Stable, instance-unique id so multiple marks on a page don't collide.
  const reactId = React.useId().replace(/:/g, '');
  const maskId = `sp-mark-${reactId}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      className={className}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse">
          <rect width="100" height="100" fill="white" />
          {/* The carved S — strokeDashoffset is animated below. */}
          <path
            d="M 32 78 Q 72 78 72 66 Q 72 54 54 54 Q 32 54 32 42 Q 32 24 72 24"
            stroke="black"
            strokeWidth="11"
            strokeLinecap="round"
            fill="none"
            className={animated ? 'sp-mark-spath' : undefined}
          />
          {/* The nav-pip waypoint at the upper-right terminal. */}
          <circle
            cx="72"
            cy="24"
            r="6"
            fill="black"
            className={animated ? 'sp-mark-pip' : undefined}
          />
        </mask>
      </defs>
      <rect
        x="12"
        y="12"
        width="76"
        height="76"
        rx="16"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
