import {
  Inbox,
  Lock,
  SearchX,
  ToggleLeft,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The one look for a page or list that has nothing to show, and why
 * (matrix W-SH-33): empty, no match, forbidden, module off, failed read,
 * offline.
 *
 * THE PAGE PASSES ITS OWN WORDS. There is no default title or sentence: each
 * page keeps the exact copy, buttons and links it shows today (and which
 * pages redirect instead of explaining stays the page's decision). `kind`
 * only picks the icon and its tone, and is exposed as `data-state-kind`.
 *
 * - `surface="card"` (default) draws the quiet card; `plain` draws nothing,
 *   for a message inside a card or table that is already there (the
 *   reference's 40 px padded centred line).
 * - `size`: `sm` inside a small card, `md` a list's empty state, `page` a
 *   state that replaces the whole page (module off, forbidden).
 * - `headingLevel`: 2 by default (under the page's h1); 1 when the panel IS
 *   the page and there is no other heading; `null` for a line that is not a
 *   heading at all (a table's "No items match your filters.").
 * - `live`: opt in to `role="status"` (polite) or `role="alert"` (assertive)
 *   where the page wants the state announced when it appears.
 */

export type StateKind = 'empty' | 'no-match' | 'forbidden' | 'module-off' | 'failed' | 'offline';

const KIND_ICON: Record<StateKind, LucideIcon> = {
  empty: Inbox,
  'no-match': SearchX,
  forbidden: Lock,
  'module-off': ToggleLeft,
  failed: TriangleAlert,
  offline: WifiOff,
};

const KIND_TONE: Record<StateKind, string> = {
  empty: 'bg-sunk text-muted-foreground',
  'no-match': 'bg-sunk text-muted-foreground',
  forbidden: 'bg-sunk text-muted-foreground',
  'module-off': 'bg-sunk text-muted-foreground',
  failed: 'bg-destructive-wash text-destructive',
  offline: 'bg-warning-wash text-warning',
};

export interface StatePanelProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  kind: StateKind;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The page's own way out: a button, a link, a "Clear search". */
  action?: React.ReactNode;
  /** Replaces the kind's icon; `null` shows none (a plain line in a table). */
  icon?: LucideIcon | null;
  headingLevel?: 1 | 2 | 3 | null;
  surface?: 'card' | 'plain';
  size?: 'sm' | 'md' | 'page';
  live?: 'polite' | 'assertive';
}

export function StatePanel({
  kind,
  title,
  description,
  action,
  icon,
  headingLevel = 2,
  surface = 'card',
  size = 'md',
  live,
  className,
  ...props
}: StatePanelProps) {
  const Icon = icon === undefined ? KIND_ICON[kind] : icon;
  const Heading = headingLevel === null ? 'p' : (`h${headingLevel}` as 'h1' | 'h2' | 'h3');
  // The reference's in-table line: quiet text, no weight, no card.
  const quiet = surface === 'plain' && description == null && action == null;
  const role = live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined;
  return (
    <div
      data-slot="state-panel"
      data-state-kind={kind}
      role={role}
      className={cn(
        'flex w-full min-w-0 flex-col items-center justify-center text-center',
        surface === 'card' && 'border-border bg-card rounded-lg border',
        size === 'sm' && 'min-h-[200px] gap-2 px-4 py-8',
        size === 'md' && (surface === 'card' ? 'min-h-[320px] gap-3 px-6 py-14' : 'gap-3 p-10'),
        size === 'page' && 'mx-auto min-h-[280px] max-w-2xl gap-3 px-6 py-12',
        className,
      )}
      {...props}
    >
      {Icon ? (
        <div
          aria-hidden="true"
          data-slot="state-panel-icon"
          className={cn(
            'flex items-center justify-center rounded-full',
            size === 'sm' ? 'size-9' : 'size-11',
            KIND_TONE[kind],
          )}
        >
          <Icon className={size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'} strokeWidth={1.75} />
        </div>
      ) : null}
      <Heading
        className={cn(
          'max-w-md',
          quiet ? 'text-muted-foreground font-normal' : 'text-foreground font-medium',
          size === 'page'
            ? 'text-[20px] leading-[30px] tracking-[-0.02em] [font-family:var(--font-display)]'
            : quiet
              ? 'text-[13.5px] leading-[20.25px]'
              : 'text-[14px] leading-5',
        )}
      >
        {title}
      </Heading>
      {description != null ? (
        <div className="text-muted-foreground max-w-md text-[13.5px] leading-[20.25px]">
          {description}
        </div>
      ) : null}
      {action != null ? (
        <div
          className={cn(
            'flex flex-wrap items-center justify-center gap-2',
            size === 'sm' ? 'mt-1' : 'mt-2',
          )}
        >
          {action}
        </div>
      ) : null}
    </div>
  );
}
