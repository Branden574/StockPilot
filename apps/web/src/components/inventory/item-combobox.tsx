'use client';

import { Command, defaultFilter } from 'cmdk';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import * as React from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface ComboboxItem {
  id: string;
  sku: string;
  name: string;
  /** Optional secondary metadata to show in the row, e.g. "12 on hand". */
  detail?: string | null;
}

interface ItemComboboxProps {
  items: ComboboxItem[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** Placeholder for when no item is selected. */
  placeholder?: string;
  /** Width override for the trigger; defaults to filling the parent. */
  className?: string;
  /** Disable the trigger entirely. */
  disabled?: boolean;
  /** Allow clearing selection. Defaults to true. */
  clearable?: boolean;
}

/**
 * Searchable item picker. Renders a trigger button that shows the current
 * selection (or a placeholder), opens a popover with a cmdk command + a
 * search input, and filters the alphabetized item list as the user types.
 *
 * Items are pre-sorted alphabetically by name; cmdk's built-in fuzzy match
 * handles search against `sku name` ONLY — `detail` is display-only
 * metadata and deliberately excluded from the search haystack (typing a
 * number must match SKUs/names, never incidental metadata like an on-hand
 * count). Designed to drop into table rows where 100s of items would
 * otherwise blow out a plain <select>.
 *
 * Each row's cmdk value is the item id, so two records that share a SKU and a
 * name (a SKU family across warehouses) stay two rows: before, they shared one
 * value, lit up together and the keyboard could only ever pick the first. The
 * filter still scores the `sku name` haystack alone (the row's keyword).
 *
 * Look (DESIGN-SPEC 6.4): the filter-trigger recipe, 32px on a mouse and 44px
 * where a finger is the pointer; the search box keeps 16px text below sm so
 * iOS does not zoom on focus.
 */
export function ItemCombobox({
  items,
  value,
  onChange,
  placeholder = 'Pick item',
  className,
  disabled,
  clearable = true,
}: ItemComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const sorted = React.useMemo(
    () =>
      [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [items],
  );
  const selected = items.find((i) => i.id === value) ?? null;

  function pick(id: string) {
    onChange(id === value ? null : id);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        disabled={disabled}
        className={cn(
          'border-border bg-card flex w-full items-center gap-1.5 rounded-md border px-2.5 text-left text-[13px] text-[var(--ed-ink-2)] outline-none transition-colors',
          TOUCH_HEIGHT,
          'focus-visible:ring-ring hover:border-[var(--ed-line-strong)] focus-visible:ring-2',
          'disabled:hover:border-border disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
      >
        <span className="flex-1 truncate">
          {selected ? (
            <>
              <span className="text-muted-foreground font-mono text-[11.5px]">{selected.sku}</span>
              <span className="text-muted-foreground mx-1.5">·</span>
              <span className="text-foreground">{selected.name}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        <ChevronsUpDown aria-hidden className="text-muted-foreground size-3 shrink-0" />
      </PopoverTrigger>

      <PopoverContent className="w-[min(560px,calc(100vw-1rem))] p-0" align="start" sideOffset={4}>
        <Command className="bg-popover overflow-hidden rounded-[inherit]" filter={scoreHaystack}>
          <div className="border-border flex items-center gap-2 border-b px-3 py-2">
            <Search aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <Command.Input
              autoFocus
              placeholder="Search by SKU or name…"
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-base outline-none sm:text-sm"
            />
          </div>
          <Command.List className="max-h-[280px] overflow-y-auto p-1.5">
            <Command.Empty className="text-muted-foreground py-6 text-center text-sm">
              No matches.
            </Command.Empty>
            {clearable && selected && (
              <Command.Item
                value="__clear__"
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
                className={ROW}
              >
                <span className="mr-2 inline-block h-3.5 w-3.5" />
                <span className="text-muted-foreground">Clear selection</span>
              </Command.Item>
            )}
            {sorted.map((i) => {
              const isActive = i.id === value;
              const haystack = `${i.sku} ${i.name}`;
              return (
                <Command.Item
                  key={i.id}
                  value={i.id}
                  keywords={[haystack]}
                  onSelect={() => pick(i.id)}
                  className={ROW}
                >
                  {isActive ? (
                    <Check aria-hidden className="mr-2 size-3.5 shrink-0" />
                  ) : (
                    <span className="mr-2 inline-block size-3.5 shrink-0" />
                  )}
                  <span className="text-muted-foreground mr-2 font-mono text-[11.5px]">
                    {i.sku}
                  </span>
                  <span className="flex-1 truncate">{i.name}</span>
                  {i.detail && (
                    <span className="text-muted-foreground ml-2 text-xs">{i.detail}</span>
                  )}
                </Command.Item>
              );
            })}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** 32px on a mouse, 44px wherever a finger is the pointer (below sm, or any
 *  coarse pointer). The coarse rule is an arbitrary variant so it is emitted
 *  after `sm:` and wins when both match. */
const TOUCH_HEIGHT = 'h-11 sm:h-8 [@media(pointer:coarse)]:h-11';

const ROW = cn(
  'flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] outline-none',
  '[@media(pointer:coarse)]:min-h-11',
  'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
);

/**
 * cmdk's own scoring over a row's `sku name` haystack (its keyword), never the
 * value (an item id) and never the detail text. A row without a keyword (the
 * Clear selection row) is scored on its value, as before.
 */
function scoreHaystack(value: string, search: string, keywords?: string[]): number {
  return defaultFilter(keywords && keywords.length > 0 ? keywords.join(' ') : value, search);
}
