'use client';

import { Loader2, Plus, Search, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { toast } from 'sonner';

import { BlankZeroNumberInput } from '@/components/ui/blank-zero-number-input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { isPickingSettled } from '@stockpilot/core';
import { cn, formatNumber } from '@/lib/utils';
import { addOrderRequestLinesAction } from '@/server/actions/order-requests';

import type { OrderRequestStatus } from '@/server/services/order-requests';

const PAGE_SIZE = 50;

/**
 * Statuses where OrderRequestsService.addLines throws a 'conflict' — the order
 * has shipped or is dead, so its contents are final. Mirrored here (the same
 * way CancelOrderButton mirrors its own terminal set) so the affordance never
 * renders on an order the server would refuse: staging five items and only
 * then being told the order left the building is the failure worth preventing.
 */
const SHIPPED_OR_CLOSED: OrderRequestStatus[] = ['in_transit', 'completed', 'denied', 'cancelled'];

/** Per-item requested totals already on the order — drives the top-up preview. */
export interface ExistingOrderLine {
  itemId: string;
  name: string;
  quantity: number;
}

interface Props {
  orderId: string;
  status: OrderRequestStatus;
  /** THIS order's warehouse. Every search is pinned to it because addLines
   *  rejects an item stocked anywhere else. */
  warehouseId: string;
  warehouseName: string | null;
  existingLines: ExistingOrderLine[];
}

/** Row shape returned by /api/items/search (the fields this picker needs). */
interface PickerRow {
  id: string;
  sku: string;
  name: string;
  quantity_on_hand: number;
  item_type: string;
  warehouse_id: string | null;
}

type PickerTab = 'inventory' | 'book';

/**
 * Item types the "Inventory" tab covers. The order-creation catalog
 * (server/loaders/orders-new-catalog.ts) applies NO item_type filter, so a
 * consumable or an asset can be ordered when the order is raised — sending only
 * type=product here would leave those lines impossible to top up afterwards,
 * which is the exact round trip this dialog exists to remove. Books keep their
 * own tab because that is how the rest of the app splits them.
 */
const INVENTORY_TYPES = ['product', 'asset', 'consumable'] as const;

interface StagedPick {
  row: PickerRow;
  qty: number;
}

/**
 * Copy for an empty result list.
 *
 * "No items stocked at this warehouse yet" is a claim the picker cannot
 * actually make: rows are dropped client-side when the API returns another
 * warehouse's stock, the viewer may simply have no read grant on this
 * warehouse (inventory_items_select AND-s user_can_access_inventory), and a
 * whole fetched page can be filtered away while later pages still hold
 * matches. Say what is true and give the next step instead.
 */
export function pickerEmptyMessage(input: {
  query: string;
  isBooks: boolean;
  /** More pages remain on the server — Load more is rendered below this copy. */
  morePages: boolean;
}): string {
  const noun = input.isBooks ? 'books' : 'items';
  const q = input.query.trim();
  if (q) {
    return input.morePages
      ? `No matches for “${q}” at this warehouse in the results loaded so far. Load more to keep looking.`
      : `No ${noun} at this warehouse match “${q}”.`;
  }
  return input.morePages
    ? `None of the ${noun} loaded so far are stocked at this warehouse. Load more to keep looking.`
    : `No ${noun} are available to add here. If you expect stock at this warehouse, ask an administrator for access to it.`;
}

/**
 * "2 items added", "1 line topped up", or both. Pure so the singular/plural
 * rules are testable without rendering the dialog.
 */
export function summarizeAddLines(added: number, merged: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} item${added === 1 ? '' : 's'} added`);
  if (merged > 0) parts.push(`${merged} line${merged === 1 ? '' : 's'} topped up`);
  return parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing changed.';
}

/**
 * Add items to an EXISTING order (the "customer called back and wants more"
 * case). Backed by OrderRequestsService.addLines, which tops up an item that
 * is already on the order instead of creating a duplicate line — so the tray
 * says so BEFORE submitting, since "I added 5" silently becoming "that line
 * now reads 12" is the confusing part.
 */
export function AddItemsDialog({
  orderId,
  status,
  warehouseId,
  warehouseName,
  existingLines,
}: Props) {
  const [open, setOpen] = React.useState(false);

  if (SHIPPED_OR_CLOSED.includes(status)) return null;

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add items
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add items to this order</DialogTitle>
            <DialogDescription>
              Only items stocked at {warehouseName ?? "this order's warehouse"} can be added. An
              item already on the order tops up its existing line.
            </DialogDescription>
            {/* Adding to an order whose picking is already finished is the same
                act as raising a line there: it creates units nobody has been
                told to pull. The per-line control warns about that; this path
                reached it silently, which review flagged as the same defect one
                door over. */}
            {isPickingSettled(status) && (
              <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
                Picking on this order is already complete. Anything added here will need picking
                before hand-over, or it will be reported as owed.
              </p>
            )}
          </DialogHeader>
          {/* Gated on `open` so the browse fetch is paid only when someone
              actually opens the picker — the order detail re-renders on every
              realtime refresh, and none of those should hit the search API. */}
          {open && (
            <AddItemsBody
              orderId={orderId}
              warehouseId={warehouseId}
              existingLines={existingLines}
              onClose={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AddItemsBody({
  orderId,
  warehouseId,
  existingLines,
  onClose,
}: {
  orderId: string;
  warehouseId: string;
  existingLines: ExistingOrderLine[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [tab, setTab] = React.useState<PickerTab>('inventory');
  const [q, setQ] = React.useState('');
  const [rows, setRows] = React.useState<PickerRow[]>([]);
  // Raw rows received from the server so far. This — NOT rows.length — is the
  // paging cursor, because the warehouse filter below can drop rows: paging by
  // the rendered count would re-request the same offset forever.
  const [fetched, setFetched] = React.useState(0);
  const [total, setTotal] = React.useState(0);
  const [listStatus, setListStatus] = React.useState<'loading' | 'ready' | 'failed'>('loading');
  const [loadingMore, setLoadingMore] = React.useState(false);
  // Load-more failures are NON-destructive: already-loaded rows stay rendered
  // and the button doubles as the retry.
  const [loadMoreError, setLoadMoreError] = React.useState(false);
  const [picks, setPicks] = React.useState<Record<string, StagedPick>>({});
  const [pending, setPending] = React.useState(false);
  const loadMoreAbortRef = React.useRef<AbortController | null>(null);

  const existingByItem = React.useMemo(
    () => new Map(existingLines.map((l) => [l.itemId, l.quantity])),
    [existingLines],
  );

  const buildUrl = React.useCallback(
    (offset: number): string => {
      const p = new URLSearchParams();
      // browse=1 returns a default listing before the user types anything.
      p.set('browse', '1');
      // Repeated `type` = a SET (the route reads getAll). Server-side so the
      // `total` that drives Load more counts the same rows the tab renders.
      if (tab === 'book') {
        p.set('type', 'book');
      } else {
        for (const t of INVENTORY_TYPES) p.append('type', t);
      }
      // Bundles are containers, not pickable stock. loadCatalogItems excludes
      // them from the order-creation catalog, and addLines has no bundle check
      // of its own — so without this the dialog would be the ONE path that can
      // put a bundle line on an order.
      p.set('bundles', 'exclude');
      p.set('sort', 'name_asc');
      p.set('limit', String(PAGE_SIZE));
      // Hard-pinned to THIS order's warehouse. addLines rejects an item stocked
      // anywhere else, so offering a warehouse switcher (as the cycle-count
      // picker does) would only let the user stage doomed items.
      p.set('wh', warehouseId);
      if (offset > 0) p.set('offset', String(offset));
      const needle = q.trim();
      if (needle) p.set('q', needle);
      // Deliberately no `expected=1`: an item awaiting its first receipt is
      // rejected by addLines, and the default listing already excludes them.
      return `/api/items/search?${p.toString()}`;
    },
    [tab, q, warehouseId],
  );

  // `wh=` is documented as a manager/admin convenience filter — a
  // warehouse-scoped user is force-narrowed to their own assignments
  // "regardless of what's passed", so the response can carry rows from another
  // warehouse. Every one of those would fail server-side, so drop them rather
  // than let the user stage a guaranteed rejection.
  const keep = React.useCallback(
    (incoming: PickerRow[]) => incoming.filter((r) => r.warehouse_id === warehouseId),
    [warehouseId],
  );

  React.useEffect(() => {
    const ac = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle: mark the list stale the instant a filter changes
    setListStatus('loading');
    const t = setTimeout(async () => {
      try {
        const res = await fetch(buildUrl(0), { signal: ac.signal });
        if (!res.ok) throw new Error(`search failed (${res.status})`);
        const body = (await res.json()) as { items: PickerRow[]; total: number };
        const incoming = body.items ?? [];
        setRows(keep(incoming));
        setFetched(incoming.length);
        setTotal(body.total);
        setListStatus('ready');
        setLoadMoreError(false); // fresh page 1 — any old load-more notice is moot
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setRows([]);
        setFetched(0);
        setTotal(0);
        setListStatus('failed');
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ac.abort();
      // A filter change also orphans any in-flight load-more page — abort it so
      // its stale rows can never append onto the fresh list.
      loadMoreAbortRef.current?.abort();
    };
  }, [buildUrl, keep]);

  async function loadMore() {
    if (loadingMore || listStatus !== 'ready') return;
    const ac = new AbortController();
    loadMoreAbortRef.current = ac;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const res = await fetch(buildUrl(fetched), { signal: ac.signal });
      if (!res.ok) throw new Error(`search failed (${res.status})`);
      const body = (await res.json()) as { items: PickerRow[]; total: number };
      if (ac.signal.aborted) return; // a newer fetch owns the list
      const incoming = body.items ?? [];
      setRows((prev) => {
        // De-dupe on id in case the list shifted between pages.
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...keep(incoming).filter((r) => !seen.has(r.id))];
      });
      setFetched((prev) => prev + incoming.length);
      setTotal(body.total);
    } catch {
      if (ac.signal.aborted) return; // superseded, not a failure
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  function toggle(row: PickerRow) {
    setPicks((prev) => {
      const next = { ...prev };
      if (next[row.id]) {
        delete next[row.id];
      } else {
        // Default 1, never 0: BlankZeroNumberInput renders 0 as an empty field,
        // and a blank quantity on stage reads as a broken input.
        next[row.id] = { row, qty: 1 };
      }
      return next;
    });
  }

  function setQty(itemId: string, qty: number) {
    setPicks((prev) => {
      const current = prev[itemId];
      if (!current) return prev;
      return { ...prev, [itemId]: { ...current, qty } };
    });
  }

  function unpick(itemId: string) {
    setPicks((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }

  const entries = Object.values(picks);
  const invalidQty = entries.some((p) => !Number.isFinite(p.qty) || p.qty <= 0);

  async function submit() {
    setPending(true);
    const res = await addOrderRequestLinesAction({
      id: orderId,
      lines: entries.map((p) => ({ itemId: p.row.id, quantity: p.qty })),
    });
    setPending(false);
    if (!res.ok) {
      // Keep the dialog open with the staged picks intact: a conflict (the
      // order shipped in another tab) or a forbidden is worth reading with the
      // work still on screen, and re-staging ten items is punitive.
      toast.error(res.error.message);
      return;
    }
    const { added, merged, pickSlipStale } = res.data;
    toast.success(summarizeAddLines(added, merged));
    if (pickSlipStale) {
      // The sheet in the picker's hand no longer matches the order.
      toast.warning('The printed pick slip is now out of date. Generate it again before picking.', {
        duration: 8000,
      });
    }
    setPicks({});
    onClose();
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="bg-muted/50 inline-flex rounded-md p-0.5 text-sm">
        <PickerTabButton active={tab === 'inventory'} onClick={() => setTab('inventory')}>
          Inventory
        </PickerTabButton>
        <PickerTabButton active={tab === 'book'} onClick={() => setTab('book')}>
          Books
        </PickerTabButton>
      </div>

      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            tab === 'book'
              ? 'Search books by title, SKU, barcode…'
              : 'Search items by name, SKU, barcode…'
          }
          className="pl-8"
          aria-label="Search items to add"
        />
      </div>

      <div className="border-border overflow-hidden rounded-md border">
        {listStatus === 'loading' ? (
          <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading items…
          </div>
        ) : listStatus === 'failed' ? (
          <p className="text-muted-foreground px-3 py-8 text-center text-sm">
            Couldn&apos;t load items. Check your connection and try again.
          </p>
        ) : (
          <>
            {rows.length === 0 ? (
              <p className="text-muted-foreground px-3 py-8 text-center text-sm">
                {pickerEmptyMessage({
                  query: q,
                  isBooks: tab === 'book',
                  morePages: fetched < total,
                })}
              </p>
            ) : (
              <ul className="divide-border max-h-72 divide-y overflow-y-auto">
                {rows.map((row) => {
                  const staged = Boolean(picks[row.id]);
                  const onOrder = existingByItem.get(row.id);
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        aria-label={`Select ${row.name}`}
                        aria-pressed={staged}
                        onClick={() => toggle(row)}
                        className={cn(
                          'hover:bg-muted/40 flex w-full items-center gap-3 px-3 py-2 text-left',
                          staged && 'bg-muted/30',
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{row.name}</span>
                          <span className="text-muted-foreground block truncate font-mono text-xs">
                            {row.sku}
                          </span>
                        </span>
                        {onOrder !== undefined && (
                          <span className="shrink-0 text-xs tabular-nums text-amber-700 dark:text-amber-300">
                            On order · {formatNumber(onOrder)}
                          </span>
                        )}
                        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                          {formatNumber(row.quantity_on_hand)} on hand
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {/*
             * OUTSIDE the rows.length ternary on purpose. Nested inside it,
             * a page whose rows were all dropped by the warehouse filter
             * rendered an empty state with no way to reach page 2 — and
             * InventoryService.list ignores `wh=` for warehouse-scoped users,
             * so a full page of another warehouse's stock is routine, not
             * exotic. Load more must depend only on pages remaining.
             */}
            {fetched < total && (
              <div className="border-border border-t p-2">
                {loadMoreError && (
                  <p className="text-destructive pb-1.5 text-center text-xs" role="alert">
                    Couldn&apos;t load more — try again.
                  </p>
                )}
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
                    `Load more (${fetched} of ${total})`
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-border overflow-hidden rounded-md border">
        <div className="border-border bg-muted/30 border-b px-3 py-2">
          <h3 className="text-xs font-medium">Selected ({entries.length})</h3>
        </div>
        {entries.length === 0 ? (
          <p className="text-muted-foreground px-3 py-4 text-center text-xs">
            Pick items above to add them to this order.
          </p>
        ) : (
          <ul className="divide-border max-h-48 divide-y overflow-y-auto">
            {entries.map((p) => {
              const onOrder = existingByItem.get(p.row.id);
              return (
                <li key={p.row.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{p.row.name}</span>
                    <span className="text-muted-foreground block truncate font-mono text-xs">
                      {p.row.sku}
                    </span>
                    {onOrder !== undefined && (
                      // The one thing worth saying BEFORE submitting: this does
                      // not create a second line, it grows one already there.
                      //
                      // Phrased as the ITEM total, not "line to N": addLines
                      // builds existingByItem as a Map over the order's line
                      // rows, so on an order carrying two lines of the same
                      // item only the LAST row is topped up and no single line
                      // ever reads this number. The item total is the figure
                      // that is true either way.
                      <span className="block text-xs text-amber-700 dark:text-amber-300">
                        Already on this order — {formatNumber(onOrder)} requested, going to{' '}
                        {formatNumber(onOrder + (Number.isFinite(p.qty) ? p.qty : 0))} in total
                      </span>
                    )}
                  </span>
                  <BlankZeroNumberInput
                    value={p.qty}
                    onValueChange={(n) => setQty(p.row.id, n)}
                    min={1}
                    step={1}
                    className="w-20 text-right tabular-nums"
                    aria-label={`Quantity for ${p.row.name}`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${p.row.name}`}
                    onClick={() => unpick(p.row.id)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={submit}
          // Stay disabled rather than surface a server validation error for a
          // rule enforceable at the keystroke: addLines rejects any qty <= 0.
          disabled={pending || entries.length === 0 || invalidQty}
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <>
              <Plus className="mr-1 h-4 w-4" /> Add to order
            </>
          )}
        </Button>
      </DialogFooter>
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
