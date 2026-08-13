'use client';

import {
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Pin,
  Plus,
  ScanLine,
  Search,
  Users,
  X,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { BulkActions } from '@/components/inventory/bulk-actions';
import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import { ExportBuilderDialog } from './export-builder/export-builder-dialog';
import { GENERIC_CHARTER_LABEL } from '@/lib/charter-display';
import { useCountSelection } from '@/lib/cycle-counts/use-count-selection';
import {
  countingUnitLabel,
  groupBySizeRun,
  groupRollupLabel,
  resolvePlacement,
  type CountingUnit,
  type RackHoldingLike,
  type SizeRunGroup,
} from '@stockpilot/core';
import {
  groupPlacementsBySku,
  rollupStatus,
  type PlacementRow as SkuInputRow,
  type SkuGroup,
} from '@/lib/inventory/group-by-sku';
import {
  createSavedViewAction,
  deleteSavedViewAction,
  setActiveWarehouseAction,
  toggleSavedViewShareAction,
} from '@/server/actions/saved-views';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DestructiveConfirm } from '@/components/ui/destructive-confirm';
import { ImageHoverPreview, prewarmPreviewImages } from '@/components/ui/image-hover-preview';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { InventoryExportRequest } from '@/lib/download-export';
import { Sparkline } from '@/components/ui/sparkline';
import { StockBar } from '@/components/ui/stock-bar';
import { getCrateColor, readBookStorage, readItemRack } from '@/lib/book-storage';
import {
  EMPTY_MULTI_FILTER_STATE,
  multiFilterStatesEqual,
  readMultiFilterState,
  useInstantFilters,
} from '@/components/inventory/use-instant-filters';
import {
  deriveInstantView,
  expandInstantPlacementRows,
  filterInstantRows,
  instantStateFromSearchParams,
  type InstantModeState,
  type InstantPlacementLine,
} from '@/lib/inventory/instant-mode';
import {
  deselectPage,
  isPageFullySelected,
  isPagePartiallySelected,
  selectPage,
} from '@/components/inventory/selection-utils';
import { rememberLastListUrl } from '@/lib/last-list-url';
import { isSplitRackItem } from '@/lib/inventory/rack-holdings';
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
  /** Optional on the base row (server mode never reads them here); the
   * instant-mode dataset always carries them — they're two of the four
   * authoritative search fields (name/sku/barcode/model_number). */
  barcode?: string | null;
  model_number?: string | null;
  /** Needed by the created_asc/created_desc local sorts in instant mode. */
  created_at?: string;
  custom_fields?: Record<string, unknown> | null;
  /** Sports (0298). The item's STORED product-group id. When present it is
   *  the only signal size-run grouping uses — a rename can no longer break
   *  the family and a name collision can no longer forge one. NULL for every
   *  ungrouped item in every org (there is no backfill), which keeps the
   *  legacy name heuristic serving them exactly as before. */
  group_id?: string | null;
  /** Sports (0298). The stored size, used to order a grouped run's members
   *  ("10 after 9") instead of a token parsed out of the display name. */
  variant_size?: string | null;
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
  /** Quantity on hand but never placed into a rack (the "Unplaced" bucket).
   * Like staged, it's NOT counted as placed — surfaced as its own "+N
   * unplaced" line so racked-looking stock that's actually unplaced (and so
   * can't be transferred) is visible. Optional; defaults to 0. */
  unplaced_quantity?: number;
  /** ACTUAL rack/crate location names this item's stock sits in (from the
   * holdings model), sorted. Drives the RACK column so it shows where the
   * stock really is — not the stale free-text bin_location label. Optional so
   * older callers fall back to the custom_fields label. */
  placed_racks?: string[];
  /** Count of DISTINCT rack/crate holdings by location_id (never name) —
   *  see isSplitRackItem below. NOT derivable from placed_racks.length,
   *  which dedupes by rack NAME and so under-counts a rack named the
   *  same in two different warehouses. Optional so older callers without
   *  the field still render (treated as 0 = "not split"). */
  rackHoldingsCount?: number;
  /** The same holdings as `placed_racks`, carrying QUANTITY and
   *  `locations.kind`. The BOOKS view has no holdings-derived cell at all (the
   *  `placed_racks` cell is gated behind `!showBookFields`), so its RACK column
   *  reads custom_fields straight — and a book whose stock moved into a
   *  position-less crate keeps its old rack printed there (mig 0335). This is
   *  what lets that column apply the crate rule. Optional so older callers
   *  render unchanged. */
  placed_holdings?: RackHoldingLike[];
  /** True only when the SYSTEM auto-archived this item on zero stock
   *  (migration 0266) — drives the "Auto-archived" badge next to the
   *  Archived pill and the Archived view's "Auto-archived only" filter
   *  chip. Optional so older callers without the column still render. */
  auto_archived?: boolean;
  /** True while an item auto-created from an inbound PO has never
   *  received any stock (migration 0277) — drives the "Expected" pill
   *  (replacing "Out of stock") and the Expected chip's local count in
   *  instant mode. Optional so older callers still render. */
  awaiting_first_receipt?: boolean;
  // ── "One line per rack" split-row fields (Items inventory page only) ──
  /** Unique row key when one item is split into multiple placement rows
   *  (item id + location id). Falls back to `id` when absent. */
  rowKey?: string;
  /** This row's per-location quantity (one rack/bucket). When set, the ON HAND
   *  column shows THIS, not the item total — while `quantity_on_hand` stays the
   *  item total so status/coverage/value remain item-level. */
  line_quantity?: number;
  /** The rack/crate name, or "Staging"/"Unplaced", for this split row. When
   *  defined (even null), the RACK column shows it. `null` = no holding. */
  placement_label?: string | null;
  /** This row's holding kind ('rack' | 'crate' | 'staging' | 'unplaced'). */
  placement_kind?: string;
}

interface Lookups {
  categories: Map<string, { name: string; color: string | null }>;
  locations: Map<string, { name: string }>;
  /** Charter id → display name + short code. Missing-key rows render
   *  the "Generic" pill (any charter the warehouse services can use). */
  charters?: Map<string, { name: string; code: string | null }>;
}

/**
 * Model B SKU grouping (see the `skuGroups` derivation below): the shape
 * fed into Task 1's groupPlacementsBySku. PlacementRow's index signature
 * (`[k: string]: unknown`) lets us ride the ORIGINAL Item along under
 * `__item` — groupPlacementsBySku only reads/sums the declared fields,
 * but the object it hands back is the exact same reference, so casting
 * back to `SkuGroupInputRow` recovers the full row for rendering.
 */
type SkuGroupInputRow = SkuInputRow & { __item: Item };

/** One row the table body actually renders: either a plain placement
 *  row (today's per-rack `<tr>`, unchanged) or a SKU-group header
 *  (collapsed by default; expanding reveals its `items` as the SAME
 *  per-row `<tr>`s beneath it). `rowIdx` is a running position used
 *  only for the "first ~12 rows load with priority" image hint. */
type RenderEntry =
  | { kind: 'row'; item: Item; rowIdx: number }
  | { kind: 'header'; group: SkuGroup; items: Item[]; rowIdx: number };

/** The size-run layer sits ON TOP of RenderEntry: a run of same-base sized
 *  items (Pink Shirt - L/XL/2XL) collapses into one `style` header whose
 *  members are the underlying RenderEntry rows; everything else is a
 *  `passthrough` rendered exactly as before. Display-only. */
type StyledEntry =
  | { kind: 'style'; group: SizeRunGroup<RenderEntry>; items: Item[] }
  | { kind: 'passthrough'; entry: RenderEntry };

/** A full-dataset row for instant mode: the table row shape plus the
 *  columns the local matcher (barcode/model_number) and the created_*
 *  sorts read. The pages build these from InventoryListItemRow. */
export type InstantDatasetItem = Item & {
  barcode: string | null;
  model_number: string | null;
  created_at: string;
};

/**
 * INSTANT MODE dataset (owner-approved design, ≤ INSTANT_MODE_MAX_ROWS
 * orgs, manager+ only — the pages gate). When present, the table stops
 * being a window over server-computed rows and derives EVERYTHING
 * locally from this full per-view dataset + the URL state: search (one
 * complete answer per keystroke — no two-phase serverHits fallback, no
 * "(searching…)"), filters, sort, status/stock, pagination, and the
 * footer totals. URL updates ride App Router-integrated
 * window.history.pushState/replaceState (shallow — zero server round
 * trips), so URLs stay shareable and back/forward-able. Props refresh
 * via realtime router.refresh() + the 60s dataset cache; because the
 * derivation is a pure function of (dataset, URL state), refreshes
 * reconcile automatically and selection survives (id-identity
 * semantics, selection-utils).
 */
export interface InstantInventoryDataset {
  /** ALL rows for the view — every status, every page. */
  items: InstantDatasetItem[];
  /** Items page only: holdings for the one-line-per-rack expansion.
   *  Omitted by the Books page (books never split rows). */
  placement?: Record<string, InstantPlacementLine[]>;
  /** Which per-view semantics apply (rack custom-field keys). */
  view: 'items' | 'books';
}

/**
 * FIRST-ROWS-FIRST STREAMING (React 19 use()): what the page's UNAWAITED
 * dataset promise resolves to. The default manager+ view server-renders
 * immediately from the small 30-row cached payload (server mode), while
 * this full dataset streams behind it over the same RSC response; an
 * invisible <InstantDatasetAdopter> reads it with React.use() and hands
 * it to the (still-mounted) table, which flips into instant mode — SAME
 * component instance, same data, only the delivery order changed. `null`
 * = dataset unavailable (over-cap org or loader failure) → the table
 * stays in server mode, byte-identical to today. The promise NEVER
 * rejects (the page resolves null on failure), so nothing in the client
 * path ever calls `.catch` — this is the supported replacement for the
 * reverted `.then().catch()` effect that crashed hydration (recurring
 * bug pattern #15).
 */
export interface InstantAdoptedPayload {
  items: InstantDatasetItem[];
  placement?: Record<string, InstantPlacementLine[]>;
  /** Full-dataset 14-day series — replaces the 30-row `trends` prop the
   *  moment instant mode takes over, so every locally-derived page has
   *  its sparklines ready. */
  trends?: Map<string, { qtySeries: number[]; moveSeries: number[] }>;
  view: 'items' | 'books';
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
   * Public-catalog visibility (P3): forwards to BulkActions to show the
   * "Set public visibility" bulk action. Page passes
   * can(ctx, 'public_links:manage'). Default false → hidden.
   */
  canSetPublicVisibility?: boolean;
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
  /** Instant mode — see InstantInventoryDataset. Absent (staff/viewer,
      over-cap orgs, every other caller) → server mode, byte-identical
      to today. */
  instant?: InstantInventoryDataset;
  /** First-rows-first streaming — see InstantAdoptedPayload. Only the
      manager+ DEFAULT view passes this; deep links pass the awaited
      `instant` prop instead. While it's pending the table runs in server
      mode over the initial 30 rows; keystrokes take today's server-search
      path until the dataset lands, at which point the SAME (preserved)
      search box re-derives locally over the full dataset. Consumed via
      React.use() in <InstantDatasetAdopter> — NEVER a `.then().catch()`
      effect (pattern #15). */
  instantPromise?: Promise<InstantAdoptedPayload | null>;
  /** Server-computed count of ACTIVE items awaiting their first receipt
      (migration 0277) for this view — the badge on the "Expected" chip.
      Instant mode ignores it and derives the count from the full
      dataset (always fresh with realtime refreshes). Absent → 0, chip
      hidden unless the Expected view is already active. */
  expectedCount?: number;
  /**
   * Sports (Task 18): `product_groups.id` → `default_counting_unit`, for the
   * groups the rendered rows belong to. Resolved server-side in ONE batched
   * lookup (`loadSizeRunGroups`), never per row — the size-run header uses it
   * to say "52 pairs total" instead of a bare number.
   *
   * Absent (and empty for every non-sports org, which is every org that has
   * opted nothing in) leaves the header exactly as it was. PAIR is a display
   * convention with no conversion behind it, so the unit is always READ from
   * the group and never inferred from the item.
   */
  productGroupUnits?: Record<string, string>;
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
// v2: default flipped to 'total' so ON HAND shows the real on-hand quantity
// (placed + staged + unplaced) rather than placed-only — an all-unplaced item
// must never read as "0 on hand". Bumping the key resets stale 'placed' saves
// so existing users pick up the new default.
const STOCK_VIEW_KEY = 'stockpilot:inventory:stock-view:v2';

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

function deriveStatus(qty: number, reorder: number): 'ok' | 'warn' | 'crit' {
  if (qty <= 0) return 'crit';
  if (reorder > 0 && qty <= reorder) return 'warn';
  return 'ok';
}

/**
 * Split-row selection → item-level action ids.
 *
 * The Items list splits one `inventory_items` row into one TABLE row per
 * holding location, keyed by `rowKey = `${item.id}:${locationId}``. Row
 * SELECTION keys on that rowKey (so checking one rack row does NOT visually
 * check the item's OTHER rack rows). But every bulk action is item-level —
 * archive / labels / export / draft-PO / cycle-count all take item ids — so
 * at the action boundary we collapse the selected rowKeys back to DISTINCT
 * item ids here.
 *
 * The item id is everything before the FIRST ':'. Item ids are UUIDs, which
 * never contain ':', so splitting on the first ':' is unambiguous; a rowKey
 * with no ':' (a zero-holding row, whose rowKey falls back to the bare
 * `item.id`) passes straight through. Order-stable, deduped — so selecting
 * both racks of ONE item yields a single item id, and archiving it affects
 * that one item exactly once.
 */
export function rowKeysToItemIds(keys: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    const colon = key.indexOf(':');
    const itemId = colon === -1 ? key : key.slice(0, colon);
    if (!seen.has(itemId)) {
      seen.add(itemId);
      out.push(itemId);
    }
  }
  return out;
}

/** Stable empty series for the (shouldn't-happen) miss in the seriesByItem
 *  map — a module-level constant so its identity never changes, keeping the
 *  memo'd <Sparkline> from re-rendering on a fallback. */
const EMPTY_SERIES: number[] = [];

/**
 * On-demand master-image URL for payload-diet rows (rank 5): instant-mode
 * dataset rows ship only the ~200px thumb; the 2048px master (hover
 * preview + lightbox only) is fetched here on hover intent from the
 * org-scoped, session-authed route. Module-level promise cache so
 * re-hovers and re-renders never re-fetch; failures are NOT cached (a
 * later hover retries).
 */
const masterUrlPromises = new Map<string, Promise<string | null>>();
function loadMasterImageUrl(itemId: string): Promise<string | null> {
  const existing = masterUrlPromises.get(itemId);
  if (existing) return existing;
  const p = fetch(`/api/items/${itemId}/image-master`)
    .then((res) => (res.ok ? (res.json() as Promise<{ url: string | null }>) : { url: null }))
    .then((data) => data.url ?? null)
    .catch(() => null);
  masterUrlPromises.set(itemId, p);
  void p.then((url) => {
    if (url === null) masterUrlPromises.delete(itemId);
  });
  return p;
}

/**
 * Instant-mode <Link>/<a> click interception: plain left clicks become a
 * shallow history update (no server round trip — the rows derive
 * locally); modified clicks (cmd/ctrl/shift/alt, middle button) are left
 * to the browser so open-in-new-tab still works and the href still
 * server-renders as a deep link. preventDefault() also tells next/link
 * to skip its own router navigation.
 */
function interceptShallowNav(
  e: React.MouseEvent<HTMLAnchorElement>,
  href: string,
  navigate: (href: string) => void,
): void {
  if (e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(href);
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

/**
 * Invisible dataset adopter (React 19 use()). The default manager+ table
 * mounts in server mode over the fast 30-row payload and the FULL instant
 * dataset arrives as `promise` — an unawaited server promise streamed
 * across the RSC boundary. This leaf reads it with React.use(), which
 * suspends ONLY this leaf (behind the table's own `<Suspense fallback=
 * {null}>`, so the 30 rows stay painted the whole time), then hands the
 * resolved value to the still-mounted table via `onResolve`. Because the
 * table never unmounts, its search box, selection, scroll and every other
 * local state survive the server→instant flip.
 *
 * This is the supported replacement for the reverted
 * `instantPromise.then().catch()` effect (recurring bug pattern #15): the
 * promise is consumed by use(), never a hand-rolled effect, and it
 * resolves `null` on failure so there is no `.catch` anywhere in the
 * client path. `onResolve` only ever receives an already-settled plain
 * value (dataset object or null) — never a floating promise.
 */
function InstantDatasetAdopter({
  promise,
  onResolve,
}: {
  promise: Promise<InstantAdoptedPayload | null>;
  onResolve: (payload: InstantAdoptedPayload | null) => void;
}): null {
  const payload = React.use(promise);
  React.useEffect(() => {
    onResolve(payload);
  }, [payload, onResolve]);
  return null;
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
  canSetPublicVisibility = false,
  onScanRequest,
  page = 1,
  pageSize = 50,
  trends,
  savedViews = [],
  savedViewScope,
  activeWarehouseId = null,
  currentUserId = null,
  reservedByItem,
  instant,
  instantPromise,
  expectedCount = 0,
  productGroupUnits,
}: InventoryTableProps) {
  // ── Streamed-dataset adoption (React 19 use()) ──────────────────────
  // The default manager+ view mounts in server mode over the fast 30-row
  // payload while the FULL instant dataset arrives as `instantPromise` —
  // an unawaited server promise streamed across the RSC boundary. The
  // invisible <InstantDatasetAdopter> rendered below reads it with
  // React.use() (suspending ONLY itself, behind a `fallback={null}` — the
  // 30 rows stay painted) and calls setAdopted with the resolved value.
  // Because THIS component instance never unmounts, the search box,
  // selection, scroll and sparkline mode all survive the server→instant
  // flip, and any keystrokes typed during the gap re-derive over the full
  // dataset the moment it lands (the 30 cached rows ARE page 1 of the
  // default derivation, by the loader parity contract). `null` (over-cap
  // org / loader failure) keeps plain server mode. The promise is
  // consumed by use(), NEVER a `.then().catch()` effect — that was the
  // reverted crash (recurring bug pattern #15).
  // `undefined` = the streamed payload hasn't resolved yet; `null` = it
  // resolved to "no dataset" (over-cap org / loader failure) — server
  // mode is final. The distinction drives `instantPending` below.
  const [adopted, setAdopted] = React.useState<InstantAdoptedPayload | null | undefined>(undefined);
  const handleAdopt = React.useCallback((payload: InstantAdoptedPayload | null) => {
    setAdopted(payload);
  }, []);

  // The dataset the derivation actually runs over: the awaited prop
  // (deep links) wins; otherwise the adopted streamed payload.
  const effectiveInstant: InstantInventoryDataset | null = React.useMemo(() => {
    if (instant) return instant;
    if (adopted) {
      return { items: adopted.items, placement: adopted.placement, view: adopted.view };
    }
    return null;
  }, [instant, adopted]);
  const instantMode = effectiveInstant != null;
  // TRUE only during the streamed default view's adoption gap: a promise
  // was handed over, no awaited `instant` prop, and the adopter hasn't
  // resolved. Under-cap orgs flip to instant mode moments later, so any
  // server-mode RSC prefetch fired in this gap (e.g. the Pagination
  // adjacent-page warm) would fetch payloads nothing ever consumes —
  // Pagination suspends its prefetch while this is true. Over-cap orgs
  // resolve `null`, the flag drops, and server-mode prefetch proceeds.
  const instantPending = instantPromise != null && instant == null && adopted === undefined;
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
  // Same SSR-safe init pattern as sparkMode above — server always sees the
  // 'total' default so the hydration markup matches, then we swap in the stored
  // preference post-mount. 'total' = full on-hand (placed+staged+unplaced) so a
  // fully-unplaced item shows its real quantity, not 0.
  const [stockView, setStockView] = React.useState<StockView>('total');
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(STOCK_VIEW_KEY);
    if (stored === 'placed' || stored === 'total') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
      setStockView(stored);
    }
  }, []);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STOCK_VIEW_KEY, stockView);
  }, [stockView]);

  const router = useRouter();
  const addToCount = useCountSelection((s) => s.add);
  const params = useSearchParams();
  // INSTANT-MODE URL SYNC: App Router-integrated shallow history updates
  // (official since Next 14.1) — the address bar moves, usePathname/
  // useSearchParams reflect the new URL (so every URL-derived control
  // stays in sync), but NO server component re-runs and no RSC fetch
  // fires. Filter/sort/search mirror server mode's router.replace with
  // replaceState; pagination + view chips mirror their <Link> pushes
  // with pushState, so back/forward keep stepping through pages.
  const shallowReplace = React.useCallback((url: string) => {
    window.history.replaceState(null, '', url);
  }, []);
  const shallowPush = React.useCallback((url: string) => {
    window.history.pushState(null, '', url);
  }, []);

  // Filter / sort navigations re-run the server component — a multi-second
  // round-trip at real-org scale. useInstantFilters makes the CONTROLS
  // optimistic: a checkbox flips synchronously on click, rapid toggles
  // coalesce into ONE debounced router.replace carrying the final filter set
  // (last-click-wins — no queue of stale intermediate navigations), and
  // isFilterPending drives a subtle "updating" treatment while the current
  // rows stay visible AND interactive. Once the navigation settles, the
  // controls mirror the URL again, so settled URL == visible state.
  // Instant mode swaps the transport to a shallow replaceState — the
  // optimistic/coalescing model is unchanged, but the commit costs zero
  // server work because the rows derive locally.
  const replaceUrl = React.useCallback(
    (url: string) => {
      if (instantMode) shallowReplace(url);
      else router.replace(url, { scroll: false });
    },
    [router, instantMode, shallowReplace],
  );
  const filters = useInstantFilters({ params, basePath, replace: replaceUrl });
  const isFilterPending = filters.isPending;
  const [q, setQ] = React.useState(initialQuery);
  // Server-authoritative search hits — populated after a debounced
  // fetch to /api/items/search. `null` means "no server result yet,
  // fall back to localMatches"; an empty array means "server says
  // zero matches". Cleared when q goes back to empty.
  const [serverHits, setServerHits] = React.useState<Item[] | null>(null);
  // How many rows the server says MATCH the current search, which is not
  // the same as how many it returned (the endpoint is capped at
  // `pageSize`). The SKU-group partial-total marker needs the size of the
  // RESULT SET, not the view's unsearched `total` — otherwise an active
  // search stamps "other pages may hold more" on groups whose every row
  // is already on screen.
  const [serverHitsTotal, setServerHitsTotal] = React.useState<number | null>(null);
  const [serverLoading, setServerLoading] = React.useState(false);

  // Instant local filter on every keystroke. Substring match against
  // name / sku / barcode of the rows already on this page. Renders
  // before the server fetch comes back so the user gets immediate
  // feedback; the server result then supersedes via `displayed` below.
  // (SERVER MODE ONLY — instant mode's matcher runs over the FULL
  // dataset in instantView below and this memo reduces to `items`.)
  const localMatches = React.useMemo(() => {
    const needle = instantMode ? '' : q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((i) => {
      const name = (i.name ?? '').toLowerCase();
      const sku = (i.sku ?? '').toLowerCase();
      const barcode = ((i as { barcode?: string | null }).barcode ?? '').toLowerCase();
      return name.includes(needle) || sku.includes(needle) || barcode.includes(needle);
    });
  }, [items, q, instantMode]);

  // INSTANT MODE derivation — a pure function of (dataset, URL state,
  // optimistic control state). q comes from local state and cat/loc/
  // charter from filters.visible so rows respond in the SAME FRAME as
  // the control; the URL catches up via the debounced shallow commits
  // and, once settled, produces the identical state (so realtime prop
  // refreshes reconcile automatically). While q or the filter set is
  // ahead of the URL, page snaps to 1 — mirroring how every server-mode
  // q/filter commit deletes ?page.
  const instantState: InstantModeState | null = React.useMemo(() => {
    if (!instantMode) return null;
    const urlState = instantStateFromSearchParams(params);
    const visible = {
      cat: [...filters.visible.cat],
      loc: [...filters.visible.loc],
      charter: [...filters.visible.charter],
    };
    const aheadOfUrl =
      q.trim() !== urlState.q.trim() ||
      !multiFilterStatesEqual(visible, readMultiFilterState(params));
    return {
      ...urlState,
      q,
      ...visible,
      page: aheadOfUrl ? 1 : urlState.page,
    };
  }, [instantMode, params, q, filters.visible]);

  const instantView = React.useMemo(() => {
    if (!effectiveInstant || !instantState) return null;
    return deriveInstantView(effectiveInstant.items, instantState, effectiveInstant.view, pageSize);
  }, [effectiveInstant, instantState, pageSize]);

  // Items view: expand the page's items into one row per holding line —
  // the client twin of the page's server-mode placementRows flatMap.
  // Books view (no placement passed): the page items render as-is.
  const instantRows: Item[] | null = React.useMemo(() => {
    if (!effectiveInstant || !instantView) return null;
    return effectiveInstant.placement
      ? expandInstantPlacementRows(instantView.pageItems, effectiveInstant.placement)
      : instantView.pageItems;
  }, [effectiveInstant, instantView]);

  const view = paramsToView(params.get('stock'));
  // Archived-view-only chip state (Task 8): the chip itself only renders
  // when the URL is already scoped to the Archived tab.
  const isArchivedView = params.get('status') === 'archived';
  const autoArchivedOnly = params.get('auto') === '1';
  // Expected chip state (mig 0277): ?expected=1 shows ONLY items awaiting
  // their first receipt. The chip's count badge is server-computed in
  // server mode (expectedCount prop, countExpected with the page's active
  // filters) and derived from the full dataset in instant mode — here via
  // the EXACT view derivation (filterInstantRows with expected forced on:
  // honors q/cat/loc/charter/rack/stock and spans lifecycles), so the
  // badge N always equals the rows the chip's view would list.
  const expectedOnly = params.get('expected') === '1';
  const effectiveExpectedCount = React.useMemo(() => {
    if (!effectiveInstant || !instantState) return expectedCount;
    return filterInstantRows(
      effectiveInstant.items,
      { ...instantState, expected: true },
      effectiveInstant.view,
    ).length;
  }, [effectiveInstant, instantState, expectedCount]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  // Model B SKU grouping — which SKU-group headers are expanded, keyed
  // on the group's `sku` string (guaranteed non-blank: a blank/whitespace
  // SKU is never grouped into a >1-placement header — see
  // lib/inventory/group-by-sku.ts). Collapsed (empty set) by default.
  const [expandedSkuGroups, setExpandedSkuGroups] = React.useState<Set<string>>(new Set());
  // Size-run (apparel) grouping expand state — keyed by the derived style base.
  // Collapsed by default, like the SKU groups above.
  const [expandedStyleGroups, setExpandedStyleGroups] = React.useState<Set<string>>(new Set());

  const sort = paramsToSort(params.get('sort'));
  // OPTIMISTIC filter selections — these flip synchronously on click and
  // settle back to mirroring the URL once the coalesced navigation lands
  // (see useInstantFilters). Never derive checkbox state from `params`
  // directly: that gave zero feedback until the server round-trip finished,
  // which read as "I had to click 3-4 times".
  const categoryIds = filters.visible.cat;
  const locationIds = filters.visible.loc;
  const charterIds = filters.visible.charter;

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

  // Archived-view-only "Auto-archived only" toggle (Task 8): narrows the
  // Archived tab to rows the zero-stock cron archived, vs everything a
  // human archived too. Same Link + shallow-nav pattern as the VIEWS
  // chips above — a real href for bookmarkability, intercepted into a
  // shallow history.pushState in instant mode.
  function hrefForAutoArchivedToggle(): string {
    const next = new URLSearchParams(params.toString());
    if (next.get('auto') === '1') next.delete('auto');
    else next.set('auto', '1');
    next.delete('page');
    const qs = next.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  // "Expected" chip toggle (mig 0277) — same Link + shallow-nav pattern
  // as the Auto-archived chip above. Toggling on shows ONLY items
  // awaiting their first receipt; toggling off returns to the default
  // (which excludes them). Pagination resets across the flip.
  function hrefForExpectedToggle(): string {
    const next = new URLSearchParams(params.toString());
    if (next.get('expected') === '1') next.delete('expected');
    else next.set('expected', '1');
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

  function setSort(key: SortKey) {
    // Immediate navigation via the hook so any un-flushed filter toggles
    // fold into the SAME URL — a sort change 200ms after a category click
    // must not clobber (or race) the pending filter commit.
    filters.navigate((next) => {
      if (key === 'updated_desc') next.delete('sort');
      else next.set('sort', key);
    });
  }

  function setMultiParam(key: 'cat' | 'loc' | 'charter', ids: Set<string>) {
    // Instant visually, debounced on the wire: checking 3 categories fast
    // produces ONE navigation with the final set (see useInstantFilters).
    filters.setFilter(key, ids);
  }

  const activeFilterCount = categoryIds.size + locationIds.size + charterIds.size;
  function clearAllFilters() {
    setQ('');
    // One navigation clears the three filter keys (the override) plus
    // sort + q, so two navigations can't race each other.
    filters.navigate((next) => {
      next.delete('sort');
      next.delete('q');
    }, EMPTY_MULTI_FILTER_STATE);
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
  //
  // INSTANT MODE SKIPS ALL OF THIS: the dataset is complete, so there is
  // no server search to phase in (`serverHits` stays null forever) and
  // no "(searching…)" hedge — one complete answer per keystroke. The
  // dedicated effect below keeps the URL in sync via shallow
  // replaceState instead.
  React.useEffect(() => {
    // Streamed default view (instantPromise pending, not yet adopted):
    // the table is still in server mode here, so keystrokes take today's
    // server-search path until the dataset lands. The instant of adoption
    // instantMode flips true, this effect re-runs and early-returns, and
    // the SAME q re-derives locally over the full dataset (the search box
    // is preserved — the table never remounts).
    if (instantMode) return;
    const needle = q.trim();
    if (!needle) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async fetch lifecycle
      setServerHits(null);
      setServerHitsTotal(null);
      setServerLoading(false);
      // Clear the q param from the URL when the user empties the box.
      // Use router.replace (not history.replaceState) so Next.js
      // re-runs the server component and re-fetches the FULL item
      // list — otherwise the page stays seeded with whatever
      // filtered set the URL was loaded with (e.g. after a round
      // trip from the detail page that started with ?q=lanyard,
      // clearing the box would leave only the lanyard rows on
      // screen because the page-level fetch never re-ran).
      //
      // Gate on a STALE ?q ONLY. This effect also runs on mount with an
      // empty box, and the old `|| next.has('page')` arm made any bare
      // ?page=N deep link router.replace straight back to page 1 —
      // server-mode pagination was unusable for every over-instant-cap
      // org (>2000 items; invisible below that, where instantMode
      // early-returns above). Found by the 50k load test 2026-07-06.
      // ?page still drops WHEN a q is cleared — emptying a search
      // resets pagination, the same rule as every q commit.
      const next = new URLSearchParams(params.toString());
      if (next.has('q')) {
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
        // 'expected' rides along so searching inside the Expected chip
        // view (server mode) keeps returning ONLY flagged rows — the
        // endpoint mirrors list()'s expected predicate.
        for (const k of ['type', 'status', 'stock', 'sort', 'rack', 'expected']) {
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
        setServerHitsTotal(Number(data.total) || 0);

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
          setServerHitsTotal(null);
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
  }, [q, instantMode]);

  // INSTANT-MODE URL SYNC for the search box: mirror server mode's URL
  // shape (?q=needle, ?page dropped on any q change) with a debounced
  // SHALLOW replaceState — the rows already updated synchronously via
  // instantView, so this is purely about keeping the URL shareable.
  // Skips when the URL already matches (mount with a ?q= deep link).
  React.useEffect(() => {
    if (!instantMode) return;
    const needle = q.trim();
    // URL already reflects this search state → leave it (and ?page)
    // alone. Only a CHANGED q rewrites the URL and drops ?page — the
    // same rule every server-mode q commit follows.
    if (needle === (params.get('q') ?? '').trim()) return;
    const next = new URLSearchParams(params.toString());
    if (needle) next.set('q', needle);
    else next.delete('q');
    next.delete('page');
    const qs = next.toString();
    const newUrl = qs ? `${basePath}?${qs}` : basePath;
    const timer = setTimeout(() => shallowReplace(newUrl), 150);
    return () => clearTimeout(timer);
  }, [q, instantMode, params, basePath, shallowReplace]);

  // Page-scoped select-all (see selection-utils.ts): adds/removes the
  // VISIBLE ids while preserving off-page selection. The old
  // replace-with-page / clear-everything shape combined with the
  // size-equality header test below desynced permanently on live orgs
  // whose realtime refreshes reorder rows under the selection. In
  // instant mode the "visible page" is the locally-derived one.
  // Select-all keys on rowKey (unique per rack row) — same identity the row
  // checkboxes and the `selected` Set use — so the header toggles exactly the
  // rows on screen without co-selecting an item's other rack rows.
  const pageIds = React.useMemo(
    () => (instantRows ?? items).map((i) => i.rowKey ?? i.id),
    [instantRows, items],
  );
  const allVisibleSelected = isPageFullySelected(selected, pageIds);
  const someVisibleSelected = isPagePartiallySelected(selected, pageIds);
  function toggleAll(checked: boolean) {
    setSelected((prev) => (checked ? selectPage(prev, pageIds) : deselectPage(prev, pageIds)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // `selected` holds rowKeys (unique per rack row) so the checkboxes are
  // per-row. But EVERY bulk action is item-level, so collapse the selection
  // to DISTINCT item ids for the action boundary + the "N selected" counter.
  // Passing these to BulkActions makes the counter (selectedIds.length) read
  // the DISTINCT-ITEM count — the true scope of what archive/labels/export/
  // draft-PO/cycle-count will affect. Selecting BOTH racks of one item is
  // therefore "1 selected", one action, no double-processing.
  const selectedItemIds = React.useMemo(() => rowKeysToItemIds(selected), [selected]);
  const selectedItemIdSet = React.useMemo(() => new Set(selectedItemIds), [selectedItemIds]);

  // Prefer the server-computed org-wide value (covers ALL pages of
  // the current filter set). Falls back to a page-only sum for any
  // legacy caller that doesn't pass the prop yet. Instant mode computes
  // it locally over the FULL filtered set — the buildSumPage mirror
  // (deriveInstantView), so it tracks every active filter including q.
  const valueOnHand = instantView
    ? instantView.valueOnHand
    : (valueOnHandProp ?? items.reduce((s, it) => s + it.quantity_on_hand * it.unit_cost, 0));

  // ── THE THREE COUNTS (settled once; every label and every marker
  // below cites which one it means) ──────────────────────────────────
  // This list has THREE different populations, and they are NOT
  // interchangeable. Naming one with another's number is the single
  // recurring defect class in this file:
  //
  //   1. ITEM ROWS      — inventory_items rows. Under Model B (mig 0234)
  //                       one SKU can be several of them (one per
  //                       charter/bin). `effectiveTotal` (instant:
  //                       instantView.total; server: the `total` prop)
  //                       is THIS count, and nothing else.
  //   2. PLACEMENT ROWS — what the Items list actually renders: each
  //                       item expanded into one row per holding line
  //                       (rack/crate/staging/unplaced), or one row when
  //                       it has no holdings. Always ≥ item rows. Books
  //                       ship no placement map, so there the two counts
  //                       coincide.
  //   3. DISTINCT SKUs  — how many TOP-LEVEL lines the body shows: one
  //                       per grouped SKU header plus one per blank-SKU
  //                       row (a blank SKU is never grouped — see
  //                       group-by-sku.ts). Always ≤ item rows.
  //
  // WHO USES WHICH:
  //   • footer "N SKUs"        → 3 (instant only; server mode holds one
  //                              page and cannot count SKUs set-wide, so
  //                              it labels its number "items" — 1).
  //   • footer "N rows"        → 2, because "rows" must mean the rows on
  //                              screen. Shown only when it differs from
  //                              the SKU count (that difference IS the
  //                              collapsing the list just did).
  //   • "$X on hand"           → whole filtered set, unaffected.
  //   • Pagination / "Page X of Y" / "Showing X–Y of N" → 1, matching the
  //                              derivation, which paginates ITEM rows.
  //   • the partial-total "*"  → 1. A group is at risk of straddling a
  //                              page boundary only when it holds more
  //                              than one ITEM row; a single item split
  //                              across racks is one paginated unit and
  //                              can never be cut, so it must never be
  //                              stamped partial. Comparisons against the
  //                              full set are DISTINCT-ITEM-ID based for
  //                              the same reason.
  //
  // Total + current page: locally derived in instant mode (clamped to
  // the filtered set), server-provided otherwise. ITEM ROWS (count 1).
  const effectiveTotal = instantView ? instantView.total : total;
  const effectivePage = instantView ? instantView.page : page;
  // Instant mode paginates GROUP-AWARE — a SKU family is never split
  // across pages — so pages hold a VARIABLE number of item rows and
  // `page × pageSize` is no longer the range this page covers. Hand the
  // footer the real page count and the real row range so a page showing
  // 20 groups over 34 rows never claims "Showing 1–50". Server mode has
  // no such information (and slices at a fixed pageSize), so it keeps
  // the arithmetic fallback inside Pagination.
  const instantRange = React.useMemo(() => {
    if (!instantView) return undefined;
    const shown = instantView.pageItems.length;
    return {
      pageCount: instantView.pageCount,
      startRow: shown === 0 ? 0 : instantView.pageStartIndex + 1,
      endRow: instantView.pageStartIndex + shown,
    };
  }, [instantView]);
  // COUNT 3 — DISTINCT SKUs. The footer says "N SKUs", but
  // `effectiveTotal` is an ITEM-ROW count, and with grouping live that
  // visibly contradicts the screen: 47 book rows collapse into 19 headers
  // while the footer claimed "47 SKUs". Count the TOP-LEVEL lines over the
  // full filtered set instead.
  // KEYED ON THE RAW SKU, deliberately: groupPlacementsBySku keys on the
  // raw string, so " ABC" and "ABC" render as TWO lines. Folding them here
  // (on the trimmed value) would make the footer under-count what the body
  // shows — the same class of mismatch this count exists to remove. A
  // blank/whitespace SKU is never grouped, so each blank row is its own
  // line and counts as one.
  // Instant mode only: server mode holds a single page and has no way to
  // count distinct SKUs across the set.
  const distinctSkuCount = React.useMemo(() => {
    if (!instantView) return null;
    const seen = new Set<string>();
    let ungrouped = 0;
    for (const r of instantView.filteredRows) {
      if (r.sku.trim()) seen.add(r.sku);
      else ungrouped++;
    }
    return seen.size + ungrouped;
  }, [instantView]);
  // COUNT 2 — PLACEMENT ROWS over the full filtered set: what the footer's
  // "rows" term means, because "rows" has to mean the rows on screen. The
  // Items list expands each item into one row per holding line, so its
  // rendered row count EXCEEDS the item-row count — printing
  // `effectiveTotal` there understated the very number it claimed to
  // report. The dataset's `placement` map is full-dataset (not page-slice),
  // so this is answerable set-wide; Books ship no map, in which case a
  // placement row IS an item row and this collapses to `total`.
  const placementRowCount = React.useMemo(() => {
    if (!instantView) return null;
    const placement = effectiveInstant?.placement;
    if (!placement) return instantView.total;
    let n = 0;
    for (const r of instantView.filteredRows) {
      // Mirrors expandInstantPlacementRows: no holdings → exactly one
      // fallback row.
      n += placement[r.id]?.length || 1;
    }
    return n;
  }, [instantView, effectiveInstant]);
  // Show pagination when there is genuinely more than one page. Instant
  // mode asks the derivation (group-aware page count) rather than
  // `total > pageSize`, which over-counts pages whenever a family runs a
  // page long and would offer a Next that lands on an empty page.
  const showPagination = instantMode
    ? (instantView?.pageCount ?? 1) > 1
    : !q.trim() && total > pageSize;

  // What the table actually renders. Instant mode: the one complete
  // locally-derived answer. Server mode priority: server-authoritative
  // result if we have one (covers cross-page matches), else the
  // synchronous local filter (covers in-page matches with zero
  // latency). On no search, the server-mode pair reduces to `items`.
  const displayed = instantRows ?? serverHits ?? localMatches;

  // Precompute each row's sparkline series ONCE per (displayed, sparkMode,
  // trends) instead of inside the row map. `displayed` is stable across
  // selection toggles (localMatches/serverHits don't depend on `selected`),
  // so the array refs stay identical when only a checkbox flips — which lets
  // the memo'd <Sparkline> skip its SVG-path recompute for all 50 rows. This
  // is the fix for the click-lag: a single checkbox toggle no longer rebuilds
  // every visible sparkline.
  // Adopted streamed payload carries FULL-dataset trends (the 30-row
  // `trends` prop only covers the initial page); prefer them once present.
  const effectiveTrends = adopted?.trends ?? trends;
  const seriesByItem = React.useMemo(() => {
    const m = new Map<string, number[]>();
    for (const it of displayed) {
      m.set(it.id, seriesForRow(it.id, it.quantity_on_hand, sparkMode, effectiveTrends));
    }
    return m;
  }, [displayed, sparkMode, effectiveTrends]);

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

  // ── Model B: SKU-grouped rows (Items AND Books) ────────────────────
  // Books were gated out of this on the premise that "books never split
  // rows". That premise was wrong. Books do not split PLACEMENT rows
  // (books/page.tsx passes unsplit items — no `placement` map — so
  // line_quantity/placement_label/rowKey are undefined and the fallbacks
  // below take over), but they absolutely split ITEM rows: mig 0234 made
  // SKU uniqueness (organization_id, sku, charter_id, bin_location), so
  // one title legitimately exists as several inventory_items rows, one
  // per charter/rack. Measured on L4L North Region: 19 book SKUs covering
  // 47 rows, i.e. the Books list rendered the same title up to 4 times.
  // `displayed` is already one row per (sku, charter, rack) holding
  // (the existing placement split from instant-mode/page.tsx). We feed
  // that flat list through Task 1's groupPlacementsBySku (pure, sums
  // lineQuantity — a READ-TIME display sum only; no record is written
  // or changed) to cluster same-SKU rows together. A SKU whose group
  // has more than one placement collapses into ONE header row with the
  // summed total and a chevron; a SKU with exactly one placement (the
  // common case — most items live in a single rack/charter) renders
  // exactly as it does today, byte-identical, with no header at all.
  // The underlying Item object for each placement rides along under
  // `__item` (PlacementRow's index signature allows it) so the exact
  // same per-row <tr> markup can be reused unchanged when a group
  // expands.
  // Model B: full-dataset (not page-slice) per-SKU ITEM-ROW COUNTS, keyed
  // for the SKU-group headers below. Used as a SPLIT DETECTOR, not as a
  // total.
  //
  // WHAT CHANGED AND WHY. This map used to hold each SKU's full-dataset
  // on-hand SUM, and the header displayed that sum instead of the sum of
  // the rows it expands to. That was wrong in two directions at once:
  //   1. A SKU whose rows straddled a page boundary still rendered a
  //      header on EVERY page that held any of them, and each header
  //      showed the full cross-page total — the same title appearing
  //      twice, each copy claiming all the stock.
  //   2. It divorced the header number from the rows beneath it, so the
  //      "On hand: placed only" toggle made the header disagree with its
  //      own children.
  // The real fix for (1) is upstream: instant mode paginates GROUP-AWARE
  // (deriveInstantView → runAwarePages), so a SKU family is never split
  // and the page-slice sum IS the full sum. (2) then follows for free —
  // the header derives its total from the rows (see SkuGroupHeaderRow).
  // This map survives as the guard that proves invariant (1) holds: if a
  // group ever shows fewer distinct item rows than the full filtered set
  // has for that SKU, the header is disclosed as partial rather than
  // presenting an under-count as complete (bug pattern #18).
  // `null` in server mode, where only the current page exists.
  //
  // KEYED ON THE RAW SKU — the SAME key groupPlacementsBySku uses. Keying
  // this map on the TRIMMED sku while the groups keyed on the raw one made
  // whitespace-variant SKUs ("ABC" and " ABC") collapse into one full-set
  // count of 2 that BOTH one-row groups then compared themselves against,
  // so each stamped a false "*" and a false "other pages may hold more"
  // tooltip on a group whose every row was already on screen. A detector
  // must count the same population it is comparing.
  const skuItemRowCountsFull = React.useMemo(() => {
    if (!instantView) return null;
    const m = new Map<string, number>();
    for (const r of instantView.filteredRows) {
      if (!r.sku.trim()) continue; // blank skus are never grouped — see group-by-sku.ts
      m.set(r.sku, (m.get(r.sku) ?? 0) + 1);
    }
    return m;
  }, [instantView]);

  const skuGroups = React.useMemo<SkuGroup[] | null>(() => {
    const rows: SkuGroupInputRow[] = displayed.map((it) => ({
      id: it.rowKey ?? it.id,
      sku: it.sku,
      name: it.name,
      charterId: it.charter_id,
      placementLabel: it.placement_label ?? null,
      lineQuantity: it.line_quantity ?? it.quantity_on_hand,
      __item: it,
    }));
    const groups = groupPlacementsBySku(rows);
    // DISTINCT ITEM ROWS in a group (count 1), not its placement rows
    // (count 2) — the unit pagination slices is the item row.
    const itemRowsIn = (g: SkuGroup): number =>
      new Set(g.placements.map((p) => (p as unknown as SkuGroupInputRow).__item.id)).size;
    if (!skuItemRowCountsFull) {
      // Server mode: no full-dataset sum available. A single page (every
      // row for this view is already on screen) is still exact even
      // here; a multi-placement group on a multi-page result COULD be
      // missing rows sitting on another page, so it's flagged rather
      // than silently shown as if it were complete (recurring bug
      // pattern #18 — disclose silent caps, never hide them).
      // The question is whether the RESULT SET ON SCREEN is complete, not
      // whether the view's unsearched total fits a page. With a search
      // active the rows come from /api/items/search, which reports its own
      // match count and returns at most `pageSize` of them; keying off
      // `effectiveTotal` (the server `total` prop, which a search never
      // updates) stamped a false asterisk and an "other pages may hold
      // more" tooltip on groups that were entirely on screen. When the
      // search fetch hasn't landed (or failed) the rows are a local filter
      // over the current page, so completeness falls back to the view's
      // own single-page test.
      const resultSetTotal = q.trim() && serverHits ? (serverHitsTotal ?? total) : total;
      const singlePage = resultSetTotal <= pageSize;
      if (singlePage) return groups;
      // A group can only straddle a page boundary if it holds more than
      // one ITEM ROW — the server slices item rows and expands placements
      // afterwards. Keying off `placements.length` counted PLACEMENT rows,
      // so ONE item split across two racks (an everyday Items-list row,
      // one paginated unit, uncuttable) got a false asterisk and a
      // "other pages may hold more of this SKU" tooltip.
      return groups.map((g) => (itemRowsIn(g) > 1 ? { ...g, totalIsPartial: true } : g));
    }
    // Instant mode: group-aware pagination guarantees every row of a SKU
    // is on this page, so the group's own sum is already the full one.
    // Verify rather than assume — compare the group's DISTINCT item ids
    // against the full filtered set's row count for that SKU (ids, not a
    // sum: placement expansion means one item can contribute several
    // rows, so only ids are comparable). A shortfall means the guarantee
    // broke; disclose it instead of showing a confident under-count.
    return groups.map((g) => {
      if (!g.sku.trim()) return g;
      const full = skuItemRowCountsFull.get(g.sku);
      if (full == null) return g;
      return itemRowsIn(g) < full ? { ...g, totalIsPartial: true } : g;
    });
  }, [displayed, skuItemRowCountsFull, q, serverHits, serverHitsTotal, total, pageSize]);

  const renderItems = React.useMemo<RenderEntry[]>(() => {
    let idx = 0;
    if (!skuGroups) {
      return displayed.map((item) => ({ kind: 'row' as const, item, rowIdx: idx++ }));
    }
    const out: RenderEntry[] = [];
    for (const g of skuGroups) {
      const groupItems = g.placements.map((p) => (p as unknown as SkuGroupInputRow).__item);
      if (groupItems.length <= 1) {
        for (const it of groupItems) out.push({ kind: 'row', item: it, rowIdx: idx++ });
        continue;
      }
      out.push({ kind: 'header', group: g, items: groupItems, rowIdx: idx++ });
      if (expandedSkuGroups.has(g.sku)) {
        for (const it of groupItems) out.push({ kind: 'row', item: it, rowIdx: idx++ });
      }
    }
    return out;
  }, [skuGroups, displayed, expandedSkuGroups]);

  function toggleSkuGroup(sku: string) {
    setExpandedSkuGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  // Size-run (apparel) grouping: collapse a run of same-base sized items
  // ("Pink Shirt - L / - XL / - 2XL") into ONE expandable header ON TOP of the
  // SKU grouping above. Display-only — members keep their own SKU/count/rack. A
  // multi-placement SKU header is never folded in (groupable: false). Off for
  // Books (never sized, and their header layout differs). Collapsed by default;
  // the chevron alone controls expansion — an earlier build force-expanded runs
  // during a search, which made the collapse arrow do nothing while filtering
  // (exactly when the collapsed view is most wanted).
  const styledRenderItems = React.useMemo<StyledEntry[]>(() => {
    if (showBookFields) {
      return renderItems.map((entry) => ({ kind: 'passthrough', entry }));
    }
    const grouped = groupBySizeRun<RenderEntry>(renderItems, (entry) =>
      entry.kind === 'row'
        ? {
            key: entry.item.rowKey ?? entry.item.id,
            name: entry.item.name,
            quantity: Number(entry.item.quantity_on_hand) || 0,
            // The ITEM is the unit, not the row. `quantity_on_hand` is the
            // item TOTAL on every one of its placement rows (the rack's own
            // qty is `line_quantity`), so without this an expanded
            // multi-placement SKU inside a run added its whole total once per
            // rack — a header claiming 72 for two variants holding 52.
            unitKey: entry.item.id,
            groupable: true,
            // Stored identity when the item has one; null keeps the legacy
            // name heuristic, which is every ungrouped row in every org.
            groupId: entry.item.group_id ?? null,
            variantSize: entry.item.variant_size ?? null,
            countingUnit: entry.item.group_id
              ? (productGroupUnits?.[entry.item.group_id] ?? null)
              : null,
          }
        : { key: `sku:${entry.group.sku}`, name: entry.group.name, quantity: 0, groupable: false },
    );
    const out: StyledEntry[] = [];
    for (const ge of grouped) {
      if (ge.kind === 'single') {
        out.push({ kind: 'passthrough', entry: ge.entry });
        continue;
      }
      const items = ge.group.members.map((m) => (m as Extract<RenderEntry, { kind: 'row' }>).item);
      out.push({ kind: 'style', group: ge.group, items });
      if (expandedStyleGroups.has(ge.group.styleKey)) {
        for (const m of ge.group.members) out.push({ kind: 'passthrough', entry: m });
      }
    }
    return out;
  }, [renderItems, expandedStyleGroups, showBookFields, productGroupUnits]);

  function toggleStyleGroup(styleKey: string) {
    setExpandedStyleGroups((prev) => {
      const next = new Set(prev);
      if (next.has(styleKey)) next.delete(styleKey);
      else next.add(styleKey);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {/* React 19 use() dataset handoff: an invisible leaf that suspends
          on `instantPromise` behind its OWN `fallback={null}` (so the
          table rows above stay painted) and adopts the full dataset into
          local state the moment it streams in. Only the streamed default
          view passes instantPromise; deep links pass the awaited `instant`
          prop and never mount this. See the adoption note by the `adopted`
          state above. */}
      {instantPromise != null && instant == null && (
        <React.Suspense fallback={null}>
          <InstantDatasetAdopter promise={instantPromise} onResolve={handleAdopt} />
        </React.Suspense>
      )}
      {/* Saved views — built-in chips first, then user-saved, then save button */}
      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => (
          <Link
            key={v}
            href={hrefForView(v)}
            scroll={false}
            // No viewport prefetch: these hrefs embed the CURRENT q/filters,
            // so every keystroke re-prefetched 3-4 full RSC renders of the
            // low/out/archived variants (observed live) — pure server waste,
            // doubly so in instant mode where the click never hits the
            // server at all. Hover still warms in server mode.
            prefetch={false}
            // Instant mode: the stock filter derives locally, so the chip
            // becomes a shallow push (same URL, zero server work).
            onClick={
              instantMode ? (e) => interceptShallowNav(e, hrefForView(v), shallowPush) : undefined
            }
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
        {isArchivedView && (
          <Link
            href={hrefForAutoArchivedToggle()}
            scroll={false}
            prefetch={false}
            onClick={
              instantMode
                ? (e) => interceptShallowNav(e, hrefForAutoArchivedToggle(), shallowPush)
                : undefined
            }
            aria-pressed={autoArchivedOnly}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors',
              autoArchivedOnly
                ? 'border-foreground bg-foreground text-background'
                : 'border-border bg-background text-[var(--ed-ink-2)] hover:border-[var(--ed-line-strong)]',
            )}
          >
            Auto-archived only
          </Link>
        )}
        {(effectiveExpectedCount > 0 || expectedOnly) && (
          // "Expected" chip (mig 0277): items auto-created from inbound
          // POs, hidden from every default view until their first
          // receipt. Rendered only when such items exist (or the view is
          // already active, so it can be toggled off). The count badge
          // mirrors exactly what the view lists.
          <Link
            href={hrefForExpectedToggle()}
            scroll={false}
            prefetch={false}
            onClick={
              instantMode
                ? (e) => interceptShallowNav(e, hrefForExpectedToggle(), shallowPush)
                : undefined
            }
            aria-pressed={expectedOnly}
            title="Items created from purchase orders that haven't received any stock yet"
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[11.5px] transition-colors',
              expectedOnly
                ? 'border-foreground bg-foreground text-background'
                : 'border-border bg-background text-[var(--ed-ink-2)] hover:border-[var(--ed-line-strong)]',
            )}
          >
            Expected
            <span
              className={cn(
                'inline-flex min-w-[1.1rem] items-center justify-center rounded-full px-1 text-[10px] font-medium tabular-nums',
                expectedOnly ? 'bg-background/20 text-background' : 'bg-muted text-[var(--ed-ink-2)]',
              )}
            >
              {effectiveExpectedCount}
            </span>
          </Link>
        )}
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

      {/* Toolbar row + bulk-actions bar: GRID-STACKED in the same cell and
          swapped via `invisible`. Both layers stay mounted so the row's
          height is always the taller of the two — toggling selection causes
          ZERO vertical layout shift. The previous conditional mount inserted
          the bar as a NEW block above the table the moment selection became
          non-empty, pushing the table and every checkbox down by the bar's
          height: the just-clicked select-all "vanished" from under the
          cursor and the next click landed on the wrong element (owner's
          "select-all disappears" / "3-4 clicks for row checkmarks"
          reports). Gmail-style swap keeps every table pixel exactly where
          it was. */}
      <div className="grid">
        <div
          className={cn(
            'col-start-1 row-start-1 flex flex-wrap items-center gap-2',
            selected.size > 0 && 'invisible',
          )}
        >
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
                className="hover:text-foreground absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--ed-ink-4)] transition-colors"
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
              className="border-border hover:text-foreground inline-flex h-8 items-center gap-1 rounded-md border border-dashed px-2.5 text-[11.5px] text-[var(--ed-ink-3)] transition-colors hover:border-[var(--ed-line-strong)]"
              aria-label="Clear all filters"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}

          <button
            type="button"
            onClick={() => setStockView((v) => (v === 'placed' ? 'total' : 'placed'))}
            className="border-border hover:text-foreground inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-[11.5px] text-[var(--ed-ink-3)] transition-colors hover:border-[var(--ed-line-strong)]"
            aria-label="Toggle on-hand view"
            title="Switch between total on-hand and placed-only"
          >
            {stockView === 'placed' ? 'On hand: placed only' : 'On hand: total'}
          </button>

          <ExportMenu
            params={params}
            itemType={showBookFields ? 'book' : (params.get('type') ?? 'product')}
          />

          <p className="ml-auto flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-[var(--ed-ink-3)]">
            {/* Filter round-trip affordance: rows stay visible (dimmed) while
              the new result set loads; this small spinner is the "working"
              signal — mirrors the search box's "(searching…)" treatment. */}
            {isFilterPending && (
              <Loader2 aria-label="Updating results" className="h-3 w-3 animate-spin" />
            )}
            {(() => {
              // Instant mode: the totals ARE the filtered set (the
              // buildSumPage mirror runs locally over the full dataset),
              // so the footer never needs the "Showing N matching" hedge
              // or the "(searching…)" phase — every keystroke's answer is
              // complete.
              if (instantMode) {
                // Label and number must agree (see THE THREE COUNTS
                // above): "SKUs" counts DISTINCT SKUs (count 3), "rows"
                // counts the PLACEMENT rows actually rendered (count 2) —
                // NOT `effectiveTotal`, which is item rows (count 1) and
                // therefore understates the screen on the one surface
                // where the two differ (the Items list, which expands one
                // row per rack). The row term is worth showing only when
                // it differs from the SKU count — that difference IS the
                // collapsing the list just did.
                const skus = distinctSkuCount ?? effectiveTotal;
                const rows = placementRowCount ?? effectiveTotal;
                return (
                  <>
                    {formatNumber(skus)} SKUs ·{' '}
                    {skus !== rows ? <>{formatNumber(rows)} rows · </> : null}
                    {formatCurrency(valueOnHand)} on hand
                  </>
                );
              }
              const needle = q.trim();
              if (!needle) {
                return (
                  <>
                    {/* SERVER MODE holds ONE page, so it cannot count
                        distinct SKUs across the result set — and `total`
                        is an ITEM-ROW count (count 1), which grouping now
                        collapses on Books too. Label it what it is rather
                        than calling item rows "SKUs". */}
                    {formatNumber(total)} items · {formatCurrency(valueOnHand)} on hand
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

        {/* Bulk actions layer — always mounted (see grid-stack note above),
          revealed in place of the toolbar while rows are selected. */}
        <div
          className={cn(
            'col-start-1 row-start-1 flex min-w-0 flex-col justify-center',
            selected.size === 0 && 'invisible',
          )}
        >
          <BulkActions
            // DISTINCT item ids (not rowKeys) — actions are item-level and the
            // counter is selectedIds.length, so both stay correct even when two
            // rack rows of the same item are checked.
            selectedIds={selectedItemIds}
            categories={categories}
            suppliers={suppliers}
            locations={locations}
            tags={tags}
            canSetPublicVisibility={canSetPublicVisibility}
            // Books tab and Items tab share this table (see the onCycleCount
            // itemType inference below) — thread the same signal into the
            // bulk Export dialog so a books bulk-selection gets ISBN/Author/
            // Grade/Rack/Crate fields and the catalog layout instead of the
            // generic "items" experience.
            itemType={showBookFields ? 'book' : 'all'}
            onClear={() => setSelected(new Set())}
            // Instant mode holds the FULL dataset, so cross-page selections
            // resolve against it; server mode keeps today's page-row scan.
            // Match on the deduped item-id set (selection now keys on rowKey).
            hasArchivedSelection={(effectiveInstant?.items ?? items).some(
              (i) => selectedItemIdSet.has(i.id) && i.status === 'archived',
            )}
            // A "split" item (stock on >1 distinct rack/crate HOLDING) is
            // the one case bulk Set rack does NOT physically move — moving
            // it would be a guess (the bulk op carries no fromLocationId).
            // Warn in the dialog so the user reaches for Transfer instead.
            // isSplitRackItem reads rackHoldingsCount (by location_id), NOT
            // placed_racks.length (which dedupes by rack NAME and would
            // under-count a same-named rack split across two warehouses).
            hasSplitRackSelection={(effectiveInstant?.items ?? items).some(
              (i) => selectedItemIdSet.has(i.id) && isSplitRackItem(i),
            )}
            onCycleCount={() => {
              // Books tab and Items tab share this table; infer the pick
              // type from the base path so the confirm screen can group
              // Products vs Books. sku/name are display-only — the server
              // re-validates by id.
              const itemType = basePath.includes('/books') ? 'book' : 'product';
              const byId = new Map<string, Item>();
              for (const r of effectiveInstant?.items ?? items) byId.set(r.id, r);
              for (const r of serverHits ?? []) byId.set(r.id, r);
              // Distinct item ids — one cycle-count pick per item, never one
              // per rack row.
              const picks = selectedItemIds.map((id) => {
                const r = byId.get(id);
                return { id, sku: r?.sku ?? '', name: r?.name ?? 'Item', itemType };
              });
              addToCount(picks);
              setSelected(new Set());
              router.push('/dashboard/cycle-counts/new');
            }}
          />
        </div>
      </div>

      {/* Top pagination — mirrors the bottom one so users on long lists
          don't have to scroll to the bottom to flip pages. Same component,
          same URL state, same buildHref. Hides on single-page lists for
          the same reason the bottom one does. SERVER mode also hides it
          during an active search because the server response delivers the
          full filtered set up to the limit — pages recompose once `q`
          clears. INSTANT mode keeps it: search results are complete and
          paginate locally like any other filter. */}
      {showPagination && (
        <div className="flex items-center justify-end">
          <Pagination
            page={effectivePage}
            pageSize={pageSize}
            total={effectiveTotal}
            range={instantRange}
            buildHref={hrefForPage}
            onNavigate={instantMode ? shallowPush : undefined}
            pendingInstant={instantPending}
          />
        </div>
      )}

      {/* Table */}
      <div
        aria-busy={isFilterPending}
        className={cn(
          'border-border bg-card overflow-x-auto rounded-[10px] border transition-opacity',
          // Subtle pending treatment ONLY — never pointer-events-none. The
          // old pointer-events-none silently swallowed every row-checkbox
          // click for the full filter round-trip (seconds at org scale),
          // which is exactly the owner's "click 3-4 times" report. Rows stay
          // interactive: selection is keyed by rowKey — stable per holding,
          // same transition-stability property the old item-id key had — so
          // clicks landing during the transition still select the right row
          // (and bulk actions still resolve to the right distinct items).
          isFilterPending && 'opacity-60',
        )}
      >
        <table className="w-full min-w-[720px] text-[12.5px]">
          <thead>
            <tr className="border-border border-b">
              <th className="w-8 px-3">
                <Checkbox
                  checked={allVisibleSelected}
                  indeterminate={someVisibleSelected}
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
            {styledRenderItems.map((se) => {
              // Size-run (apparel) header — one collapsed row per style base
              // (e.g. "L4L - Pink Shirt"), stacked ABOVE the SKU grouping.
              // Expanding splices its member rows (the SAME `<tr>`s below) in
              // right after it.
              if (se.kind === 'style') {
                return (
                  <StyleGroupHeaderRow
                    key={`style-group:${se.group.styleKey}`}
                    group={se.group}
                    items={se.items}
                    expanded={expandedStyleGroups.has(se.group.styleKey)}
                    onToggle={() => toggleStyleGroup(se.group.styleKey)}
                    lookups={lookups}
                    rowLinkPrefix={rowLinkPrefix}
                    currentListUrl={currentListUrl}
                  />
                );
              }
              const entry = se.entry;
              // Model B SKU-group header: one collapsed row per SKU that
              // has MORE than one placement, showing the summed on-hand
              // total. A chevron toggles `expandedSkuGroups`, which
              // re-derives `renderItems` to splice the group's own
              // placement rows (the SAME `<tr>`s below, unchanged) in
              // right after it. Not selectable — no checkbox.
              if (entry.kind === 'header') {
                return (
                  <SkuGroupHeaderRow
                    key={`sku-group:${entry.group.sku}`}
                    group={entry.group}
                    items={entry.items}
                    expanded={expandedSkuGroups.has(entry.group.sku)}
                    onToggle={() => toggleSkuGroup(entry.group.sku)}
                    lookups={lookups}
                    sparkMode={sparkMode}
                    trends={effectiveTrends}
                    rowLinkPrefix={rowLinkPrefix}
                    currentListUrl={currentListUrl}
                    rowIdx={entry.rowIdx}
                    showBookFields={showBookFields}
                    stockView={stockView}
                    reservedByItem={reservedByItem}
                  />
                );
              }
              const { item, rowIdx } = entry;
              const category = item.category_id ? lookups.categories.get(item.category_id) : null;
              const location = item.primary_location_id
                ? lookups.locations.get(item.primary_location_id)
                : null;
              // Status badge + coverage bar follow AVAILABLE (on-hand −
              // reserved), matching the "{avail} avail · {out} out" indicator
              // below. A rental checkout reserves stock instead of decrementing
              // on-hand, so a fully checked-out item (0 avail, 1 out) must read
              // "Out of stock", not "In stock". reservedByItem is passed ONLY by
              // the rentals items view; everywhere else reserved is 0, so
              // available === on-hand and nothing changes.
              const reservedForStatus = reservedByItem?.get(item.id) ?? 0;
              const availableForStatus = Math.max(0, item.quantity_on_hand - reservedForStatus);
              const status = deriveStatus(availableForStatus, item.reorder_point);
              const par = Math.max(item.reorder_point * 4, item.quantity_on_hand * 1.5, 10);
              // Stable per (displayed, sparkMode, trends) — see seriesByItem above.
              const series = seriesByItem.get(item.id) ?? EMPTY_SERIES;
              // Key selection on rowKey (unique per rack row) — NOT item.id,
              // which is identical across an item's rack rows and made
              // checking one rack visually check them all (owner's "both
              // Chromebook rows checked but bar says 1 selected"). Bulk
              // actions still collapse back to distinct item ids (see
              // selectedItemIds).
              const isSelected = selected.has(item.rowKey ?? item.id);
              // Payload-diet rows (rank 5) carry only the thumb URL; the
              // cell renders whichever is present (thumb preferred, exactly
              // as before) and the hover preview lazy-loads the master.
              const rowThumbSrc = item.image_thumb_url ?? item.image_url;

              return (
                <tr
                  key={item.rowKey ?? item.id}
                  className={cn(
                    'border-border border-b transition-colors last:border-0',
                    isSelected ? 'bg-[hsl(var(--accent)/0.10)]' : 'hover:bg-muted/60',
                  )}
                >
                  <td className="px-3">
                    <Checkbox
                      checked={isSelected}
                      onChange={() => toggleOne(item.rowKey ?? item.id)}
                    />
                  </td>
                  <td className="py-2.5 pr-3">
                    <div className="flex items-center gap-2.5">
                      <ImageHoverPreview
                        src={item.image_url ?? null}
                        // Diet rows: master on demand (org-scoped route,
                        // same 25-day-stable URL the row used to carry).
                        srcLoader={
                          !item.image_url && item.image_thumb_url
                            ? () => loadMasterImageUrl(item.id)
                            : undefined
                        }
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
                        {rowThumbSrc ? (
                          <Image
                            // Prefer the pre-resized ~200px thumb
                            // (item_images.thumb_path, populated by
                            // uploads after 0122). Falls back to the
                            // master URL for rows that pre-date the
                            // thumb column — Vercel Image Optimizer
                            // downscales it on first hit and caches.
                            // Diet rows carry ONLY the thumb (rank 5).
                            src={rowThumbSrc}
                            // Thumbs are ALREADY ~200px WebPs — putting
                            // them through /_next/image adds no bytes
                            // saved, but the optimizer cache is
                            // PER-DEPLOYMENT: the first viewer after
                            // every deploy paid ~30 cold transforms
                            // (~750ms each, concurrency-capped) and the
                            // page "loaded" for 8-15s (owner-reported
                            // 2026-07-06). Serve pre-sized thumbs
                            // straight from storage; only legacy
                            // master-URL rows still go through the
                            // optimizer, which genuinely downscales
                            // them.
                            unoptimized={!!item.image_thumb_url}
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
                            className="border-border bg-muted h-7 w-7 shrink-0 rounded-[5px] border object-cover"
                          />
                        ) : (
                          <span
                            aria-hidden
                            className="border-border h-7 w-7 shrink-0 rounded-[5px] border"
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
                        ? (lookups.charters?.get(item.charter_id) ?? null)
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
                          className="text-[11px] italic text-[var(--ed-ink-4)]"
                          title="Generic stock — any charter serviced by this warehouse can use it"
                        >
                          {GENERIC_CHARTER_LABEL}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                    {location?.name ?? '—'}
                  </td>
                  {!showBookFields && (
                    <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                      {(() => {
                        // Split "one line per rack" row: show THIS row's location
                        // label (rack/crate name, or "Staging"/"Unplaced"). null
                        // = no holding → em dash. Staging/unplaced buckets read
                        // AMBER — this row's stock is awaiting put-away (owner
                        // decision 2026-07-08, consistent with the item detail
                        // card and the qty sub-line below).
                        if (item.placement_label !== undefined) {
                          const awaiting =
                            item.placement_kind === 'staging' || item.placement_kind === 'unplaced';
                          return item.placement_label ? (
                            <span
                              className={
                                awaiting
                                  ? 'text-warning font-mono tabular-nums'
                                  : 'font-mono tabular-nums'
                              }
                            >
                              {item.placement_label}
                            </span>
                          ) : (
                            <span className="text-[var(--ed-ink-4)]">—</span>
                          );
                        }
                        // Prefer the ACTUAL placement (rack/crate locations the
                        // stock sits in, from holdings). An empty array means the
                        // stock is unplaced/staged — show "—", not a stale label.
                        const placed = item.placed_racks;
                        if (placed !== undefined) {
                          if (placed.length === 0) {
                            return <span className="text-[var(--ed-ink-4)]">—</span>;
                          }
                          const shown = placed.slice(0, 2).join(', ');
                          const extra = placed.length - 2;
                          return (
                            <span className="font-mono tabular-nums" title={placed.join(', ')}>
                              {shown}
                              {extra > 0 ? ` +${extra}` : ''}
                            </span>
                          );
                        }
                        // Fallback for callers that don't compute holdings-based
                        // placement (kept for backwards-compat).
                        const rack = readItemRack(item.custom_fields);
                        return rack.rackLabel ? (
                          <span className="font-mono tabular-nums">{rack.rackLabel}</span>
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
                            {(() => {
                              const rackLabel = bookRackLabelFor(item);
                              return rackLabel ? (
                                <span className="font-mono tabular-nums">{rackLabel}</span>
                              ) : (
                                <span className="text-[var(--ed-ink-4)]">—</span>
                              );
                            })()}
                          </td>
                          <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                            {storage.crateNumber ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span
                                  aria-hidden
                                  title={color ? color.label : 'No color set'}
                                  className="border-border inline-block h-2.5 w-2.5 rounded-full border"
                                  style={color ? { backgroundColor: color.hex } : undefined}
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
                      // Split "one line per rack" row: ON HAND is THIS rack's
                      // quantity. If the bucket is staging/unplaced, add the
                      // amber "awaiting put-away" line so a split row reads the
                      // same as the item detail card (owner decision
                      // 2026-07-08). Placed rack rows show just the number.
                      if (item.line_quantity !== undefined) {
                        const awaiting =
                          item.placement_kind === 'staging' || item.placement_kind === 'unplaced';
                        return (
                          <>
                            {formatNumber(item.line_quantity)}
                            {awaiting && (
                              <div className="text-warning mt-0.5 text-[10.5px] font-normal leading-tight">
                                awaiting put-away
                              </div>
                            )}
                          </>
                        );
                      }
                      // Defensive defaults so rows without the new fields (older
                      // callers, non-service code paths) render exactly as before.
                      const staged = item.staged_quantity ?? 0;
                      const unplaced = item.unplaced_quantity ?? 0;
                      const placed = item.placed_quantity ?? item.quantity_on_hand;
                      // Single source of truth with the SKU-group header,
                      // which sums this exact function over its rows.
                      const shown = rowDisplayQuantity(item, stockView);
                      // Received/unassigned stock reads as ONE amber phrase —
                      // "awaiting put-away" (staged + unplaced) — per owner
                      // direction 2026-07-08: on-hand accounting is unchanged,
                      // but not-yet-put-away stock must be unmistakable. The
                      // staged/unplaced operational split still lives on the
                      // Staging page.
                      const awaiting = staged + unplaced;
                      return (
                        <>
                          {formatNumber(shown)}
                          {awaiting > 0 && (
                            <div className="mt-0.5 text-[10.5px] font-normal leading-tight">
                              {stockView === 'total' ? (
                                <>
                                  {/* Omit "0 placed" — for a fully-unplaced
                                      item it reads as if the item is
                                      unavailable. */}
                                  {placed > 0 && (
                                    <span className="text-[var(--ed-ink-4)]">
                                      {formatNumber(placed)} placed ·{' '}
                                    </span>
                                  )}
                                  <span className="text-warning">
                                    {formatNumber(awaiting)} awaiting put-away
                                  </span>
                                </>
                              ) : (
                                <span className="text-warning">
                                  +{formatNumber(awaiting)} awaiting put-away
                                </span>
                              )}
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
                    <StockBar stock={availableForStatus} par={par} status={status} />
                  </td>
                  <td className="px-3 text-right">
                    <Sparkline data={series} width={56} height={18} />
                  </td>
                  <td className="px-3">
                    <StockStatusBadge
                      quantity={availableForStatus}
                      reorderPoint={item.reorder_point}
                      itemStatus={item.status}
                      autoArchived={item.auto_archived}
                      awaitingFirstReceipt={item.awaiting_first_receipt === true}
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
            paginated views are bookmarkable + shareable. Server mode also
            hides during an active search; instant mode paginates search
            results locally (see top-pagination comment). */}
        {showPagination ? (
          <Pagination
            page={effectivePage}
            pageSize={pageSize}
            total={effectiveTotal}
            range={instantRange}
            buildHref={hrefForPage}
            onNavigate={instantMode ? shallowPush : undefined}
            pendingInstant={instantPending}
          />
        ) : (
          <span />
        )}
        {canCreate && (
          <Button asChild>
            <Link href={`${basePath}/new`}>+ New {showBookFields ? 'book' : 'item'}</Link>
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
  range,
  buildHref,
  onNavigate,
  pendingInstant = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** The REAL page count and row range, when the caller paginates in
   *  variable-size pages (instant mode packs whole SKU families, so a
   *  page can run over or under `pageSize`). Absent → the fixed-slice
   *  arithmetic below, which is exactly what server-mode pagination
   *  does. */
  range?: { pageCount: number; startRow: number; endRow: number };
  buildHref: (page: number) => string;
  /** Instant mode: plain left clicks on the page links become
   *  `onNavigate(href)` (a shallow history push — pagination without a
   *  server round trip). Modified clicks and copied hrefs keep working
   *  as real deep links. Absent → plain <Link> navigation, unchanged. */
  onNavigate?: (href: string) => void;
  /** TRUE while a streamed instant dataset is still resolving (the
   *  under-cap default view's adoption gap): the table is momentarily
   *  in server mode but is about to flip to instant, so the adjacent-
   *  page RSC prefetch below is suspended — it would fetch a ?page=2
   *  payload nothing ever consumes. Drops to false when the promise
   *  resolves null (over-cap org), re-enabling server-mode prefetch. */
  pendingInstant?: boolean;
}) {
  const totalPages = Math.max(1, range?.pageCount ?? Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startRow = range ? range.startRow : (safePage - 1) * pageSize + 1;
  const endRow = range ? range.endRow : Math.min(safePage * pageSize, total);
  const prevDisabled = safePage <= 1;
  const nextDisabled = safePage >= totalPages;
  const linkClick = onNavigate
    ? (href: string) => (e: React.MouseEvent<HTMLAnchorElement>) =>
        interceptShallowNav(e, href, onNavigate)
    : () => undefined;
  // SETTLED SERVER mode (no onNavigate, no pending instant payload)
  // only: full-RSC prefetch of the two ADJACENT pages so a Prev/Next
  // click swaps in already-fetched data instead of paying a ~1-2s
  // server round trip (>2000-item orgs have no instant dataset — every
  // page turn is a real navigation). Deliberately INTENT-SCOPED,
  // next + prev only — never the numbered popover herd (sidebar
  // lesson: idle-herd prefetching regressed the app; two visible,
  // high-probability targets is the whole budget). Instant mode keeps
  // prefetch={false}: pagination there is a shallow history push that
  // never talks to the server, so a prefetch would fetch RSC payloads
  // nothing will ever consume — and while an instant upgrade is still
  // PENDING (`pendingInstant`, the streamed default view's adoption
  // gap) the same waste applies, so prefetch waits until the promise
  // settles (resuming only if it resolves null → server mode is final).
  const adjacentPrefetch = !onNavigate && !pendingInstant;
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
            <Link
              href={buildHref(safePage - 1)}
              prefetch={adjacentPrefetch}
              onClick={linkClick(buildHref(safePage - 1))}
            >
              ← Prev
            </Link>
          )}
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Jump to page"
              className="hover:text-foreground hover:bg-muted/40 text-muted-foreground cursor-pointer rounded px-2 py-0.5 text-[11.5px] transition-colors"
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
                    // NEVER prefetch the numbered herd — only the two
                    // adjacent links above/below warm (intent-scoped;
                    // N full RSC prefetches on popover-open would be
                    // the sidebar idle-herd regression all over again).
                    prefetch={false}
                    onClick={linkClick(buildHref(n))}
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
            <Link
              href={buildHref(safePage + 1)}
              prefetch={adjacentPrefetch}
              onClick={linkClick(buildHref(safePage + 1))}
            >
              Next →
            </Link>
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * The ONE on-hand number a body row shows, given the current stock view.
 * The SKU-group header sums THIS across the rows it expands to for its
 * on-hand NUMBER, so a collapsed header's number always equals the sum
 * of its own children — under both toggle states. It is deliberately NOT
 * what the header's status badge / coverage bar / sparkline derive from:
 * the body row's health cells read the ITEM's on-hand regardless of the
 * toggle, so the header's must too (see SkuGroupHeaderRow's derivation
 * block). The header used to show a separate full-dataset
 * on-hand sum, which silently disagreed with the rows whenever the
 * "On hand: placed only" toggle was on (it persists in localStorage
 * SHARED with the Items list, so flipping it once on Items left Books in
 * placed-only).
 *
 * A placement-split row (`line_quantity`, the Items list's one-line-per-
 * rack shape) always shows THAT holding's quantity: the placed/total
 * distinction is already resolved by which holding line this is.
 */
function rowDisplayQuantity(item: Item, stockView: StockView): number {
  if (item.line_quantity !== undefined) return item.line_quantity;
  return stockView === 'total'
    ? item.quantity_on_hand
    : (item.placed_quantity ?? item.quantity_on_hand);
}

/**
 * The rack/crate labels a body row shows in the Items layout's rack cell,
 * resolved in the SAME priority order that cell uses (this row's holding
 * label → the item's holdings-derived racks → the custom_fields
 * fallback). An empty array means the row shows an em dash. The group
 * header counts DISTINCT labels across its rows with this — the header
 * must never claim more racks than the rows beneath it actually list.
 */
function itemRackLabels(item: Item): string[] {
  if (item.placement_label !== undefined) {
    return item.placement_label ? [item.placement_label] : [];
  }
  if (item.placed_racks !== undefined) return item.placed_racks;
  const rack = readItemRack(item.custom_fields);
  return rack.rackLabel ? [rack.rackLabel] : [];
}

/**
 * Roll up a per-placement text field for a SKU-group header. A field that
 * DIFFERS across placements must never be shown as if it were the group's
 * value (that is the whole reason rollupStatus exists) — so this reports
 * 'multiple' instead and lets the caller render a neutral label. Nulls
 * count as a distinct absence: [null, '38-A'] is 'multiple', not '38-A'.
 */
/**
 * The BOOKS view's RACK cell value for one row.
 *
 * The books layout has NO holdings-derived cell — the `placed_racks` column is
 * gated behind `!showBookFields` — so this column used to read
 * `readBookStorage(custom_fields).rackLabel` straight, and a book whose stock
 * had moved entirely into a position-less crate kept printing the rack it left
 * (mig 0335 preserves those keys on purpose). `resolvePlacement` owns the
 * decision; this only picks the compact rendering the narrow cell has room for.
 *
 * `itemType: 'book'` is asserted rather than read: every caller is inside a
 * `showBookFields` branch, and that flag is what puts the row in this layout.
 */
export function bookRackLabelFor(item: {
  custom_fields?: Record<string, unknown> | null;
  placed_holdings?: RackHoldingLike[];
}): string | null {
  const res = resolvePlacement({
    itemType: 'book',
    customFields: item.custom_fields ?? null,
    holdings: item.placed_holdings,
  });
  if (res.source === 'holdings') {
    return res.holdings
      .map((h) => h.name)
      .sort((a, b) => a.localeCompare(b))
      .join(', ');
  }
  return res.source === 'structured' ? res.rackLabel : null;
}

function rollupText(
  values: ReadonlyArray<string | null>,
): { kind: 'none' } | { kind: 'same'; value: string } | { kind: 'multiple'; count: number } {
  if (values.length === 0) return { kind: 'none' };
  // noUncheckedIndexedAccess: [0] is T|undefined even after the length check.
  const first = values[0] ?? null;
  if (values.every((v) => (v ?? null) === first)) {
    return first == null ? { kind: 'none' } : { kind: 'same', value: first };
  }
  return { kind: 'multiple', count: values.length };
}

/**
 * Model B: the collapsed SKU-group header row. Renders once per SKU that
 * has MORE than one placement (a SKU with exactly one placement renders
 * as a plain row instead — see the `skuGroups`/`renderItems` derivation
 * in InventoryTable). NOT selectable (no checkbox — bulk actions only
 * ever target the individual placement rows beneath it, unchanged).
 *
 * DISPLAY ONLY: the headline total is a read-time SUM of exactly what the
 * expanded rows show (rowDisplayQuantity per row) — it never writes or
 * recomputes any record.
 */
function SkuGroupHeaderRow({
  group,
  items,
  expanded,
  onToggle,
  lookups,
  sparkMode,
  trends,
  rowLinkPrefix,
  currentListUrl,
  rowIdx,
  showBookFields,
  stockView,
  reservedByItem,
}: {
  group: SkuGroup;
  items: Item[];
  expanded: boolean;
  onToggle: () => void;
  lookups: Lookups;
  sparkMode: SparkMode;
  trends: InventoryTableProps['trends'];
  rowLinkPrefix: string;
  currentListUrl: string;
  rowIdx: number;
  /** Books layout renders 14 columns (Grade/Rack/Crate) where Items
   *  renders 12 (one Rack column) — the header must emit the SAME cell
   *  count as the body rows beneath it or every cell right of Location
   *  shifts one column. See the Rack/Grade/Crate branch below. */
  showBookFields: boolean;
  /** The "On hand: total / placed only" toggle. The header total is
   *  derived from it so a collapsed header always equals the sum of the
   *  rows it expands to. */
  stockView: StockView;
  /** Rentals-only reserved-quantity map (undefined on Items/Books). The
   *  header's health cells subtract it exactly like the body rows do, so
   *  a fully checked-out group cannot badge "In stock" while every row
   *  beneath it badges "Out of stock". */
  reservedByItem?: Map<string, number>;
}) {
  // Only IDENTITY fields come from the FIRST placement (first-seen order —
  // see group-by-sku.ts): a SKU is one product identity (mig 0234 makes
  // (org, sku, charter_id, bin_location) the uniqueness key), so name and
  // cover image are shared by construction. Every field that is genuinely
  // PER-ROW — status, charter, category, primary location, and the books
  // grade/rack/crate — is rolled up instead, because showing one
  // placement's value as if it were the group's is exactly the masking
  // bug rollupStatus exists to prevent.
  const first = items[0]!;
  // ── WHAT A HEADER DERIVES EACH VALUE FROM (settled once, applied to
  // every cell below) ────────────────────────────────────────────────
  // A collapsed header is a SUMMARY OF THE ROWS IT EXPANDS TO, so every
  // cell mirrors the SAME source its body-row counterpart reads:
  //   • the ON-HAND NUMBER mirrors the body's quantity cell → sum of
  //     rowDisplayQuantity over the PLACEMENT rows (honours the
  //     placed-only toggle and the one-line-per-rack split).
  //   • the HEALTH cells — status badge, coverage bar, sparkline —
  //     mirror the body's health cells, which read the ITEM's on-hand
  //     minus reserved (`availableForStatus`), independent of the toggle
  //     and identical on every rack row of one item. They therefore sum
  //     over DISTINCT ITEMS: summing placement rows would count one
  //     item's on-hand once per rack, and following the toggle would let
  //     a header badge "Out of stock" over rows all badging "In stock".
  //   • every genuinely per-row TEXT field is rolled up (Multiple / a
  //     count / an em dash) — never taken from one placement.
  const distinctItems = Array.from(new Map(items.map((it) => [it.id, it])).values());
  const availableOf = (it: Item): number =>
    Math.max(0, it.quantity_on_hand - (reservedByItem?.get(it.id) ?? 0));
  const displayedTotal = items.reduce((sum, it) => sum + rowDisplayQuantity(it, stockView), 0);
  const healthQuantity = distinctItems.reduce((sum, it) => sum + availableOf(it), 0);
  // reorder_point is per-row too, and taking `first`'s let the
  // quantity-derived badge read HEALTHIER than the group's worst
  // placement — the exact masking rollupStatus exists to prevent. Roll
  // it up as the SUM: the group's replenishment need is the sum of its
  // placements' needs, which puts threshold and quantity on the same
  // (group) scale. It is also the only rollup that guarantees the
  // header can never out-rank a UNANIMOUS reading — if every placement
  // is low then Σqty ≤ Σreorder, and if every placement is out then
  // Σqty ≤ 0. A MIXED group falls back to the honest aggregate, the
  // same every()-not-some() rule the lifecycle flags below follow.
  const groupReorderPoint = distinctItems.reduce(
    (sum, it) => sum + (Number(it.reorder_point) || 0),
    0,
  );
  const status = deriveStatus(healthQuantity, groupReorderPoint);
  // The coverage bar's PAR must be built from the same inputs the body
  // rows use, or the header fills to a different fraction than the rows
  // it summarises. A body row computes
  //   par = max(reorder_point × 4, quantity_on_hand × 1.5, 10)
  // — note the third term is ON-HAND, NOT available (on-hand − reserved),
  // even though the BAR's fill is available. Substituting `healthQuantity`
  // here shrank the header's par wherever stock is reserved (the rentals
  // view), so an identical group read fuller in the header than in its own
  // rows. Sum on-hand over DISTINCT ITEMS for the same reason
  // `healthQuantity` does: an item's on-hand is repeated on each of its
  // placement rows.
  const parQuantity = distinctItems.reduce(
    (sum, it) => sum + (Number(it.quantity_on_hand) || 0),
    0,
  );
  const par = Math.max(groupReorderPoint * 4, parQuantity * 1.5, 10);
  // The sparkline is the group's series, not one placement's. Plotting
  // `first`'s 14-day trend beside a SUMMED number presented one member's
  // history as the whole group's; sum the members' series element-wise
  // instead so the curve and the number describe the same scope.
  const series = (() => {
    const members = distinctItems.map((it) =>
      seriesForRow(it.id, availableOf(it), sparkMode, trends),
    );
    const len = members.reduce((n, s) => Math.max(n, s.length), 0) || 14;
    return Array.from({ length: len }, (_, i) => members.reduce((sum, s) => sum + (s[i] ?? 0), 0));
  })();
  // category_id / primary_location_id are per-row and CAN differ across a
  // SKU's placements (books imported by different POs land in different
  // book categories; placements can sit at different sites). Roll up
  // rather than taking `first` — same class of bug as the charter column,
  // which already had this right.
  const categoryRollup = rollupText(items.map((it) => it.category_id));
  const category =
    categoryRollup.kind === 'same' ? lookups.categories.get(categoryRollup.value) : null;
  const locationRollup = rollupText(items.map((it) => it.primary_location_id));
  const location =
    locationRollup.kind === 'same' ? lookups.locations.get(locationRollup.value) : null;
  const distinctCharterIds = new Set(items.map((it) => it.charter_id ?? ''));
  const rowThumbSrc = first.image_thumb_url ?? first.image_url;
  // `status` is a PER-PLACEMENT field — placements of one SKU can
  // legitimately differ (e.g. one discontinued at a site while others stay
  // active). Never take just the first placement's status here: that can
  // mask a discontinued/archived placement behind a healthy badge for the
  // whole group. Roll up conservatively instead (see group-by-sku.ts).
  const rolledUpStatus = rollupStatus(distinctItems.map((it) => it.status));
  // LIFECYCLE FLAGS (migs 0277 / 0266) are per-placement too, and the
  // header dropped both — so in the Expected view (?expected=1) a title
  // whose rows ALL await their first receipt collapsed into one "Out of
  // stock" badge, inside the very view that exists to show expected
  // stock; and in the Archived view an auto-archived group read as a
  // plain "Archived".
  // ROLLUP RULE — every(), not some(), for both. These are the only two
  // flags that make a zero-quantity group read as SOFTER than "out of
  // stock" / "archived by a person". A group where only SOME rows await
  // a first receipt has real received stock on the others, so an
  // "Expected" pill would be the more-flattering, less-true reading —
  // exactly what rollupStatus refuses to do. Requiring every() means the
  // pill appears only when it is unambiguously the whole truth, and a
  // mixed group falls back to the ordinary quantity-derived badge —
  // never anything healthier than its worst placement.
  const allAwaitingFirstReceipt = distinctItems.every((it) => it.awaiting_first_receipt === true);
  const allAutoArchived = distinctItems.every((it) => it.auto_archived === true);

  return (
    <tr className="border-border bg-muted/30 border-b transition-colors last:border-0">
      {/* Not selectable — no checkbox (bulk actions target placements). */}
      <td className="px-3" />
      <td className="py-2.5 pr-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.sku} (${items.length} placements)`}
            className="hover:bg-muted hover:text-foreground grid h-5 w-5 shrink-0 place-items-center rounded-sm text-[var(--ed-ink-3)] transition-colors"
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')}
            />
          </button>
          <ImageHoverPreview
            src={first.image_url ?? null}
            srcLoader={
              !first.image_url && first.image_thumb_url
                ? () => loadMasterImageUrl(first.id)
                : undefined
            }
            alt={first.name}
            title={first.name}
            subtitle={group.sku}
            meta={
              <span>
                On hand{' '}
                <span
                  className="text-foreground font-medium tabular-nums"
                  title={
                    group.totalIsPartial
                      ? 'This total only counts placements on the current page — other pages may hold more of this SKU.'
                      : undefined
                  }
                >
                  {formatNumber(displayedTotal)}
                </span>
                {group.totalIsPartial && (
                  <span aria-hidden className="ml-0.5 text-[var(--ed-ink-4)]">
                    *
                  </span>
                )}
              </span>
            }
            className="shrink-0"
          >
            {rowThumbSrc ? (
              <Image
                src={rowThumbSrc}
                unoptimized={!!first.image_thumb_url}
                alt=""
                width={56}
                height={56}
                sizes="28px"
                priority={rowIdx < 12}
                placeholder={first.image_lqip ? 'blur' : 'empty'}
                blurDataURL={first.image_lqip ?? undefined}
                className="border-border bg-muted h-7 w-7 shrink-0 rounded-[5px] border object-cover"
              />
            ) : (
              <span
                aria-hidden
                className="border-border h-7 w-7 shrink-0 rounded-[5px] border"
                style={{
                  background:
                    'repeating-linear-gradient(45deg, hsl(var(--border)) 0 1px, transparent 1px 6px), hsl(var(--muted))',
                }}
              />
            )}
          </ImageHoverPreview>
          <Link
            href={`${rowLinkPrefix}/${first.id}?return=${encodeURIComponent(currentListUrl)}`}
            prefetch={false}
            className="font-medium hover:underline"
          >
            {first.name}
          </Link>
        </div>
      </td>
      <td className="px-3 font-mono text-[11.5px] tracking-[-0.01em] text-[var(--ed-ink-3)]">
        {group.sku}
      </td>
      <td className="px-3">
        {categoryRollup.kind === 'multiple' ? (
          <span
            className="text-[11px] italic text-[var(--ed-ink-4)]"
            title="Placements span multiple categories — expand to see each"
          >
            Multiple
          </span>
        ) : category ? (
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
        {distinctCharterIds.size > 1 ? (
          <span
            className="text-[11px] italic text-[var(--ed-ink-4)]"
            title="Placements span multiple charters — expand to see each"
          >
            Multiple
          </span>
        ) : first.charter_id ? (
          (() => {
            const charter = lookups.charters?.get(first.charter_id!) ?? null;
            return charter ? (
              <span className="text-[var(--ed-ink-2)]" title={charter.name}>
                {charter.code ?? charter.name}
              </span>
            ) : (
              <span className="text-[11px] italic text-[var(--ed-ink-4)]">{GENERIC_CHARTER_LABEL}</span>
            );
          })()
        ) : (
          <span
            className="text-[11px] italic text-[var(--ed-ink-4)]"
            title="Generic stock — any charter serviced by this warehouse can use it"
          >
            {GENERIC_CHARTER_LABEL}
          </span>
        )}
      </td>
      <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
        {locationRollup.kind === 'multiple' ? (
          <span
            className="text-[11px] italic text-[var(--ed-ink-4)]"
            title="Placements span multiple sites — expand to see each"
          >
            Multiple
          </span>
        ) : (
          // Plain em dash in the same ink-3 token the BODY row's Location
          // cell uses, so a collapsed group and its expanded placements
          // read identically.
          (location?.name ?? '—')
        )}
      </td>
      {!showBookFields &&
        (() => {
          // Items layout: this is the RACK cell — the body row prints the
          // rack/crate label(s) that row sits in. The header printed
          // `items.length`, a count of placement ROWS labelled
          // "locations", so three rows sharing two racks read "3
          // locations" while expanding showed two. Count DISTINCT labels
          // (same fix as the books Rack cell), and give rows with no rack
          // at all their own explicit tail rather than counting them as a
          // location that doesn't exist.
          const labels = Array.from(new Set(items.flatMap(itemRackLabels)));
          const unset = items.filter((it) => itemRackLabels(it).length === 0).length;
          if (labels.length === 0) {
            return (
              <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                <span className="text-[var(--ed-ink-4)]">—</span>
              </td>
            );
          }
          if (labels.length === 1 && unset === 0) {
            return (
              <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                <span className="font-mono tabular-nums">{labels[0]}</span>
              </td>
            );
          }
          return (
            <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
              <span
                title={`Placements span: ${labels.join(', ')}${
                  unset > 0 ? ` (+${unset} with no rack set)` : ''
                }`}
              >
                {labels.length} location{labels.length === 1 ? '' : 's'}
                {unset > 0 ? ` +${unset} unset` : ''}
              </span>
            </td>
          );
        })()}
      {showBookFields &&
        (() => {
          // Books layout: the body row emits THREE cells here (grade /
          // rack / crate — see the `showBookFields &&` block in the row
          // map), so the header must too or every cell right of Location
          // shifts one column. Each is rolled up, never taken from
          // `first`: these live in custom_fields PER inventory_items row
          // and can genuinely differ across a SKU's placements (one row
          // graded during a PO import, its sibling graded by hand).
          const storages = items.map((it) => readBookStorage(it.custom_fields));
          const grade = rollupText(storages.map((s) => s.grade));
          // Rolled up from the RESOLVED label, not the raw custom_fields one —
          // otherwise the collapsed header names a rack that its own expanded
          // rows (which resolve) no longer show.
          const rackLabels_ = items.map(bookRackLabelFor);
          const rack = rollupText(rackLabels_);
          // Colour is only a visual aid attached to a crate NUMBER, so
          // both must agree before a swatch is drawn — a coloured dot for
          // a group whose placements sit in different crates sends staff
          // to the wrong crate.
          const crate = rollupText(
            storages.map((s) => (s.crateNumber ? `${s.crateColor ?? ''}|${s.crateNumber}` : null)),
          );
          // `crate.value` is only a comparison KEY — read the display
          // values back off the first placement rather than splitting it,
          // so a crate number that ever contains the '|' separator can't
          // render a truncated number. kind==='same' guarantees every
          // placement carries this exact colour + number.
          const crateColor = crate.kind === 'same' ? getCrateColor(storages[0]?.crateColor) : null;
          const crateNumber = crate.kind === 'same' ? (storages[0]?.crateNumber ?? '') : '';
          // Every DISTINCT rack label present. The count below is a count
          // of RACKS, not of placements: three placements sharing two
          // racks is "2 racks", and printing items.length there said "3
          // racks" while this very tooltip listed only two.
          const rackLabels = Array.from(
            new Set(rackLabels_.filter((l): l is string => !!l)),
          );
          // Placements with no rack set at all are not a rack — counting
          // them into "N racks" would send staff looking for a shelf that
          // doesn't exist, so they get their own explicit "unset" tail.
          const rackUnset = rackLabels_.filter((l) => !l).length;
          const rackCountLabel = `${rackLabels.length} rack${rackLabels.length === 1 ? '' : 's'}${
            rackUnset > 0 ? ` +${rackUnset} unset` : ''
          }`;
          return (
            <>
              <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                {grade.kind === 'same' ? (
                  <span className="font-mono">
                    {/^\d{1,2}$/.test(grade.value) ? `Gr ${grade.value}` : grade.value}
                  </span>
                ) : grade.kind === 'multiple' ? (
                  <span
                    className="text-[11px] italic text-[var(--ed-ink-4)]"
                    title="Placements span multiple grades — expand to see each"
                  >
                    Multiple
                  </span>
                ) : (
                  <span className="text-[var(--ed-ink-4)]">—</span>
                )}
              </td>
              <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                {/* Rack is the books layout's analogue of the items
                    "N locations" cell — and the field the owner
                    physically walks to. When every placement agrees the
                    concrete label is strictly more useful than a count;
                    when they differ a COUNT (never one placement's rack)
                    is the only honest value, and it preserves the
                    how-many-placements information the items header
                    carries. */}
                {rack.kind === 'same' ? (
                  <span className="font-mono tabular-nums">{rack.value}</span>
                ) : rack.kind === 'multiple' ? (
                  <span
                    title={
                      rackLabels.length > 0
                        ? `Placements span: ${rackLabels.join(', ')}${
                            rackUnset > 0 ? ` (+${rackUnset} with no rack set)` : ''
                          }`
                        : 'Placements span multiple racks — expand to see each'
                    }
                  >
                    {rackCountLabel}
                  </span>
                ) : (
                  <span className="text-[var(--ed-ink-4)]">—</span>
                )}
              </td>
              <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
                {crate.kind === 'same' ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden
                      title={crateColor ? crateColor.label : 'No color set'}
                      className="border-border inline-block h-2.5 w-2.5 rounded-full border"
                      style={crateColor ? { backgroundColor: crateColor.hex } : undefined}
                    />
                    <span className="font-mono tabular-nums">{crateNumber}</span>
                  </span>
                ) : crate.kind === 'multiple' ? (
                  <span
                    className="text-[11px] italic text-[var(--ed-ink-4)]"
                    title="Placements sit in different crates — expand to see each"
                  >
                    Multiple
                  </span>
                ) : (
                  <span className="text-[var(--ed-ink-4)]">—</span>
                )}
              </td>
            </>
          );
        })()}
      <td
        className="px-3 text-right font-mono font-medium tabular-nums"
        title={
          group.totalIsPartial
            ? 'This total only counts placements on the current page — other pages may hold more of this SKU.'
            : undefined
        }
      >
        {formatNumber(displayedTotal)}
        {group.totalIsPartial && (
          <span aria-hidden className="ml-0.5 text-[var(--ed-ink-4)]">
            *
          </span>
        )}
      </td>
      <td className="px-3">
        <StockBar stock={healthQuantity} par={par} status={status} />
      </td>
      <td className="px-3 text-right">
        <Sparkline data={series} width={56} height={18} />
      </td>
      <td className="px-3">
        <StockStatusBadge
          quantity={healthQuantity}
          reorderPoint={groupReorderPoint}
          itemStatus={rolledUpStatus}
          autoArchived={allAutoArchived}
          awaitingFirstReceipt={allAwaitingFirstReceipt}
        />
      </td>
      <td className="px-3 text-right text-[11.5px] text-[var(--ed-ink-4)]">—</td>
    </tr>
  );
}

/**
 * Size-run (apparel) group header — one collapsed row for a run of same-base
 * sized items ("L4L - Pink Shirt - L / - XL / - 2XL"). A clone of
 * SkuGroupHeaderRow adapted for a run: the SKU column reads "—" (members have
 * distinct SKUs), the roll-up total sums member on-hand, and a "N sizes" chip
 * shows the run size. Not selectable (bulk actions target the member rows).
 */
function StyleGroupHeaderRow({
  group,
  items,
  expanded,
  onToggle,
  lookups,
  rowLinkPrefix,
  currentListUrl,
}: {
  group: SizeRunGroup<RenderEntry>;
  items: Item[];
  expanded: boolean;
  onToggle: () => void;
  lookups: Lookups;
  rowLinkPrefix: string;
  currentListUrl: string;
}) {
  const first = items[0]!;
  const status = deriveStatus(group.total, first.reorder_point);
  const par = Math.max(first.reorder_point * 4, group.total * 1.5, 10);
  const category = first.category_id ? lookups.categories.get(first.category_id) : null;
  const location = first.primary_location_id
    ? lookups.locations.get(first.primary_location_id)
    : null;
  const distinctCharterIds = new Set(items.map((it) => it.charter_id ?? ''));
  const rowThumbSrc = first.image_thumb_url ?? first.image_url;
  // Status is per-member and can differ; roll up conservatively (see group-by-sku).
  const rolledUpStatus = rollupStatus(items.map((it) => it.status));
  // A STORED group knows what it is and what it counts in, so its header reads
  // "3 variants · 18 pairs total". A name-derived run knows neither — its
  // "sizes" are tokens parsed out of a display string — so it keeps the older,
  // weaker claim. Byte-identical for every ungrouped org.
  const sizeLabel =
    group.groupId && group.countingUnit
      ? groupRollupLabel(
          group.sizeCount,
          group.total,
          countingUnitLabel(group.countingUnit as CountingUnit, group.total),
        )
      : group.groupId
        ? `${group.sizeCount} variant${group.sizeCount === 1 ? '' : 's'}`
        : `${group.sizeCount} size${group.sizeCount === 1 ? '' : 's'}`;

  // Rack summary across the run's members. This cell used to render
  // `sizeLabel`, which merely repeated the badge already shown next to the name
  // — so the Rack column read "3 variants · 9 pairs total" and told you nothing
  // about where the stock physically is, the one thing the column exists for.
  //
  // Mirrors the SKU header's cell deliberately (same source of truth, same
  // wording): the concrete label when every member agrees, an honest COUNT when
  // they differ — never one member's rack, which would send staff to the wrong
  // shelf — and an explicit "+N unset" tail, because a member with no rack is
  // not a rack. Reads `placed_racks` (where the stock actually sits, from
  // holdings) and falls back to the free-text label only for callers that don't
  // compute holdings, exactly as the member rows below do.
  const rackLabels: string[] = [];
  let rackUnset = 0;
  for (const it of items) {
    // `[]` is meaningful (holdings computed, nothing placed) so only a missing
    // field falls through to the legacy label.
    const placed =
      it.placed_racks ??
      (readItemRack(it.custom_fields).rackLabel
        ? [readItemRack(it.custom_fields).rackLabel as string]
        : []);
    if (placed.length === 0) {
      rackUnset += 1;
      continue;
    }
    for (const label of placed) if (!rackLabels.includes(label)) rackLabels.push(label);
  }
  const rackCountLabel = `${rackLabels.length} rack${rackLabels.length === 1 ? '' : 's'}${
    rackUnset > 0 ? ` +${rackUnset} unset` : ''
  }`;

  return (
    <tr className="border-border bg-muted/30 border-b transition-colors last:border-0">
      {/* Not selectable — no checkbox (bulk actions target the member rows). */}
      <td className="px-3" />
      <td className="py-2.5 pr-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.baseName} (${sizeLabel})`}
            className="hover:bg-muted hover:text-foreground grid h-5 w-5 shrink-0 place-items-center rounded-sm text-[var(--ed-ink-3)] transition-colors"
          >
            <ChevronRight
              className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')}
            />
          </button>
          <ImageHoverPreview
            src={first.image_url ?? null}
            srcLoader={
              !first.image_url && first.image_thumb_url
                ? () => loadMasterImageUrl(first.id)
                : undefined
            }
            alt={first.name}
            title={group.baseName}
            subtitle={sizeLabel}
            meta={
              <span>
                On hand{' '}
                <span className="text-foreground font-medium tabular-nums">
                  {formatNumber(group.total)}
                </span>
              </span>
            }
            className="shrink-0"
          >
            {rowThumbSrc ? (
              <Image
                src={rowThumbSrc}
                unoptimized={!!first.image_thumb_url}
                alt=""
                width={56}
                height={56}
                sizes="28px"
                placeholder={first.image_lqip ? 'blur' : 'empty'}
                blurDataURL={first.image_lqip ?? undefined}
                className="border-border bg-muted h-7 w-7 shrink-0 rounded-[5px] border object-cover"
              />
            ) : (
              <span
                aria-hidden
                className="border-border h-7 w-7 shrink-0 rounded-[5px] border"
                style={{
                  background:
                    'repeating-linear-gradient(45deg, hsl(var(--border)) 0 1px, transparent 1px 6px), hsl(var(--muted))',
                }}
              />
            )}
          </ImageHoverPreview>
          <Link
            href={`${rowLinkPrefix}/${first.id}?return=${encodeURIComponent(currentListUrl)}`}
            prefetch={false}
            className="font-medium hover:underline"
          >
            {group.baseName}
          </Link>
          <span className="border-border shrink-0 rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--ed-ink-3)]">
            {sizeLabel}
          </span>
        </div>
      </td>
      {/* SKU — a run spans multiple SKUs, so no single value. */}
      <td className="px-3 text-[11.5px] italic text-[var(--ed-ink-4)]">—</td>
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
        {distinctCharterIds.size > 1 ? (
          <span
            className="text-[11px] italic text-[var(--ed-ink-4)]"
            title="Sizes span multiple charters — expand to see each"
          >
            Multiple
          </span>
        ) : first.charter_id ? (
          (() => {
            const charter = lookups.charters?.get(first.charter_id!) ?? null;
            return charter ? (
              <span className="text-[var(--ed-ink-2)]" title={charter.name}>
                {charter.code ?? charter.name}
              </span>
            ) : (
              <span className="text-[11px] italic text-[var(--ed-ink-4)]">{GENERIC_CHARTER_LABEL}</span>
            );
          })()
        ) : (
          <span
            className="text-[11px] italic text-[var(--ed-ink-4)]"
            title="Generic stock — any charter serviced by this warehouse can use it"
          >
            {GENERIC_CHARTER_LABEL}
          </span>
        )}
      </td>
      <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">{location?.name ?? '—'}</td>
      <td className="px-3 text-[12px] text-[var(--ed-ink-3)]">
        {rackLabels.length === 0 ? (
          <span className="text-[var(--ed-ink-4)]">—</span>
        ) : rackLabels.length === 1 && rackUnset === 0 ? (
          <span className="font-mono tabular-nums">{rackLabels[0]}</span>
        ) : (
          <span
            title={`Placements span: ${rackLabels.join(', ')}${
              rackUnset > 0 ? ` (+${rackUnset} with no rack set)` : ''
            }`}
          >
            {rackCountLabel}
          </span>
        )}
      </td>
      <td className="px-3 text-right font-mono font-medium tabular-nums">
        {formatNumber(group.total)}
      </td>
      <td className="px-3">
        <StockBar stock={group.total} par={par} status={status} />
      </td>
      <td className="px-3 text-right text-[11.5px] text-[var(--ed-ink-4)]">—</td>
      <td className="px-3">
        <StockStatusBadge
          quantity={group.total}
          reorderPoint={first.reorder_point}
          itemStatus={rolledUpStatus}
        />
      </td>
      <td className="px-3 text-right text-[11.5px] text-[var(--ed-ink-4)]">—</td>
    </tr>
  );
}

/** Shared box styling for the interactive Checkbox and the non-interactive
 *  CheckGlyph so the two can never drift apart visually. */
function checkboxBoxClasses(checked: boolean): string {
  return cn(
    'inline-grid h-5 w-5 place-items-center rounded-[5px] border bg-card transition-colors',
    checked ? 'border-foreground bg-foreground' : 'border-[var(--ed-line-strong)]',
  );
}

/** CSS-drawn ✓: bottom+RIGHT borders rotated +45°. bottom+LEFT at -45°
 *  renders the MIRROR of a checkmark (owner-reported "backwards checkmark",
 *  hard to read at 14px). */
function CheckTick() {
  return (
    <span
      aria-hidden
      className="border-background h-[11px] w-[6px] -translate-y-px rotate-45 border-b-2 border-r-2"
    />
  );
}

function Checkbox({
  checked,
  indeterminate = false,
  onChange,
}: {
  checked: boolean;
  /** Some-but-not-all state (header over a partially selected page). */
  indeterminate?: boolean;
  onChange: (c: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked ? 'true' : indeterminate ? 'mixed' : 'false'}
      onClick={() => onChange(!checked)}
      className={checkboxBoxClasses(checked || indeterminate)}
    >
      {checked ? (
        <CheckTick />
      ) : indeterminate ? (
        <span aria-hidden className="bg-background h-[2px] w-[10px] rounded-full" />
      ) : null}
    </button>
  );
}

/**
 * NON-INTERACTIVE checkbox visual, for use INSIDE another interactive
 * element. MultiSelectFilter's option rows used to nest the <button>
 * Checkbox inside the row <button>: a click directly on the box fired the
 * inner onChange AND bubbled to the row's onClick — two toggles in one
 * click, batched by React into a visual no-op. That self-cancelling
 * double-toggle is the owner's "I had to click the filter boxes 3-4 times"
 * report (only clicks on the label text registered once). The wrapping
 * element owns role="checkbox" + aria-checked; this is just the picture.
 */
function CheckGlyph({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={checkboxBoxClasses(checked)}>
      {checked && <CheckTick />}
    </span>
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
          className="border-border bg-background inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)]"
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
                'hover:bg-muted rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors',
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

/**
 * Multi-select filter dropdown. LIVE-APPLY + OPTIMISTIC: every toggle calls
 * onChange immediately — the parent (useInstantFilters) flips the visible
 * state synchronously and debounces the actual navigation, so each click
 * gives instant feedback while rapid picks coalesce into ONE server
 * round-trip. Two prior designs both produced the owner's "3-4 clicks"
 * report and must not come back:
 *   • per-click router.replace — zero feedback until the round-trip landed;
 *   • draft-commit-on-popover-close — nothing applied while picking, and
 *     its Checkbox was a <button> NESTED inside the row <button>, so a
 *     direct click on the box fired both handlers and self-cancelled.
 * The row button is now the single interactive element (role="checkbox");
 * the box itself is the non-interactive CheckGlyph.
 *
 * Exported for tests (inventory-table.filters.test.tsx).
 */
export function MultiSelectFilter({
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
  const visible = filter.trim()
    ? options.filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : options;
  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'bg-background inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] transition-colors hover:border-[var(--ed-line-strong)]',
            selected.size > 0
              ? 'border-foreground text-foreground'
              : 'border-border text-[var(--ed-ink-2)]',
          )}
          aria-label={`Filter by ${label}`}
        >
          <span>{label}</span>
          {selected.size > 0 && (
            <span className="bg-foreground text-background grid h-4 min-w-4 place-items-center rounded-full px-1 font-mono text-[10px] tabular-nums">
              {selected.size}
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
                  const isOn = selected.has(opt.id);
                  return (
                    <li key={opt.id}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isOn}
                        onClick={() => toggle(opt.id)}
                        className="hover:bg-muted flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors"
                      >
                        <CheckGlyph checked={isOn} />
                        <span className="truncate">{opt.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {selected.size > 0 && (
            <div className="border-border border-t pt-2">
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="hover:text-foreground text-[11.5px] text-[var(--ed-ink-3)] underline-offset-2 hover:underline"
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

export function ExportMenu({ params, itemType }: { params: URLSearchParams; itemType: string }) {
  const [scope, setScope] = React.useState<'filtered' | 'all' | null>(null);

  // "filtered" carries the active params (q, sort, cat[], loc[], stock,
  // status, expected). ?expected=1 (the Expected chip view, mig 0277) must
  // ride along or exporting that view yields zero rows — the server's
  // default list excludes flagged items.
  const filtersFromParams = (): InventoryExportRequest['filters'] => ({
    q: params.get('q') || undefined,
    status: (params.get('status') as 'active' | 'archived' | 'discontinued' | 'all') || undefined,
    stock: (params.get('stock') as 'low' | 'out') || null,
    expected: params.get('expected') === '1' || undefined,
    sort: params.get('sort') || undefined,
    categoryIds: params.getAll('cat').filter(Boolean),
    locationIds: params.getAll('loc').filter(Boolean),
    charterIds: params.getAll('charter').filter(Boolean),
  });

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="border-border bg-background inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12px] text-[var(--ed-ink-2)] transition-colors hover:border-[var(--ed-line-strong)]"
            aria-label="Export"
          >
            <Download className="h-3 w-3" />
            <span className="font-medium">Export</span>
            <ChevronDown className="h-3 w-3 text-[var(--ed-ink-4)]" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[240px] p-2">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setScope('filtered')}
              className="rounded-sm px-2 py-1.5 text-left text-[12.5px] hover:bg-muted"
            >
              <span className="block font-medium">Export filtered</span>
              <span className="block text-[11px] text-[var(--ed-ink-4)]">
                What&apos;s currently visible
              </span>
            </button>
            <button
              type="button"
              onClick={() => setScope('all')}
              className="rounded-sm px-2 py-1.5 text-left text-[12.5px] hover:bg-muted"
            >
              <span className="block font-medium">Export all</span>
              <span className="block text-[11px] text-[var(--ed-ink-4)]">
                Full {itemType === 'book' ? 'books' : 'inventory'} dump
              </span>
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {scope ? (
        <ExportBuilderDialog
          open
          onOpenChange={(open) => {
            if (!open) setScope(null);
          }}
          scope={scope}
          itemType={itemType as InventoryExportRequest['itemType'] & string}
          filters={scope === 'filtered' ? filtersFromParams() : undefined}
        />
      ) : null}
    </>
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
  if (state.cat?.length)
    parts.push(`${state.cat.length} categor${state.cat.length === 1 ? 'y' : 'ies'}`);
  if (state.loc?.length)
    parts.push(`${state.loc.length} location${state.loc.length === 1 ? '' : 's'}`);
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
    toast.success(
      next ? `View "${view.name}" shared with the team.` : `View "${view.name}" set to private.`,
    );
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
          aria-label={
            view.isShared ? `Make view ${view.name} private` : `Share view ${view.name} with team`
          }
          className={cn(
            'hover:bg-foreground/15 ml-0.5 grid h-4 w-4 place-items-center rounded-full opacity-0 transition-opacity group-hover:opacity-100',
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
            'hover:bg-foreground/15 ml-0.5 grid h-4 w-4 place-items-center rounded-full opacity-0 transition-opacity group-hover:opacity-100',
            isActive && 'hover:bg-background/20',
          )}
        >
          {deleting ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <X className="h-2.5 w-2.5" />
          )}
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
      shareWithTeam
        ? `View "${trimmed}" saved and shared with the team.`
        : `View "${trimmed}" saved.`,
    );
    setOpen(false);
    router.refresh();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="border-border hover:text-foreground inline-flex h-6 items-center gap-1 rounded-full border border-dashed px-2.5 text-[11.5px] text-[var(--ed-ink-3)] transition-colors hover:border-[var(--ed-line-strong)]"
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
          <div className="border-border bg-muted/30 rounded-md border px-2.5 py-2">
            <div className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]">
              Saving
            </div>
            <div className="mt-0.5 text-[12px] text-[var(--ed-ink-2)]">
              {describeState(currentState)}
            </div>
          </div>
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              checked={shareWithTeam}
              onChange={(e) => setShareWithTeam(e.target.checked)}
              className="border-border text-primary focus:ring-primary mt-0.5 h-3.5 w-3.5 rounded"
            />
            <div className="flex-1">
              <div className="text-[12px] font-medium">Share with team</div>
              <div className="text-[11px] text-[var(--ed-ink-3)]">
                Everyone in your org will see this view. Only you can edit or delete it.
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
          className="hover:text-foreground ml-auto inline-flex h-5 items-center gap-1 rounded-sm px-1 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[var(--ed-ink-4)]"
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
                'hover:bg-muted rounded-sm px-2 py-1.5 text-left text-[12.5px] transition-colors',
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
