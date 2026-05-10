'use client';

import { Loader2, Package, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { manualCreateShipmentAction } from '@/server/actions/shipments';

interface WarehouseOption {
  id: string;
  name: string;
  code: string;
}

interface CharterOption {
  id: string;
  name: string;
  code: string | null;
}

interface WarehouseCharterPair {
  warehouse_id: string;
  charter_id: string;
}

/**
 * Shape returned by /api/inventory/by-warehouse. Slim on purpose — only
 * what the picker rows render. Bigger item shapes belong in the dedicated
 * inventory list pages.
 */
interface PickerItem {
  id: string;
  sku: string;
  name: string;
  quantityOnHand: number;
  imageUrl: string | null;
}

interface FormValues {
  attentionToName: string;
  notes: string;
  ccEmails: string;
}

interface LineRow {
  itemId: string;
  qtyShipped: number;
  qtyBackOrdered: number;
}

interface ApiResponse {
  items: PickerItem[];
  nextCursor: string | null;
  total: number;
}

const PAGE_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 250;

type ItemTypeFilter = 'all' | 'book' | 'product' | 'asset' | 'consumable';

// Order intentionally puts Books first — that's the dominant L4L packing-
// slip flow. The other tabs let staff ship non-books when they need to.
const ITEM_TYPE_TABS: Array<{ value: ItemTypeFilter; label: string }> = [
  { value: 'book', label: 'Books' },
  { value: 'product', label: 'Products' },
  { value: 'asset', label: 'Assets' },
  { value: 'consumable', label: 'Consumables' },
  { value: 'all', label: 'All' },
];

export function NewShipmentForm({
  sourceWarehouses,
  charters,
  warehouseCharterPairs,
}: {
  sourceWarehouses: WarehouseOption[];
  charters: CharterOption[];
  warehouseCharterPairs: WarehouseCharterPair[];
}) {
  const router = useRouter();
  const [sourceWarehouseId, setSourceWarehouseId] = React.useState<string>(
    () => sourceWarehouses[0]?.id ?? '',
  );
  const [destinationCharterId, setDestinationCharterId] =
    React.useState<string>('');
  const [lines, setLines] = React.useState<LineRow[]>([]);
  const [submitting, setSubmitting] = React.useState(false);

  // Cache of every PickerItem we've seen across pages and warehouses, so
  // the right-hand "On this shipment" pane can resolve sku/name/thumb for
  // any line item even after the user switches the picker to a different
  // search query or warehouse and the row is no longer in the visible
  // page. Keyed by item id; never evicted within a single form session.
  const [itemCache, setItemCache] = React.useState<Map<string, PickerItem>>(
    () => new Map(),
  );

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: { attentionToName: '', notes: '', ccEmails: '' },
  });

  // Pairs indexed by warehouse_id for O(1) lookup of charter ids.
  const chartersByWarehouse = React.useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of warehouseCharterPairs) {
      const set = m.get(p.warehouse_id) ?? new Set<string>();
      set.add(p.charter_id);
      m.set(p.warehouse_id, set);
    }
    return m;
  }, [warehouseCharterPairs]);

  // Filter charters by the selected source warehouse (warehouse_charters).
  // Falls back to an empty list if no source is picked.
  const filteredCharters = React.useMemo(() => {
    if (!sourceWarehouseId) return [] as CharterOption[];
    const allowed = chartersByWarehouse.get(sourceWarehouseId);
    if (!allowed || allowed.size === 0) return [];
    return charters.filter((c) => allowed.has(c.id));
  }, [charters, chartersByWarehouse, sourceWarehouseId]);

  // When the source changes, reset the charter selection — the previously
  // chosen charter may not be in the new warehouse's service list.
  React.useEffect(() => {
    if (
      destinationCharterId &&
      !filteredCharters.some((c) => c.id === destinationCharterId)
    ) {
      setDestinationCharterId('');
    }
  }, [filteredCharters, destinationCharterId]);

  const upsertCache = React.useCallback((items: PickerItem[]) => {
    if (items.length === 0) return;
    setItemCache((prev) => {
      const next = new Map(prev);
      for (const item of items) next.set(item.id, item);
      return next;
    });
  }, []);

  function addItem(itemId: string) {
    setLines((prev) => {
      // If the item is already on the slip, just bump qty by 1 instead
      // of adding a duplicate row. (Same dedupe semantics the search-based
      // picker used to have.)
      const existing = prev.findIndex((l) => l.itemId === itemId);
      if (existing !== -1) {
        return prev.map((l, i) =>
          i === existing ? { ...l, qtyShipped: l.qtyShipped + 1 } : l,
        );
      }
      return [...prev, { itemId, qtyShipped: 1, qtyBackOrdered: 0 }];
    });
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateLine(idx: number, patch: Partial<LineRow>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  const onSubmit = handleSubmit(async (values) => {
    if (!sourceWarehouseId) {
      toast.error('Pick a source warehouse');
      return;
    }
    if (!destinationCharterId) {
      toast.error('Pick a destination charter');
      return;
    }
    if (lines.length === 0) {
      toast.error('Add at least one line item');
      return;
    }
    if (lines.some((l) => l.qtyShipped <= 0 && l.qtyBackOrdered <= 0)) {
      toast.error('Every line needs a non-zero shipped or back-ordered qty');
      return;
    }

    const ccList = values.ccEmails
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    setSubmitting(true);
    const res = await manualCreateShipmentAction({
      sourceWarehouseId,
      destinationCharterId,
      attentionToName: values.attentionToName.trim()
        ? values.attentionToName.trim()
        : null,
      notes: values.notes.trim() ? values.notes.trim() : null,
      ccEmails: ccList.length > 0 ? ccList : undefined,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        qtyShipped: l.qtyShipped,
        qtyBackOrdered: l.qtyBackOrdered,
      })),
    });
    setSubmitting(false);

    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success('Shipment draft created');
    router.push(`/dashboard/shipments/${res.data.id}`);
  });

  const canSubmit =
    !!sourceWarehouseId && !!destinationCharterId && lines.length > 0;

  const selectedSource = sourceWarehouses.find((w) => w.id === sourceWarehouseId);

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="source-wh">Source warehouse</Label>
          <Select value={sourceWarehouseId} onValueChange={setSourceWarehouseId}>
            <SelectTrigger id="source-wh">
              <SelectValue placeholder="Pick a source warehouse" />
            </SelectTrigger>
            <SelectContent>
              {sourceWarehouses.length === 0 && (
                <SelectItem value="__none" disabled>
                  No writable warehouses
                </SelectItem>
              )}
              {sourceWarehouses.map((w) => (
                <SelectItem key={w.id} value={w.id}>
                  {w.name}{' '}
                  <span className="text-muted-foreground text-xs">({w.code})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sourceWarehouses.length === 0 && (
            <p className="text-muted-foreground text-xs">
              You don&apos;t have write access to any warehouse — can&apos;t
              create a shipment.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="dest-charter">Destination charter</Label>
          <Select
            value={destinationCharterId}
            onValueChange={setDestinationCharterId}
            disabled={!sourceWarehouseId || filteredCharters.length === 0}
          >
            <SelectTrigger id="dest-charter">
              <SelectValue placeholder="Pick a destination charter" />
            </SelectTrigger>
            <SelectContent>
              {filteredCharters.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                  {c.code ? (
                    <span className="text-muted-foreground text-xs"> ({c.code})</span>
                  ) : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sourceWarehouseId && filteredCharters.length === 0 && (
            <p className="text-muted-foreground text-xs">
              This warehouse doesn&apos;t service any charters yet. Add charter
              assignments in Admin → Warehouses.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="attention">Attention to (optional)</Label>
        <Input
          id="attention"
          maxLength={200}
          placeholder="Principal, receiving clerk, etc."
          {...register('attentionToName')}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes (optional)</Label>
        <Textarea
          id="notes"
          rows={3}
          maxLength={2000}
          placeholder="Anything the receiver needs to know"
          {...register('notes')}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="cc">CC emails (optional)</Label>
        <Input
          id="cc"
          placeholder="principal@school.org, ops@charter.org"
          {...register('ccEmails')}
        />
        <p className="text-muted-foreground text-[11px]">
          Comma-separated. Used by the Phase 2B signed-PDF email.
        </p>
        {errors.ccEmails && (
          <p className="text-destructive text-xs">{errors.ccEmails.message}</p>
        )}
      </div>

      <div className="space-y-3">
        <Label>Line items</Label>
        {/*
         * Browseable two-pane picker. The left pane lists every active item
         * at the chosen source warehouse — paginated, debounced-searchable,
         * with thumbnails. Click a row to add it (or bump its qty if it's
         * already on the slip). The right pane is the current slip.
         */}
        <div className="grid gap-4 lg:grid-cols-2">
          <ItemBrowsePane
            sourceWarehouseId={sourceWarehouseId}
            sourceWarehouseName={selectedSource?.name ?? null}
            onPick={addItem}
            onItemsLoaded={upsertCache}
          />
          <ShipmentLinesPane
            lines={lines}
            itemCache={itemCache}
            onUpdate={updateLine}
            onRemove={removeLine}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.back()}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="gradient"
          disabled={submitting || !canSubmit}
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            'Create shipment'
          )}
        </Button>
      </div>
    </form>
  );
}

/**
 * Browseable, paginated list of items at the source warehouse. Fetches
 * a server page from /api/inventory/by-warehouse on warehouse change
 * and on debounced search-input change. Loads the next page when the
 * sentinel scrolls into view OR when the user clicks "Load more".
 *
 * In-flight requests are aborted on supersede so a slow page-1 fetch
 * can't stomp a fresh page-1 fetch triggered by a quicker search edit.
 */
function ItemBrowsePane({
  sourceWarehouseId,
  sourceWarehouseName,
  onPick,
  onItemsLoaded,
}: {
  sourceWarehouseId: string;
  sourceWarehouseName: string | null;
  onPick: (itemId: string) => void;
  onItemsLoaded: (items: PickerItem[]) => void;
}) {
  const [items, setItems] = React.useState<PickerItem[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [total, setTotal] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [debouncedQuery, setDebouncedQuery] = React.useState('');
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  // Item-type filter — packing slips at L4L are usually books, so 'book'
  // is the default tab. The picker still serves the other types on the
  // other tabs (assets / consumables / products / all) for the cases
  // when someone is shipping out a non-book.
  const [itemType, setItemType] = React.useState<ItemTypeFilter>('book');

  const abortRef = React.useRef<AbortController | null>(null);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const onItemsLoadedRef = React.useRef(onItemsLoaded);
  React.useEffect(() => {
    onItemsLoadedRef.current = onItemsLoaded;
  }, [onItemsLoaded]);

  // Debounce search-query changes so we don't re-fetch on every keystroke.
  React.useEffect(() => {
    const t = setTimeout(
      () => setDebouncedQuery(searchQuery.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [searchQuery]);

  /**
   * Single fetch primitive. `mode='reset'` clears the list before the
   * round trip; `mode='append'` adds the page to the end (used by the
   * sentinel + Load more). Cancels any pending request before starting.
   */
  const fetchPage = React.useCallback(
    async (
      whId: string,
      q: string,
      type: ItemTypeFilter,
      cursorParam: string | null,
      mode: 'reset' | 'append',
    ) => {
      if (!whId) return;

      // Supersede any in-flight request — slower responses must not
      // overwrite the result of a newer query.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setErrorMsg(null);

      try {
        const params = new URLSearchParams({
          warehouseId: whId,
          itemType: type,
          limit: String(PAGE_LIMIT),
        });
        if (q) params.set('q', q);
        if (cursorParam) params.set('cursor', cursorParam);

        const res = await fetch(
          `/api/inventory/by-warehouse?${params.toString()}`,
          {
            method: 'GET',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!res.ok) {
          throw new Error(`Request failed: ${res.status}`);
        }
        const data = (await res.json()) as ApiResponse;

        // Bail if a newer fetch already replaced us — controller.signal
        // would have aborted, but defensive check covers the case where
        // the response landed exactly between abort() and our handler.
        if (controller.signal.aborted) return;

        if (mode === 'reset') {
          setItems(data.items);
        } else {
          setItems((prev) => {
            // Dedupe across pages: if the picker reloads with the same
            // cursor twice (race / double-click), don't double-render
            // the same id.
            const seen = new Set(prev.map((p) => p.id));
            const fresh = data.items.filter((i) => !seen.has(i.id));
            return [...prev, ...fresh];
          });
        }
        setCursor(data.nextCursor);
        setTotal(data.total);
        onItemsLoadedRef.current(data.items);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setErrorMsg('Failed to load items. Try again.');
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    },
    [],
  );

  // Reset + fetch page 1 whenever the source warehouse or the debounced
  // search term changes. This is the canonical "page 1" trigger; the
  // sentinel/Load-more path only ever calls fetchPage with mode='append'.
  React.useEffect(() => {
    if (!sourceWarehouseId) {
      setItems([]);
      setCursor(null);
      setTotal(null);
      return;
    }
    setItems([]);
    setCursor(null);
    setTotal(null);
    void fetchPage(sourceWarehouseId, debouncedQuery, itemType, null, 'reset');
    // We intentionally cancel + re-fetch on warehouse, type, OR query change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceWarehouseId, debouncedQuery, itemType]);

  // Cleanup any in-flight fetch on unmount.
  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const loadMore = React.useCallback(() => {
    if (!sourceWarehouseId || loading || !cursor) return;
    void fetchPage(sourceWarehouseId, debouncedQuery, itemType, cursor, 'append');
  }, [sourceWarehouseId, debouncedQuery, itemType, cursor, loading, fetchPage]);

  // IntersectionObserver on the sentinel: as soon as it scrolls into view
  // the list auto-loads the next page. The scroll container is the
  // bounded-height list itself (max-h-[420px]), not the page viewport,
  // so we pass it as `root` to the observer.
  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !cursor) return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMore();
          }
        }
      },
      { root, rootMargin: '200px 0px', threshold: 0 },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [cursor, loadMore]);

  const isInitialLoad = loading && items.length === 0;
  const allLoaded = !cursor && total !== null && items.length === total;

  return (
    <div className="bg-card flex flex-col overflow-hidden rounded-md border">
      <div className="border-border space-y-2 border-b px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Available items
          {sourceWarehouseName ? (
            <span className="text-foreground/80 ml-1 normal-case tracking-normal">
              at {sourceWarehouseName}
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Item type filter">
          {ITEM_TYPE_TABS.map((t) => {
            const active = t.value === itemType;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={!sourceWarehouseId}
                onClick={() => setItemType(t.value)}
                className={
                  active
                    ? 'bg-foreground text-background rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors'
                    : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50'
                }
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Type to filter…"
          className="h-8 text-sm"
          disabled={!sourceWarehouseId}
        />
      </div>
      <div ref={scrollRef} className="max-h-[420px] overflow-y-auto">
        {!sourceWarehouseId ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-10 text-center text-xs">
            <Package className="h-5 w-5 opacity-60" />
            <p>Pick a source warehouse to see available items.</p>
          </div>
        ) : isInitialLoad ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-10 text-center text-xs">
            <Loader2 className="h-5 w-5 animate-spin opacity-60" />
            <p>Loading items…</p>
          </div>
        ) : errorMsg && items.length === 0 ? (
          <div className="text-destructive flex flex-col items-center gap-2 px-4 py-10 text-center text-xs">
            <p>{errorMsg}</p>
            <button
              type="button"
              className="underline"
              onClick={() =>
                fetchPage(sourceWarehouseId, debouncedQuery, itemType, null, 'reset')
              }
            >
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-10 text-center text-xs">
            <Package className="h-5 w-5 opacity-60" />
            <p>
              {debouncedQuery.length > 0
                ? `No items match “${debouncedQuery}”.`
                : 'No active items at this warehouse yet.'}
            </p>
          </div>
        ) : (
          <>
            <ul className="divide-border divide-y">
              {items.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    onClick={() => onPick(i.id)}
                    className="hover:bg-muted/60 focus-visible:bg-muted/60 flex w-full items-center gap-3 px-3 py-2 text-left transition-colors focus:outline-none"
                  >
                    <ItemThumb
                      imageUrl={i.imageUrl}
                      alt={i.name}
                      itemId={i.id}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-muted-foreground font-mono text-[11px]">
                        {i.sku}
                      </p>
                      <p className="truncate text-sm font-medium">{i.name}</p>
                    </div>
                    <div className="text-right">
                      <p
                        className={`tabular-nums text-sm font-medium ${
                          i.quantityOnHand <= 0
                            ? 'text-muted-foreground/60'
                            : 'text-foreground'
                        }`}
                      >
                        {i.quantityOnHand}
                      </p>
                      <p className="text-muted-foreground text-[10px] uppercase tracking-wider">
                        on hand
                      </p>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {/*
             * Sentinel + fallback button. The sentinel triggers the next
             * page automatically as the user scrolls; the button is a
             * fallback for tall viewports where the list never overflows
             * its container, plus an explicit affordance for keyboard /
             * screen-reader users.
             */}
            {cursor ? (
              <div
                ref={sentinelRef}
                className="flex items-center justify-center gap-2 px-3 py-3"
              >
                {loading ? (
                  <span className="text-muted-foreground inline-flex items-center gap-2 text-xs">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading more…
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={loadMore}
                    className="text-muted-foreground hover:text-foreground text-xs underline"
                  >
                    Load more
                  </button>
                )}
              </div>
            ) : null}
            {allLoaded && items.length > 0 ? (
              <p className="text-muted-foreground px-3 py-2 text-center text-[11px]">
                All loaded
              </p>
            ) : null}
          </>
        )}
      </div>
      {sourceWarehouseId && (items.length > 0 || total !== null) && (
        <div className="border-border bg-muted/30 text-muted-foreground border-t px-3 py-1.5 text-[11px]">
          Showing {items.length} of {total ?? '…'} items
        </div>
      )}
    </div>
  );
}

/**
 * Renders a 40×40 thumbnail when the item has a primary image, falling
 * back to the brand-styled Package icon otherwise. We swap to the icon
 * on `onError` too, since signed URLs can race expiry or the underlying
 * file can have been deleted between the API response and the <img>
 * fetch — better a placeholder than a broken-image glyph.
 */
function ItemThumb({
  imageUrl,
  alt,
  itemId,
}: {
  imageUrl: string | null;
  alt: string;
  itemId: string;
}) {
  // We track failures per-itemId so swapping back/forth in pagination
  // doesn't accidentally re-try a known-broken URL each time.
  const [failed, setFailed] = React.useState(false);
  // Reset the failed flag if the URL actually changes (e.g. a new
  // signed URL after a re-fetch). The id is included so the same image
  // for the same item with a refreshed signature resets the state.
  React.useEffect(() => {
    setFailed(false);
  }, [imageUrl, itemId]);

  if (imageUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="bg-muted h-10 w-10 flex-shrink-0 rounded-md object-cover"
      />
    );
  }
  return (
    <div className="bg-muted text-muted-foreground/70 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md">
      <Package className="h-4 w-4" />
    </div>
  );
}

function ShipmentLinesPane({
  lines,
  itemCache,
  onUpdate,
  onRemove,
}: {
  lines: LineRow[];
  itemCache: Map<string, PickerItem>;
  onUpdate: (idx: number, patch: Partial<LineRow>) => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <div className="bg-card flex flex-col overflow-hidden rounded-md border">
      <div className="border-border border-b px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          On this shipment
          <span className="text-foreground/80 ml-1 normal-case tracking-normal">
            ({lines.length} {lines.length === 1 ? 'item' : 'items'})
          </span>
        </p>
      </div>
      {lines.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-10 text-center text-xs">
          <Package className="h-5 w-5 opacity-60" />
          <p>Click items on the left to add them</p>
        </div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          {/*
           * Back-ordered (B.O.) qty is intentionally NOT exposed here.
           * Back-orders only make sense when a shipment is fulfilling a
           * pre-existing request and you couldn't ship everything asked
           * for — i.e., the order-request → shipment flow. On a manual
           * slip the user IS deciding the qty, so there's no "shortage"
           * to capture. The data model still defaults qty_back_ordered
           * to 0, and the printed PDF still has a B.O. column when it's
           * relevant.
           */}
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col />
              <col className="w-[88px]" />
              <col className="w-[56px]" />
            </colgroup>
            <thead className="bg-muted/50 text-muted-foreground text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Item</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-center font-medium sr-only">Remove</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.map((line, idx) => {
                const item = itemCache.get(line.itemId);
                return (
                  <tr key={`${line.itemId}-${idx}`}>
                    <td className="px-3 py-2 align-middle">
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {item?.sku ?? '—'}
                      </div>
                      <div className="truncate font-medium">
                        {item?.name ?? 'Unknown item'}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-middle">
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        value={line.qtyShipped}
                        onChange={(e) =>
                          onUpdate(idx, {
                            qtyShipped: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                        className="w-full text-right tabular-nums"
                        aria-label={`Qty shipped for ${item?.name ?? 'item'}`}
                      />
                    </td>
                    <td className="px-2 py-2 text-center align-middle">
                      <button
                        type="button"
                        onClick={() => onRemove(idx)}
                        aria-label={`Remove ${item?.name ?? 'item'}`}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive inline-flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors"
                        title="Remove from shipment"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
