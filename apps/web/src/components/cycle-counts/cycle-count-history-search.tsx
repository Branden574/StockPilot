'use client';

import { Loader2, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Input } from '@/components/ui/input';

import { CYCLE_COUNT_SEARCH_MAX_LENGTH } from '@stockpilot/core';

import { cycleCountListHref } from './cycle-count-list-href';

/** Typing settles for this long before the list is asked for again. */
export const CYCLE_COUNT_SEARCH_DEBOUNCE_MS = 250;

/**
 * The history search box. The URL is the state: every search writes
 * `?q=` (and drops `?page=`, so a new search always starts on page 1) and the
 * server component renders the list for exactly that URL, so reload, Back,
 * Forward and a shared link all reproduce the same view.
 *
 *   • Typing settles for CYCLE_COUNT_SEARCH_DEBOUNCE_MS, then REPLACES the
 *     history entry: a burst of keystrokes is one entry, not one per letter.
 *   • Enter searches at once; the clear button empties the box and the
 *     search at once.
 *   • The navigation runs in a transition, so the rows already on screen stay
 *     up (with a "Searching" note) until the new ones arrive. Next's router
 *     discards a navigation that a newer one supersedes, so an earlier, slower
 *     search can never land on top of a later one.
 *
 * The box is NOT re-keyed on the URL (that would drop focus mid-word).
 * Instead it remembers the last query it applied and only adopts the URL's
 * `q` when that changes from outside: Back/Forward, a status filter, a
 * link.
 */
export function CycleCountHistorySearch({
  initialQuery,
  status,
}: {
  initialQuery: string;
  status: string | null;
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(initialQuery);
  const [pending, startTransition] = React.useTransition();
  const applied = React.useRef(initialQuery.trim());
  const inputRef = React.useRef<HTMLInputElement>(null);

  // The URL moved without us (Back/Forward, another control): follow it.
  React.useEffect(() => {
    if (initialQuery.trim() !== applied.current) {
      applied.current = initialQuery.trim();
      setQ(initialQuery);
    }
  }, [initialQuery]);

  const apply = React.useCallback(
    (value: string) => {
      const next = value.trim();
      if (next === applied.current) return;
      applied.current = next;
      startTransition(() => {
        router.replace(cycleCountListHref({ q: next, status, page: 1 }), { scroll: false });
      });
    },
    [router, status],
  );

  React.useEffect(() => {
    if (q.trim() === applied.current) return;
    const t = setTimeout(() => apply(q), CYCLE_COUNT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, apply]);

  return (
    <form
      role="search"
      aria-label="Cycle count history"
      onSubmit={(e) => {
        e.preventDefault();
        apply(q);
      }}
      className="flex w-full flex-col gap-1.5 sm:max-w-md"
    >
      <label htmlFor="cycle-count-search" className="text-muted-foreground text-xs font-medium">
        Search cycle counts
      </label>
      <div className="relative">
        <Search
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
        />
        <Input
          ref={inputRef}
          id="cycle-count-search"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={CYCLE_COUNT_SEARCH_MAX_LENGTH}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search count #, warehouse, or notes…"
          className="h-9 pl-8 pr-16 text-[13px] [&::-webkit-search-cancel-button]:hidden"
        />
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {pending ? (
            <Loader2 aria-hidden className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
          ) : null}
          {q ? (
            <button
              type="button"
              onClick={() => {
                setQ('');
                apply('');
                inputRef.current?.focus();
              }}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded p-1 focus-visible:outline-none focus-visible:ring-2"
              aria-label="Clear search"
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {pending ? 'Searching cycle counts' : ''}
      </p>
    </form>
  );
}
