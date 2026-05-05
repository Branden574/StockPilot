'use client';

import { Command } from 'cmdk';
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
 * handles search against `sku name detail`. Designed to drop into table
 * rows where 100s of items would otherwise blow out a plain <select>.
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
      [...items].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
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
          'border-border bg-background flex h-8 w-full items-center gap-2 rounded-md border px-2.5 text-left text-xs outline-none transition-colors',
          'hover:border-[var(--ed-line-strong)] focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
      >
        <span className="flex-1 truncate">
          {selected ? (
            <>
              <span className="text-muted-foreground font-mono">{selected.sku}</span>
              <span className="mx-1.5 text-muted-foreground">·</span>
              <span>{selected.name}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
        <ChevronsUpDown className="text-muted-foreground h-3 w-3 shrink-0 opacity-60" />
      </PopoverTrigger>

      <PopoverContent
        className="w-[min(560px,calc(100vw-1rem))] p-0"
        align="start"
        sideOffset={4}
      >
        <Command className="bg-popover overflow-hidden rounded-md">
          <div className="border-border flex items-center gap-2 border-b px-3 py-2">
            <Search className="text-muted-foreground h-3.5 w-3.5" />
            <Command.Input
              autoFocus
              placeholder="Search by SKU or name…"
              className="placeholder:text-muted-foreground flex-1 bg-transparent text-sm outline-none"
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
              const haystack = `${i.sku} ${i.name} ${i.detail ?? ''}`;
              return (
                <Command.Item
                  key={i.id}
                  value={haystack}
                  onSelect={() => pick(i.id)}
                  className={ROW}
                >
                  {isActive ? (
                    <Check className="mr-2 h-3.5 w-3.5" />
                  ) : (
                    <span className="mr-2 inline-block h-3.5 w-3.5" />
                  )}
                  <span className="text-muted-foreground mr-2 font-mono text-[11px]">
                    {i.sku}
                  </span>
                  <span className="flex-1 truncate">{i.name}</span>
                  {i.detail && (
                    <span className="text-muted-foreground ml-2 text-[11px]">
                      {i.detail}
                    </span>
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

const ROW = cn(
  'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm outline-none',
  'data-[selected=true]:bg-muted data-[selected=true]:text-foreground',
);
