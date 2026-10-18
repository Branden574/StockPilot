import Link from 'next/link';
import * as React from 'react';

import { cn } from '@/lib/utils';

import { touchTargetClass } from './touch-target';

/**
 * Chips (DESIGN-SPEC 6.6 and 6.21).
 *
 * FILTER CHIPS: pill links or buttons that pick a view or toggle a filter
 * (saved views, Expected, Auto-archived only, movement types). Idle: a strong
 * hairline and ink 2 text; active: ink fill. `md` is 30 px (movement types),
 * `sm` 28 px (saved views, toggles); `dashed` draws the "+ Save view" chip.
 * `filterChipClass` gives the same look to an element the page already
 * renders (a Link with its own shallow-navigation onClick), so its href,
 * aria-pressed and handlers stay exactly as they are. A chip is 44 px tall
 * below sm, like the search field in the same row; on a coarse pointer above
 * sm it keeps its size and gets the Button's invisible 44 px touch target, so
 * keep 8 px between chips.
 *
 * META CHIP: the small outlined pill on a row ("In group X", "Same SKU as
 * records in X") with an optional text action beside it ("Add to group").
 * The action is a sibling of the label, never inside another control.
 */

export interface FilterChipStyle {
  active?: boolean;
  size?: 'sm' | 'md';
  dashed?: boolean;
}

export function filterChipClass({
  active = false,
  size = 'sm',
  dashed = false,
}: FilterChipStyle = {}) {
  return cn(
    'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border transition-colors max-sm:min-h-11',
    touchTargetClass,
    size === 'md' ? 'h-[30px] px-3 text-[13px]' : 'h-7 px-2.5 text-[12.5px]',
    active
      ? 'border-foreground bg-foreground text-background'
      : 'hover:bg-muted border-[var(--ed-line-strong)] bg-transparent text-[var(--ed-ink-2)] hover:text-foreground',
    dashed && !active && 'border-dashed',
  );
}

function ChipCount({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <span
      data-slot="chip-count"
      className={cn(
        'font-mono text-[11px] font-medium tabular-nums',
        active ? 'text-background/80' : 'text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

export interface FilterChipProps extends React.ComponentProps<'button'>, FilterChipStyle {
  /** A count the page already has. Absent: nothing is printed. */
  count?: React.ReactNode;
  /** Toggle chips: sets aria-pressed (and the active look unless `active` says otherwise). */
  pressed?: boolean;
}

export function FilterChip({
  active,
  pressed,
  size,
  dashed,
  count,
  className,
  children,
  type = 'button',
  ...props
}: FilterChipProps) {
  const isActive = active ?? pressed ?? false;
  return (
    <button
      type={type}
      data-slot="filter-chip"
      aria-pressed={pressed}
      className={cn(filterChipClass({ active: isActive, size, dashed }), className)}
      {...props}
    >
      {children}
      {count != null ? <ChipCount active={isActive}>{count}</ChipCount> : null}
    </button>
  );
}

export interface FilterChipLinkProps extends React.ComponentProps<typeof Link>, FilterChipStyle {
  count?: React.ReactNode;
}

export function FilterChipLink({
  active = false,
  size,
  dashed,
  count,
  className,
  children,
  ...props
}: FilterChipLinkProps) {
  return (
    <Link
      data-slot="filter-chip"
      className={cn(filterChipClass({ active, size, dashed }), className)}
      {...props}
    >
      {children}
      {count != null ? <ChipCount active={active}>{count}</ChipCount> : null}
    </Link>
  );
}

/** The 12 px text action used beside a meta chip and on group header rows. */
export const chipActionClass =
  'text-muted-foreground hover:text-foreground text-[12px] underline-offset-2 transition-colors hover:underline';

export interface MetaChipProps extends React.ComponentProps<'span'> {
  /** A text action beside the chip ("Add to group"); a button the page renders. */
  action?: React.ReactNode;
}

export function MetaChip({ action, className, children, ...props }: MetaChipProps) {
  const chip = (
    <span
      data-slot="meta-chip"
      className={cn(
        'text-muted-foreground inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap rounded-full border border-[var(--ed-line-strong)] px-1.5 text-[11px] leading-[16.5px]',
        action ? null : className,
      )}
      {...(action ? {} : props)}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
  if (!action) return chip;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} {...props}>
      {chip}
      {action}
    </span>
  );
}
