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
 *
 * Two looks (DESIGN-SPEC 4 "Status pill 20 (22 with a 1 px border)"):
 * - `chip` (the default without a dot): every tone keeps its 1 px border, so
 *   the pill is 22 px. The PO and order status chips are drawn this way; on
 *   the three wash tones the border is transparent, as in the reference.
 * - `wash` (the default with a dot, the stock-status look): the success,
 *   warning and destructive washes draw no border at all, so the pill is
 *   20 px. The neutral and outline tones keep their hairline, which is their
 *   only edge.
 * Pass `look` to choose either one explicitly.
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
      look: {
        chip: '',
        wash: '',
      },
    },
    compoundVariants: [
      // The wash pills have no border (20 px). Badge merges this over the
      // base `border` through cn(); read badgeVariants() through cn() too.
      { look: 'wash', variant: ['success', 'warning', 'destructive'], className: 'border-0' },
    ],
    defaultVariants: { variant: 'default', look: 'chip' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {
  /** A 5 px dot in the label's own colour before the words (the stock-status look). */
  dot?: boolean;
}

export function Badge({ className, variant, look, dot = false, children, ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        badgeVariants({ variant, look: look ?? (dot ? 'wash' : 'chip') }),
        // A dotted badge takes its baseline from the label, not the empty dot:
        // the words align on the baseline and the dot centres itself, so the
        // pill sits level with its neighbours' text in a baseline row.
        dot && 'items-baseline',
        className,
      )}
      {...props}
    >
      {dot ? (
        <span aria-hidden className="size-[5px] shrink-0 self-center rounded-full bg-current" />
      ) : null}
      {children}
    </div>
  );
}

export { badgeVariants };
