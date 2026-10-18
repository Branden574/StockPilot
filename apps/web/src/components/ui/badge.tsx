import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Status label (DESIGN-SPEC 6.10): a 12 px pill that never wraps, in one of six
 * tones. The variant names are stored data (per-org order status colours in
 * packages/core ORDER_STATUS_COLORS pick exactly these six), so they never
 * change:
 * - success: accent text on the accent wash
 * - warning: caution text on the caution wash
 * - destructive: danger text on the danger wash
 * - secondary: neutral text on the sunk fill, stronger hairline
 * - outline: muted text, stronger hairline, no fill
 * - default: the ink fill. Its border is transparent, not ink: the fill paints
 *   under a transparent border, so the pill looks the same, and a caller that
 *   recolours only the fill and the text (the maintenance status pills) gets no
 *   ink ring around its own colours.
 * Every badge keeps its words, so colour is never the only cue.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-px text-xs/[18px] font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-[var(--ed-line-strong)] bg-sunk text-[var(--ed-ink-2)]',
        destructive: 'border-transparent bg-destructive-wash text-destructive',
        success: 'border-transparent bg-success-wash text-success',
        warning: 'border-transparent bg-warning-wash text-warning',
        outline: 'border-[var(--ed-line-strong)] bg-transparent text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {
  /** A 5 px dot in the label's own colour before the words (the stock-status look). */
  dot?: boolean;
}

export function Badge({ className, variant, dot = false, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-current" /> : null}
      {children}
    </div>
  );
}

export { badgeVariants };
