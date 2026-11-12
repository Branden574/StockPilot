'use client';

import { Columns3 } from 'lucide-react';
import * as React from 'react';

import { FilterTrigger } from '@/components/patterns/filter-bar';
import { CheckboxGlyph } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * LIQUID GLASS ONLY: the Books table's column chooser.
 *
 * Under glass the Books table draws the board's seven columns (Books.dc.html:
 * Title, Grade, the crate and rack, On hand, Status; the board's ISBN and
 * Available columns need data the list does not load, so they are not drawn).
 * Classic's other six columns are not dropped: each stays one tick away here,
 * and a ticked column shows again in its classic place
 * (styles/liquid-glass/pages/items.css reads the table's inert
 * data-glass-cols hook). Classic never renders this chooser (under the `off`
 * rollout it is not rendered at all, and it is a data-glass-only element,
 * hidden in Classic by styles/liquid-glass/visibility.css) and always draws
 * every column.
 *
 * The choice is the viewer's own convenience, kept in this browser
 * (localStorage, every read and write guarded); it reads and writes no data.
 */

/** Classic's Books columns that glass leaves out unless the viewer ticks them, in classic's order. */
export const BOOKS_GLASS_COLUMNS = [
  { key: 'category', label: 'Category' },
  { key: 'charter', label: 'Charter' },
  { key: 'location', label: 'Location' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'trend', label: '14-day trend' },
  { key: 'updated', label: 'Updated' },
] as const;

export type BooksGlassColumn = (typeof BOOKS_GLASS_COLUMNS)[number]['key'];

const KEYS = new Set<string>(BOOKS_GLASS_COLUMNS.map((c) => c.key));

/** Where the choice is kept (this browser only). */
export const BOOKS_GLASS_COLUMNS_STORAGE_KEY = 'sp-books-glass-columns';

// A tiny store over localStorage, so the server render and hydration agree
// (both read no choice) and the saved one applies right after, with no
// effect that sets state. When storage cannot be written (a private window,
// blocked site data) the choice still holds for this page's life.
let memory: string | null = null;
const listeners = new Set<() => void>();

function readRaw(): string {
  if (memory !== null) return memory;
  try {
    return window.localStorage.getItem(BOOKS_GLASS_COLUMNS_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeRaw(value: string) {
  try {
    window.localStorage.setItem(BOOKS_GLASS_COLUMNS_STORAGE_KEY, value);
    memory = null;
  } catch {
    memory = value;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === BOOKS_GLASS_COLUMNS_STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The saved choice, read leniently: anything unreadable is "none ticked". */
export function parseBooksGlassColumns(raw: string): ReadonlySet<BooksGlassColumn> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return new Set();
    return new Set(
      value.filter((k): k is BooksGlassColumn => typeof k === 'string' && KEYS.has(k)),
    );
  } catch {
    return new Set();
  }
}

/** The viewer's ticked columns and a setter that keeps them in this browser. */
export function useBooksGlassColumns(): readonly [
  ReadonlySet<BooksGlassColumn>,
  (next: ReadonlySet<BooksGlassColumn>) => void,
] {
  const raw = React.useSyncExternalStore(subscribe, readRaw, () => '');
  const shown = React.useMemo(() => parseBooksGlassColumns(raw), [raw]);
  const setShown = React.useCallback((next: ReadonlySet<BooksGlassColumn>) => {
    // Kept in classic's column order, so the stored text is stable.
    writeRaw(JSON.stringify(BOOKS_GLASS_COLUMNS.map((c) => c.key).filter((k) => next.has(k))));
  }, []);
  return [shown, setShown] as const;
}

/** The table's inert hook: the ticked columns, space-separated (`~=` in the glass CSS). */
export function booksGlassColumnsHook(shown: ReadonlySet<BooksGlassColumn>): string {
  return BOOKS_GLASS_COLUMNS.map((c) => c.key)
    .filter((k) => shown.has(k))
    .join(' ');
}

export function BooksGlassColumnsMenu({
  shown,
  onChange,
}: {
  shown: ReadonlySet<BooksGlassColumn>;
  onChange: (next: ReadonlySet<BooksGlassColumn>) => void;
}) {
  function toggle(key: BooksGlassColumn) {
    const next = new Set(shown);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  }
  return (
    <div data-glass-only="" data-glass="books-columns">
      <Popover>
        <PopoverTrigger asChild>
          <FilterTrigger
            icon={<Columns3 aria-hidden className="h-3.5 w-3.5" />}
            label="Columns"
            count={shown.size}
            aria-label="Choose more columns"
          />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[240px] p-1.5">
          <p className="text-muted-foreground px-2 pb-1.5 pt-1 text-[12px] leading-[17px]">
            Title, Grade, Rack, Crate, On hand and Status always show.
          </p>
          <ul className="flex flex-col">
            {BOOKS_GLASS_COLUMNS.map((c) => {
              const isOn = shown.has(c.key);
              return (
                <li key={c.key}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isOn}
                    onClick={() => toggle(c.key)}
                    className="hover:bg-muted flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors max-sm:min-h-11"
                  >
                    <CheckboxGlyph checked={isOn} />
                    <span className="truncate">{c.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
