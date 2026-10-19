'use client';

import { Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { FilterChip } from '@/components/patterns/chip';
import { FilterBar } from '@/components/patterns/filter-bar';
import { touchTargetClass } from '@/components/patterns/touch-target';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  MOVEMENT_TYPE_OPTIONS,
  buildMovementsQueryString,
  type MovementsFilterQuery,
} from '@/lib/movements-filters';

interface MovementsFilterBarProps {
  initial: MovementsFilterQuery;
  /**
   * 'server' pushes every change into the URL (?q=&type=&from=&to=, always
   * resetting to page 1) — the numbered-pagination ledger reads them back
   * via searchParams. 'client' calls `onChange` instead so the instant-mode
   * table (whole small ledger already loaded) can filter purely in memory —
   * same UI, same debounce, no navigation.
   */
  mode: 'server' | 'client';
  onChange?: (values: MovementsFilterQuery) => void;
  /** Server mode only. Defaults to the Movements page itself. */
  basePath?: string;
  /** The right end of the search row: the top pager. */
  trailing?: React.ReactNode;
}

/**
 * Search + movement-type + date-range filter bar for the global Movements
 * page. Debounces free-text search (300ms, matching the old MovementsSearch
 * it replaces); type/date changes apply immediately since they're discrete
 * picks, not keystrokes. All four filters travel together so a page link or
 * export href built from them is always internally consistent.
 *
 * The type is a row of chips (DESIGN-SPEC 6.6, the reference's type chips)
 * over the 10 real movement types plus "All types", in the order the select
 * they replace listed them. A chip sets exactly what the select set: the same
 * `type` value, so the server ledger's URL keeps its `?type=` and the instant
 * ledger filters in memory. They are toggle buttons in a group that keeps the
 * select's name, "Filter by movement type"; the one on is pressed.
 */
export function MovementsFilterBar({
  initial,
  mode,
  onChange,
  basePath = '/dashboard/movements',
  trailing,
}: MovementsFilterBarProps) {
  const router = useRouter();
  const [q, setQ] = React.useState(initial.q);
  const [type, setType] = React.useState(initial.type);
  const [from, setFrom] = React.useState(initial.from);
  const [to, setTo] = React.useState(initial.to);

  // Latest type/from/to for the debounced q-effect below, so changing q
  // doesn't need those in its dependency array (which would reset/refire
  // the debounce timer whenever a non-q filter changes). Synced in an
  // effect, not during render — mutating a ref while rendering is unsafe.
  const latest = React.useRef({ type, from, to });
  React.useEffect(() => {
    latest.current = { type, from, to };
  });

  const apply = React.useCallback(
    (next: MovementsFilterQuery) => {
      if (mode === 'client') {
        onChange?.(next);
        return;
      }
      const qs = buildMovementsQueryString(next);
      router.replace(qs ? `${basePath}?${qs}` : basePath);
    },
    [mode, onChange, router, basePath],
  );

  // The needle we last handed upstream. Seeded with the mount value so the
  // initial render still skips a redundant apply (in server mode that would
  // router.replace() the page back over the user's own ?page= navigation).
  //
  // It has to be a REF of the last APPLIED value, not a `q === initial.q`
  // comparison: instant mode's `initial` is the filters in effect when the bar
  // mounted (a module constant, q:'', when it used to be), never updated
  // after, so comparing against it also swallowed the keystroke that returns
  // q to the mount value — select-all + Backspace left the ledger, and the
  // Export CSV href built from the same filter state, pinned to the old needle
  // while the search box read empty (SP-034). Server mode hid it because the
  // URL round-trip keeps initial.q equal to the committed value.
  const appliedQ = React.useRef(initial.q);
  React.useEffect(() => {
    if (q === appliedQ.current) return;
    const t = setTimeout(() => {
      appliedQ.current = q;
      apply({ q, ...latest.current });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function updateType(next: string) {
    // The chip already on does nothing, as picking the select's current
    // option did nothing: in server mode a repeat would router.replace() the
    // ledger back to page 1.
    if (next === type) return;
    setType(next);
    apply({ q, type: next, from, to });
  }
  function updateFrom(next: string) {
    setFrom(next);
    apply({ q, type, from: next, to });
  }
  function updateTo(next: string) {
    setTo(next);
    apply({ q, type, from, to: next });
  }
  function clearAll() {
    setQ('');
    appliedQ.current = '';
    setType('');
    setFrom('');
    setTo('');
    apply({ q: '', type: '', from: '', to: '' });
  }

  const hasFilters = Boolean(q || type || from || to);

  return (
    <div data-slot="movements-filter-bar" className="flex min-w-0 flex-col gap-3">
      <div
        role="group"
        aria-label="Filter by movement type"
        className="flex min-w-0 flex-wrap items-center gap-2"
      >
        <FilterChip size="md" pressed={type === ''} onClick={() => updateType('')}>
          All types
        </FilterChip>
        {MOVEMENT_TYPE_OPTIONS.map((opt) => (
          <FilterChip
            key={opt.value}
            size="md"
            pressed={type === opt.value}
            onClick={() => updateType(opt.value)}
          >
            {opt.label}
          </FilterChip>
        ))}
      </div>

      <FilterBar
        leading={
          <>
            <div className="relative w-full sm:w-[240px]">
              <Search
                aria-hidden="true"
                className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                strokeWidth={1.8}
              />
              <Input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by item name or SKU…"
                aria-label="Search stock movements"
                className="pl-8 pr-9"
              />
              {q && (
                <button
                  type="button"
                  onClick={() => {
                    setQ('');
                    appliedQ.current = '';
                    apply({ q: '', type, from, to });
                  }}
                  aria-label="Clear search"
                  // The touch target first: its `relative` must lose to `absolute`.
                  className={cn(
                    touchTargetClass,
                    'text-muted-foreground hover:bg-muted hover:text-foreground absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded transition-colors',
                  )}
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* The from–to pair is ONE flex group so a wrapping filter bar never
                splits the range across rows (dangling dash / orphaned second date
                — owner report 2026-07-15). [color-scheme:…] keeps the NATIVE
                date-picker chrome (calendar icon + popup) in sync with the app
                theme. An EMPTY native date input paints its mm/dd/yyyy segment
                text in the normal text color (it is not a ::placeholder), which
                reads as bright typed text next to the muted search placeholder —
                so tint the whole control muted until a date is actually set
                (owner report 2026-07-15). On a phone the pair shares the row. */}
            <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
              <Input
                type="date"
                value={from}
                onChange={(e) => updateFrom(e.target.value)}
                max={to || undefined}
                aria-label="From date"
                className={cn(
                  'min-w-0 flex-1 [color-scheme:light] sm:w-[150px] sm:flex-none dark:[color-scheme:dark]',
                  !from && 'text-muted-foreground',
                )}
              />
              <span className="text-muted-foreground text-[13px]" aria-hidden>
                –
              </span>
              <Input
                type="date"
                value={to}
                onChange={(e) => updateTo(e.target.value)}
                min={from || undefined}
                aria-label="To date"
                className={cn(
                  'min-w-0 flex-1 [color-scheme:light] sm:w-[150px] sm:flex-none dark:[color-scheme:dark]',
                  !to && 'text-muted-foreground',
                )}
              />
            </div>

            {hasFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearAll}
                className="text-muted-foreground font-normal"
              >
                <X aria-hidden="true" /> Clear filters
              </Button>
            )}
          </>
        }
      >
        {trailing}
      </FilterBar>
    </div>
  );
}
