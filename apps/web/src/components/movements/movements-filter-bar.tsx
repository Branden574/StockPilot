'use client';

import { Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
}

/**
 * Search + movement-type + date-range filter bar for the global Movements
 * page. Debounces free-text search (300ms, matching the old MovementsSearch
 * it replaces); type/date changes apply immediately since they're discrete
 * picks, not keystrokes. All four filters travel together so a page link or
 * export href built from them is always internally consistent.
 */
export function MovementsFilterBar({
  initial,
  mode,
  onChange,
  basePath = '/dashboard/movements',
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

  React.useEffect(() => {
    // Skip the initial mount (value already reflected upstream).
    if (q === initial.q) return;
    const t = setTimeout(() => apply({ q, ...latest.current }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function updateType(next: string) {
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
    setType('');
    setFrom('');
    setTo('');
    apply({ q: '', type: '', from: '', to: '' });
  }

  const hasFilters = Boolean(q || type || from || to);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] max-w-xs flex-1 sm:flex-none">
        <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by item name or SKU…"
          aria-label="Search stock movements"
          className="h-9 pl-8 pr-8 text-[13px]"
        />
        {q && (
          <button
            type="button"
            onClick={() => {
              setQ('');
              apply({ q: '', type, from, to });
            }}
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <Select value={type || 'all'} onValueChange={(v) => updateType(v === 'all' ? '' : v)}>
        <SelectTrigger className="h-9 w-[150px] text-[13px]" aria-label="Filter by movement type">
          <SelectValue placeholder="All types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All types</SelectItem>
          {MOVEMENT_TYPE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* The from–to pair is ONE flex group so a wrapping filter bar never
          splits the range across rows (dangling dash / orphaned second date
          — owner report 2026-07-15). [color-scheme:…] keeps the NATIVE
          date-picker chrome (calendar icon + popup) in sync with the app
          theme — without it the browser renders light-scheme widgets inside
          the dark UI. */}
      <div className="flex shrink-0 items-center gap-2">
        <Input
          type="date"
          value={from}
          onChange={(e) => updateFrom(e.target.value)}
          max={to || undefined}
          aria-label="From date"
          className="h-9 w-[140px] text-[13px] [color-scheme:light] dark:[color-scheme:dark]"
        />
        <span className="text-muted-foreground text-xs" aria-hidden>
          –
        </span>
        <Input
          type="date"
          value={to}
          onChange={(e) => updateTo(e.target.value)}
          min={from || undefined}
          aria-label="To date"
          className="h-9 w-[140px] text-[13px] [color-scheme:light] dark:[color-scheme:dark]"
        />
      </div>

      {hasFilters && (
        <button
          type="button"
          onClick={clearAll}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11.5px]"
        >
          <X className="h-3 w-3" /> Clear filters
        </button>
      )}
    </div>
  );
}
