import Link from 'next/link';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * A row of figures in one card (DESIGN-SPEC 6.8): the Overview stat strip,
 * a record's stat strip, and the stage strip (status links that look like
 * tiles).
 *
 * The cells flow in an auto-fit grid (180 / 150 / 130 px minimum per variant)
 * and wrap on narrow screens. Every cell draws a right and a bottom hairline;
 * the grid overhangs the card's padding box by 1 px on those two sides, so the
 * lines that would sit against the card's own border are clipped, whatever the
 * column count. The last cell also drops its right border (the reference's
 * double line at wide widths, where auto-fit leaves empty tracks after it).
 *
 * Figures come from the page; a strip never invents one (no tile without a
 * real number).
 */

export type StatStripVariant = 'overview' | 'detail' | 'stages';

const COLUMNS: Record<StatStripVariant, string> = {
  overview: 'grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))]',
  detail: 'grid-cols-[repeat(auto-fit,minmax(min(100%,150px),1fr))]',
  stages: 'grid-cols-[repeat(auto-fit,minmax(min(100%,130px),1fr))]',
};

export interface StatStripProps extends React.ComponentProps<'div'> {
  variant?: StatStripVariant;
  /** `nav` for a strip of status links (give it an aria-label). */
  as?: 'div' | 'nav';
}

export function StatStrip({
  variant = 'overview',
  as = 'div',
  className,
  children,
  ...props
}: StatStripProps) {
  const Root = as;
  return (
    <Root
      data-slot="stat-strip"
      data-variant={variant}
      className={cn('border-border bg-card overflow-hidden rounded-lg border', className)}
      {...(props as React.ComponentProps<'div'>)}
    >
      <div
        className={cn(
          '[&>*]:border-border -mb-px -mr-px grid [&>*:last-child]:border-r-0 [&>*]:border-b [&>*]:border-r',
          COLUMNS[variant],
        )}
      >
        {children}
      </div>
    </Root>
  );
}

export type StatTone = 'default' | 'muted' | 'accent' | 'warning' | 'destructive';

const TONE_TEXT: Record<StatTone, string> = {
  default: 'text-foreground',
  muted: 'text-muted-foreground',
  accent: 'text-accent',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

export interface StatStripItemProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  label: React.ReactNode;
  value: React.ReactNode;
  /** The line under the figure. */
  sub?: React.ReactNode;
  subTone?: StatTone;
  /** Colour the figure itself (item Coverage is coloured by status). */
  valueTone?: StatTone;
  /** `detail` sizes for a record's strip; defaults to the overview sizes. */
  size?: 'overview' | 'detail';
}

export function StatStripItem({
  label,
  value,
  sub,
  subTone = 'muted',
  valueTone = 'default',
  size = 'overview',
  className,
  ...props
}: StatStripItemProps) {
  return (
    <div
      data-slot="stat-strip-item"
      className={cn('min-w-0 px-[18px]', size === 'detail' ? 'py-3.5' : 'py-4', className)}
      {...props}
    >
      <div className="text-muted-foreground text-[12.5px] leading-[18.75px]">{label}</div>
      <div
        className={cn(
          'font-medium tabular-nums tracking-[-0.02em] [font-family:var(--font-display)] [overflow-wrap:anywhere]',
          size === 'detail' ? 'text-[22px] leading-[33px]' : 'text-[24px] leading-9',
          TONE_TEXT[valueTone],
        )}
      >
        {value}
      </div>
      {sub != null ? (
        <div className={cn('text-[12px] leading-[18px]', TONE_TEXT[subTone])}>{sub}</div>
      ) : null}
    </div>
  );
}

export interface StatStripLinkProps extends Omit<React.ComponentProps<typeof Link>, 'children'> {
  label: React.ReactNode;
  /** A count the page already has. Absent: nothing is printed. */
  count?: React.ReactNode;
  /** The current stage: `aria-current="page"`, the hover fill and the accent bar. */
  active?: boolean;
}

/**
 * A stage tile that is a link (the Orders tabs as a stage strip): same URL as
 * the tab it replaces, `aria-current="page"` on the current one.
 *
 * The bottom padding keeps 12 px between the figure and the 2 px stage bar
 * that sits in it (DESIGN-SPEC 6.8: 81.75 px strip). The strip clips at its
 * rounded edge and a tile fills its row, so a focused tile draws the app's
 * focus ring inside its own edge.
 */
export function StatStripLink({
  label,
  count,
  active = false,
  className,
  ...props
}: StatStripLinkProps) {
  return (
    <Link
      data-slot="stat-strip-link"
      data-state={active ? 'active' : 'inactive'}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'hover:bg-muted pointer-coarse:min-h-11 relative flex min-w-0 flex-col justify-center gap-0.5 px-4 pb-3.5 pt-3 transition-colors focus-visible:ring-inset focus-visible:ring-offset-0 max-sm:min-h-11',
        active && 'bg-muted',
        className,
      )}
      {...props}
    >
      <span className="text-muted-foreground whitespace-nowrap text-[12.5px] leading-[18.75px]">
        {label}
      </span>
      {count != null ? (
        <span className="text-foreground text-[22px] font-medium tabular-nums leading-[33px] tracking-[-0.02em] [font-family:var(--font-display)]">
          {count}
        </span>
      ) : null}
      <span
        aria-hidden
        className={cn('absolute inset-x-0 bottom-0 h-0.5', active ? 'bg-accent' : 'bg-transparent')}
      />
    </Link>
  );
}
