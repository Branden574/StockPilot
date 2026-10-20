'use client';

import { Check, ChevronDown, Search, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export type AvailabilityFilter = 'any' | 'in-stock' | 'low' | 'out';
export type SortKey = 'name' | 'most-ordered' | 'least-stock';

interface ToolbarProps {
  searchQuery: string;
  onSearchChange: (q: string) => void;
  availabilityFilter: AvailabilityFilter;
  onAvailabilityChange: (f: AvailabilityFilter) => void;
  sortKey: SortKey;
  onSortChange: (s: SortKey) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
}

function useDebouncedCallback(fn: (value: string) => void, delay: number) {
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  return React.useCallback(
    (value: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => fn(value), delay);
    },
    [fn, delay],
  );
}

const availabilityOptions: Array<{ value: AvailabilityFilter; label: string }> = [
  { value: 'any', label: 'Any availability' },
  { value: 'in-stock', label: 'In stock' },
  { value: 'low', label: 'Low stock' },
  { value: 'out', label: 'Out of stock' },
];

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: 'name', label: 'Name A→Z' },
  { value: 'most-ordered', label: 'Most ordered' },
  { value: 'least-stock', label: 'Least stock first' },
];

export function Toolbar({
  searchQuery,
  onSearchChange,
  availabilityFilter,
  onAvailabilityChange,
  sortKey,
  onSortChange,
  onClear,
  hasActiveFilters,
}: ToolbarProps) {
  const [localSearch, setLocalSearch] = React.useState(searchQuery);

  // Sync external reset (e.g. Clear button) into local state
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on external clear
    setLocalSearch(searchQuery);
  }, [searchQuery]);

  const debouncedSearch = useDebouncedCallback(onSearchChange, 150);

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    setLocalSearch(e.target.value);
    debouncedSearch(e.target.value);
  }

  const availLabel =
    availabilityFilter === 'any'
      ? 'Availability'
      : (availabilityOptions.find((o) => o.value === availabilityFilter)?.label ?? 'Availability');

  const sortLabel =
    sortKey === 'name'
      ? 'Sort'
      : (sortOptions.find((o) => o.value === sortKey)?.label ?? 'Sort');

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Search */}
      <div className="relative flex-1 min-w-[160px]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={localSearch}
          onChange={handleSearchChange}
          placeholder="Search by name or SKU…"
          className="h-8 pl-8 text-[13px]"
          aria-label="Search catalog"
        />
      </div>

      {/* Availability filter */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant={availabilityFilter !== 'any' ? 'default' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-[13px] font-normal max-sm:h-11"
          >
            {availLabel}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start">
          {availabilityOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onAvailabilityChange(opt.value)}
              aria-pressed={availabilityFilter === opt.value}
              className={cn(
                'hover:bg-muted flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors max-sm:min-h-11',
                availabilityFilter === opt.value && 'text-foreground font-medium',
              )}
            >
              {opt.label}
              {availabilityFilter === opt.value ? (
                <Check className="ml-auto h-3.5 w-3.5" aria-hidden />
              ) : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Sort */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant={sortKey !== 'name' ? 'default' : 'outline'}
            size="sm"
            className="h-8 gap-1.5 px-2.5 text-[13px] font-normal max-sm:h-11"
          >
            {sortLabel}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start">
          {sortOptions.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => onSortChange(opt.value)}
              aria-pressed={sortKey === opt.value}
              className={cn(
                'hover:bg-muted flex min-h-8 w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors max-sm:min-h-11',
                sortKey === opt.value && 'text-foreground font-medium',
              )}
            >
              {opt.label}
              {opt.value === 'most-ordered' ? (
                <span className="text-muted-foreground font-normal">(freq)</span>
              ) : null}
              {sortKey === opt.value ? (
                <Check className="ml-auto h-3.5 w-3.5" aria-hidden />
              ) : null}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Clear */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          className="text-muted-foreground ml-auto h-8 gap-1 text-[13px] font-normal max-sm:h-11"
        >
          <X className="h-3 w-3" />
          Clear
        </Button>
      )}
    </div>
  );
}
