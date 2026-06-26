'use client';

import { ChevronDown, Download, Loader2, Pin, Plus, ScanLine, Search, Users, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { BulkActions } from '@/components/inventory/bulk-actions';
import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import { useCountSelection } from '@/lib/cycle-counts/use-count-selection';
import {
  createSavedViewAction,
  deleteSavedViewAction,
  setActiveWarehouseAction,
  toggleSavedViewShareAction,
} from '@/server/actions/saved-views';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import {
  ImageHoverPreview,
  prewarmPreviewImages,
} from '@/components/ui/image-hover-preview';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { downloadInventoryExport, type InventoryExportRequest } from '@/lib/download-export';
import { Sparkline } from '@/components/ui/sparkline';
import { StockBar } from '@/components/ui/stock-bar';
import { getCrateColor, readBookStorage, readItemRack } from '@/lib/book-storage';
import { rememberLastListUrl } from '@/lib/last-list-url';
import { formatCurrency, formatNumber, formatRelative } from '@/lib/utils';
import { cn } from '@/lib/utils';

interface Item {
  id: string;
  sku: string;
  name: string;
  status: 'active' | 'archived' | 'discontinued';
  quantity_on_hand: number;
  reorder_point: number;
  unit_cost: number;
  retail_price: number;
  category_id: string | null;
  charter_id: string | null;
  primary_location_id: string | null;
  updated_at: string;
  custom_fields?: Record<string, unknown> | null;
  /** Signed URL to the master (2048px) image. Used by hover-preview
   * prefetch + the lightbox. Falls back to a custom_fields.thumbnail_url
   * stash for legacy bulk-imported books. */
  image_url?: string | null;
  /** Signed URL to the pre-resized ~200px WebP thumb (item_images.thumb_path,
   * populated by uploads after migration 0122). When null the row falls
   * back to image_url so the Vercel Image Optimizer downscales the master
   * — same as the pre-thumb behavior. */
  image_thumb_url?: string | null;
  /** Base64 data URL of a 16x16 WebP blur placeholder
   * (item_images.lqip, populated after migration 0122). Threaded into
   * next/image's blurDataURL when present. */
  image_lqip?: string | null;
  /** Quantity that has been confirmed placed into a rack/crate location
   * (from staging). Added by Task 6 — optional so older callers that
   * don't pass it still render correctly (defaults to quantity_on_hand). */
  placed_quantity?: number;
  /** Quantity received into a PO staging buffer but not yet placed.
   * Added by Task 6 — optional so older callers that don't pass it
   * still render correctly (defaults to 0 = no staged line shown). */
  staged_quantity?: number;
}

interface Lookups {
  categories: Map<string, { name: string; color: string | null }>;
  locations: Map<string, { name: string }>;
  /** Charter id → display name + short code. Missing-key rows render
   *  the "Generic" pill (any charter the warehouse services can use). */
  charters?: Map<string, { name: string; code: string | null }>;
}

export interface InventoryTableProps {
  items: Item[];
  lookups: Lookups;
  /** Lists used by the bulk actions bar AND the new filter dropdowns.
      Passed from the page server fetch so the toolbar can render
      checkbox lists without an extra round trip. */
  categories?: Array<{ id: string; name: string }>;
  /** Locations available for the filter dropdown. */
  locations?: Array<{ id: string; name: string }>;
  /** Charters available for the filter dropdown. */
  charters?: Array<{ id: string; name: string; code: string | null }>;
  suppliers?: Array<{ id: string; name: string }>;
  /** Org tag list — forwarded to BulkActions for the Add/Remove tags
      dialogs. Defaults to [] so older callers don't crash. */
  tags?: Array<{ id: string; name: string; color: string | null }>;
  total: number;
  /** Sum of (unit_cost × quantity_on_hand) across the FULL filtered
   *  result set, not just the current page. Server-computed in
   *  InventoryService.list so paginating doesn't change the footer
   *  total. Optional for back-compat; older callers fall back to a
   *  page-only sum. */
  valueOnHand?: number;
  initialQuery?: string;
  /**
   * URL prefix for the row click target. Used so the Books tab can
   * link to /dashboard/books/{id} (keeping users in the books context)
   * while the default Items tab links to /dashboard/inventory/{id}.
   */
  rowLinkPrefix?: string;
  /**
   * Base path for the filter chips ("All items / Low + critical /
   * Out of stock"). Defaults to /dashboard/inventory; pass
   * /dashboard/books from the books tab so chips don't jump tabs.
   */
  basePath?: string;
  /**
   * When true, the table renders book-specific columns: Rack
   * (number-row, e.g. "38-A") and Crate (color dot + number).
   * Driven by reading custom_fields.book_* off each row. Used by
   * the Books tab; the default Items tab leaves the columns out.
   */
  showBookFields?: boolean;
  /**
   * Whether the current viewer can create new items. Drives the
   * "+ New item/book" button that sits at the bottom right of the
   * table next to pagination. Page passes this from a
   * can(ctx, 'items:create') check.
   */
  canCreate?: boolean;
  /**
   * When provided, renders a small camera button inside the search
   * input on the right edge. Click invokes the callback so the
   * parent can open its own scanner modal + handle the result. The
   * table never imports IsbnScanner itself — keeps the dependency
   * direction one-way.
   */
  onScanRequest?: () => void;
  /** 1-based current page. Default 1 — pagination UI hides if total ≤ pageSize. */
  page?: number;
  /** How many rows per page. Drives the page count math. */
  pageSize?: number;
  /** Per-item 14-day series (qty trend + move count) keyed by item id.
      When omitted or a row is missing, the sparkline falls back to a
      flat line at current quantity. Computed by getItemTrends in
      services/movements.ts. */
  trends?: Map<string, { qtySeries: number[]; moveSeries: number[] }>;
  /** User's saved views for this scope. Renders as chips alongside the
      built-in All / Low / Out chips. Pass [] (or omit) for tabs that
      haven't loaded any. */
  savedViews?: SavedViewSummary[];
  /** Which scope these views belong to ('inventory' or 'books'). The
      tab page knows which it is; we forward that to the create/delete
      server actions so they revalidate the right path. */
  savedViewScope?: 'inventory' | 'books';
  /** Currently active warehouse id (from cookie via the layout). Saved
      views capture this alongside URL params so applying a view can
      restore both axes. */
  activeWarehouseId?: string | null;
  /** Current user id — used to decide whether to show owner-only
      actions (share toggle, delete) on org-shared saved views. */
  currentUserId?: string | null;
  /** Active stock_reservations summed per item id. ONLY the rentals
      items list passes this. Rentals reserve stock instead of
      decrementing on-hand, so a row with reserved > 0 renders a small
      secondary "{available} avail · {reserved} out" indicator under the
      On hand cell. Absent (inventory + books lists) → the On hand cell
      renders exactly as before, byte-identical. */
  reservedByItem?: Map<string, number>;
}

interface SavedViewSummary {
  id: string;
  name: string;
  state: {
    q?: string;
    status?: string;
    stock?: string;
    type?: string;
    sort?: string;
    cat?: string[];
    loc?: string[];
    warehouseId?: string | null;
  };
  /** True when shared with the whole org. Non-owner viewers see a
      read-only chip with a small Users icon. */
  isShared?: boolean;
  /** Owner's user id. Only the owner sees the delete + share-toggle
      controls on the chip; everyone else gets a click-to-apply chip. */
  ownerId?: string;
}

type SparkMode = 'qty' | 'moves';
const SPARK_MODE_KEY = 'stockpilot:inventory:sparkline-mode';

type StockView = 'placed' | 'total';
const STOCK_VIEW_KEY = 'stockpilot:inventory:stock-view';

const VIEWS = ['All items', 'Low + critical', 'Out of stock'] as const;
type View = (typeof VIEWS)[number];

function paramsToView(stock: string | null): View {
  if (stock === 'low') return 'Low + critical';
  if (stock === 'out') return 'Out of stock';
  return 'All items';
}

type SortKey =
  | 'updated_desc'
  | 'updated_asc'
  | 'name_asc'
  | 'name_desc'
  | 'sku_asc'
  | 'sku_desc'
  | 'qty_desc'
  | 'qty_asc'
  | 'created_desc'
  | 'created_asc';

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'updated_desc', label: 'Last updated (newest)' },
  { value: 'updated_asc', label: 'Last updated (oldest)' },
  { value: 'name_asc', label: 'Name (A → Z)' },
  { value: 'name_desc', label: 'Name (Z → A)' },
  { value: 'sku_asc', label: 'SKU (A → Z)' },
  { value: 'sku_desc', label: 'SKU (Z → A)' },
  { value: 'qty_desc', label: 'On hand (high → low)' },
  { value: 'qty_asc', label: 'On hand (low → high)' },
  { value: 'created_desc', label: 'Created (newest)' },
  { value: 'created_asc', label: 'Created (oldest)' },
];

function paramsToSort(value: string | null): SortKey {
  const found = SORT_OPTIONS.find((o) => o.value === value);
  return found?.value ?? 'updated_desc';
}

function paramsToIdSet(params: URLSearchParams, key: string): Set<string> {
  return new Set(params.getAll(key).filter(Boolean));
}

function deriveStatus(qty: number, reorder: number): 'ok' | 'warn' | 'crit' {
  if (qty <= 0) return 'crit';
  if (reorder > 0 && qty <= reorder) return 'warn';
  return 'ok';
}

/**
 * Returns the 14-day series to plot for a row, given the active spark
 * mode and the trends map from getItemTrends. Falls back to a flat
 * line at current qty (or zero, for moves) when trends data is missing
 * — e.g. parent forgot to pass `trends`, or the item had no movements.
 */
function seriesForRow(
  itemId: string,
  currentQty: number,
  mode: SparkMode,
  trends: InventoryTableProps['trends'],
): number[] {
  const t = trends?.get(itemId);
  if (t) return mode === 'qty' ? t.qtySeries : t.moveSeries;
  return new Array<number>(14).fill(mode === 'qty' ? currentQty : 0);
}

export function InventoryTable({
  items,
  lookups,
  categories = [],
  locations = [],
  charters = [],
  suppliers = [],
  tags = [],
  total,
  valueOnHand: valueOnHandProp,
  initialQuery = '',
  rowLinkPrefix = '/dashboard/inventory',
  basePath = '/dashboard/inventory',
  showBookFields = false,
  canCreate = true,
  onScanRequest,
  page = 1,
  pageSize = 50,
  trends,
  savedViews = [],
  savedViewScope,
  activeWarehouseId = null,
  currentUserId = null,
  reservedByItem,
}: InventoryTableProps) {
  // Sparkline mode preference. localStorage-backed so it sticks across
  // reloads + tabs but doesn't pollute URLs (it's a personal preference,
  // not a query filter). MUST initialize to the server-safe default
  // ('qty') so the SSR markup matches the client's first hydration —
  // reading localStorage in the initializer caused React error #418
  // because the server always saw 'qty' and the client might pick
  // 'moves'. We swap in the stored preference post-mount via the
  // effect below; ‑any sparkline columns rendered during hydration
  // briefly show qty mode before flipping. This is exactly the
  // tradeoff React's docs recommend for storage-backed UI state.
  const [sparkMode, setSparkMode] = React.useState<SparkMode>('qty');
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(SPARK_MODE_KEY);
    if (stored === 'moves' && sparkMode !== 'moves') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
      setSparkMode('moves');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SPARK_MODE_KEY, sparkMode);
  }, [sparkMode]);

  // Stock view preference: 'placed' = placed-only on-hand; 'total' = placed + staged.
  // Same SSR-safe init pattern as sparkMode above — server always sees 'placed'
  // so the hydration markup matches, then we swap in the stored preference post-mount.
  const [stockView, setStockView] = React.useState<StockView>('placed');
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STOCK_VIEW_KEY);
    if (stored === 'total') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
      setStockView('total');
    }
  }, []);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STOCK_VIEW_KEY, stockView);
  }, [stockView]);

  const router = useRouter();
  // Filter / sort / page navigations re-run the server component. Wrapping the
  // router.replace in a transition keeps the current rows interactive and
  // exposes isFilterPending so we can show an immediate "updating" state —
  // otherwise a category/charter/location change looks frozen until the
  // round-trip lands, which reads as "super slow".
  const [isFilterPending, startFilterTransition] = React.useTransition();
  const addToCount = useCountSelection((s) => s.add);
  const params = useSearchParams();
  const [q, setQ] = React.useState(initialQuery);
  // Server-authoritative search hits — populated after a debounced
  // fetch to /api/items/search. `null` means "no server result yet,
  // fall back to localMatches"; an empty array means "server says
  // zero matches". Cleared when q goes back to empty.
  const [serverHits, setServerHits] = React.useState<Item[] | null>(null);
  const [serverLoading, setServerLoading] = React.useState(false);

  // Instant local filter on every keystroke. Substring match against
  // name / sku / barcode of the rows already on this page. Renders
  // before the server fetch comes back so the user gets immediate
  // feedback; the server result then supersedes via `displayed` below.
  const localMatches = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((i) => {
      const name = (i.name ?? '').toLowerCase();
      const sku = (i.sku ?? '').toLowerCase();
      const barcode = (
        (i as { barcode?: string | null }).barcode ?? ''
      ).toLowerCase();
      return (
        name.includes(needle) || sku.includes(needle) || barcode.includes(needle)
      );
    });
  }, [items, q]);

  const view = paramsToView(params.get('stock'));
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const sort = paramsToSort(params.get('sort'));
  const categoryIds = React.useMemo(
    () => paramsToIdSet(new URLSearchParams(params.toString()), 'cat'),
    [params],
  );
  const locationIds = React.useMemo(
    () => paramsToIdSet(new URLSearchParams(params.toString()), 'loc'),
    [params],
  );
  const charterIds = React.useMemo(
    () => paramsToIdSet(new URLSearchParams(params.toString()), 'charter'),
    [params],
  );

  function hrefForView(v: View): string {
    const next = new URLSearchParams(params.toString());
    if (v === 'Low + critical') next.set('stock', 'low');
    else if (v === 'Out of stock') next.set('stock', 'out');
    else next.delete('stock');
    // Switching the view always reset to page 1 — staying on page 5
    // of "All items" doesn't make sense if Out-of-stock has 1 page.
    next.delete('page');
    const qs = next.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  function hrefForPage(p: number): string {
    const next = new URLSearchParams(params.toString());
    if (p <= 1) next.delete('page');
    else next.set('page', String(p));
    const qs = next.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  // Encoded full current list URL — used to round-trip search/filter
  // state when the user clicks into a row, views, and comes back.
  // Recomputes when `params`, `basePath`, or the live `q` state
  // changes. We merge `q` into the URL explicitly because the search
  // box writes to React state immediately but only debounces into
  // the URL after 150ms — clicking a row mid-keystroke would
  // otherwise lose the typed-but-not-yet-committed search.
  const currentListUrl = React.useMemo(() => {
    const next = new URLSearchParams(params.toString());
    const trimmed = q.trim();
    if (trimmed) next.set('q', trimmed);
    else next.delete('q');
    const qs = next.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }, [params, basePath, q]);

  // Persist the live list URL to sessionStorage so the edit / variant
  // / bulk-create flows can bounce the user back to the exact page +
  // filter state they were on — even when the `?return=` chain breaks
  // (direct URL entry, mid-flight cmd-click, autocomplete, etc).
  // Cheap (a single sessionStorage write per param change).
  React.useEffect(() => {
    rememberLastListUrl(basePath, currentListUrl);
  }, [basePath, currentListUrl]);

  function navigateWith(mutator: (p: URLSearchParams) => void) {
    const next = new URLSearchParams(params.toString());
    mutator(next);
    // Filter / sort changes always reset to page 1 — staying on page 5
    // would be wrong if the new result set is shorter.
    next.delete('page');
    const qs = next.toString();
    // Transition so the click registers instantly (table shows a pending
    // state) instead of appearing frozen during the server round-trip.
    startFilterTransition(() => {
      router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
    });
  }

  function setSort(key: SortKey) {
    navigateWith((next) => {
      if (key === 'updated_desc') next.delete('sort');
      else next.set('sort', key);
    });
  }

  function setMultiParam(key: 'cat' | 'loc' | 'charter', ids: Set<string>) {
    navigateWith((next) => {
      next.delete(key);
      for (const id of ids) next.append(key, id);
    });
  }

  const activeFilterCount = categoryIds.size + locationIds.size + charterIds.size;
  function clearAllFilters() {
    navigateWith((next) => {
      next.delete('cat');
      next.delete('loc');
      next.delete('charter');
      next.delete('sort');
      next.delete('q');
      setQ('');
    });
  }

  // Instant-search flow. On every q change:
  //   1. localMatches has already updated synchronously (see useMemo
  //      above) — the table is already showing the user's typed-filter
  //      view.
  //   2. After 150ms of no further typing, fetch /api/items/search
  //      with q + the page's current URL filters so we catch matches
  //      on other pages.
  //   3. Update the URL via history.replaceState (NOT router.replace)
  //      so Next.js App Router doesn't re-execute the parent server
  //      component and re-fetch all 8 page queries — that's the bug
  //      this whole effort is escaping.
  //
  // AbortController cancels in-flight requests on rapid typing. On
  // any error we silently fall back to localMatches (which is still
  // mounted) — no toast, no UX disruption.
  React.useEffect(() => {
    const needle = q.trim();
    if (!needle) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
      setServerHits(null);
      setServerLoading(false);
      // Clear the q param from the URL when the user empties the box.
      // Use router.replace (not history.replaceState) so Next.js
      // re-runs the server component and re-fetches the FULL item
      // list — otherwise the page stays seeded with whatever
      // filtered set the URL was loaded with (e.g. after a round
      // trip from the detail page that started with ?q=lanyard,
      // clearing the box would leave only the lanyard rows on
      // screen because the page-level fetch never re-ran).
      const next = new URLSearchParams(params.toString());
      if (next.has('q') || next.has('page')) {
        next.delete('q');
        next.delete('page');
        const qs = next.toString();
        const newUrl = qs ? `${basePath}?${qs}` : basePath;
        router.replace(newUrl, { scroll: false });
      }
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setServerLoading(true);
      try {
        const url = new URL('/api/items/search', window.location.origin);
        url.searchParams.set('q', needle);
        for (const k of ['type', 'status', 'stock', 'sort', 'rack']) {
          const v = params.get(k);
          if (v) url.searchParams.set(k, v);
        }
        for (const v of params.getAll('cat')) url.searchParams.append('cat', v);
        for (const v of params.getAll('loc')) url.searchParams.append('loc', v);
        // Scope the API query to the tab's item type when the URL
        // didn't explicitly set ?type=. The books tab passes
        // `showBookFields` and its page-level fetch hardcodes
        // `itemType: 'book'`, but that's invisible to the API URL
        // — without this override, the endpoint defaults to
        // 'product' (the InventoryService default) and books get
        // filtered out of the search results.
        if (!url.searchParams.has('type') && showBookFields) {
          url.searchParams.set('type', 'book');
        }
        url.searchParams.set('limit', String(pageSize));

        const res = await fetch(url.toString(), { signal: ctrl.signal });
        if (!res.ok) throw new Error(`search failed: ${res.status}`);
        const data = (await res.json()) as { items: Item[]; total: number };
        setServerHits(data.items);

        // URL update LAST. history.replaceState updates the address
        // bar without invoking Next.js's router, so the page-level
        // server component doesn't re-execute. router.replace would
        // — and that's exactly the page-reload-per-keystroke we're
        // escaping.
        const next = new URLSearchParams(params.toString());
        next.set('q', needle);
        next.delete('page');
        const newUrl = `${basePath}?${next.toString()}`;
        window.history.replaceState(null, '', newUrl);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          // Silent fall-back to localMatches. Don't toast — the user
          // already has results on screen; a toast would imply
          // something is broken when it isn't.
          setServerHits(null);
        }
      } finally {
        setServerLoading(false);
      }
    }, 150);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(items.map((i) => i.id)) : new Set());
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Prefer the server-computed org-wide value (covers ALL pages of
  // the current filter set). Falls back to a page-only sum for any
  // legacy caller that doesn't pass the prop yet.
  const valueOnHand =
    valueOnHandProp ??
    items.reduce((s, it) => s + it.quantity_on_hand * it.unit_cost, 0);

  // What the table actually renders. Priority: server-authoritative
  // result if we have one (covers cross-page matches), else the
  // synchronous local filter (covers in-page matches with zero
  // latency). On no search, both reduce to `items`.
  const displayed = serverHits ?? localMatches;

  // Idle-prewarm the Vercel-optimized hover-preview URLs for every
  // visible row. Runs via requestIdleCallback so it never competes
  // with the initial paint; by the time the user mouses over any
  // thumbnail, the bigger preview variant is already in HTTP cache
  // and the popover paints in the same frame as the open delay.
  // De-duped internally by the preloader, so re-renders are free.
  const displayedImageSrcs = displayed.map((i) => i.image_url ?? null);
  const prewarmKey = displayedImageSrcs.filter(Boolean).join('|');
  React.useEffect(() => {
    prewarmPreviewImages(displayedImageSrcs);
    // The string-joined key is the cheap stable dep — the array would
    // be a fresh reference every render and re-fire on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prewarmKey]);

  return (
    <div className="space-y-4">
      {/* Saved views — built-in chips first, then user-saved, then save button */}
      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => (
          <Link
            key={v}
            href={hrefForView(v)}
            scroll={false}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors',
              v === view
                ? 'border-foreground bg-foreground text-background'
                : 'border-border bg-background text-[var(--ed-ink-2)] hover:border-[var(--ed-line-strong)]',
            )}
          >
            {v}
          </Link>
        ))}
        {savedViews.map((sv) => (
          <SavedViewChip
            key={sv.id}
            view={sv}
            isActive={isSavedViewActive(sv, params, activeWarehouseId)}
            scope={savedViewScope ?? (showBookFields ? 'books' : 'inventory')}
            basePath={basePath}
            isOwner={!!currentUserId && sv.ownerId === currentUserId}
          />
        ))}
        {savedViewScope && (
          <SaveCurrentViewButton
            scope={savedViewScope}
            currentState={readCurrentState(params, activeWarehouseId)}
          />
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ed-ink-4)]" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, SKU, barcode…"
            className={cn('h-8 pl-8 text-[12.5px]', onScanRequest && 'pr-8')}
            aria-label="Search items"
          />
          {onScanRequest && (
            <button
              type="button"
              onClick={onScanRequest}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--ed-ink-4)] transition-colors hover:text-foreground"
              aria-label="Scan barcode"
            >
              <ScanLine className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <SortMenu value={sort} onChange={setSort} />

        {categories.length > 0 && (
          <MultiSelectFilter
            label="Category"
            options={categories}
            selected={categoryIds}
            onChange={(ids) => setMultiParam('cat', ids)}
          />
        )}

        {locations.length > 0 && (
          <MultiSelectFilter
            label="Location"
            options={locations}
            selected={locationIds}
            onChange={(ids) => setMultiParam('loc', ids)}
          />
        )}

        {charters.length > 0 && (
          <MultiSelectFilter
            label="Charter"
            // "Generic" is the sentinel for items with charter_id IS NULL
            // — stock that any charter the warehouse services can use.
            // Sits at the top so the most common pick is immediately
            // reachable; real charters follow in their natural order.
            options={[
              { id: 'generic', name: 'Generic (any charter)' },
              ...charters.map((c) => ({
                id: c.id,
                name: c.code ? `${c.name} · ${c.code}` : c.name,
              })),
            ]}
            selected={charterIds}
            onChange={(ids) => setMultiParam('charter', ids)}
          />
        )}

        {(activeFilterCount > 0 || params.get('sort') || q.trim()) && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed border-border px-2.5 text-[11.5px] text-[var(--ed-ink-3)] transition-colors hover:border-[var(--ed-line-strong)] hover:text-foreground"
            aria-label="Clear all filters"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}

        <button
          type="button"
          onClick={() => setStockView((v) => (v === 'placed' ? 'total' : 'placed'))}
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2.5 text-[11.5px] text-[var(--ed-ink-3)] transition-colors hover:border-[var(--ed-line-strong)] hover:text-foreground"
          aria-label="Toggle on-hand view"
          title="Switch between placed-only and placed+staged on-hand"
        >
          {stockView === 'placed' ? 'On hand: placed' : 'On hand: placed + staged'}
        </button>

        <ExportMenu
          params={params}
          itemType={showBookFields ? 'book' : params.get('type') ?? 'product'}
        />

        <p className="ml-auto font-mono text-[11px] tabular-nums text-[var(--ed-ink-3)]">
          {(() => {
            const needle = q.trim();
            if (!needle) {
              return (
                <>
                  {formatNumber(total)} SKUs · {formatCurrency(valueOnHand)} on hand
                </>
              );
            }
            return (
              <>
                Showing {formatNumber(displayed.length)} matching &ldquo;{needle}&rdquo;
                {serverLoading ? ' (searching…)' : null}
              </>
            );
          })()}
        </p>
      </div>

      {/* Bulk actions bar */}
      {selected.size > 0 && (
        <BulkActions
          selectedIds={[...selected]}
          categories={categories}
          suppliers={suppliers}
          locations={locations}
          tags={tags}
          onClear={() => setSelected(new Set())}
          hasArchivedSelection={items.some(
            (i) => selected.has(i.id) && i.status === 'archived',
          )}
          onCycleCount={() => {
            // Books tab and Items tab share this table; infer the pick
            // type from the base path so the confirm screen can group
            // Products vs Books. sku/name are display-only — the server
            // re-validates by id.
            const itemType = basePath.includes('/books') ? 'book' : 'product';
            const byId = new Map<string, Item>();
            for (const r of items) byId.set(r.id, r);
            for (const r of serverHits ?? []) byId.set(r.id, r);
            const picks = [...selected].map((id) => {
              const r = byId.get(id);
              return { id, sku: r?.sku ?? '', name: r?.name ?? 'Item', itemType };
            });
            addToCount(picks);
            setSelected(new Set());
            router.push('/dashboard/cycle-counts/new');
          }}
        />
      )}

      {/* Top pagination — mirrors the bottom one so users on long lists
          don't have to scroll to the bottom to flip pages. Same component,
          same URL state, same buildHref. Hides on single-page lists for
          the same reason the bottom one does. Also hides during an active
          search because the server response delivers the full filtered
          set up to the limit — pages recompose once `q` clears. */}
      {!q.trim() && total > pageSize && (
        <div className="flex items-center justify-end">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            buildHref={hrefForPage}
          />
        </div>
      )}

      {/* Table */}
      <div
        aria-busy={isFilterPending}
        className={cn(
          'overflow-x-auto rounded-[10px] border border-border bg-card transition-opacity',
          isFilterPending && 'pointer-events-none opacity-60',
        )}
      >
        <table className="w-full min-w-[720px] text-[12.5px]">
          <thead>
            <tr className="border-b border-border">
              <th className="w-8 px-3">
                <Checkbox
                  checked={items.length > 0 && selected.size === items.length}
                  onChange={(c) => toggleAll(c)}
                />
              </th>
              {(
                [
                  ['Item', 'left'],
                  ['SKU', 'left'],
                  ['Category', 'left'],
                  ['Charter', 'left'],
                  ['Location', 'left'],
                  ...(showBookFields
                    ? ([
                        ['Grade', 'left'],
                        ['Rack', 'left'],
                        ['Crate', 'left'],
                      ] as const)
                    : ([['Rack', 'left']] as const)),
                  ['On hand', 'right'],
                  ['Coverage', 'left'],
                  ['14-day', 'right'],
                  ['Status', 'left'],
                  ['Updated', 'right'],
                ] as ReadonlyArray<readonly [string, 'left' | 'right']>
              ).map(([label, align]) => (
                <th
                  key={label}
                  className={cn(
                    'h-9 px-3 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]',
                    align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {label === '14-day' ? (
                    <SparkModeToggle mode={sparkMode} onChange={setSparkMode} />
                  ) : (
                    label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayed.length === 0 && (
              <tr>
                <td
                  colSpan={showBookFields ? 14 : 12}
                  className="py-12 text-center text-[12.5px] text-[var(--ed-ink-4)]"
                >
                  No items match your filters.
                </td>
              </tr>
            )}
            {displayed.map((item, rowIdx) => {
              const category = item.category_id ? lookups.categories.get(item.category_id) : null;
              const location = item.primary_location_id
                ? lookups.locations.get(item.primary_location_id)
                : null;
              const status = deriveStatus(item.quantity_on_hand, item.reorder_point);
              const par = Math.max(item.reorder_point * 4, item.quantity_on_hand * 1.5, 10);
              const series = seriesForRow(
                item.id,
                item.quantity_on_hand,
                sparkMode,
                trends,
              );
              const isSelected = selected.has(item.id);

              return (
                <tr
                  key={item.id}
                  className={cn(
                    'border-b border-border transition-colors last:border-0',
                    isSelected ? 'bg-[hsl(var(--accent)/0.10)]' : 'hover:bg-muted/60',
                  )}
                >
                  <td className="px-3">
                    <Checkbox checked={isSelected} onChange={() => toggleOne(item.id)} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-2.5">
                      <ImageHoverPreview
                        src={item.image_url ?? null}
                        alt={item.name}
                        title={item.name}
                        subtitle={item.sku}
                        meta={
                          <span>
                            On hand{' '}
                            <span className="text-foreground font-medium tabular-nums">
                              {formatNumber(item.quantity_on_hand)}
                            </span>
                          </span>
                        }
                        className="shrink-0"
                      >
                        {item.image_url ? (
                          <Image
                            // Prefer the pre-resized ~200px thumb
                            // (item_images.thumb_path, populated by
                            // uploads after 0122). Falls back to the
                            // master URL for rows that pre-date the
                            // thumb column — Vercel Image Optimizer
                            // downscales it on first hit and caches.
                            src={item.image_thumb_url ?? item.image_url}
                            alt=""
                            width={56}
                            height={56}
                            sizes="28px"
                            // First ~12 rows are above the fold on a
                            // typical 1080p screen — bypass lazy
                            // loading so they start fetching with the
                            // initial HTML instead of after JS paints.
                            priority={rowIdx < 12}
                            // 16x16 base64 WebP blur — paints a hint
                            // of the photo immediately while the
                            // 28x28 transform resolves. Omitted on
                            // pre-0122 rows; next/image falls back
                            // to the empty bg-muted background.
                            placeholder={item.image_lqip ? 'blur' : 'empty'}
                            blurDataURL={item.image_lqip ?? undefined}
                            className="h-7 w-7 shrink-0 rounded-[5px] border border-border bg-muted object-cover"
                          />
                        ) : (
                          <span
                            aria-hidden
                            className="h-7 w-7 shrink-0 rounded-[5px] border border-border"
                            style={{
                              background:
                                'repeating-linear-gradient(45deg, hsl(var(--border)) 0 1px, transparent 1px 6px), hsl(var(--muted))',
                            }}
                          />
                        )}
                      </ImageHoverPreview>
                      <Link
                        href={`${rowLinkPrefix}/${item.id}?return=${encodeURIComponent(currentListUrl)}`}
                        // Disable eager prefetch. The previous
                        // `prefetch` setting fired an RSC prefetch for
                        // EVERY row's detail page on mount — measured
                        // 50+ prefetches × ~500ms server time each on
                        // a 50-row inventory list, dominating the
                        // page's resource graph and slowing the
                        // initial render. The user clicks ~1 row on
                        // average, so 49 prefetches were pure waste.
                        // Next.js still prefetches on hover by
                        // default, so perceived nav speed stays
                        // identical for the row the user actually
                        // chooses.
                        prefetch={false}
                        className="font-medium hover:underline"
                      >
                        {item.name}
                      </Link>
                    </div>
                  </td>
                  <td className="px-3 font-mono text-[11.5px] tracking-[-0.01em] text-[var(--ed-ink-3)]">
                    {item.sku}
                  </td>
                  <td className="px-3">
                    {category ? (
                      <span
                        className="inline-flex items-center gap-1.5 text-[12px]"
                        style={category.color ? { color: category.color } : undefined}
                      >
                        {category.color && (
                          <span
                            aria-hidden
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: category.color }}
                          />
                        )}
                        {category.name}
                      </span>
                    ) : (
                      <span className="text-[12px] text-[var(--ed-ink-4)]">—</span>
                    )}
                  </td>
                  <td className="px-3 text-[12px]">
                    {(() => {
                      const charter = item.charter_id
                        ? lookups.charters?.get(item.charter_id) ?? null
                        : null;
                      if (charter) {
                        return (
                          <span className="text-[var(--ed-ink-2)]" title={charter.name}>
                            {charter.code ?? charter.name}
                          </span>
                        );
                      }
                      // charter_id IS NULL = generic stock (any charter
                      // serviced by the warehouse can pull from it).
                      return (
                        <span
                          className="text-[11px] text-[var(--ed-ink-4)] italic"
                          title="Generic stock — any charter serviced by this warehouse can use it"
                        >
                          Generic
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">{location?.name ?? '—'}</td>
                  {!showBookFields && (
                    <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                      {(() => {
                        const rack = readItemRack(item.custom_fields);
                        return rack.rackLabel ? (
                          <span className="font-mono tabular-nums">
                            {rack.rackLabel}
                          </span>
                        ) : (
                          <span className="text-[var(--ed-ink-4)]">—</span>
                        );
                      })()}
                    </td>
                  )}
                  {showBookFields &&
                    (() => {
                      const storage = readBookStorage(item.custom_fields);
                      const color = getCrateColor(storage.crateColor);
                      return (
                        <>
                          <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                            {storage.grade ? (
                              <span className="font-mono">
                                {/^\d{1,2}$/.test(storage.grade)
                                  ? `Gr ${storage.grade}`
                                  : storage.grade}
                              </span>
                            ) : (
                              <span className="text-[var(--ed-ink-4)]">—</span>
                            )}
                          </td>
                          <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                            {storage.rackLabel ? (
                              <span className="font-mono tabular-nums">
                                {storage.rackLabel}
                              </span>
                            ) : (
                              <span className="text-[var(--ed-ink-4)]">—</span>
                            )}
                          </td>
                          <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                            {color && storage.crateNumber ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span
                                  aria-hidden
                                  title={color.label}
                                  className="border-border inline-block h-2.5 w-2.5 rounded-full border"
                                  style={{ backgroundColor: color.hex }}
                                />
                                <span className="font-mono tabular-nums">
                                  {storage.crateNumber}
                                </span>
                              </span>
                            ) : (
                              <span className="text-[var(--ed-ink-4)]">—</span>
                            )}
                          </td>
                        </>
                      );
                    })()}
                  <td className="px-3 text-right font-mono tabular-nums">
                    {(() => {
                      // Defensive defaults so rows without the new fields (older
                      // callers, non-service code paths) render exactly as before.
                      const staged = item.staged_quantity ?? 0;
                      const placed = item.placed_quantity ?? item.quantity_on_hand;
                      const shown = stockView === 'total' ? item.quantity_on_hand : placed;
                      return (
                        <>
                          {formatNumber(shown)}
                          {staged > 0 && (
                            <div className="mt-0.5 text-[10.5px] font-normal leading-tight text-[var(--ed-ink-4)]">
                              {stockView === 'total'
                                ? `${formatNumber(placed)} placed · ${formatNumber(staged)} staged`
                                : `+${formatNumber(staged)} staged`}
                            </div>
                          )}
                        </>
                      );
                    })()}
                    {(() => {
                      // Rentals-only: reserve-not-decrement model means a
                      // checkout never lowers on-hand. Surface available +
                      // out-on-rental under the qty so reserved stock is
                      // visible. `reservedByItem` is undefined on the
                      // inventory + books lists → nothing renders.
                      const reserved = reservedByItem?.get(item.id) ?? 0;
                      if (reserved <= 0) return null;
                      const available = Math.max(0, item.quantity_on_hand - reserved);
                      return (
                        <div className="mt-0.5 text-[10.5px] font-normal leading-tight text-[var(--ed-ink-4)]">
                          {formatNumber(available)} avail · {formatNumber(reserved)} out
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-3">
                    <StockBar stock={item.quantity_on_hand} par={par} status={status} />
                  </td>
                  <td className="px-3 text-right">
                    <Sparkline data={series} width={56} height={18} />
                  </td>
                  <td className="px-3">
                    <StockStatusBadge
                      quantity={item.quantity_on_hand}
                      reorderPoint={item.reorder_point}
                      itemStatus={item.status}
                    />
                  </td>
                  <td
                    className="px-3 text-right text-[11.5px] text-[var(--ed-ink-4)]"
                    // `formatRelative` reads `new Date()` at call time, so the
                    // string produced during server SSR ("15 minutes ago") can
                    // shift by the time the client hydrates ("16 minutes
                    // ago"), tripping React error #418. Tolerate the drift —
                    // exactly the case suppressHydrationWarning is for.
                    suppressHydrationWarning
                  >
                    {formatRelative(item.updated_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Pagination — hides when everything fits on one page so the
            single-screen empty/typical case stays clean. URL-driven so
            paginated views are bookmarkable + shareable. Also hides
            during an active search (see top-pagination comment). */}
        {!q.trim() && total > pageSize ? (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            buildHref={hrefForPage}
          />
        ) : (
          <span />
        )}
        {canCreate && (
          <Button asChild>
            <Link href={`${basePath}/new`}>
              + New {showBookFields ? 'book' : 'item'}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  buildHref,
}: {
  page: number;
  pageSize: number;
  total: number;
  buildHref: (page: number) => string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startRow = (safePage - 1) * pageSize + 1;
  const endRow = Math.min(safePage * pageSize, total);
  const prevDisabled = safePage <= 1;
  const nextDisabled = safePage >= totalPages;
  return (
    <div className="text-muted-foreground flex items-center gap-3 text-[12px]">
      <span>
        Showing <span className="text-foreground font-medium">{startRow}</span>–
        <span className="text-foreground font-medium">{endRow}</span> of{' '}
        <span className="text-foreground font-medium">{total}</span>
      </span>
      <div className="flex items-center gap-1">
        <Button asChild variant="outline" size="sm" disabled={prevDisabled}>
          {prevDisabled ? (
            <span aria-disabled className="pointer-events-none opacity-50">
              ← Prev
            </span>
          ) : (
            <Link href={buildHref(safePage - 1)} prefetch={false}>
              ← Prev
            </Link>
          )}
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Jump to page"
              className="hover:text-foreground hover:bg-muted/40 cursor-pointer rounded px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors"
            >
              Page {safePage} of {totalPages}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="center"
            side="top"
            className="max-h-[360px] w-auto min-w-[260px] overflow-y-auto p-2"
          >
            <div className="grid grid-cols-5 gap-1 sm:grid-cols-8">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                <Button
                  key={n}
                  asChild
                  variant={n === safePage ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 w-full px-2 text-[12px]"
                >
                  <Link
                    href={buildHref(n)}
                    prefetch={false}
                    aria-current={n === safePage ? 'page' : undefined}
                  >
                    {n}
                  </Link>
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Button asChild variant="outline" size="sm" disabled={nextDisabled}>
          {nextDisabled ? (
            <span aria-disabled className="pointer-events-none opacity-50">
              Next →
            </span>
          ) : (
            <Link href={buildHref(safePage + 1)} prefetch={false}>
              Next →
            </Link>
          )}
        </Button>
      </div>
    </div>
  );
}

function Checkbox({ checked, onChange }: { checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-grid h-3.5 w-3.5 place-items-center rounded-[3px] border bg-card transition-colors',
        checked ? 'border-foreground bg-foreground' : 'border-[var(--ed-line-strong)]',
      )}
    >
      {checked && (
        <span
          aria-hidden
          className="h-[7px] w-[4px] -translate-y-px rotate-[-45deg] border-b-[1.5px] border-l-[1.5px] border-background"
        />
      )}
    </button>
  );
}

function SortMenu({ value, onChange }: { value: SortKey; onChange: (k: SortKey) => void }) {
  const [open, setOpen] = React.useState(false);
  const current = SORT_OPTIONS.find((o) => o.value === value) ?? SORT_OPTIONS[0]!;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)]"
          aria-label={`Sort by ${current.label}`}
        >
          <span className="text-[var(--ed-ink-4)]">Sort:</span>
          <span className="font-medium">{current.label}</span>
          <ChevronDown className="h-3 w-3 text-[var(--ed-ink-4)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-1">
        <div className="flex flex-col">
          {SORT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={cn(
                'rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted',
                opt.value === value && 'bg-muted font-medium',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Array<{ id: string; name: string }>;
  selected: Set<string>;
  onChange: (ids: Set<string>) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState('');
  // Local DRAFT selection. Toggling options mutates the draft only — instant,
  // no navigation — and we commit ONCE when the dropdown closes. Previously
  // every checkbox click fired onChange → a full server round-trip, so picking
  // 3 categories meant 3 sequential re-fetches (the "super slow" report).
  const [draft, setDraft] = React.useState<Set<string>>(() => new Set(selected));
  const visible = filter.trim()
    ? options.filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : options;
  function toggle(id: string) {
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function handleOpenChange(next: boolean) {
    if (next) {
      // Opening: re-sync the draft to the applied selection (covers an external
      // change such as the toolbar's "Clear all filters").
      setDraft(new Set(selected));
    } else {
      // Closing: commit once, only if the draft actually changed.
      const changed =
        draft.size !== selected.size || [...draft].some((id) => !selected.has(id));
      if (changed) onChange(new Set(draft));
    }
    setOpen(next);
  }
  // While open, reflect the in-progress draft; when closed, the applied count.
  const shownSelected = open ? draft : selected;
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-[12px] transition-colors hover:border-[var(--ed-line-strong)]',
            shownSelected.size > 0
              ? 'border-foreground text-foreground'
              : 'border-border text-[var(--ed-ink-2)]',
          )}
          aria-label={`Filter by ${label}`}
        >
          <span>{label}</span>
          {shownSelected.size > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 font-mono text-[10px] tabular-nums text-background">
              {shownSelected.size}
            </span>
          )}
          <ChevronDown className="h-3 w-3 text-[var(--ed-ink-4)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-2">
        <div className="space-y-2">
          {options.length > 8 && (
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-7 text-[12px]"
              aria-label={`Filter ${label} options`}
            />
          )}
          <div className="max-h-[260px] overflow-y-auto">
            {visible.length === 0 ? (
              <p className="px-2 py-3 text-center text-[12px] text-[var(--ed-ink-4)]">
                No matches.
              </p>
            ) : (
              <ul className="flex flex-col">
                {visible.map((opt) => {
                  const isOn = shownSelected.has(opt.id);
                  return (
                    <li key={opt.id}>
                      <button
                        type="button"
                        onClick={() => toggle(opt.id)}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted"
                      >
                        <Checkbox checked={isOn} onChange={() => toggle(opt.id)} />
                        <span className="truncate">{opt.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {shownSelected.size > 0 && (
            <div className="border-t border-border pt-2">
              <button
                type="button"
                onClick={() => setDraft(new Set())}
                className="text-[11.5px] text-[var(--ed-ink-3)] underline-offset-2 hover:text-foreground hover:underline"
              >
                Clear {label.toLowerCase()}
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const EXPORT_FORMATS: Array<{ format: 'csv' | 'xlsx' | 'pdf'; label: string }> = [
  { format: 'xlsx', label: 'Excel' },
  { format: 'pdf', label: 'PDF' },
  { format: 'csv', label: 'CSV' },
];

function ExportFormatRow({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: (format: 'csv' | 'xlsx' | 'pdf') => void;
}) {
  return (
    <div className="mt-1 flex gap-1">
      {EXPORT_FORMATS.map((f) => (
        <button
          key={f.format}
          type="button"
          disabled={busy}
          onClick={() => onPick(f.format)}
          className="flex-1 rounded-sm border border-border bg-background px-2 py-1 text-[11px] font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

function ExportMenu({ params, itemType }: { params: URLSearchParams; itemType: string }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const itemTypeArg = itemType as InventoryExportRequest['itemType'];

  // "filtered" carries the active params (q, sort, cat[], loc[], stock, status).
  const filtersFromParams = (): InventoryExportRequest['filters'] => ({
    q: params.get('q') || undefined,
    status: (params.get('status') as 'active' | 'archived' | 'discontinued' | 'all') || undefined,
    stock: (params.get('stock') as 'low' | 'out') || null,
    sort: params.get('sort') || undefined,
    categoryIds: params.getAll('cat').filter(Boolean),
    locationIds: params.getAll('loc').filter(Boolean),
    charterIds: params.getAll('charter').filter(Boolean),
  });

  async function run(scope: 'filtered' | 'all', format: 'csv' | 'xlsx' | 'pdf') {
    setBusy(true);
    try {
      await downloadInventoryExport({
        format,
        scope,
        itemType: itemTypeArg,
        ...(scope === 'filtered' ? { filters: filtersFromParams() } : {}),
      });
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-[12px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)]"
          aria-label="Export"
        >
          <Download className="h-3 w-3" />
          <span className="font-medium">Export</span>
          <ChevronDown className="h-3 w-3 text-[var(--ed-ink-4)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[240px] p-2">
        <div className="flex flex-col gap-3">
          <div>
            <div className="px-0.5 text-[12.5px] font-medium">Export filtered</div>
            <div className="px-0.5 text-[11px] text-[var(--ed-ink-4)]">
              What's currently visible
            </div>
            <ExportFormatRow busy={busy} onPick={(f) => run('filtered', f)} />
          </div>
          <div>
            <div className="px-0.5 text-[12.5px] font-medium">Export all</div>
            <div className="px-0.5 text-[11px] text-[var(--ed-ink-4)]">
              Full {itemType === 'book' ? 'books' : 'inventory'} dump
            </div>
            <ExportFormatRow busy={busy} onPick={(f) => run('all', f)} />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Saved views helpers + components.
// Spec: docs/superpowers/specs/2026-05-08-saved-views-design.md
// ---------------------------------------------------------------------------

function readCurrentState(
  params: URLSearchParams,
  warehouseId: string | null,
): SavedViewSummary['state'] {
  const out: SavedViewSummary['state'] = {};
  const q = params.get('q');
  if (q) out.q = q;
  const status = params.get('status');
  if (status) out.status = status;
  const stock = params.get('stock');
  if (stock) out.stock = stock;
  const type = params.get('type');
  if (type) out.type = type;
  const sort = params.get('sort');
  if (sort) out.sort = sort;
  const cat = params.getAll('cat').filter(Boolean);
  if (cat.length > 0) out.cat = cat;
  const loc = params.getAll('loc').filter(Boolean);
  if (loc.length > 0) out.loc = loc;
  if (warehouseId) out.warehouseId = warehouseId;
  return out;
}

function isSavedViewActive(
  view: SavedViewSummary,
  params: URLSearchParams,
  warehouseId: string | null,
): boolean {
  const cur = readCurrentState(params, warehouseId);
  return JSON.stringify(normalize(cur)) === JSON.stringify(normalize(view.state));
}

// Order-independent comparison helpers for state shapes.
function normalize(s: SavedViewSummary['state']) {
  return {
    q: s.q ?? '',
    status: s.status ?? '',
    stock: s.stock ?? '',
    type: s.type ?? '',
    sort: s.sort ?? '',
    cat: [...(s.cat ?? [])].sort(),
    loc: [...(s.loc ?? [])].sort(),
    warehouseId: s.warehouseId ?? '',
  };
}

function describeState(state: SavedViewSummary['state']): string {
  const parts: string[] = [];
  if (state.q) parts.push(`search "${state.q}"`);
  if (state.stock === 'low') parts.push('low stock');
  else if (state.stock === 'out') parts.push('out of stock');
  if (state.status && state.status !== 'active') parts.push(state.status);
  if (state.type && state.type !== 'product') parts.push(state.type);
  if (state.cat?.length) parts.push(`${state.cat.length} categor${state.cat.length === 1 ? 'y' : 'ies'}`);
  if (state.loc?.length) parts.push(`${state.loc.length} location${state.loc.length === 1 ? '' : 's'}`);
  if (state.warehouseId) parts.push('warehouse');
  if (state.sort) parts.push(`sorted ${state.sort.replace('_', ' ')}`);
  return parts.length === 0 ? 'No filters set' : parts.join(' · ');
}

function SavedViewChip({
  view,
  isActive,
  scope,
  basePath,
  isOwner,
}: {
  view: SavedViewSummary;
  isActive: boolean;
  scope: 'inventory' | 'books';
  basePath: string;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  async function apply() {
    await setActiveWarehouseAction(view.state.warehouseId ?? null);
    const next = new URLSearchParams();
    if (view.state.q) next.set('q', view.state.q);
    if (view.state.status) next.set('status', view.state.status);
    if (view.state.stock) next.set('stock', view.state.stock);
    if (view.state.type) next.set('type', view.state.type);
    if (view.state.sort) next.set('sort', view.state.sort);
    for (const c of view.state.cat ?? []) next.append('cat', c);
    for (const l of view.state.loc ?? []) next.append('loc', l);
    const qs = next.toString();
    router.replace(qs ? `${basePath}?${qs}` : basePath, { scroll: false });
    router.refresh();
  }

  function remove(e: React.MouseEvent) {
    e.stopPropagation();
    setDeleteOpen(true);
  }

  async function confirmDelete() {
    setDeleting(true);
    const res = await deleteSavedViewAction(view.id, scope);
    setDeleting(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    setDeleteOpen(false);
    toast.success(`Saved view "${view.name}" deleted.`);
    router.refresh();
  }

  async function toggleShare(e: React.MouseEvent) {
    e.stopPropagation();
    const next = !view.isShared;
    setSharing(true);
    const res = await toggleSavedViewShareAction(view.id, next, scope);
    setSharing(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(next ? `View "${view.name}" shared with the team.` : `View "${view.name}" set to private.`);
    router.refresh();
  }

  return (
    <span
      className={cn(
        'group inline-flex h-6 items-center gap-1 rounded-full border pl-2 pr-1 text-[11.5px] transition-colors',
        isActive
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-background text-[var(--ed-ink-2)] hover:border-[var(--ed-line-strong)]',
      )}
      title={view.isShared ? `Shared by ${isOwner ? 'you' : 'a teammate'}` : undefined}
    >
      <button
        type="button"
        onClick={apply}
        className="inline-flex items-center gap-1"
        aria-label={`Apply view ${view.name}`}
      >
        {view.isShared ? <Users className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
        <span className="max-w-[120px] truncate">{view.name}</span>
      </button>
      {isOwner && (
        <button
          type="button"
          onClick={toggleShare}
          disabled={sharing}
          aria-label={view.isShared ? `Make view ${view.name} private` : `Share view ${view.name} with team`}
          className={cn(
            'ml-0.5 grid h-4 w-4 place-items-center rounded-full opacity-0 transition-opacity hover:bg-foreground/15 group-hover:opacity-100',
            isActive && 'hover:bg-background/20',
          )}
        >
          {sharing ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : view.isShared ? (
            <Users className="h-2.5 w-2.5" />
          ) : (
            <Users className="h-2.5 w-2.5 opacity-50" />
          )}
        </button>
      )}
      {isOwner && (
        <button
          type="button"
          onClick={remove}
          disabled={deleting}
          aria-label={`Delete view ${view.name}`}
          className={cn(
            'ml-0.5 grid h-4 w-4 place-items-center rounded-full opacity-0 transition-opacity hover:bg-foreground/15 group-hover:opacity-100',
            isActive && 'hover:bg-background/20',
          )}
        >
          {deleting ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <X className="h-2.5 w-2.5" />}
        </button>
      )}
      <DestructiveConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete saved view "${view.name}"?`}
        description={
          view.isShared
            ? 'This view is shared with the team — every teammate will lose access. The underlying items and filters are not affected; only the saved-view shortcut is removed.'
            : 'The saved-view shortcut will be removed. The underlying items and filters are not affected.'
        }
        confirmLabel="Delete view"
        pending={deleting}
        onConfirm={confirmDelete}
      />
    </span>
  );
}

function SaveCurrentViewButton({
  scope,
  currentState,
}: {
  scope: 'inventory' | 'books';
  currentState: SavedViewSummary['state'];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [shareWithTeam, setShareWithTeam] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on open/close
      setName('');
      setShareWithTeam(false);
    }
  }, [open]);

  async function save() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setSaving(true);
    const res = await createSavedViewAction({
      scope,
      name: trimmed,
      state: currentState as Parameters<typeof createSavedViewAction>[0]['state'],
      isShared: shareWithTeam,
    });
    setSaving(false);
    if (!res.ok) {
      toast.error(res.error.message);
      return;
    }
    toast.success(
      shareWithTeam ? `View "${trimmed}" saved and shared with the team.` : `View "${trimmed}" saved.`,
    );
    setOpen(false);
    router.refresh();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-[11.5px] text-[var(--ed-ink-3)] transition-colors hover:border-[var(--ed-line-strong)] hover:text-foreground"
        >
          <Plus className="h-3 w-3" /> Save view
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-3">
        <div className="space-y-3">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]">
              Name
            </label>
            <Input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving) save();
              }}
              placeholder="Restock candidates"
              maxLength={80}
              className="mt-1 h-8 text-[12.5px]"
            />
          </div>
          <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
            <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]">
              Saving
            </div>
            <div className="mt-0.5 text-[12px] text-[var(--ed-ink-2)]">
              {describeState(currentState)}
            </div>
          </div>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={shareWithTeam}
              onChange={(e) => setShareWithTeam(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded border-border text-primary focus:ring-primary"
            />
            <div className="flex-1">
              <div className="text-[12px] font-medium">Share with team</div>
              <div className="text-[11px] text-[var(--ed-ink-3)]">
                Everyone in your org will see this view. Only you can edit or
                delete it.
              </div>
            </div>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={saving || name.trim().length === 0}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SparkModeToggle({
  mode,
  onChange,
}: {
  mode: SparkMode;
  onChange: (m: SparkMode) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const label = mode === 'qty' ? '14-day · qty' : '14-day · moves';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="ml-auto inline-flex h-5 items-center gap-1 rounded-sm px-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)] hover:text-foreground"
          aria-label={`Sparkline mode: ${mode === 'qty' ? 'quantity trend' : 'movement count'}`}
        >
          {label}
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[200px] p-1">
        <div className="flex flex-col">
          {(
            [
              { value: 'qty', label: 'Quantity trend' },
              { value: 'moves', label: 'Move count' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={cn(
                'rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-muted',
                opt.value === mode && 'bg-muted font-medium',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
