import { ChevronDown } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

import { touchTargetClass } from './touch-target';

/**
 * One wrapping filter row (DESIGN-SPEC 4 "Toolbar", 6.4).
 *
 * `leading` holds the view tabs (a `SegmentedTabs`), the children hold the
 * filter cluster (search, filter triggers, toggles). The row wraps instead of
 * scrolling the page: 12 px between the two groups, 8 px inside each. Nothing
 * here reads data or owns state; every control keeps its own URL parameter,
 * aria-label and tour selector.
 */
export interface FilterBarProps extends React.ComponentProps<'div'> {
  /** Left group: the view tabs. */
  leading?: React.ReactNode;
}

export function FilterBar({ leading, children, className, role, ...props }: FilterBarProps) {
  // A named row is a group (an aria-label on a plain div means nothing).
  const named = props['aria-label'] != null || props['aria-labelledby'] != null;
  return (
    <div
      data-slot="filter-bar"
      role={role ?? (named ? 'group' : undefined)}
      className={cn('flex min-w-0 flex-wrap items-center justify-between gap-3', className)}
      {...props}
    >
      {leading ? (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{leading}</div>
      ) : null}
      {children ? (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}

/**
 * The filter dropdown trigger (DESIGN-SPEC 6.4): 32 px, hairline border that
 * strengthens on hover and while its menu is open, and a trailing chevron.
 *
 * - `label` alone prints the label ("Category").
 * - `label` + `value` prints the "Label: value" form, the label quiet and the
 *   value in 500 ("Sort: Newest first").
 * - `count` above 0 adds the active-count suffix (mono 11); absent, null or 0
 *   prints nothing.
 *
 * It is a plain `<button>` that spreads every other prop and the ref, so it can
 * be a Radix `PopoverTrigger asChild` child; the caller keeps its own
 * aria-label ("Filter by Category", "Sort by Newest").
 *
 * Size follows the shared Input and Select beside it in the row: 32 px, and
 * 44 px tall below sm. On a coarse pointer above sm it keeps 32 px (the search
 * field does too) and gets the Button's invisible 44 px touch target.
 */
export interface FilterTriggerProps extends Omit<React.ComponentProps<'button'>, 'value'> {
  label: React.ReactNode;
  /** The chosen value for the "Label: value" form (not the button's value attribute). */
  value?: React.ReactNode;
  count?: number | null;
  /** An optional leading icon (14 px). */
  icon?: React.ReactNode;
  /** Draw the trigger as active even without a count (a chosen sort, a set rack). */
  active?: boolean;
  hideChevron?: boolean;
}

export function FilterTrigger({
  label,
  value,
  count,
  icon,
  active,
  hideChevron = false,
  className,
  type = 'button',
  ...props
}: FilterTriggerProps) {
  const showCount = typeof count === 'number' && count > 0;
  const isActive = Boolean(active) || showCount;
  return (
    <button
      type={type}
      data-slot="filter-trigger"
      data-active={isActive ? '' : undefined}
      className={cn(
        'border-border bg-card inline-flex h-8 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[13px] font-normal text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)] disabled:pointer-events-none disabled:opacity-50 data-[state=open]:border-[var(--ed-line-strong)] max-sm:min-h-11 [&_svg]:shrink-0',
        touchTargetClass,
        isActive && 'border-[var(--ed-line-strong)]',
        className,
      )}
      {...props}
    >
      {icon}
      {value != null ? (
        <>
          <span className="text-muted-foreground">{label}:</span>
          <span className="text-foreground min-w-0 truncate font-medium">{value}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
      {showCount ? (
        <span
          data-slot="filter-trigger-count"
          className="bg-foreground text-background inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[11px] font-medium tabular-nums leading-none"
        >
          {count}
        </span>
      ) : null}
      {hideChevron ? null : (
        <ChevronDown
          aria-hidden
          className="text-muted-foreground h-[11px] w-[11px]"
          strokeWidth={2}
        />
      )}
    </button>
  );
}
