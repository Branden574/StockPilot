'use client';

import { Loader2, Search } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { readBookStorage, readItemRack } from '@/lib/book-storage';
import { useCountSelection } from '@/lib/cycle-counts/use-count-selection';
import { cn } from '@/lib/utils';

const ALL_WAREHOUSES = '__all';
const PAGE_SIZE = 50;

/** Row shape returned by /api/items/search (the fields the picker renders). */
interface PickerRow {
  id: string;
  sku: string;
  name: string;
  quantity_on_hand: number;
  item_type: string;
  custom_fields: Record<string, unknown> | null;
}

type PickerTab = 'product' | 'book';

/**
 * Embedded item picker for "cycle count by selection" — lives INSIDE the
 * Start-a-count page so picking items no longer requires a round-trip
 * through the Inventory/Books list pages (that select-mode path still
 * works and converges here: both write the same sessionStorage-backed
 * count-selection store, so items ticked over there show pre-checked).
 *
 * Data source: /api/items/search with `browse=1` (paginated default
 * listing before any query — the same org-scoped InventoryService.list
 * the Items/Books pages use, so the default visibility rules hold:
 * archived, rentals and expected/awaiting-first-receipt items are all
 * excluded — you cannot count stock that never arrived).
 */
export function CountItemPicker({
  warehouses,
}: {
  warehouses: Array<{ id: string; name: string }>;
}) {
  const picks = useCountSelection((s) => s.picks);
  const add = useCountSelection((s) => s.add);
  const remove = useCountSelection((s) => s.remove);
  const clear = useCountSelection((s) => s.clear);

  const [tab, setTab] = React.useState<PickerTab>('product');
  const [q, setQ] = React.useState('');
  const [warehouseId, setWarehouseId] = React.useState<string>(ALL_WAREHOUSES);
  const [rows, setRows] = React.useState<PickerRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const [loadingMore, setLoadingMore] = React.useState(false);

  const buildUrl = React.useCallback(
    (offset: number): string => {
      const p = new URLSearchParams();
      // browse=1 lets the endpoint return a default listing for an empty
      // query — the picker shows a checkable list before the user types.
      p.set('browse', '1');
      p.set('type', tab);
      p.set('sort', 'name_asc');
      p.set('limit', String(PAGE_SIZE));
      if (offset > 0) p.set('offset', String(offset));
      const needle = q.trim();
      if (needle) p.set('q', needle);
      if (warehouseId !== ALL_WAREHOUSES) p.set('wh', warehouseId);
      return `/api/items/search?${p.toString()}`;
    },
    [tab, q, warehouseId],
  );

  // Debounced fetch on tab / query / warehouse change. AbortController
  // cancels the in-flight request on rapid typing; the trailing 250ms
  // collapses a burst of keystrokes into one request.
  React.useEffect(() => {
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle: mark the list stale the instant a filter changes
    setStatus('loading');
    const t = setTimeout(async () => {
      try {
        const res = await fetch(buildUrl(0), { signal: ac.signal });
        if (!res.ok) throw new Error(`search failed (${res.status})`);
        const body = (await res.json()) as { items: PickerRow[]; total: number };
        setRows(body.items);
        setTotal(body.total);
        setStatus('ready');
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setRows([]);
        setTotal(0);
        setStatus('failed');
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [buildUrl]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await fetch(buildUrl(rows.length));
      if (!res.ok) throw new Error(`search failed (${res.status})`);
      const body = (await res.json()) as { items: PickerRow[]; total: number };
      setRows((prev) => {
        // De-dupe on id in case the list shifted between pages.
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...body.items.filter((r) => !seen.has(r.id))];
      });
      setTotal(body.total);
    } catch {
      setStatus('failed');
    } finally {
      setLoadingMore(false);
    }
  }

  function toggle(row: PickerRow) {
    if (picks[row.id]) {
      remove(row.id);
    } else {
      add([
        {
          id: row.id,
          sku: row.sku,
          name: row.name,
          // Trust the row's own item_type (not the tab) so a book that
          // surfaces outside the Books tab still groups correctly downstream.
          itemType: row.item_type === 'book' ? 'book' : 'product',
        },
      ]);
    }
  }

  const selectedCount = Object.keys(picks).length;

  return (
    <div className="space-y-3">
      <div className="bg-muted/50 inline-flex rounded-md p-0.5 text-sm">
        <PickerTabButton active={tab === 'product'} onClick={() => setTab('product')}>
          Inventory
        </PickerTabButton>
        <PickerTabButton active={tab === 'book'} onClick={() => setTab('book')}>
          Books
        </PickerTabButton>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              tab === 'book'
                ? 'Search books by title, SKU, barcode…'
                : 'Search items by name, SKU, barcode…'
            }
            className="pl-8"
            aria-label="Search items to count"
          />
        </div>
        {warehouses.length > 0 && (
          <Select value={warehouseId} onValueChange={setWarehouseId}>
            <SelectTrigger className="sm:w-44" aria-label="Filter by warehouse">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_WAREHOUSES}>All warehouses</SelectItem>
              {warehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="border-border overflow-hidden rounded-md border">
        {status === 'loading' ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading items…
          </div>
        ) : status === 'failed' ? (
          <p className="text-muted-foreground px-3 py-8 text-center text-sm">
            Couldn&apos;t load items. Check your connection and try again.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground px-3 py-8 text-center text-sm">
            {q.trim()
              ? `No ${tab === 'book' ? 'books' : 'items'} match “${q.trim()}”.`
              : `No ${tab === 'book' ? 'books' : 'items'} here yet.`}
          </p>
        ) : (
          <ul className="divide-border max-h-80 divide-y overflow-y-auto">
            {rows.map((row) => {
              const checked = Boolean(picks[row.id]);
              const place =
                row.item_type === 'book'
                  ? readBookStorage(row.custom_fields)
                  : readItemRack(row.custom_fields);
              const placeLabel = [
                place.rackLabel ? `Rack ${place.rackLabel}` : null,
                'crateLabel' in place && place.crateLabel
                  ? `Crate ${place.crateLabel}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={row.id}>
                  <label
                    className={cn(
                      'hover:bg-muted/40 flex cursor-pointer items-center gap-3 px-3 py-2',
                      checked && 'bg-muted/30',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(row)}
                      aria-label={`Select ${row.name}`}
                      className="border-border text-primary focus:ring-primary h-4 w-4 shrink-0 rounded"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{row.name}</span>
                      <span className="text-muted-foreground block truncate font-mono text-xs">
                        {row.sku}
                        {placeLabel ? ` · ${placeLabel}` : ''}
                      </span>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {row.quantity_on_hand} on hand
                    </span>
                  </label>
                </li>
              );
            })}
            {rows.length < total && (
              <li className="p-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    `Load more (${rows.length} of ${total})`
                  )}
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground tabular-nums" data-testid="picker-selected-bar">
          {selectedCount} item{selectedCount === 1 ? '' : 's'} selected
          {selectedCount > 0 && (
            <>
              {' · '}
              <button
                type="button"
                onClick={clear}
                className="hover:text-foreground underline underline-offset-2"
              >
                Clear
              </button>
            </>
          )}
        </span>
        <Link
          href="/dashboard/inventory"
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
        >
          or pick from the full Inventory page
        </Link>
      </div>
    </div>
  );
}

function PickerTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded px-3 py-1.5 font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
