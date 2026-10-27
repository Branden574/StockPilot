'use client';

import {
  ChevronDown,
  ChevronRight,
  Download,
  LayoutGrid,
  List,
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
import { CategoryLabel } from '@/components/inventory/category-label';
import {
  GroupSelectedDialog,
  RemoveFromGroupDialog,
  RenameGroupDialog,
} from '@/components/inventory/display-group-dialogs';
import {
  InventoryGrid,
  inventoryViewCookieFor,
  inventoryViewCookieString,
  type GridEntry,
  type GridGroupCard,
  type GridRecordCard,
  type InventoryView,
} from '@/components/inventory/inventory-grid';
import { StockStatusBadge } from '@/components/inventory/stock-status-badge';
import { chipActionClass, filterChipClass, MetaChip } from '@/components/patterns/chip';
import { FilterTrigger } from '@/components/patterns/filter-bar';
import { ItemCell } from '@/components/patterns/item-cell';
import { MissingPhoto } from '@/components/patterns/missing-photo';
import { SegmentedTabs } from '@/components/patterns/segmented-tabs';
import { SizeBadge } from '@/components/patterns/size-badge';
import { StatePanel } from '@/components/patterns/state-panel';
import { Thumb } from '@/components/patterns/thumb';
import { touchTargetClass } from '@/components/patterns/touch-target';
import { usePerfUseful } from '@/components/perf/perf-useful';
import { Checkbox, CheckboxGlyph } from '@/components/ui/checkbox';
import { ExportBuilderDialog } from './export-builder/export-builder-dialog';
import { GENERIC_CHARTER_LABEL } from '@/lib/charter-display';
import { useCountSelection } from '@/lib/cycle-counts/use-count-selection';
import { ELSEWHERE_PLACEMENT_KIND, elsewhereSuffix } from '@/lib/placements';
import {
  countingUnitLabel,
  extractSize,
  groupRollupLabel,
  placementPhysicalNames,
  resolvePlacement,
  composeDisplayList,
  displayGroupChips,
  groupCoverRow,
  shownUnderByRecord,
  ungroupableItemIds,
  DISPLAY_GROUP_FALLBACK_NAME,
  GROUP_COPY,
  groupingSelectionFacts,
  type CountingUnit,
  type DisplayGroupChip,
  type PlacedHoldingLike,
  type PlacementResolution,
  type RackHoldingLike,
  type SizeRunGroup,
} from '@stockpilot/core';
import { rollupStatus, type SkuGroup } from '@/lib/inventory/group-by-sku';
import {
  createSavedViewAction,
  deleteSavedViewAction,
  setActiveWarehouseAction,
  toggleSavedViewShareAction,
} from '@/server/actions/saved-views';
import { toast } from 'sonner';
import { IntentLink } from '@/components/ui/intent-link';
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
  countDistinctSkuLines,
  countItemRowsByHeaderUnit,
  countItemRowsBySku,
  countPlacementRows,
  deriveInstantView,
  expandInstantPlacementRows,
  filterInstantRows,
  findDisplayGroupPage,
  instantStateFromSearchParams,
  parseRevealGroupParam,
  type InstantFirstPage,
  type PlannedServerPage,
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
import { resolveStartOrder, writeOrderPrefill } from '@/lib/orders/start-order-prefill';

interface Item {
  id: string;
  sku: string;
  name: string;
  status: 'active' | 'archived' | 'discontinued';
  quantity_on_hand: number;
  /** Warehouse this item row belongs to. Shipped by the list loader; used by
   *  the 'Start an order' shortcut to route the selection to one warehouse. */
  warehouse_id?: string | null;
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
  /** Group selected (0400): the record's explicit display group, read next to
   *  the rows (never a column of inventory_items). Display only. Optional so
   *  older callers render as before (no explicit groups). */
  display_group_id?: string | null;
  display_group_name?: string | null;
  display_group_version?: number | null;
  /** The record's type (Items vs Books), for Group selected's "one type"
   *  rule in the bulk bar. Shipped by the loaders. */
  item_type?: string | null;
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
  /** Every OTHER placed holding (a Site, an area, a NULL-kind shelf or bin),
   *  with kind AND type. With it the BOOKS Rack column says "No rack" for a
   *  book whose stock all sits on the Site, instead of the rack its keys still
   *  name (B37). Absent when the item has none, and for older callers. */
  other_holdings?: PlacedHoldingLike[];
  /** Units this item holds in warehouses the viewer cannot see
   *  (item_holdings_elsewhere, 0371). Staff and viewers read holdings only in
   *  their own warehouses, so the rack cells above describe those; this is
   *  the remainder, shown as "+N in other warehouses". Optional: absent or 0
   *  for managers (who see everything) and for older callers. */
  elsewhere_quantity?: number;
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
  /** This row's holding kind ('rack' | 'crate' | 'staging' | 'unplaced'), or
   *  'elsewhere' for the one row carrying the item's stock in warehouses the
   *  viewer cannot see (0371). */
  placement_kind?: string;
}

interface Lookups {
  categories: Map<string, { name: string; color: string | null }>;
  locations: Map<string, { name: string }>;
  /** Charter id → display name + short code. Missing-key rows render
   *  the "Generic" pill (any charter the warehouse services can use). */
  charters?: Map<string, { name: string; code: string | null }>;
}

/** One row the table body actually renders: either a plain placement
 *  row (today's per-rack `<tr>`, unchanged) or a SKU-group header
 *  (collapsed by default; expanding reveals its `items` as the SAME
 *  per-row `<tr>`s beneath it). `rowIdx` is a running position used
 *  only for the "first ~12 rows load with priority" image hint. */
type RenderEntry =
  | {
      kind: 'row';
      item: Item;
      rowIdx: number;
      /** Under an expanded header (core composeDisplayList). */
      nested?: boolean;
      /** "In group <name>" / "Same SKU as records in <name>" (Group selected). */
      chip?: DisplayGroupChip | null;
    }
  | { kind: 'header'; group: SkuGroup; items: Item[]; rowIdx: number }
  /** Group selected (0400): an explicit display group with two or more of its
   *  records on screen. `partial`: other records of it may sit on another
   *  page (server mode) or the never-split guarantee broke. */
  | {
      kind: 'explicit';
      groupId: string;
      name: string | null;
      version: number | null;
      items: Item[];
      rowIdx: number;
      partial: boolean;
    };

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
 * immediately from the small cached page-1 payload (page 1 of the instant
 * derivation, planned by the loader; see `firstPage`), while this full
 * dataset streams behind it over the same RSC response; an invisible
 * <InstantDatasetAdopter> reads it with React.use() and hands it to the
 * (still-mounted) table, which flips into instant mode — SAME component
 * instance, same page, only the delivery order changed. `null` = dataset
 * unavailable (over-cap org or loader failure) → the table stays in server
 * mode: an over-cap org's fixed slices as before, and a loader failure
 * under the planned page keeps that page with a note to refresh in place
 * of its pager (see `plannedPageStranded`). The promise NEVER
 * rejects (the page resolves null on failure), so nothing in the client
 * path ever calls `.catch` — this is the supported replacement for the
 * reverted `.then().catch()` effect that crashed hydration (recurring
 * bug pattern #15).
 */
export interface InstantAdoptedPayload {
  items: InstantDatasetItem[];
  placement?: Record<string, InstantPlacementLine[]>;
  /** Full-dataset 14-day series — replaces the first page's `trends` prop
   *  the moment instant mode takes over, so every locally-derived page has
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
  /** Viewer can place order requests AND the orders module is enabled. Enables
   *  the bulk 'Start an order' shortcut. Default false → hidden. */
  canStartOrder?: boolean;
  /** Ungroup (0399): the viewer holds items:update, so the bulk bar may offer
   *  Ungroup for selected records that share a SKU with another loaded
   *  record. Default false: never offered. The server re-checks everything. */
  canUngroup?: boolean;
  /** Ungroup anything (owner 2026-10-12): the viewer may also take records
   *  out of a size family (sports:manage with the sports module on, the gate
   *  of unlinkItems), so Ungroup is offered for a family member shown under
   *  its family. Default false. The server re-checks everything. */
  canUnlinkFamilies?: boolean;
  /** Group selected (0400): the viewer is a manager (or above) who can edit
   *  items, so an explicit group's header offers Rename. Only a manager may
   *  rename a group (security review SEC-1: apply_item_grouping answers on the
   *  role alone, never on which records the caller can see). Default false. */
  canRenameGroups?: boolean;
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
  /** The Rentals items list (/dashboard/rentals/items), which lists rentals
      of every type. Its server search then asks /api/items/search for the
      same set (`rentalsOnly=1&type=all`); without it the endpoint answers
      non-rentals only, so every typed search there came back empty. Absent
      (every other caller) → the search request is exactly as before. */
  rentalsOnly?: boolean;
  /** Instant mode — see InstantInventoryDataset. Absent (staff/viewer,
      over-cap orgs, every other caller) → server mode, byte-identical
      to today. */
  instant?: InstantInventoryDataset;
  /** First-rows-first streaming — see InstantAdoptedPayload. Only the
      manager+ DEFAULT view passes this; deep links pass the awaited
      `instant` prop instead. While it's pending the table runs in server
      mode over the planned page 1; keystrokes take today's server-search
      path until the dataset lands, at which point the SAME (preserved)
      search box re-derives locally over the full dataset. Consumed via
      React.use() in <InstantDatasetAdopter> — NEVER a `.then().catch()`
      effect (pattern #15). */
  instantPromise?: Promise<InstantAdoptedPayload | null>;
  /** The streamed default view's PLANNED page 1 (the cached loader's
      `firstPage`): `items` is page 1 of the instant derivation, and this
      carries what instant mode will print for it, the real page count, the
      "Showing 1–N" range and the footer's set-wide SKU and row counts. Until
      the dataset is adopted (or for good, if it resolves null) the table
      prints these instead of server-mode arithmetic over `total`, so the
      first paint already reads exactly as the settled page. If it resolves
      null, a note to refresh replaces the pager: a server page 2 would be
      a fixed 30-row slice that skips or repeats rows of this page. Ignored
      in instant mode and while a server-mode search is on screen. Absent →
      server mode (staff/viewer, over-cap orgs, deep links), whose page may
      be planned too (`plannedPage`, below). */
  firstPage?: InstantFirstPage | null;
  /** Phase 2 of the grouping brief (staff and viewers, and anyone on the live
      path within the instant-mode cap): this server page was planned
      group-aware over the whole filtered view (planGroupAwarePage), so no
      size run, SKU family or display group is split across pages. Like
      `firstPage` for the pager, the footer's SKU count and the headers'
      whole-view counts, but for any page, and never stranded: nothing streams
      in behind it. Ignored in instant mode and while a server-mode search is
      on screen. Absent: fixed server slices (over the cap). */
  plannedPage?: PlannedServerPage | null;
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
  /**
   * The Table / Grid choice the list's server page read from its cookie
   * (inventory-grid.tsx INVENTORY_VIEW_COOKIES), so a Grid viewer's first
   * paint is already the grid: no table-then-grid swap and no second wave of
   * images. Absent: Table, the default. A presentation preference only: it
   * never reaches the URL, the derivation or isDefaultInventoryView.
   */
  initialView?: InventoryView;
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

/** B5: how long, after a grouping, the list waits for the refreshed rows (to
 *  turn to the group's page) or for the group's header to be drawn (to scroll
 *  to it). A refresh that has not landed by then turns and scrolls nothing,
 *  so a late one never pulls the person away from where they went since. */
const REVEAL_WAIT_MS = 20_000;

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
 * mounts in server mode over the cached page-1 payload (the planned page 1)
 * and the FULL instant dataset arrives as `promise` — an unawaited server
 * promise streamed across the RSC boundary. This leaf reads it with
 * React.use(), which suspends ONLY this leaf (behind the table's own
 * `<Suspense fallback={null}>`, so the first page stays painted the whole
 * time), then hands the resolved value to the still-mounted table via
 * `onResolve`. Because the table never unmounts, its search box, selection,
 * scroll and every other local state survive the server→instant flip.
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
  canStartOrder = false,
  canUngroup = false,
  canUnlinkFamilies = false,
  canRenameGroups = false,
  onScanRequest,
  page = 1,
  pageSize = 50,
  trends,
  savedViews = [],
  savedViewScope,
  activeWarehouseId = null,
  currentUserId = null,
  reservedByItem,
  rentalsOnly = false,
  instant,
  instantPromise,
  firstPage,
  plannedPage,
  expectedCount = 0,
  productGroupUnits,
  initialView = 'table',
}: InventoryTableProps) {
  // Performance marker (lib/perf/marks.ts): "the list is useful". A mount-only
  // effect, so it fires when the INITIAL rows render — the cached page-1
  // payload on the default view — and NOT again when the streamed
  // instant dataset is adopted below: adoption is a state change on this same
  // mounted instance, never a remount. First rows first is what the person
  // waits for, so it is what gets timed. Covers Items and Books (the books
  // table is this component); their zero-result EmptyStates carry their own
  // marker in the page files, because this component does not render then.
  usePerfUseful();

  // ── Streamed-dataset adoption (React 19 use()) ──────────────────────
  // The default manager+ view mounts in server mode over the cached page-1
  // payload while the FULL instant dataset arrives as `instantPromise` —
  // an unawaited server promise streamed across the RSC boundary. The
  // invisible <InstantDatasetAdopter> rendered below reads it with
  // React.use() (suspending ONLY itself, behind a `fallback={null}` — the
  // first page stays painted) and calls setAdopted with the resolved value.
  // Because THIS component instance never unmounts, the search box,
  // selection, scroll and sparkline mode all survive the server→instant
  // flip, and any keystrokes typed during the gap re-derive over the full
  // dataset the moment it lands. The flip changes nothing on screen: the
  // cached rows ARE page 1 of the default derivation because the loader
  // plans them with it, and `firstPage` carries the pager and footer
  // numbers instant mode will print (see `planned` below). `null`
  // (over-cap org / loader failure) keeps server mode (a loader failure
  // under the planned page: see `plannedPageStranded`). The promise is
  // consumed by use(), NEVER a `.then().catch()` effect — that was the
  // reverted crash (recurring bug pattern #15).
  // `undefined` = the streamed payload hasn't resolved yet; `null` = it
  // resolved to "no dataset" (over-cap org / loader failure) — server
  // mode is final. The distinction drives `instantPending` and
  // `plannedPageStranded` below.
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

  // TABLE / GRID (redesign P3.2). The server page read the viewer's choice
  // from this list's cookie and passed it as `initialView`, so the first
  // paint (SSR) is already right and hydration agrees with it. Switching is
  // a client-only state change on this SAME mounted table, so selection,
  // expanded headers, search text, scroll and page membership are untouched
  // (the grid draws the same `styledRenderItems`); the cookie is written for
  // the next visit. It never reaches the URL.
  const [listView, setListView] = React.useState<InventoryView>(initialView);
  const viewCookieName = inventoryViewCookieFor(basePath);
  const selectListView = React.useCallback(
    (next: InventoryView) => {
      setListView(next);
      try {
        document.cookie = inventoryViewCookieString(viewCookieName, next);
      } catch {
        /* cookies blocked: the choice still applies to this visit */
      }
    },
    [viewCookieName],
  );
  const gridIdPrefix = React.useId();

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
  // Group selected (0400): open explicit display groups, by group id.
  const [expandedExplicitGroups, setExpandedExplicitGroups] = React.useState<Set<string>>(
    new Set(),
  );
  // A group's Rename / Remove (its header) and Add to group (a row's chip).
  const [groupAction, setGroupAction] = React.useState<
    | { kind: 'rename'; groupId: string; memberIds: string[] }
    | { kind: 'remove'; ids: string[] }
    | { kind: 'add'; ids: string[]; groupId: string }
    | null
  >(null);
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

  const hrefForPage = React.useCallback(
    (p: number): string => {
      const next = new URLSearchParams(params.toString());
      if (p <= 1) next.delete('page');
      else next.set('page', String(p));
      // A page link chooses a page: never with ?group= (B5), which would
      // plan the group's page instead.
      next.delete('group');
      const qs = next.toString();
      return qs ? `${basePath}?${qs}` : basePath;
    },
    [params, basePath],
  );

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
  // People review P5: an explicit group's header says "N matching" whenever
  // anything narrows the list (a search, a filter, a stock view, Expected, a
  // rack, or a lifecycle view that shows fewer records than the default:
  // Archived or Discontinued; Active is the default and All shows more), as
  // the phone does: its count is then the records listed, not the group's.
  const lifecycleParam = params.get('status');
  const listNarrowed =
    !!q.trim() ||
    activeFilterCount > 0 ||
    !!params.get('stock') ||
    !!params.get('rack') ||
    (!!lifecycleParam && lifecycleParam !== 'active' && lifecycleParam !== 'all') ||
    params.get('expected') === '1';
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
  //
  // The exact set of URL params the search fetch below sends, flattened to
  // a string so the effect can DEPEND on it. The effect used to end with
  // `}, [q, instantMode])` while its body read cat/loc/type/status/stock/
  // sort/rack/expected off `params` — so in SERVER MODE (only orgs over the
  // 2000-item instant cap) ticking a category chip during an active search
  // never re-ran the fetch. `displayed = instantRows ?? serverHits ??
  // localMatches` prefers serverHits whenever it is non-null, and it is
  // cleared ONLY when q empties or the fetch fails, so the table kept
  // rendering the PREVIOUS, unfiltered hits (and the SKU partial-total
  // marker kept using the stale serverHitsTotal) until the user edited the
  // search text — the chip looked dead. Keying on this string re-fetches
  // the cross-page matches under the new filters instead of dropping them.
  // A plain `params` dep would churn on unrelated param edits (?page, ?view);
  // this narrows to what the request actually carries.
  const serverSearchParamKey = React.useMemo(() => {
    const key = new URLSearchParams();
    for (const k of ['type', 'status', 'stock', 'sort', 'rack', 'expected']) {
      const v = params.get(k);
      if (v) key.set(k, v);
    }
    for (const v of params.getAll('cat')) key.append('cat', v);
    for (const v of params.getAll('loc')) key.append('loc', v);
    // The books tab forces type=book below when the URL didn't set one, so
    // it belongs in the key too; so does the Rentals list's rentals-only set.
    if (showBookFields) key.set('books', '1');
    if (rentalsOnly) key.set('rentals', '1');
    return key.toString();
  }, [params, showBookFields, rentalsOnly]);

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
        // The Rentals items list: its page lists rentals ONLY, of every type
        // (a rental can be a product or a book) and whatever the URL's
        // ?type= says, so its search asks for exactly that set. Without the
        // flag the endpoint lists non-rentals, as every other table wants.
        if (rentalsOnly) {
          url.searchParams.set('rentalsOnly', '1');
          url.searchParams.set('type', 'all');
        }
        url.searchParams.set('limit', String(pageSize));
        // Each hit's display group (0400): the route reads memberships only
        // for a caller that shows them (recheck R2-6).
        url.searchParams.set('groups', '1');

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
    // serverSearchParamKey (see above) makes a settled filter/sort change
    // re-run the search; the rest of the body's reads (params for the URL
    // rewrite, router, basePath, pageSize) are intentionally not deps —
    // re-running on those would fire a fetch per unrelated param edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, instantMode, serverSearchParamKey]);

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
  // rows on screen without co-selecting an item's other rack rows. `pageIds`
  // (the rows on screen, `displayed`) is defined beside `displayed` below.
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
  //   • footer "N SKUs"        → 3 (instant mode, and a planned page — the
  //                              streamed first page or a staff member's
  //                              planned server page — whose counts the
  //                              server took over the whole view; fixed-slice
  //                              server mode holds one page and cannot count
  //                              SKUs set-wide, so it labels its number
  //                              "items" — 1).
  //   • footer "N rows"        → 2, because "rows" must mean the rows on
  //                              screen. Shown only when it differs from
  //                              the SKU count (that difference IS the
  //                              collapsing the list just did). A planned
  //                              server page knows no rack rows set-wide, so
  //                              on Items it prints its records as "items"
  //                              (1) instead; on Books a record is one row.
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
  // THE PLANNED FIRST PAGE. On the streamed default view the server painted
  // page 1 of the instant derivation itself (the cached loader plans it with
  // the same functions) and `firstPage` carries what instant mode will print
  // for it. Until the dataset is adopted — or for good, if it resolves null —
  // the pager, the footer and the split detector read those numbers instead
  // of server-mode arithmetic over `total`, so the first paint already reads
  // exactly as the settled page (owner bug 2026-10-05: "Showing 1–30 of 455,
  // 455 items" turned into "Showing 1–24 of 455, 441 SKUs · 455 rows" half a
  // second after a refresh). Only while no search is on screen: a server-mode
  // search shows /api/items/search results, which this page does not describe.
  // Phase 2: a staff member's or viewer's server page planned group-aware
  // brings the same numbers for ANY page (and is never stranded: nothing
  // streams in behind it). Both plans read the same way from here on.
  const planned = React.useMemo(() => {
    if (instantMode || q.trim()) return null;
    if (plannedPage) {
      return {
        pageCount: plannedPage.pageCount,
        pageItemCount: plannedPage.pageItemCount,
        pageStartIndex: plannedPage.pageStartIndex,
        distinctSkus: plannedPage.distinctSkus,
        placementRows: null as number | null,
        skuItemRowCounts: plannedPage.skuItemRowCounts,
        unitItemRowCounts: plannedPage.unitItemRowCounts as Array<[string, number]> | undefined,
        streamed: false,
      };
    }
    if (firstPage) {
      return {
        ...firstPage,
        placementRows: firstPage.placementRows as number | null,
        pageStartIndex: 0,
        streamed: true,
      };
    }
    return null;
  }, [instantMode, q, plannedPage, firstPage]);
  // Instant mode paginates GROUP-AWARE — a SKU family is never split
  // across pages — so pages hold a VARIABLE number of item rows and
  // `page × pageSize` is no longer the range this page covers. Hand the
  // footer the real page count and the real row range so a page showing
  // 20 groups over 34 rows never claims "Showing 1–50". The planned first
  // page carries the same two numbers from the server. Plain server mode
  // has no such information (and slices at a fixed pageSize), so it keeps
  // the arithmetic fallback inside Pagination.
  const pageRange = React.useMemo(() => {
    if (instantView) {
      const shown = instantView.pageItems.length;
      return {
        pageCount: instantView.pageCount,
        startRow: shown === 0 ? 0 : instantView.pageStartIndex + 1,
        endRow: instantView.pageStartIndex + shown,
      };
    }
    if (planned) {
      const shown = planned.pageItemCount;
      return {
        pageCount: planned.pageCount,
        startRow: shown === 0 ? 0 : planned.pageStartIndex + 1,
        endRow: planned.pageStartIndex + shown,
      };
    }
    return undefined;
  }, [instantView, planned]);
  // COUNT 3 — DISTINCT SKUs. The footer says "N SKUs", but
  // `effectiveTotal` is an ITEM-ROW count, and with grouping live that
  // visibly contradicts the screen: 47 book rows collapse into 19 headers
  // while the footer claimed "47 SKUs". Count the TOP-LEVEL lines over the
  // full filtered set instead (countDistinctSkuLines: raw SKU keys, one line
  // per blank-SKU row — the same function the cached loader plans with).
  // Instant mode counts the dataset; the planned first page brings the
  // server's count; plain server mode holds a single page and has no way to
  // count distinct SKUs across the set.
  const distinctSkuCount = React.useMemo(() => {
    if (instantView) return countDistinctSkuLines(instantView.filteredRows);
    return planned?.distinctSkus ?? null;
  }, [instantView, planned]);
  // COUNT 2 — PLACEMENT ROWS over the full filtered set: what the footer's
  // "rows" term means, because "rows" has to mean the rows on screen. The
  // Items list expands each item into one row per holding line, so its
  // rendered row count EXCEEDS the item-row count — printing
  // `effectiveTotal` there understated the very number it claimed to
  // report. The dataset's `placement` map is full-dataset (not page-slice),
  // so this is answerable set-wide; Books ship no map, in which case a
  // placement row IS an item row and this collapses to `total`.
  const placementRowCount = React.useMemo(() => {
    if (instantView) {
      const placement = effectiveInstant?.placement;
      if (!placement) return instantView.total;
      return countPlacementRows(instantView.filteredRows, (id) => placement[id]?.length ?? 0);
    }
    return planned?.placementRows ?? null;
  }, [instantView, effectiveInstant, planned]);
  // THE PLANNED PAGE, STRANDED (review 2026-10-05): the dataset resolved null
  // (a loader failure) while the planned page is on screen. The page and its
  // numbers stay (they still describe it), but its pager cannot: page 2 would
  // be a server page, sliced at a fixed 30 rows by last update, while the
  // planned page 1 is group-aware (it can stop short of a family that does
  // not fit, and pulls a family's members up from deeper in the list), so a
  // fixed page 2 skipped rows page 1 left out and repeated members it already
  // showed. A plain note to refresh replaces the pager: a refresh streams the
  // dataset again. A planned page that is the whole list needs no note.
  const plannedPageStranded =
    planned !== null && planned.streamed && adopted === null && planned.pageCount > 1;
  // Show pagination when there is genuinely more than one page. Instant
  // mode asks the derivation (group-aware page count) rather than
  // `total > pageSize`, which over-counts pages whenever a family runs a
  // page long and would offer a Next that lands on an empty page; the
  // planned first page brings the same page count (and has no pager once
  // stranded, see above).
  const showPagination = instantMode
    ? (instantView?.pageCount ?? 1) > 1
    : planned
      ? planned.pageCount > 1 && !plannedPageStranded
      : !q.trim() && total > pageSize;

  // What the table actually renders. Instant mode: the one complete
  // locally-derived answer. Server mode priority: server-authoritative
  // result if we have one (covers cross-page matches), else the
  // synchronous local filter (covers in-page matches with zero
  // latency). On no search, the server-mode pair reduces to `items`.
  const displayed = instantRows ?? serverHits ?? localMatches;

  // THE VISIBLE PAGE the select-all box acts on (the header box in Table, the
  // box above the cards in Grid): exactly the rows on screen, members under
  // collapsed headers included. CONFLICTS D9 (fixed here): this used to read
  // `instantRows ?? items`, so during a server-mode search (staff, viewers,
  // orgs over the instant cap) the box ticked and judged the server page's own
  // rows while the search hits were on screen: rows that were not visible got
  // ticked and the hits on screen did not. Without a search `displayed` IS
  // `items` (server mode) or `instantRows` (instant mode), as before.
  // A plain map over the page's rows (a page holds a few dozen): no hook
  // depends on it, and the select-all reads it on each render anyway.
  const pageIds = displayed.map((i) => i.rowKey ?? i.id);
  const allVisibleSelected = isPageFullySelected(selected, pageIds);
  const someVisibleSelected = isPagePartiallySelected(selected, pageIds);

  // Precompute each row's sparkline series ONCE per (displayed, sparkMode,
  // trends) instead of inside the row map. `displayed` is stable across
  // selection toggles (localMatches/serverHits don't depend on `selected`),
  // so the array refs stay identical when only a checkbox flips — which lets
  // the memo'd <Sparkline> skip its SVG-path recompute for all 50 rows. This
  // is the fix for the click-lag: a single checkbox toggle no longer rebuilds
  // every visible sparkline.
  // Adopted streamed payload carries FULL-dataset trends (the `trends`
  // prop only covers the initial page); prefer them once present.
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
  // The planned first page brings the server's counts for the SKUs on it.
  // `null` in plain server mode, where only the current page exists.
  //
  // KEYED ON THE RAW SKU — the SAME key groupPlacementsBySku uses. Keying
  // this map on the TRIMMED sku while the groups keyed on the raw one made
  // whitespace-variant SKUs ("ABC" and " ABC") collapse into one full-set
  // count of 2 that BOTH one-row groups then compared themselves against,
  // so each stamped a false "*" and a false "other pages may hold more"
  // tooltip on a group whose every row was already on screen. A detector
  // must count the same population it is comparing.
  const skuItemRowCountsFull = React.useMemo(() => {
    // Blank SKUs are never grouped (group-by-sku.ts), so countItemRowsBySku
    // skips them.
    if (instantView) return countItemRowsBySku(instantView.filteredRows);
    if (planned) return new Map(planned.skuItemRowCounts);
    return null;
  }, [instantView, planned]);

  // Group selected (0400): records per HEADER UNIT over the whole set, for
  // the headers' split detectors: 'grp:<id>' for an explicit group that forms
  // (two or more of its records present), 'sku:<raw>' for a SKU counted over
  // the records no formed group claims (the raw per-SKU counts above would
  // stamp a false "*" on every partly grouped SKU). Instant mode counts the
  // full filtered set; the planned page 1 brings the server's counts for its
  // units (a payload cached before Group selected carries only the raw
  // per-SKU counts, used as they always were). Null in plain server mode.
  // Group selected (0400, design 5): the bulk bar offers Group selected for
  // two or more DISTINCT records of one type (two rack rows of one record are
  // ONE record), from the loaded rows only (taking records out of a group is
  // Ungroup's now: owner 2026-10-12): no per-row query, and select-all stays
  // page-scoped, so hidden rows, off-page siblings and every search match are
  // never added. Offered to viewers who can edit items (items:update, the
  // same gate as Ungroup); the server decides again on what they can read and
  // edit.
  const groupFacts = React.useMemo(() => {
    if (!canUngroup || selectedItemIds.length === 0) return null;
    const pool = [...(effectiveInstant?.items ?? items), ...(serverHits ?? [])];
    const viewType = showBookFields ? 'book' : 'product';
    // A selected record not loaded here (another page, a cleared search) is
    // of this view's type (P3): Books never read it as a product.
    return groupingSelectionFacts(
      selectedItemIds,
      pool.map((r) => ({
        id: r.id,
        item_type: r.item_type ?? viewType,
        display_group_id: r.display_group_id ?? null,
      })),
      viewType,
    );
  }, [canUngroup, selectedItemIds, effectiveInstant, items, serverHits, showBookFields]);

  const headerUnitCountsFull = React.useMemo<Map<string, number> | null>(() => {
    if (instantView) return countItemRowsByHeaderUnit(instantView.filteredRows);
    if (planned) {
      return new Map(
        planned.unitItemRowCounts ??
          planned.skuItemRowCounts.map(([sku, n]) => [`sku:${sku}`, n] as [string, number]),
      );
    }
    return null;
  }, [instantView, planned]);

  // THE COMPOSITION (core composeDisplayList, the one rule the phone uses
  // too): explicit display groups with two or more records on screen, then
  // the same-SKU headers over the rows no group claims (a SKU with MORE than
  // one placement row: one record on two racks keeps its "2 locations"
  // header, as before), then size runs over the remaining single rows (Items
  // only: Books are never sized), then single rows. Every row renders exactly
  // once. Expanded rows are emitted AFTER the run pass and marked nested, so
  // an expanded SKU header can no longer pull its rows into a run elsewhere
  // (the V3 defect: the run header's total jumped by the family's stock and
  // the SKU header lost its children).
  const displayList = React.useMemo(
    () =>
      composeDisplayList<Item>(displayed, {
        itemIdOf: (it) => it.id,
        skuOf: (it) => it.sku,
        displayGroupOf: (it) => it.display_group_id ?? null,
        ...(showBookFields
          ? {}
          : {
              runMetaOf: (it: Item) => ({
                name: it.name,
                // The ITEM is the run's unit, not the row: `quantity_on_hand`
                // is the item TOTAL on every one of its placement rows, so the
                // run counts it once per record (core passes the record id as
                // the unitKey).
                quantity: Number(it.quantity_on_hand) || 0,
                // Stored identity when the item has one; null keeps the
                // legacy name heuristic, which is every ungrouped row.
                groupId: it.group_id ?? null,
                variantSize: it.variant_size ?? null,
                countingUnit: it.group_id ? (productGroupUnits?.[it.group_id] ?? null) : null,
              }),
              // An explicit group of sized records reads in size order.
              sizeOf: (it: Item) => it.variant_size ?? null,
            }),
        expanded: {
          explicit: expandedExplicitGroups,
          skus: expandedSkuGroups,
          runs: expandedStyleGroups,
        },
      }),
    [
      displayed,
      showBookFields,
      productGroupUnits,
      expandedExplicitGroups,
      expandedSkuGroups,
      expandedStyleGroups,
    ],
  );

  // Ungroup anything (owner 2026-10-12): the header each record is SHOWN
  // under in this composition (an explicit group, a shared SKU, a stored size
  // family's run). A ticked record with more than one grouping leaves this
  // one; the review says so for each record.
  const ungroupShownUnder = React.useMemo(
    () => shownUnderByRecord(displayList, (it) => it.id),
    [displayList],
  );

  // The bulk bar offers Ungroup when a ticked record has something to leave
  // this viewer may undo (core ungroupableItemIds), from the rows on hand
  // only (the full dataset in instant mode, else this page and any search
  // hits) plus the full-set per-SKU counts when known: no per-row query, and
  // the server-planned page 1 is untouched. The review reads every ticked
  // record again and decides on what the viewer can read and edit.
  const ungroupItemIds = React.useMemo<string[]>(() => {
    if (!canUngroup || selectedItemIds.length === 0) return [];
    const pool = [...(effectiveInstant?.items ?? items), ...(serverHits ?? [])];
    return ungroupableItemIds(
      selectedItemIds,
      pool.map((r) => ({
        id: r.id,
        sku: r.sku ?? null,
        display_group_id: r.display_group_id ?? null,
        group_id: r.group_id ?? null,
      })),
      {
        canEditItems: canUngroup,
        canUnlinkFamilies,
        fullSkuCounts: skuItemRowCountsFull,
        shownUnder: ungroupShownUnder,
      },
    );
  }, [
    canUngroup,
    canUnlinkFamilies,
    selectedItemIds,
    effectiveInstant,
    items,
    serverHits,
    skuItemRowCountsFull,
    ungroupShownUnder,
  ]);

  // Chips (Group selected): a record whose group has only it on screen ("In
  // group <name>", so a search hit keeps its context) and a record in no group
  // sharing a SKU with a group here ("Same SKU as records in <name>", with
  // Add to group). From the rows on screen only.
  const chips = React.useMemo(
    () =>
      displayGroupChips(displayed, {
        itemIdOf: (it) => it.id,
        skuOf: (it) => it.sku,
        displayGroupOf: (it) => it.display_group_id ?? null,
      }),
    [displayed],
  );
  const groupNames = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const it of [...(effectiveInstant?.items ?? items), ...(serverHits ?? [])]) {
      if (it.display_group_id && it.display_group_name && !m.has(it.display_group_id)) {
        m.set(it.display_group_id, it.display_group_name);
      }
    }
    return m;
  }, [effectiveInstant, items, serverHits]);

  const styledRenderItems = React.useMemo<StyledEntry[]>(() => {
    // Is the result set on screen complete? (server mode). With a search
    // active the rows come from /api/items/search, which reports its own match
    // count; otherwise the view's own total.
    const resultSetTotal = q.trim() && serverHits ? (serverHitsTotal ?? total) : total;
    const singlePage = resultSetTotal <= pageSize;
    // A header may cover only some of its unit's records. Instant mode (and
    // the planned page 1): group-aware pagination keeps a unit whole, so the
    // header is exact unless the guarantee is observed to have BROKEN (fewer
    // records here than the whole set has for that unit). Server mode cannot
    // check: a header of more than one RECORD (never one record on two racks:
    // one paginated unit) on a multi-page result is marked (pattern #18).
    const partial = (unitKey: string, rows: Item[]): boolean => {
      const records = new Set(rows.map((r) => r.id)).size;
      if (!headerUnitCountsFull) return !singlePage && records > 1;
      const full = headerUnitCountsFull.get(unitKey);
      return full != null && records < full;
    };
    let idx = 0;
    const out: StyledEntry[] = [];
    for (const e of displayList) {
      if (e.kind === 'explicit') {
        out.push({
          kind: 'passthrough',
          entry: {
            kind: 'explicit',
            groupId: e.groupId,
            name:
              e.rows.find((r) => r.display_group_name)?.display_group_name ??
              groupNames.get(e.groupId) ??
              null,
            version:
              e.rows.find((r) => r.display_group_version != null)?.display_group_version ?? null,
            items: e.rows,
            rowIdx: idx++,
            partial: partial(`grp:${e.groupId}`, e.rows),
          },
        });
      } else if (e.kind === 'sku') {
        const group: SkuGroup = {
          sku: e.sku,
          name: e.rows[0]?.name ?? '',
          total: e.rows.reduce((sum, it) => sum + (it.line_quantity ?? it.quantity_on_hand), 0),
          placements: [],
          ...(partial(`sku:${e.sku}`, e.rows) ? { totalIsPartial: true } : {}),
        };
        out.push({
          kind: 'passthrough',
          entry: { kind: 'header', group, items: e.rows, rowIdx: idx++ },
        });
      } else if (e.kind === 'run') {
        const members: RenderEntry[] = e.run.members.map((item) => ({
          kind: 'row',
          item,
          rowIdx: -1,
        }));
        out.push({ kind: 'style', group: { ...e.run, members }, items: e.run.members });
      } else {
        out.push({
          kind: 'passthrough',
          entry: {
            kind: 'row',
            item: e.row,
            rowIdx: idx++,
            nested: e.nested,
            chip: e.nested ? null : (chips.get(e.row.id) ?? null),
          },
        });
      }
    }
    return out;
  }, [
    displayList,
    chips,
    groupNames,
    headerUnitCountsFull,
    q,
    serverHits,
    serverHitsTotal,
    total,
    pageSize,
  ]);

  function toggleSkuGroup(sku: string) {
    setExpandedSkuGroups((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  function toggleExplicitGroup(groupId: string) {
    setExpandedExplicitGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  /** Opens an explicit group's header (after a grouping put records in it). */
  const openExplicitGroup = React.useCallback((groupId: string) => {
    setExpandedExplicitGroups((prev) => (prev.has(groupId) ? prev : new Set(prev).add(groupId)));
  }, []);

  function toggleStyleGroup(styleKey: string) {
    setExpandedStyleGroups((prev) => {
      const next = new Set(prev);
      if (next.has(styleKey)) next.delete(styleKey);
      else next.add(styleKey);
      return next;
    });
  }

  // ── B5 (2026-10-25): show the group a grouping made ────────────────────
  // A display group is one unit that clusters at its best-ranked record, and
  // pages are packed unit by unit, so after Group selected (or Add to group)
  // the group's header can be drawn on another page than the one the records
  // were picked on: records picked on two pages, or a unit that no longer
  // fits the end of its page. Opening the group (C3) did not show it there.
  //
  // INSTANT MODE holds every record, so it works the page out itself: once
  // the refreshed rows carry the grouping (every changed record it holds is
  // in the group), it turns to the page that draws the header (the rule
  // deriveInstantView pages with) and scrolls the header into view. A person
  // who moved on in the meantime (another page, a filter, a search) is not
  // pulled back.
  //
  // A LIST PAGED ON THE SERVER holds one page and cannot tell which page that
  // is: the done message links to ?group=<id> ("Show it"), which the server
  // plans to that page (planLivePage), and the landing below opens the group
  // there, scrolls to it and drops ?group= from the address (the page it chose
  // is in ?page= from then on, so a refresh, a page link or Back stays on it).
  // No link during a server-mode search (the list shows the search's matches,
  // not pages) or without a planned page (over the instant-mode cap the pages
  // are fixed slices, and the server cannot plan the group's page).
  const instantStateKey = React.useMemo(
    () => (instantState ? JSON.stringify(instantState) : null),
    [instantState],
  );
  const [pendingReveal, setPendingReveal] = React.useState<{
    groupId: string;
    changedItemIds: readonly string[];
    /** The view the grouping was made in: another view drops the reveal. */
    stateKey: string;
    until: number;
  } | null>(null);
  /** The group header to scroll into view once it is drawn (a ref: setting it
   *  draws nothing; the effect below reads it after every render). */
  const scrollToGroup = React.useRef<{ groupId: string; until: number } | null>(null);
  const scrollToGroupHeader = React.useCallback((groupId: string) => {
    scrollToGroup.current = { groupId, until: Date.now() + REVEAL_WAIT_MS };
  }, []);

  /** After a grouping applied (Group selected, Add to group): open the group
   *  and show it (C3, B5). */
  const revealGroup = React.useCallback(
    (groupId: string, changedItemIds: readonly string[]) => {
      openExplicitGroup(groupId);
      if (instantMode && instantStateKey !== null) {
        setPendingReveal({
          groupId,
          changedItemIds,
          stateKey: instantStateKey,
          until: Date.now() + REVEAL_WAIT_MS,
        });
      } else {
        // Server mode: the header is drawn on this page only when the
        // group's records sort here; scroll to it if it is.
        scrollToGroupHeader(groupId);
      }
    },
    [openExplicitGroup, instantMode, instantStateKey, scrollToGroupHeader],
  );

  React.useEffect(() => {
    if (!pendingReveal) return;
    if (
      !effectiveInstant ||
      !instantState ||
      !instantView ||
      instantStateKey !== pendingReveal.stateKey ||
      Date.now() > pendingReveal.until
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- drop a reveal the view moved past
      setPendingReveal(null);
      return;
    }
    const groupOf = new Map(effectiveInstant.items.map((r) => [r.id, r.display_group_id ?? null]));
    const landed = pendingReveal.changedItemIds.every(
      (id) => !groupOf.has(id) || groupOf.get(id) === pendingReveal.groupId,
    );
    // The refreshed rows have not landed yet: wait for them.
    if (!landed) return;
    setPendingReveal(null);
    const page = findDisplayGroupPage(
      effectiveInstant.items,
      instantState,
      effectiveInstant.view,
      pageSize,
      pendingReveal.groupId,
    );
    // The group does not form in this view (fewer than two of its records
    // are in it): there is no header to show.
    if (page === null) return;
    scrollToGroupHeader(pendingReveal.groupId);
    if (page !== instantView.page) shallowPush(hrefForPage(page));
  }, [
    pendingReveal,
    effectiveInstant,
    instantState,
    instantStateKey,
    instantView,
    pageSize,
    scrollToGroupHeader,
    shallowPush,
    hrefForPage,
  ]);

  // Landing on ?group=<id> (the "Show it" link): the page on screen is the
  // one that draws that group's header (planned on the server, or turned to
  // by deriveInstantView). Open it, scroll to it, and put the page in the
  // address in place of ?group=.
  const groupParam = params.get('group');
  const groupParamCount = params.getAll('group').length;
  React.useEffect(() => {
    if (groupParam === null) return;
    const groupId = groupParamCount === 1 ? parseRevealGroupParam(groupParam) : null;
    if (groupId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot: opens the group a navigation asked for, then ?group= leaves the address
      openExplicitGroup(groupId);
      scrollToGroupHeader(groupId);
    }
    shallowReplace(hrefForPage(effectivePage));
  }, [
    groupParam,
    groupParamCount,
    effectivePage,
    openExplicitGroup,
    scrollToGroupHeader,
    shallowReplace,
    hrefForPage,
  ]);

  // Scroll the header asked for above into view once it is drawn (after the
  // page turned, the refresh landed or the group opened). Runs after every
  // render; it reads a ref, so it costs nothing while nothing is asked for.
  React.useEffect(() => {
    const target = scrollToGroup.current;
    if (!target) return;
    if (Date.now() > target.until) {
      scrollToGroup.current = null;
      return;
    }
    const key = `display-group:${target.groupId}`;
    const header = Array.from(document.querySelectorAll('[data-group-key]')).find(
      (el) => el.getAttribute('data-group-key') === key,
    );
    if (!header) return;
    scrollToGroup.current = null;
    // Optional call: some test DOMs lack it.
    header.scrollIntoView?.({ block: 'center' });
  });

  // The done message's "Show it" link (B5), for a list paged on the server:
  // this view, with ?group= in place of ?page=.
  const showGroupHref = React.useCallback(
    (groupId: string) => {
      const next = new URLSearchParams(params.toString());
      next.delete('page');
      next.set('group', groupId);
      return `${basePath}?${next.toString()}`;
    },
    [params, basePath],
  );
  const offerShowGroup = !instantMode && plannedPage != null && !q.trim();

  // ── Row and card pieces (one source for the Table and the Grid) ─────────

  /** A record's category, site, and the health figures its row shows. */
  function recordFacts(item: Item) {
    // Status badge + coverage bar follow AVAILABLE (on-hand − reserved),
    // matching the "{avail} avail · {out} out" indicator under On hand. A
    // rental checkout reserves stock instead of decrementing on-hand, so a
    // fully checked-out item (0 avail, 1 out) must read "Out of stock", not
    // "In stock". reservedByItem is passed ONLY by the rentals items view;
    // everywhere else reserved is 0, so available === on-hand and nothing
    // changes.
    const reservedForStatus = reservedByItem?.get(item.id) ?? 0;
    const availableForStatus = Math.max(0, item.quantity_on_hand - reservedForStatus);
    return {
      category: item.category_id ? lookups.categories.get(item.category_id) : null,
      location: item.primary_location_id ? lookups.locations.get(item.primary_location_id) : null,
      availableForStatus,
      status: deriveStatus(availableForStatus, item.reorder_point),
      par: Math.max(item.reorder_point * 4, item.quantity_on_hand * 1.5, 10),
    };
  }

  /** A record's checkbox: the row key (one per rack row), named for the record. */
  function recordCheckbox(item: Item) {
    const key = item.rowKey ?? item.id;
    return (
      <Checkbox
        checked={selected.has(key)}
        onCheckedChange={() => toggleOne(key)}
        label={`Select ${item.name}`}
      />
    );
  }

  /** A record's name: its only link, to its own page with this list as `?return=`. */
  function itemLink(item: Item, className: string, title?: string) {
    return (
      <IntentLink
        href={`${rowLinkPrefix}/${item.id}?return=${encodeURIComponent(currentListUrl)}`}
        // No viewport prefetch: a prefetch for EVERY row's detail page on
        // mount measured 50+ requests at ~500 ms of server time each on a
        // 50-row list, for the ~1 row a person clicks. next/link's
        // prefetch={false} turns hover and touch prefetch off too, so the item
        // route's shape was unknown until the click and its skeleton painted a
        // server round trip late (166 ms vs 49 ms for warmed sidebar routes,
        // lab 2026-09-22), which also starts React's 300 ms reveal hold that
        // much later. IntentLink warms just this row's route, starting the
        // moment the pointer arrives (hoverDwellMs 0: Next only reuses a
        // warm-up that has FINISHED, so it needs a round trip's head start), on
        // focus, or on pointer-down.
        hoverDwellMs={0}
        className={className}
        title={title}
      >
        {item.name}
      </IntentLink>
    );
  }

  /**
   * A row's group chip ("In group X", or "Same SKU as records in X" with Add to
   * group). `wrapAction` (the table): Add to group may drop under the chip
   * instead of widening the Item column; a Grid card passes nothing.
   */
  function rowChip(
    entry: Extract<RenderEntry, { kind: 'row' }>,
    item: Item,
    { wrapAction = false }: { wrapAction?: boolean } = {},
  ) {
    const chip = entry.chip;
    if (!chip) return null;
    return (
      <DisplayGroupChipView
        chip={chip}
        name={groupNames.get(chip.groupId) ?? DISPLAY_GROUP_FALLBACK_NAME}
        recordName={item.name}
        onAddToGroup={
          rowChipHasAction(entry)
            ? () => setGroupAction({ kind: 'add', ids: [item.id], groupId: chip.groupId })
            : undefined
        }
        wrapAction={wrapAction}
      />
    );
  }

  /** The row's chip carries Add to group: a same-SKU chip, for a viewer who may group. */
  function rowChipHasAction(entry: Extract<RenderEntry, { kind: 'row' }>): boolean {
    return canUngroup && entry.chip?.kind === 'same-sku';
  }

  /** A named group's header facts: its name, count rule and its gated actions. */
  function explicitGroupOf(entry: Extract<RenderEntry, { kind: 'explicit' }>) {
    const name = entry.name ?? DISPLAY_GROUP_FALLBACK_NAME;
    const memberIds = [...new Set(entry.items.map((it) => it.id))];
    return {
      groupId: entry.groupId,
      name,
      matching: listNarrowed,
      onRename:
        canUngroup && canRenameGroups
          ? () => setGroupAction({ kind: 'rename', groupId: entry.groupId, memberIds })
          : undefined,
      onRemove: canUngroup ? () => setGroupAction({ kind: 'remove', ids: memberIds }) : undefined,
    };
  }

  // What shows when the page has no rows: the quiet in-table line.
  const noMatchLine = (
    <StatePanel
      kind="no-match"
      surface="plain"
      icon={null}
      headingLevel={null}
      title="No items match your filters."
    />
  );

  /** One record's Grid card: what its row shows, nothing else. */
  function recordCard(
    entry: Extract<RenderEntry, { kind: 'row' }>,
    { priority, sizeMember }: { priority: boolean; sizeMember: boolean },
  ): GridRecordCard {
    const { item } = entry;
    const facts = recordFacts(item);
    const key = item.rowKey ?? item.id;
    // A size-run member says which size it is where other cards say their
    // category (its name ends in the size; a stored family keeps it too).
    const size = sizeMember ? (item.variant_size ?? extractSize(item.name)) : null;
    const storage = showBookFields ? readBookStorage(item.custom_fields) : null;
    return {
      kind: 'record',
      key,
      selected: selected.has(key),
      checkbox: recordCheckbox(item),
      media: hasPhoto(item) ? (
        <CardPhoto
          photo={item}
          title={item.name}
          subtitle={item.sku}
          meta={<OnHandMeta value={item.quantity_on_hand} />}
          priority={priority}
        />
      ) : null,
      name: itemLink(item, 'text-foreground hover:underline', item.name),
      sku: item.sku,
      meta: (
        <MetaLine>
          {size ? (
            <span className="text-[var(--ed-ink-2)]">{size}</span>
          ) : (
            <CategoryLabel category={facts.category} />
          )}
          <CharterLabel item={item} lookups={lookups} />
        </MetaLine>
      ),
      chip: entry.nested ? null : rowChip(entry, item),
      status: (
        <StockStatusBadge
          quantity={facts.availableForStatus}
          reorderPoint={item.reorder_point}
          itemStatus={item.status}
          autoArchived={item.auto_archived}
          awaitingFirstReceipt={item.awaiting_first_receipt === true}
        />
      ),
      quantity: formatNumber(onHandFigure(item, stockView)),
      quantityNotes: hasOnHandNotes(item, reservedByItem) ? (
        <OnHandNotes item={item} stockView={stockView} reservedByItem={reservedByItem} />
      ) : undefined,
      location: facts.location?.name ?? '—',
      facts: storage
        ? [
            { label: 'Grade', value: <BookGradeLabel grade={storage.grade} /> },
            { label: 'Rack', value: <BookRackContent item={item} /> },
            {
              label: 'Crate',
              value: (
                <BookCrateLabel crateNumber={storage.crateNumber} crateColor={storage.crateColor} />
              ),
            },
          ]
        : [{ label: 'Rack', value: <ItemsRackContent item={item} /> }],
      coverage: (
        <StockBar
          stock={facts.availableForStatus}
          par={facts.par}
          status={facts.status}
          className="!w-full"
        />
      ),
    };
  }

  /** A size run's Grid card: its header row's label, roll-ups and drill-down. */
  function styleGroupCard(
    se: Extract<StyledEntry, { kind: 'style' }>,
    priority: boolean,
  ): GridGroupCard {
    const f = styleHeaderFacts(se.group, se.items, lookups);
    const expanded = expandedStyleGroups.has(se.group.styleKey);
    const named = `${se.group.baseName} (${f.sizeLabel})`;
    return {
      kind: 'group',
      key: `style-group:${se.group.styleKey}`,
      media: hasPhoto(f.first) ? (
        <CardPhoto
          photo={f.first}
          title={se.group.baseName}
          subtitle={f.sizeLabel}
          meta={<OnHandMeta value={se.group.total} />}
          priority={priority}
        />
      ) : null,
      name: (
        <Link
          href={`${rowLinkPrefix}/${f.first.id}?return=${encodeURIComponent(currentListUrl)}`}
          prefetch={false}
          className="text-foreground hover:underline"
          title={se.group.baseName}
        >
          {se.group.baseName}
        </Link>
      ),
      badge: <SizeBadge placement="grid">{f.sizeLabel}</SizeBadge>,
      meta: (
        <MetaLine>
          <CategoryLabel category={f.category} />
          <HeaderCharterContent
            first={f.first}
            distinctCharterIds={f.distinctCharterIds}
            lookups={lookups}
            multipleTitle="Sizes span multiple charters — expand to see each"
          />
        </MetaLine>
      ),
      status: (
        <StockStatusBadge
          quantity={se.group.total}
          reorderPoint={f.first.reorder_point}
          itemStatus={f.rolledUpStatus}
        />
      ),
      quantity: formatNumber(se.group.total),
      location: f.location?.name ?? '—',
      facts: [{ label: 'Rack', value: f.rackContent }],
      coverage: (
        <StockBar stock={se.group.total} par={f.par} status={f.status} className="!w-full" />
      ),
      expanded,
      toggleLabel: `${expanded ? 'Collapse' : 'Expand'} ${named}`,
      toggleText: f.sizeLabel,
      panelLabel: named,
      onToggle: () => toggleStyleGroup(se.group.styleKey),
      members: [],
    };
  }

  /** A SKU family's or a named group's Grid card (the SkuGroupHeaderRow facts). */
  function skuGroupCard(
    entry: Extract<RenderEntry, { kind: 'header' }> | Extract<RenderEntry, { kind: 'explicit' }>,
    priority: boolean,
  ): GridGroupCard {
    const items = entry.items;
    const explicit = entry.kind === 'explicit' ? explicitGroupOf(entry) : null;
    const sku = entry.kind === 'header' ? entry.group.sku : '';
    const partial =
      entry.kind === 'header'
        ? !!entry.group.totalIsPartial
        : entry.kind === 'explicit' && entry.partial;
    const f = skuHeaderFacts({ items, explicit: !!explicit, stockView, reservedByItem, lookups });
    const count = explicit ? GROUP_COPY.headerCount(f.distinctItems.length, explicit.matching) : '';
    const partialTitle = partial ? (explicit ? GROUP_PARTIAL_TITLE : SKU_PARTIAL_TITLE) : undefined;
    const expanded = explicit
      ? expandedExplicitGroups.has(explicit.groupId)
      : expandedSkuGroups.has(sku);
    const named = explicit
      ? `group ${explicit.name} (${count})`
      : `${sku} (${items.length} placements)`;
    const books = showBookFields ? booksHeaderContent(items, f.distinctItems) : null;
    return {
      kind: 'group',
      key: explicit ? `display-group:${explicit.groupId}` : `sku-group:${sku}`,
      media: hasPhoto(f.cover) ? (
        <CardPhoto
          photo={f.cover}
          title={explicit ? explicit.name : f.first.name}
          subtitle={explicit ? count : sku}
          meta={<OnHandMeta value={f.displayedTotal} title={partialTitle} partial={partial} />}
          priority={priority}
        />
      ) : null,
      name: explicit ? (
        <span title={explicit.name}>{explicit.name}</span>
      ) : (
        <Link
          href={`${rowLinkPrefix}/${f.first.id}?return=${encodeURIComponent(currentListUrl)}`}
          prefetch={false}
          className="text-foreground hover:underline"
          title={f.first.name}
        >
          {f.first.name}
        </Link>
      ),
      sku: <HeaderSkuContent items={items} explicit={!!explicit} sku={sku} />,
      meta: (
        <MetaLine>
          {explicit ? <span className="text-[var(--ed-ink-2)]">{count}</span> : null}
          {f.categoryRollup.kind === 'multiple' ? (
            <MultipleLabel title="Placements span multiple categories — expand to see each" />
          ) : (
            <CategoryLabel category={f.category} />
          )}
          <HeaderCharterContent
            first={f.first}
            distinctCharterIds={f.distinctCharterIds}
            lookups={lookups}
            multipleTitle="Placements span multiple charters — expand to see each"
          />
        </MetaLine>
      ),
      status: (
        <StockStatusBadge
          quantity={f.healthQuantity}
          reorderPoint={f.groupReorderPoint}
          itemStatus={f.rolledUpStatus}
          autoArchived={f.allAutoArchived}
          awaitingFirstReceipt={f.allAwaitingFirstReceipt}
        />
      ),
      quantity: (
        <>
          <span title={partialTitle}>{formatNumber(f.displayedTotal)}</span>
          {partial && (
            <span aria-hidden className="text-muted-foreground ml-0.5">
              *
            </span>
          )}
        </>
      ),
      location:
        f.locationRollup.kind === 'multiple' ? (
          <MultipleLabel title="Placements span multiple sites — expand to see each" />
        ) : (
          (f.location?.name ?? '—')
        ),
      facts: books
        ? [
            { label: 'Grade', value: books.gradeContent },
            { label: 'Rack', value: books.rackContent },
            { label: 'Crate', value: books.crateContent },
          ]
        : [
            {
              label: 'Rack',
              value: <ItemsHeaderRackContent items={items} distinctItems={f.distinctItems} />,
            },
          ],
      actions:
        explicit && (explicit.onRename || explicit.onRemove) ? (
          <>
            {explicit.onRename ? (
              <button
                type="button"
                onClick={explicit.onRename}
                aria-label={GROUP_COPY.renameFor(explicit.name)}
                className={cn(touchTargetClass, chipActionClass)}
              >
                {GROUP_COPY.renameAction}
              </button>
            ) : null}
            {explicit.onRemove ? (
              <button
                type="button"
                onClick={explicit.onRemove}
                aria-label={GROUP_COPY.removeFor(explicit.name)}
                className={cn(touchTargetClass, chipActionClass)}
              >
                {GROUP_COPY.removeAction}
              </button>
            ) : null}
          </>
        ) : undefined,
      coverage: (
        <StockBar stock={f.healthQuantity} par={f.par} status={f.status} className="!w-full" />
      ),
      expanded,
      toggleLabel: `${expanded ? 'Collapse' : 'Expand'} ${named}`,
      toggleText: explicit ? count : `${items.length} placements`,
      panelLabel: explicit ? `${explicit.name} (${count})` : named,
      onToggle: () => (explicit ? toggleExplicitGroup(explicit.groupId) : toggleSkuGroup(sku)),
      members: [],
    };
  }

  /**
   * THE GRID'S ENTRIES: the SAME `styledRenderItems` the table rows are drawn
   * from, in the same order. A header becomes a group card; the rows an
   * expanded header emits right after it (core composeDisplayList marks them
   * nested) become its drill-down's cards, so a group opens inline, inside the
   * page, and nothing is added to or taken from it.
   */
  function buildGridEntries(): GridEntry[] {
    const out: GridEntry[] = [];
    let open: GridGroupCard | null = null;
    let openIsRun = false;
    let shown = 0;
    for (const se of styledRenderItems) {
      const priority = shown++ < 12;
      if (se.kind === 'style') {
        open = styleGroupCard(se, priority);
        openIsRun = true;
        out.push(open);
        continue;
      }
      const entry = se.entry;
      if (entry.kind === 'explicit' || entry.kind === 'header') {
        open = skuGroupCard(entry, priority);
        openIsRun = false;
        out.push(open);
        continue;
      }
      const card = recordCard(entry, { priority, sizeMember: !!entry.nested && openIsRun });
      if (entry.nested && open) {
        open.members.push(card);
      } else {
        open = null;
        out.push(card);
      }
    }
    return out;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Group selected (0400): a group header's Rename / Remove and a row
          chip's Add to group. Each reviews first and writes only on Save; a
          change refreshes the page (the server re-reads every row). */}
      {groupAction?.kind === 'rename' ? (
        <RenameGroupDialog
          open
          groupId={groupAction.groupId}
          memberIds={groupAction.memberIds}
          onDone={() => router.refresh()}
          onOpenChange={(v) => (v ? null : setGroupAction(null))}
        />
      ) : null}
      {groupAction?.kind === 'remove' ? (
        <RemoveFromGroupDialog
          open
          itemIds={groupAction.ids}
          view={showBookFields ? 'books' : 'items'}
          onDone={(o) => (o.outcome === 'applied' ? router.refresh() : undefined)}
          onOpenChange={(v) => (v ? null : setGroupAction(null))}
        />
      ) : null}
      {groupAction?.kind === 'add' ? (
        <GroupSelectedDialog
          open
          itemIds={groupAction.ids}
          initialGroupId={groupAction.groupId}
          view={showBookFields ? 'books' : 'items'}
          showGroupHref={offerShowGroup ? showGroupHref : undefined}
          onDone={(o) => {
            if (o.outcome !== 'applied') return;
            router.refresh();
            // The record joined: show the group open (C3), on the page that
            // draws it (B5).
            const groupId = o.group?.id;
            if (groupId) {
              revealGroup(
                groupId,
                o.changes.filter((c) => c.toGroupId === groupId).map((c) => c.itemId),
              );
            }
          }}
          onOpenChange={(v) => (v ? null : setGroupAction(null))}
        />
      ) : null}
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
      {/* The views row (DESIGN-SPEC 6.5, 6.21): the stock views as a
          segmented control, then the Expected / Auto-archived only toggles and
          the saved views as chips, and the Table / Grid control at the right.
          It stays usable while rows are ticked (only the toolbar below swaps
          for the bulk bar), so the view can be switched with a selection: the
          grid draws the same page with the same picks. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <SegmentedTabs
            aria-label="Filter by stock"
            activeId={view}
            items={VIEWS.map((v) => ({
              id: v,
              label: v,
              href: hrefForView(v),
              scroll: false,
              // No viewport prefetch: these hrefs embed the CURRENT q/filters,
              // so every keystroke re-prefetched 3-4 full RSC renders of the
              // low/out/archived variants (observed live) — pure server waste,
              // doubly so in instant mode where the click never hits the
              // server at all. Hover still warms in server mode.
              prefetch: false,
              // Instant mode: the stock filter derives locally, so the tab
              // becomes a shallow push (same URL, zero server work).
              onClick: instantMode
                ? (e: React.MouseEvent<HTMLAnchorElement>) =>
                    interceptShallowNav(e, hrefForView(v), shallowPush)
                : undefined,
            }))}
          />
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
              className={filterChipClass({ active: autoArchivedOnly })}
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
              className={filterChipClass({ active: expectedOnly })}
            >
              Expected
              <span
                className={cn(
                  'font-mono text-[11px] font-medium tabular-nums',
                  expectedOnly ? 'text-background/80' : 'text-muted-foreground',
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
        {/* TABLE / GRID (P2.6 SegmentedTabs, button mode): a viewer's
            preference, kept in this list's cookie; Table is the default. */}
        <SegmentedTabs
          aria-label="Show as"
          size="sm"
          className="ml-auto"
          activeId={listView}
          onSelect={(id) => selectListView(id === 'grid' ? 'grid' : 'table')}
          items={[
            { id: 'table', label: 'Table', icon: <List aria-hidden strokeWidth={1.8} /> },
            { id: 'grid', label: 'Grid', icon: <LayoutGrid aria-hidden strokeWidth={1.8} /> },
          ]}
        />
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
            'col-start-1 row-start-1 flex flex-wrap content-start items-center gap-x-1.5 gap-y-2',
            selected.size > 0 && 'invisible',
          )}
        >
          <div className="relative w-full sm:w-[240px]">
            <Search
              aria-hidden
              className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
              strokeWidth={1.8}
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, SKU, barcode…"
              className={cn('h-8 pl-8 text-[13px]', onScanRequest && 'pr-9')}
              aria-label="Search items"
            />
            {onScanRequest && (
              <button
                type="button"
                onClick={onScanRequest}
                className={cn(
                  // The touch target first: its `relative` must lose to the
                  // `absolute` that seats the button inside the field.
                  touchTargetClass,
                  'text-muted-foreground hover:bg-muted hover:text-foreground absolute right-1 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md transition-colors max-sm:right-2.5',
                )}
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
              className={cn(
                touchTargetClass,
                'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] transition-colors max-sm:min-h-11',
              )}
              aria-label="Clear all filters"
            >
              <X aria-hidden className="h-3.5 w-3.5" /> Clear
            </button>
          )}

          <FilterTrigger
            hideChevron
            onClick={() => setStockView((v) => (v === 'placed' ? 'total' : 'placed'))}
            aria-label="Toggle on-hand view"
            title="Switch between total on-hand and placed-only"
            label={stockView === 'placed' ? 'On hand: placed only' : 'On hand: total'}
          />

          <ExportMenu
            params={params}
            itemType={showBookFields ? 'book' : (params.get('type') ?? 'product')}
          />
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
            ungroupItemIds={ungroupItemIds}
            ungroupShownUnder={ungroupShownUnder}
            groupItemIds={groupFacts?.canGroup ? selectedItemIds : []}
            groupingView={showBookFields ? 'books' : 'items'}
            // C3 (design 5): after a grouping the list opens the group, and
            // B5: shows it, on the page that draws it.
            onGrouped={revealGroup}
            showGroupHref={offerShowGroup ? showGroupHref : undefined}
            onAddToSelection={(ids) =>
              // An explicit choice in the review: add those records (their
              // rows on screen when loaded, else the record itself).
              setSelected((prev) => {
                const next = new Set(prev);
                const loaded = new Map<string, string[]>();
                for (const r of displayed) {
                  const k = r.rowKey ?? r.id;
                  loaded.set(r.id, [...(loaded.get(r.id) ?? []), k]);
                }
                for (const id of ids) for (const k of loaded.get(id) ?? [id]) next.add(k);
                return next;
              })
            }
            canStartOrder={canStartOrder}
            onStartOrder={() => {
              // Resolve ONE warehouse for the selection (an order is per
              // warehouse) from the checked rows + the active warehouse filter,
              // hand it off in sessionStorage, and open the storefront. The
              // storefront applies the prefill and reports anything not
              // orderable there. See lib/orders/start-order-prefill.ts.
              const byId = new Map<string, Item>();
              for (const r of effectiveInstant?.items ?? items) byId.set(r.id, r);
              for (const r of serverHits ?? []) byId.set(r.id, r);
              const rows = selectedItemIds.map((id) => {
                const r = byId.get(id);
                return {
                  id,
                  warehouse_id: r?.warehouse_id ?? null,
                  status: r?.status ?? 'active',
                };
              });
              const resolved = resolveStartOrder(rows, activeWarehouseId);
              if (!resolved) {
                toast.error(
                  'None of the selected items can be ordered (they may be archived or have no warehouse).',
                );
                return;
              }
              writeOrderPrefill({
                warehouseId: resolved.warehouseId,
                itemIds: resolved.itemIds,
              });
              if (resolved.droppedOtherWarehouse > 0) {
                toast.message(
                  `Starting an order for one warehouse — ${resolved.droppedOtherWarehouse} item${
                    resolved.droppedOtherWarehouse === 1 ? '' : 's'
                  } in other warehouses ${
                    resolved.droppedOtherWarehouse === 1 ? 'was' : 'were'
                  } left out.`,
                );
              }
              setSelected(new Set());
              router.push(
                `/dashboard/orders/new?warehouseId=${encodeURIComponent(resolved.warehouseId)}`,
              );
            }}
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
            // 0371: stock in warehouses the viewer cannot see is never moved by
            // Set rack; the dialog says so up front.
            hasElsewhereSelection={(effectiveInstant?.items ?? items).some(
              (i) => selectedItemIdSet.has(i.id) && (i.elsewhere_quantity ?? 0) > 0,
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
      {/* The count and value of the whole result (THE THREE COUNTS), with
          the top pager at the right. The redesign moved the count out of the
          toolbar row, which wrapped it onto a line of its own, to sit under
          the filters beside the pager. */}
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p
          className={cn(
            'text-muted-foreground flex items-center gap-1.5 font-mono text-[12px] tabular-nums',
            // Hidden in place while rows are ticked, as it was inside the
            // toolbar the bulk bar replaces (it keeps its space: no shift).
            selected.size > 0 && 'invisible',
          )}
        >
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
            // complete. The planned first page prints the same line from
            // the counts the server took over the whole view, so the
            // footer does not change when the dataset is adopted.
            if (instantMode || planned) {
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
              // A staff member's planned Items page counts the view's
              // records, not the rack rows they split into on screen
              // (that needs every record's holdings), so it names them
              // items (count 1). On Books a record is one row.
              const rowsLabel = placementRowCount === null && !showBookFields ? 'items' : 'rows';
              return (
                <>
                  {formatNumber(skus)} SKUs ·{' '}
                  {skus !== rows ? (
                    <>
                      {formatNumber(rows)} {rowsLabel} ·{' '}
                    </>
                  ) : null}
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
        {showPagination && (
          <Pagination
            page={effectivePage}
            pageSize={pageSize}
            total={effectiveTotal}
            range={pageRange}
            buildHref={hrefForPage}
            onNavigate={instantMode ? shallowPush : undefined}
            pendingInstant={instantPending}
          />
        )}
      </div>

      {/* Table */}
      <div
        aria-busy={isFilterPending}
        className={cn(
          'border-border bg-card overflow-hidden rounded-lg border transition-opacity',
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
        {listView === 'grid' ? (
          <InventoryGrid
            entries={buildGridEntries()}
            idPrefix={gridIdPrefix}
            selectionActive={selected.size > 0}
            selectAll={
              // The Table's header box is not on screen in Grid: this is the
              // same page-scoped select-all (the visible page, members of
              // collapsed group cards included), with the same mixed state.
              <Checkbox
                checked={allVisibleSelected}
                indeterminate={someVisibleSelected}
                onCheckedChange={(c) => toggleAll(c)}
                className="text-muted-foreground hover:text-foreground min-h-7 text-[12.5px] max-sm:min-h-11"
              >
                Select all rows on this page
              </Checkbox>
            }
            empty={noMatchLine}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-[13.5px]">
              <thead>
                <tr className="border-border border-b">
                  <th className="w-10 py-2.5 pl-4 pr-0 text-left">
                    <Checkbox
                      checked={allVisibleSelected}
                      indeterminate={someVisibleSelected}
                      onCheckedChange={(c) => toggleAll(c)}
                      label="Select all rows on this page"
                    />
                  </th>
                  {TABLE_COLUMNS(showBookFields).map(([label, align]) => (
                    <th
                      key={label}
                      className={cn(
                        'text-muted-foreground h-[37px] py-2.5 text-[11px] font-medium uppercase tracking-[0.06em]',
                        // The 14-day toggle may take two lines ("14-day" over
                        // "· qty"); every other label stays on one.
                        label === '14-day' ? 'py-1' : 'whitespace-nowrap',
                        align === 'right' ? 'text-right' : 'text-left',
                        columnPad(label, showBookFields),
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
                    <td colSpan={showBookFields ? 13 : 11} className="p-0">
                      {noMatchLine}
                    </td>
                  </tr>
                )}
                {styledRenderItems.map((se) => {
                  // Size-run (apparel) header — one collapsed row per style
                  // base (e.g. "L4L - Pink Shirt"), stacked ABOVE the SKU
                  // grouping. Expanding splices its member rows (the SAME
                  // `<tr>`s below) in right after it.
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
                  // Group selected (0400): an explicit display group's header,
                  // the SAME row markup as a SKU header, named for the group.
                  // Its chevron reveals the group's own rows (the SAME `<tr>`s
                  // below). Not selectable; Rename and Remove act on the
                  // group's records on screen only (the server decides on what
                  // the viewer can edit; a hidden record is never named or
                  // moved).
                  if (entry.kind === 'explicit') {
                    const g = explicitGroupOf(entry);
                    return (
                      <SkuGroupHeaderRow
                        key={`display-group:${entry.groupId}`}
                        group={{
                          sku: '',
                          name: g.name,
                          total: 0,
                          placements: [],
                          ...(entry.partial ? { totalIsPartial: true } : {}),
                        }}
                        explicit={g}
                        items={entry.items}
                        expanded={expandedExplicitGroups.has(entry.groupId)}
                        onToggle={() => toggleExplicitGroup(entry.groupId)}
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
                  const facts = recordFacts(item);
                  // Stable per (displayed, sparkMode, trends) — see seriesByItem above.
                  const series = seriesByItem.get(item.id) ?? EMPTY_SERIES;
                  // Key selection on rowKey (unique per rack row) — NOT
                  // item.id, which is identical across an item's rack rows and
                  // made checking one rack visually check them all (owner's
                  // "both Chromebook rows checked but bar says 1 selected").
                  // Bulk actions still collapse back to distinct item ids (see
                  // selectedItemIds).
                  const isSelected = selected.has(item.rowKey ?? item.id);
                  // Each body cell pads like its column's header cell (columnPad).
                  const td = (label: string) => columnTd(label, showBookFields);

                  return (
                    <tr
                      key={item.rowKey ?? item.id}
                      data-row-kind={entry.nested ? 'member' : 'record'}
                      data-row-key={item.rowKey ?? item.id}
                      className={cn(
                        'border-border border-b transition-colors last:border-0',
                        // Selected: the accent wash, kept on hover (the ticked
                        // box is the cue that does not rely on colour).
                        isSelected
                          ? 'bg-success-wash'
                          : entry.nested
                            ? 'bg-card hover:bg-muted'
                            : 'hover:bg-muted',
                      )}
                    >
                      <td className="w-10 py-[var(--row-py)] pl-4 pr-0">{recordCheckbox(item)}</td>
                      <td className={itemTd(showBookFields)}>
                        {/* The SKU is the Item cell's second line, plain text
                            outside the name link and alone in its block, so it
                            is still selected and copied on its own (owner
                            decision 2026-10-19: SKU stacked under the item name).
                            It wraps inside the column, so a long SKU never
                            widens the table. */}
                        <ItemCell
                          nested={!!entry.nested}
                          // A member's thumb sits under its header's, which
                          // has the chevron (24) and its gap (12) before it.
                          className={entry.nested ? 'pl-9' : undefined}
                          thumb={
                            <ListThumb
                              photo={item}
                              alt={item.name}
                              title={item.name}
                              subtitle={item.sku}
                              meta={<OnHandMeta value={item.quantity_on_hand} />}
                              // First ~12 rows are above the fold on a typical
                              // 1080p screen — bypass lazy loading so they start
                              // fetching with the initial HTML instead of after
                              // JS paints.
                              priority={rowIdx < 12}
                            />
                          }
                          name={itemLink(item, ITEM_NAME_LINK)}
                          chip={entry.nested ? null : rowChip(entry, item, { wrapAction: true })}
                          chipAction={!entry.nested && rowChipHasAction(entry)}
                          sku={item.sku}
                          wrapSku
                        />
                      </td>
                      <td className={td('Category')}>
                        <CategoryLabel category={facts.category} wrap />
                      </td>
                      <td className={cn(td('Charter'), 'whitespace-nowrap text-[13px]')}>
                        <CharterLabel item={item} lookups={lookups} />
                      </td>
                      <td className={locationTd(showBookFields)}>{facts.location?.name ?? '—'}</td>
                      {!showBookFields && (
                        <td className={cn(td('Rack'), RACK_TD)}>
                          <ItemsRackContent item={item} />
                        </td>
                      )}
                      {showBookFields &&
                        (() => {
                          const storage = readBookStorage(item.custom_fields);
                          return (
                            <>
                              <td
                                className={cn(
                                  td('Grade'),
                                  'whitespace-nowrap text-[12.5px] text-[var(--ed-ink-2)]',
                                )}
                              >
                                <BookGradeLabel grade={storage.grade} />
                              </td>
                              <td className={cn(td('Rack'), RACK_TD)}>
                                <BookRackContent item={item} />
                              </td>
                              <td
                                className={cn(
                                  td('Crate'),
                                  'whitespace-nowrap text-[12.5px] text-[var(--ed-ink-2)]',
                                )}
                              >
                                <BookCrateLabel
                                  crateNumber={storage.crateNumber}
                                  crateColor={storage.crateColor}
                                />
                              </td>
                            </>
                          );
                        })()}
                      <td className={cn(td('On hand'), 'text-right')}>
                        {/* Only the figure is mono: the notes under it read in
                            the body face, as on a Grid card. */}
                        <span className={ON_HAND_FIGURE}>
                          {formatNumber(onHandFigure(item, stockView))}
                        </span>
                        <OnHandNotes
                          item={item}
                          stockView={stockView}
                          reservedByItem={reservedByItem}
                          table
                        />
                      </td>
                      <td className={td('Coverage')}>
                        <StockBar
                          stock={facts.availableForStatus}
                          par={facts.par}
                          status={facts.status}
                        />
                      </td>
                      <td className={cn(td('14-day'), 'text-right')}>
                        <Sparkline data={series} width={56} height={18} />
                      </td>
                      <td className={cn(td('Status'), STATUS_WRAP)}>
                        <StockStatusBadge
                          quantity={facts.availableForStatus}
                          reorderPoint={item.reorder_point}
                          itemStatus={item.status}
                          autoArchived={item.auto_archived}
                          awaitingFirstReceipt={item.awaiting_first_receipt === true}
                        />
                      </td>
                      <td
                        className={cn(
                          td('Updated'),
                          'text-muted-foreground whitespace-nowrap text-right text-[12.5px]',
                        )}
                        // `formatRelative` reads `new Date()` at call time, so
                        // the string produced during server SSR ("15 minutes
                        // ago") can shift by the time the client hydrates ("16
                        // minutes ago"), tripping React error #418. Tolerate
                        // the drift — exactly the case suppressHydrationWarning
                        // is for.
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
        )}

        {showPagination || (plannedPageStranded && pageRange) || canCreate ? (
          <div className="border-border flex flex-wrap items-center justify-between gap-3 border-t px-4 py-2.5">
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
                range={pageRange}
                buildHref={hrefForPage}
                onNavigate={instantMode ? shallowPush : undefined}
                pendingInstant={instantPending}
              />
            ) : plannedPageStranded && pageRange ? (
              // The stranded planned page (see plannedPageStranded): no page
              // links, which would skip or repeat rows.
              <p className="text-muted-foreground text-[12.5px]">
                Showing {formatNumber(pageRange.startRow)}–{formatNumber(pageRange.endRow)} of{' '}
                {formatNumber(effectiveTotal)}. Refresh to see more.
              </p>
            ) : (
              <span />
            )}
            {canCreate && (
              <Button asChild variant="gradient">
                <Link href={`${basePath}/new`}>+ New {showBookFields ? 'book' : 'item'}</Link>
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The table's columns after the checkbox: 11 cells in all on Items, 13 on
 *  Books (Grade, Rack, Crate in place of Rack). Every row kind emits the same
 *  count (tests count them). The SKU has no column of its own: it is the
 *  Item cell's second line, under the name (owner decision 2026-10-19). */
function TABLE_COLUMNS(
  showBookFields: boolean,
): ReadonlyArray<readonly [string, 'left' | 'right']> {
  return [
    ['Item', 'left'],
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
  ];
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
    <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-2 text-[12.5px]">
      {/* The figures in the ink and Prev / Next at weight 400, the
          reference pager's (DESIGN-SPEC 6.9 and 6.2; FX8: they were 500).
          Formatted like the summary line above it ("52,345 items"). */}
      <span>
        Showing <span className="text-foreground">{formatNumber(startRow)}</span>–
        <span className="text-foreground">{formatNumber(endRow)}</span> of{' '}
        <span className="text-foreground">{formatNumber(total)}</span>
      </span>
      {/* 8 px between the 28 px controls: each grows a 44 px touch area below
          sm and on coarse pointers, and a later one paints over its
          neighbour's edge (the Button's touch rule). */}
      <div className="flex items-center gap-2">
        <Button
          asChild
          variant="outline"
          size="sm"
          disabled={prevDisabled}
          className={cn('font-normal', prevDisabled && PAGER_EDGE_DISABLED)}
        >
          {prevDisabled ? (
            <span aria-disabled className="pointer-events-none">
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
              className={cn(
                touchTargetClass,
                'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 cursor-pointer items-center rounded-md px-2 text-[12.5px] tabular-nums transition-colors',
              )}
            >
              Page {formatNumber(safePage)} of {formatNumber(totalPages)}
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="center"
            side="top"
            className="max-h-[360px] w-auto min-w-[260px] overflow-y-auto p-2"
          >
            {/* Five columns, eight from sm up, five again on a coarse pointer
                so each column stays at least 44 px wide; the page buttons are
                real 44 px targets below sm and on coarse pointers. At 28 px
                with 4 px gaps, a page button's 44 px touch area reached over
                the row above, so a tap on the bottom of page 1 opened page 6
                (P2.2 hand-off, the same fix as ui/pagination.tsx). */}
            <div className="pointer-coarse:grid-cols-5 grid grid-cols-5 gap-1 sm:grid-cols-8">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                <Button
                  key={n}
                  asChild
                  variant={n === safePage ? 'default' : 'ghost'}
                  size="sm"
                  className="pointer-coarse:h-11 h-7 w-full px-2 text-[12.5px] tabular-nums max-sm:h-11"
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
                    {formatNumber(n)}
                  </Link>
                </Button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Button
          asChild
          variant="outline"
          size="sm"
          disabled={nextDisabled}
          className={cn('font-normal', nextDisabled && PAGER_EDGE_DISABLED)}
        >
          {nextDisabled ? (
            <span aria-disabled className="pointer-events-none">
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

/** A pager end with nowhere to go (DESIGN-SPEC 6.2): no fill, the plain
 *  hairline and the faint ink, instead of a faded secondary button. */
const PAGER_EDGE_DISABLED =
  'border-border bg-transparent text-[var(--ed-ink-4)] hover:bg-transparent';

// ── Cell content shared by the Table rows and the Grid cards ──────────────
// The Grid (redesign P3.2) shows what the row shows for the same record and
// never a figure the row does not have (PLAN "Grid card content, per list"),
// so every one of these renders the SAME words, figures, titles and tones in a
// table cell and on a card. Changing one changes both.

// The Category cell (CategoryLabel) lives in ./category-label: it draws the
// category's stored colour, which it checks first (docket T14).

/** The Charter cell: the charter's code (its name as the title), or "Generic". */
function CharterLabel({ item, lookups }: { item: Item; lookups: Lookups }) {
  const charter = item.charter_id ? (lookups.charters?.get(item.charter_id) ?? null) : null;
  if (charter) {
    return (
      <span className="text-[var(--ed-ink-2)]" title={charter.name}>
        {charter.code ?? charter.name}
      </span>
    );
  }
  // charter_id IS NULL = generic stock (any charter serviced by the
  // warehouse can pull from it).
  return (
    <span
      className="text-muted-foreground text-[12px] italic"
      title="Generic stock — any charter serviced by this warehouse can use it"
    >
      {GENERIC_CHARTER_LABEL}
    </span>
  );
}

/**
 * The Items layout's Rack cell: where THIS row's stock is (one line per rack,
 * crate, staging or unplaced holding; a site holding as amber "No rack"; the
 * 0371 "In other warehouses" row), else the record's racks (first two, then
 * "+N", the full list in the title) with "+N in other warehouses" under them,
 * else the stored rack label.
 */
function ItemsRackContent({ item }: { item: Item }) {
  // Split "one line per rack" row: show THIS row's location label (rack/crate
  // name, or "Staging"/"Unplaced"). null = no holding → em dash.
  // Staging/unplaced buckets read AMBER — this row's stock is awaiting
  // put-away (owner decision 2026-07-08, consistent with the item detail card
  // and the qty sub-line).
  if (item.placement_label !== undefined) {
    // 0371: the row carrying this item's stock in warehouses the viewer cannot
    // see. Not a rack, and never a place they can act on from here.
    if (item.placement_kind === ELSEWHERE_PLACEMENT_KIND) {
      return <span className="text-muted-foreground">{item.placement_label}</span>;
    }
    // A SITE is not a rack. Stock recorded at the warehouse's own site location
    // (a NULL-kind row such as "DC4") used to print its name here, which read
    // as "rack DC4" (owner report 2026-09-24). Say what it is.
    if (item.placement_kind === 'site' && item.placement_label) {
      return (
        <span
          className="text-warning"
          title={`At ${item.placement_label} (the site), not on a rack. Use Set rack to put it away.`}
        >
          No rack
        </span>
      );
    }
    const awaiting = item.placement_kind === 'staging' || item.placement_kind === 'unplaced';
    return item.placement_label ? (
      <span className={awaiting ? 'text-warning font-mono tabular-nums' : 'font-mono tabular-nums'}>
        {item.placement_label}
      </span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }
  // Prefer the ACTUAL placement (rack/crate locations the stock sits in, from
  // holdings). An empty array means the stock is unplaced/staged — show "—",
  // not a stale label.
  const placed = item.placed_racks;
  if (placed !== undefined) {
    const elsewhere = elsewhereSuffix(item);
    if (placed.length === 0) {
      return elsewhere ? (
        <span className="text-muted-foreground">{elsewhere}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    }
    const shown = placed.slice(0, 2).join(', ');
    const extra = placed.length - 2;
    return (
      <>
        <span className="font-mono tabular-nums" title={placed.join(', ')}>
          {extra > 0 ? (
            // "+N" hides racks from the eye; a screen reader hears the full
            // list instead (the title is not read everywhere).
            <>
              <span aria-hidden>
                {shown} +{extra}
              </span>
              <span className="sr-only">{placed.join(', ')}</span>
            </>
          ) : (
            shown
          )}
        </span>
        {elsewhere && (
          <div className="text-muted-foreground mt-0.5 text-[11px] leading-tight">{elsewhere}</div>
        )}
      </>
    );
  }
  // Fallback for callers that don't compute holdings-based placement (kept for
  // backwards-compat).
  const rack = readItemRack(item.custom_fields);
  return rack.rackLabel ? (
    <span className="font-mono tabular-nums">{rack.rackLabel}</span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

/** The Books layout's Grade cell: "Gr N" for a one- or two-digit grade. */
function BookGradeLabel({ grade }: { grade: string | null | undefined }) {
  return grade ? (
    <span className="font-mono">{/^\d{1,2}$/.test(grade) ? `Gr ${grade}` : grade}</span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

/** The Books layout's Rack cell: the resolved rack label and "+N in other warehouses". */
function BookRackContent({ item }: { item: Item }) {
  // 0371: this cell describes the viewer's own warehouses; the rest is
  // counted, not named.
  const elsewhere = elsewhereSuffix(item);
  // B37: every placed unit is on a Site, so the rack the book's keys still
  // name is where the stock LEFT. The cell reads as the Items layout's lines
  // for the same holdings: a room, a vehicle or a job site prints its name;
  // the warehouse's own building is not a rack and reads "No rack".
  const sites = bookSitesFor(item);
  if (sites) {
    return (
      <>
        {sites.places.length > 0 && (
          <span className="font-mono tabular-nums">{sites.places.join(', ')}</span>
        )}
        {sites.buildings.length > 0 && <BuildingNoRack sites={sites.buildings} />}
        {elsewhere && (
          <div className="text-muted-foreground mt-0.5 text-[11px] leading-tight">{elsewhere}</div>
        )}
      </>
    );
  }
  const label = bookRackLabelFor(item);
  if (!label) {
    return <span className="text-muted-foreground">{elsewhere ?? '—'}</span>;
  }
  return (
    <>
      <span className="font-mono tabular-nums">{label}</span>
      {elsewhere && (
        <div className="text-muted-foreground mt-0.5 text-[11px] leading-tight">{elsewhere}</div>
      )}
    </>
  );
}

/**
 * The Books Rack cell's "No rack" for stock at the warehouse's own building
 * (B37), in the Items layout's words for its site line, with the building
 * named UNDER it as text. A title is not reached by a keyboard, a touch screen
 * or every screen reader, and the row's Location column names the item's
 * primary location, which is not always where this stock sits. The title
 * keeps the put-away hint for a pointer.
 */
function BuildingNoRack({ sites }: { sites: readonly string[] }) {
  const names = sites.join(', ');
  return (
    <div>
      <span
        className="text-warning"
        title={`At ${names} (${sites.length === 1 ? 'the site' : 'the sites'}), not on a rack. Use Set rack to put it away.`}
      >
        No rack
      </span>
      <div className="text-muted-foreground mt-0.5 text-[11px] leading-tight">At {names}</div>
    </div>
  );
}

/** The Books layout's Crate cell: the crate's colour dot (its name as the title) and number. */
function BookCrateLabel({
  crateNumber,
  crateColor,
}: {
  crateNumber: string | null | undefined;
  crateColor: string | null | undefined;
}) {
  const color = getCrateColor(crateColor);
  return crateNumber ? (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        title={color ? color.label : 'No color set'}
        className="inline-block h-2.5 w-2.5 rounded-full border border-[var(--ed-line-strong)]"
        style={color ? { backgroundColor: color.hex } : undefined}
      />
      <span className="font-mono tabular-nums">{crateNumber}</span>
    </span>
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

/** The number the On hand cell prints for a row (a split row: its holding). */
function onHandFigure(item: Item, stockView: StockView): number {
  return rowDisplayQuantity(item, stockView);
}

/** Whether OnHandNotes prints anything for this row (a card leaves the slot out). */
function hasOnHandNotes(item: Item, reservedByItem?: Map<string, number>): boolean {
  if ((reservedByItem?.get(item.id) ?? 0) > 0) return true;
  if (item.line_quantity !== undefined) {
    return item.placement_kind === 'staging' || item.placement_kind === 'unplaced';
  }
  return (item.staged_quantity ?? 0) + (item.unplaced_quantity ?? 0) > 0;
}

/**
 * A grid card's meta: its parts with a quiet "·" between them, in order. On
 * one line where the card has room, drawn exactly as before; where it has not
 * (a group card's "N records · Category · Generic" on a 390 px phone, W5) it
 * wraps between whole parts, and inside a part only between its words, so no
 * word is cut or hidden. Each "·" stays with the part before it, so a wrapped
 * line never starts with one, and the lines sit 18 px apart, as text does.
 */
function MetaLine({ children }: { children: React.ReactNode }) {
  const parts = React.Children.toArray(children);
  return (
    <span
      data-slot="meta-line"
      className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5"
    >
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {part}
          {i < parts.length - 1 ? (
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/**
 * The On hand cell's sub-lines: a split row's amber "awaiting put-away"; a
 * record's "N placed · N awaiting put-away" (total) or "+N awaiting put-away"
 * (placed only); and on Rentals items "{available} avail · {out} out".
 *
 * `table` (owner decision 2026-10-19: no extra space in On hand): in the table
 * the notes may wrap between words, so they no longer set the column's width
 * (its label and figure do). "N placed ·", "N avail ·" and "N out" stay whole,
 * the count stays with "awaiting" (a no-break space), and the lines are
 * balanced, so "put-away" is never split at its hyphen. A Grid card passes
 * nothing and keeps every phrase on one line, exactly as before.
 */
function OnHandNotes({
  item,
  stockView,
  reservedByItem,
  table = false,
}: {
  item: Item;
  stockView: StockView;
  reservedByItem?: Map<string, number>;
  table?: boolean;
}) {
  // Rentals-only: reserve-not-decrement model means a checkout never lowers
  // on-hand. Surface available + out-on-rental under the qty so reserved stock
  // is visible. `reservedByItem` is undefined on the inventory + books lists →
  // nothing renders.
  const reserved = reservedByItem?.get(item.id) ?? 0;
  const rentals =
    reserved > 0 ? (
      <div
        className={
          table
            ? 'text-muted-foreground mt-0.5 text-balance text-[11px] font-normal leading-tight'
            : 'text-muted-foreground mt-0.5 text-[11px] font-normal leading-tight'
        }
      >
        {table ? (
          // Each phrase stays whole, so a second line starts with the "out"
          // count, never with the dot.
          <>
            <span className="whitespace-nowrap">
              {formatNumber(Math.max(0, item.quantity_on_hand - reserved))} avail ·
            </span>{' '}
            <span className="whitespace-nowrap">{formatNumber(reserved)} out</span>
          </>
        ) : (
          <>
            {formatNumber(Math.max(0, item.quantity_on_hand - reserved))} avail ·{' '}
            {formatNumber(reserved)} out
          </>
        )}
      </div>
    ) : null;
  // Split "one line per rack" row: ON HAND is THIS rack's quantity. If the
  // bucket is staging/unplaced, add the amber "awaiting put-away" line so a
  // split row reads the same as the item detail card (owner decision
  // 2026-07-08). Placed rack rows show just the number.
  if (item.line_quantity !== undefined) {
    const awaiting = item.placement_kind === 'staging' || item.placement_kind === 'unplaced';
    return (
      <>
        {awaiting && (
          // One text node either way (tests read it whole); in the table it
          // may take two balanced lines, "awaiting" over "put-away".
          <div
            className={
              table
                ? 'text-warning mt-0.5 text-balance text-[11px] font-normal leading-tight'
                : 'text-warning mt-0.5 whitespace-nowrap text-[11px] font-normal leading-tight'
            }
          >
            awaiting put-away
          </div>
        )}
        {rentals}
      </>
    );
  }
  // Defensive defaults so rows without the new fields (older callers,
  // non-service code paths) render exactly as before.
  const staged = item.staged_quantity ?? 0;
  const unplaced = item.unplaced_quantity ?? 0;
  const placed = item.placed_quantity ?? item.quantity_on_hand;
  // Received/unassigned stock reads as ONE amber phrase — "awaiting put-away"
  // (staged + unplaced) — per owner direction 2026-07-08: on-hand accounting is
  // unchanged, but not-yet-put-away stock must be unmistakable. The
  // staged/unplaced operational split still lives on the Staging page.
  const awaiting = staged + unplaced;
  return (
    <>
      {awaiting > 0 && (
        <div
          className={
            table
              ? 'mt-0.5 text-balance text-[11px] font-normal leading-tight'
              : 'mt-0.5 text-[11px] font-normal leading-tight'
          }
        >
          {stockView === 'total' ? (
            <>
              {/* Omit "0 placed" — for a fully-unplaced item it reads as if
                  the item is unavailable. */}
              {/* Each phrase stays whole; the line may break only between them
                  (in the table also inside "N awaiting put-away", before
                  "put-away"). */}
              {placed > 0 && (
                <>
                  <span className="text-muted-foreground whitespace-nowrap">
                    {formatNumber(placed)} placed ·
                  </span>{' '}
                </>
              )}
              {table ? (
                <span className="text-warning">{`${formatNumber(awaiting)} awaiting put-away`}</span>
              ) : (
                <span className="text-warning whitespace-nowrap">
                  {formatNumber(awaiting)} awaiting put-away
                </span>
              )}
            </>
          ) : table ? (
            <span className="text-warning">{`+${formatNumber(awaiting)} awaiting put-away`}</span>
          ) : (
            <span className="text-warning whitespace-nowrap">
              +{formatNumber(awaiting)} awaiting put-away
            </span>
          )}
        </div>
      )}
      {rentals}
    </>
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
    // A site holding is not a rack (the cell reads "No rack"), so the group
    // header must not count it as one. Nor is the row carrying stock in other
    // warehouses (0371): it names no rack at all.
    if (item.placement_kind === 'site' || item.placement_kind === ELSEWHERE_PLACEMENT_KIND) {
      return [];
    }
    return item.placement_label ? [item.placement_label] : [];
  }
  if (item.placed_racks !== undefined) return item.placed_racks;
  const rack = readItemRack(item.custom_fields);
  return rack.rackLabel ? [rack.rackLabel] : [];
}

/** Units the given ITEMS (one entry per item, not per placement row) hold in
 *  warehouses the viewer cannot see (0371). */
function elsewhereUnits(distinctItems: readonly Item[]): number {
  return distinctItems.reduce((sum, it) => sum + (it.elsewhere_quantity ?? 0), 0);
}

function hasElsewhere(distinctItems: readonly Item[]): boolean {
  return elsewhereUnits(distinctItems) > 0;
}

/** A group header's "+N in other warehouses" line, or nothing. */
function ElsewhereTail({ items }: { items: readonly Item[] }) {
  const suffix = elsewhereSuffix({ elsewhere_quantity: elsewhereUnits(items) });
  if (!suffix) return null;
  return <div className="text-muted-foreground mt-0.5 text-[11px] leading-tight">{suffix}</div>;
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
export function bookRackLabelFor(item: BookPlacementRow): string | null {
  const names = bookRackNamesFor(item);
  return names.length > 0 ? names.join(', ') : null;
}

/** What the Books layout's placement helpers read off a row. */
type BookPlacementRow = {
  custom_fields?: Record<string, unknown> | null;
  placed_holdings?: RackHoldingLike[];
  other_holdings?: PlacedHoldingLike[];
};

/** The shared resolver over a books row: `resolvePlacement` decides, as everywhere. */
function bookPlacementFor(item: BookPlacementRow): PlacementResolution {
  return resolvePlacement({
    itemType: 'book',
    customFields: item.custom_fields ?? null,
    holdings: item.placed_holdings,
    otherHoldings: item.other_holdings,
  });
}

/**
 * The one NULL-kind Site type that is the warehouse's own BUILDING (such as
 * DC4) rather than a place in it. The Items layout's rule (owner report
 * 2026-09-24), in its two list paths: loaders/inventory-list.ts and
 * InventoryService.placementBreakdown turn a NULL kind of this type into the
 * 'site' line that reads "No rack", and any other NULL-kind place into a
 * 'location' line that prints its name. inventory-list.test.ts pins the Books
 * cell to the loader's lines for every type.
 */
const SITE_BUILDING_TYPE = 'warehouse';

/** A books row's Sites, split by the Items layout's rule above. */
export interface BookSites {
  /** The warehouse's own building(s): not a rack. The cell says "No rack",
   *  and the header counts the row as unset. */
  buildings: string[];
  /** Every other Site (a room, a vehicle, a job site, a place with no type):
   *  a place. The cell prints its name and the header counts it. */
  places: string[];
}

function splitSites(holdings: readonly PlacedHoldingLike[]): BookSites {
  const buildings = new Set<string>();
  const places = new Set<string>();
  for (const h of holdings) (h.type === SITE_BUILDING_TYPE ? buildings : places).add(h.name);
  const sorted = (names: Set<string>) => [...names].sort((a, b) => a.localeCompare(b));
  return { buildings: sorted(buildings), places: sorted(places) };
}

/**
 * The Sites a books row's stock all sits on (core rule 0c, B37), each list
 * sorted and distinct, or null when its stock is not wholly on Sites.
 */
export function bookSitesFor(item: BookPlacementRow): BookSites | null {
  const res = bookPlacementFor(item);
  return res.source === 'holdings' && res.reason === 'site' ? splitSites(res.holdings) : null;
}

/**
 * The same answer as `bookRackLabelFor`, UN-JOINED — one entry per physical
 * place, sorted.
 *
 * The SKU-group header counts DISTINCT RACKS across the rows it collapses, and
 * that is not the same number as distinct LABELS the moment one row is split:
 * "39-B, 5-A" is ONE label and TWO racks. Rolling up the composed strings made
 * the header announce "1 rack" directly above its own tooltip naming two. So
 * the header counts these, and only joins for display.
 */
export function bookRackNamesFor(item: BookPlacementRow): string[] {
  const res = bookPlacementFor(item);
  // Stock wholly on Sites (B37), counted as the Items header counts the same
  // lines: the warehouse's own building is not a rack (owner report
  // 2026-09-24, "No rack"), so it names nothing and the row reads as unset
  // rather than as a rack called "DC4"; a room, a vehicle or a job site is a
  // place and counts by its name.
  if (res.source === 'holdings' && res.reason === 'site') return splitSites(res.holdings).places;
  return placementPhysicalNames(res);
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
 * The 34 px thumbnail a row or a header shows (DESIGN-SPEC 6.9, 6.14), inside
 * its hover preview (title, SKU or label, "On hand N").
 *
 * Images as they always were: the pre-sized ~200 px thumb (item_images
 * .thumb_path, 0122) is served as it is, never through /_next/image, whose
 * cache is PER DEPLOYMENT (the first viewer after every deploy paid ~30 cold
 * transforms of ~750 ms each and the page "loaded" for 8-15 s, owner report
 * 2026-07-06); only a legacy row that has just the master goes through the
 * optimizer, which genuinely downscales it. The first rows of a page load
 * with `priority` (they are above the fold), the 16x16 LQIP paints a hint of
 * the photo at once, the missing-photo hatch stands in for no photo, and the
 * 2,048 px master loads only on hover intent (on demand for payload-diet rows
 * that carry the thumb alone).
 *
 * A photo that fails to load (an expired signed address, a deleted file, an
 * imported cover whose host is down) shows that same hatch, with no hover
 * preview, exactly as a row with no photo does; it used to leave the 34 px
 * tile empty. CardPhoto's rule (below): the failed address is remembered, so
 * a new one (a refresh signs the photos again) gets a fresh attempt, and
 * because next/image is given an onError it sets the address once more after
 * hydration, so a photo that failed before the page came alive is caught too.
 */
function ListThumb({
  photo,
  alt,
  title,
  subtitle,
  meta,
  priority,
}: {
  /** The record whose photo shows: the row's own, or a header's cover. */
  photo: Item | null;
  alt: string;
  title: string;
  subtitle: string;
  meta: React.ReactNode;
  priority?: boolean;
}) {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const thumbSrc = photo ? (photo.image_thumb_url ?? photo.image_url) : null;
  // The photo did not load: the hatch, and no preview of it.
  const shown = photo && thumbSrc && failedSrc !== thumbSrc ? photo : null;
  return (
    <ImageHoverPreview
      src={shown?.image_url ?? null}
      // Diet rows: master on demand (org-scoped route, same 25-day-stable URL
      // the row used to carry).
      srcLoader={
        shown && !shown.image_url && shown.image_thumb_url
          ? () => loadMasterImageUrl(shown.id)
          : undefined
      }
      alt={alt}
      title={title}
      subtitle={subtitle}
      meta={meta}
      className="shrink-0"
    >
      <Thumb size={34}>
        {shown && thumbSrc ? (
          <Image
            src={thumbSrc}
            unoptimized={!!shown.image_thumb_url}
            alt=""
            width={68}
            height={68}
            sizes="34px"
            priority={priority}
            placeholder={shown.image_lqip ? 'blur' : 'empty'}
            blurDataURL={shown.image_lqip ?? undefined}
            onError={() => setFailedSrc(thumbSrc)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : undefined}
      </Thumb>
    </ImageHoverPreview>
  );
}

/** Whether a record has a photo to show (its thumb, or the master for a legacy row). */
function hasPhoto(photo: Item | null): photo is Item {
  return !!photo && !!(photo.image_thumb_url ?? photo.image_url);
}

/**
 * A grid card's photo: the SAME thumb the row shows (never a master: O1),
 * uncropped in the card's fixed square, with the row's hover preview and
 * loading rules (ListThumb above). No photo: null, and the card draws the
 * missing-photo hatch.
 *
 * A photo that fails to load (an expired signed address, a deleted file, an
 * imported cover whose host is down) shows that same hatch, with no hover
 * preview, exactly as a card with no photo does. Before R8 it left the
 * square empty: a blank card. The failed address is remembered, so a new
 * one (a refresh signs the photos again) gets a fresh attempt without an
 * effect resetting state. Because next/image is given an onError, it sets
 * the address once more after hydration, so a cover that failed before the
 * page came alive (the first cards fetch with the HTML) reports its error
 * too. Which photos go through the optimizer is unchanged (ListThumb's rule).
 */
function CardPhoto({
  photo,
  title,
  subtitle,
  meta,
  priority,
}: {
  photo: Item | null;
  title: string;
  subtitle: string;
  meta: React.ReactNode;
  priority?: boolean;
}) {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const thumbSrc = photo ? (photo.image_thumb_url ?? photo.image_url) : null;
  if (!photo || !thumbSrc) return null;
  if (failedSrc === thumbSrc) return <MissingPhoto className="absolute inset-0" />;
  return (
    <ImageHoverPreview
      src={photo.image_url ?? null}
      srcLoader={
        !photo.image_url && photo.image_thumb_url ? () => loadMasterImageUrl(photo.id) : undefined
      }
      alt={title}
      title={title}
      subtitle={subtitle}
      meta={meta}
      className="absolute inset-0"
    >
      <Image
        src={thumbSrc}
        unoptimized={!!photo.image_thumb_url}
        alt=""
        width={200}
        height={200}
        sizes="(max-width: 640px) 50vw, 240px"
        priority={priority}
        placeholder={photo.image_lqip ? 'blur' : 'empty'}
        blurDataURL={photo.image_lqip ?? undefined}
        onError={() => setFailedSrc(thumbSrc)}
        style={{ objectFit: 'contain' }}
        className="h-full w-full object-contain"
      />
    </ImageHoverPreview>
  );
}

/** "On hand N" under a hover preview's title (a partial total keeps its "*"). */
function OnHandMeta({
  value,
  title,
  partial = false,
}: {
  value: number;
  /** Why the figure may be partial (a header whose records span pages). */
  title?: string;
  partial?: boolean;
}) {
  return (
    <span>
      On hand{' '}
      <span className="text-foreground font-medium tabular-nums" title={title}>
        {formatNumber(value)}
      </span>
      {partial && (
        <span aria-hidden className="text-muted-foreground ml-0.5">
          *
        </span>
      )}
    </span>
  );
}

/** The italic "Multiple" a header prints for a value its records do not share. */
function MultipleLabel({ title }: { title: string }) {
  return (
    <span className="text-muted-foreground text-[12px] italic" title={title}>
      Multiple
    </span>
  );
}

const SKU_PARTIAL_TITLE =
  'This total only counts placements on the current page — other pages may hold more of this SKU.';
const GROUP_PARTIAL_TITLE =
  'This total only counts records on the current page — other pages may hold more of this group.';

/**
 * Everything a SKU or named-group header shows, derived once for its row
 * (Table) and its card (Grid), so both read the same.
 *
 * Only IDENTITY fields come from the FIRST placement (first-seen order — see
 * group-by-sku.ts): a SKU is one product identity (mig 0234 makes (org, sku,
 * charter_id, bin_location) the uniqueness key), so name and cover image are
 * shared by construction. Every field that is genuinely PER-ROW — status,
 * charter, category, primary location, and the books grade/rack/crate — is
 * rolled up instead, because showing one placement's value as if it were the
 * group's is exactly the masking bug rollupStatus exists to prevent.
 *
 * WHAT A HEADER DERIVES EACH VALUE FROM (settled once, applied to every cell):
 * a collapsed header is a SUMMARY OF THE ROWS IT EXPANDS TO, so every cell
 * mirrors the SAME source its body-row counterpart reads:
 *   • the ON-HAND NUMBER mirrors the body's quantity cell → sum of
 *     rowDisplayQuantity over the PLACEMENT rows (honours the placed-only
 *     toggle and the one-line-per-rack split).
 *   • the HEALTH cells — status badge, coverage bar, sparkline — mirror the
 *     body's health cells, which read the ITEM's on-hand minus reserved
 *     (`availableForStatus`), independent of the toggle and identical on every
 *     rack row of one item. They therefore sum over DISTINCT ITEMS: summing
 *     placement rows would count one item's on-hand once per rack, and
 *     following the toggle would let a header badge "Out of stock" over rows
 *     all badging "In stock".
 *   • every genuinely per-row TEXT field is rolled up (Multiple / a count / an
 *     em dash) — never taken from one placement.
 */
function skuHeaderFacts({
  items,
  explicit,
  stockView,
  reservedByItem,
  lookups,
}: {
  items: Item[];
  explicit: boolean;
  stockView: StockView;
  reservedByItem?: Map<string, number>;
  lookups: Lookups;
}) {
  const first = items[0]!;
  const distinctItems = Array.from(new Map(items.map((it) => [it.id, it])).values());
  const availableOf = (it: Item): number =>
    Math.max(0, it.quantity_on_hand - (reservedByItem?.get(it.id) ?? 0));
  const displayedTotal = items.reduce((sum, it) => sum + rowDisplayQuantity(it, stockView), 0);
  const healthQuantity = distinctItems.reduce((sum, it) => sum + availableOf(it), 0);
  // reorder_point is per-row too, and taking `first`'s let the
  // quantity-derived badge read HEALTHIER than the group's worst placement —
  // the exact masking rollupStatus exists to prevent. Roll it up as the SUM:
  // the group's replenishment need is the sum of its placements' needs, which
  // puts threshold and quantity on the same (group) scale. It is also the only
  // rollup that guarantees the header can never out-rank a UNANIMOUS reading —
  // if every placement is low then Σqty ≤ Σreorder, and if every placement is
  // out then Σqty ≤ 0. A MIXED group falls back to the honest aggregate, the
  // same every()-not-some() rule the lifecycle flags below follow.
  const groupReorderPoint = distinctItems.reduce(
    (sum, it) => sum + (Number(it.reorder_point) || 0),
    0,
  );
  const status = deriveStatus(healthQuantity, groupReorderPoint);
  // The coverage bar's PAR must be built from the same inputs the body rows
  // use, or the header fills to a different fraction than the rows it
  // summarises. A body row computes
  //   par = max(reorder_point × 4, quantity_on_hand × 1.5, 10)
  // — note the third term is ON-HAND, NOT available (on-hand − reserved), even
  // though the BAR's fill is available. Substituting `healthQuantity` here
  // shrank the header's par wherever stock is reserved (the rentals view), so
  // an identical group read fuller in the header than in its own rows. Sum
  // on-hand over DISTINCT ITEMS for the same reason `healthQuantity` does: an
  // item's on-hand is repeated on each of its placement rows.
  const parQuantity = distinctItems.reduce(
    (sum, it) => sum + (Number(it.quantity_on_hand) || 0),
    0,
  );
  const par = Math.max(groupReorderPoint * 4, parQuantity * 1.5, 10);
  // category_id / primary_location_id are per-row and CAN differ across a
  // SKU's placements (books imported by different POs land in different book
  // categories; placements can sit at different sites). Roll up rather than
  // taking `first` — same class of bug as the charter column, which already
  // had this right.
  const categoryRollup = rollupText(items.map((it) => it.category_id));
  const category =
    categoryRollup.kind === 'same' ? lookups.categories.get(categoryRollup.value) : null;
  const locationRollup = rollupText(items.map((it) => it.primary_location_id));
  const location =
    locationRollup.kind === 'same' ? lookups.locations.get(locationRollup.value) : null;
  const distinctCharterIds = new Set(items.map((it) => it.charter_id ?? ''));
  // The picture. A SKU header shows its first placement's (one product
  // identity, see above). A group's header shows the FIRST record, in the order
  // it lists them (`items`, the rows it expands to), that has a picture, and
  // its hover preview shows that same record's master. The people review (P5)
  // had it show none; the owner overruled that on 2026-10-12 ("it should just
  // use the first picture of whatever was chosen for the grouping"): an empty
  // header read as the picture having disappeared. No picture anywhere in the
  // group keeps the placeholder. core groupCoverRow is the phone's rule too.
  const cover: Item | null = explicit
    ? groupCoverRow(items, (it) => it.image_thumb_url ?? it.image_url)
    : first;
  // `status` is a PER-PLACEMENT field — placements of one SKU can legitimately
  // differ (e.g. one discontinued at a site while others stay active). Never
  // take just the first placement's status here: that can mask a
  // discontinued/archived placement behind a healthy badge for the whole
  // group. Roll up conservatively instead (see group-by-sku.ts).
  const rolledUpStatus = rollupStatus(distinctItems.map((it) => it.status));
  // LIFECYCLE FLAGS (migs 0277 / 0266) are per-placement too, and the header
  // dropped both — so in the Expected view (?expected=1) a title whose rows ALL
  // await their first receipt collapsed into one "Out of stock" badge, inside
  // the very view that exists to show expected stock; and in the Archived view
  // an auto-archived group read as a plain "Archived".
  // ROLLUP RULE — every(), not some(), for both. These are the only two flags
  // that make a zero-quantity group read as SOFTER than "out of stock" /
  // "archived by a person". A group where only SOME rows await a first receipt
  // has real received stock on the others, so an "Expected" pill would be the
  // more-flattering, less-true reading — exactly what rollupStatus refuses to
  // do. Requiring every() means the pill appears only when it is unambiguously
  // the whole truth, and a mixed group falls back to the ordinary
  // quantity-derived badge — never anything healthier than its worst
  // placement.
  const allAwaitingFirstReceipt = distinctItems.every((it) => it.awaiting_first_receipt === true);
  const allAutoArchived = distinctItems.every((it) => it.auto_archived === true);
  return {
    first,
    distinctItems,
    availableOf,
    displayedTotal,
    healthQuantity,
    groupReorderPoint,
    status,
    par,
    categoryRollup,
    category,
    locationRollup,
    location,
    distinctCharterIds,
    cover,
    rolledUpStatus,
    allAwaitingFirstReceipt,
    allAutoArchived,
  };
}

/** A header's charter cell: "Multiple" when its rows differ, else the shared one. */
function HeaderCharterContent({
  first,
  distinctCharterIds,
  lookups,
  multipleTitle,
}: {
  first: Item;
  distinctCharterIds: Set<string>;
  lookups: Lookups;
  multipleTitle: string;
}) {
  if (distinctCharterIds.size > 1) return <MultipleLabel title={multipleTitle} />;
  if (first.charter_id) {
    const charter = lookups.charters?.get(first.charter_id) ?? null;
    return charter ? (
      <span className="text-[var(--ed-ink-2)]" title={charter.name}>
        {charter.code ?? charter.name}
      </span>
    ) : (
      <span className="text-muted-foreground text-[12px] italic">{GENERIC_CHARTER_LABEL}</span>
    );
  }
  return (
    <span
      className="text-muted-foreground text-[12px] italic"
      title="Generic stock — any charter serviced by this warehouse can use it"
    >
      {GENERIC_CHARTER_LABEL}
    </span>
  );
}

/** A SKU header's SKU cell; a named group's rolls its records' SKUs up. */
function HeaderSkuContent({
  items,
  explicit,
  sku,
}: {
  items: Item[];
  explicit: boolean;
  sku: string;
}) {
  if (!explicit) return <>{sku}</>;
  // The records of a display group keep their own SKUs (that is the point: no
  // identifier is rewritten to group them).
  const skus = rollupText(items.map((it) => it.sku));
  return skus.kind === 'same' ? (
    <>{skus.value}</>
  ) : (
    <span
      className="text-muted-foreground font-sans text-[12px] italic"
      title="These records keep their own SKUs — expand to see each"
    >
      Multiple
    </span>
  );
}

/**
 * The Items layout's RACK cell on a header: the body rows print the rack/crate
 * label(s) each row sits in. The header printed `items.length`, a count of
 * placement ROWS labelled "locations", so three rows sharing two racks read "3
 * locations" while expanding showed two. Count DISTINCT labels (same fix as the
 * books Rack cell), and give rows with no rack at all their own explicit tail
 * rather than counting them as a location that doesn't exist.
 */
function ItemsHeaderRackContent({
  items,
  distinctItems,
  table = false,
}: {
  items: Item[];
  distinctItems: Item[];
  /** The table: the count may break before its "+N unset" tail (RackCountPhrase). */
  table?: boolean;
}) {
  const labels = Array.from(new Set(items.flatMap(itemRackLabels)));
  // The "In other warehouses" line (0371) names no rack, but it is not a
  // placement with NO rack set either: it is stock the viewer cannot see, and
  // it gets its own count below instead of "+1 unset".
  const unset = items.filter(
    (it) => it.placement_kind !== ELSEWHERE_PLACEMENT_KIND && itemRackLabels(it).length === 0,
  ).length;
  const elsewhereTail = <ElsewhereTail items={distinctItems} />;
  if (labels.length === 0) {
    return (
      <>
        {unset > 0 || !hasElsewhere(distinctItems) ? (
          <span className="text-muted-foreground">—</span>
        ) : null}
        {elsewhereTail}
      </>
    );
  }
  if (labels.length === 1 && unset === 0) {
    return (
      <>
        <span className="font-mono tabular-nums">{labels[0]}</span>
        {elsewhereTail}
      </>
    );
  }
  return (
    <>
      <span
        title={`Placements span: ${labels.join(', ')}${
          unset > 0 ? ` (+${unset} with no rack set)` : ''
        }`}
      >
        {table ? (
          <RackCountPhrase
            count={`${labels.length} location${labels.length === 1 ? '' : 's'}`}
            unset={unset}
          />
        ) : (
          <>
            {labels.length} location{labels.length === 1 ? '' : 's'}
            {unset > 0 ? ` +${unset} unset` : ''}
          </>
        )}
      </span>
      {elsewhereTail}
    </>
  );
}

/**
 * A header's count in the table's Rack cell ("2 locations +1 unset", "1 rack
 * +2 unset"). The cell may wrap, but only before the "+N unset" tail: each part
 * stays whole, so it never reads "2" over "locations". The words are the
 * Grid's, unchanged.
 */
function RackCountPhrase({ count, unset }: { count: string; unset: number }) {
  return (
    <>
      <span className="whitespace-nowrap">{count}</span>
      {unset > 0 ? (
        <>
          {' '}
          <span className="whitespace-nowrap">+{unset} unset</span>
        </>
      ) : null}
    </>
  );
}

/**
 * The Books layout's three header cells (Grade, Rack, Crate). The body row
 * emits THREE cells there, so the header must too or every cell right of
 * Location shifts one column. Each is rolled up, never taken from `first`:
 * these live in custom_fields PER inventory_items row and can genuinely differ
 * across a SKU's placements (one row graded during a PO import, its sibling
 * graded by hand).
 */
function booksHeaderContent(
  items: Item[],
  distinctItems: Item[],
  /** The table: the rack count may break before its "+N unset" tail. */
  { table = false }: { table?: boolean } = {},
) {
  const storages = items.map((it) => readBookStorage(it.custom_fields));
  const grade = rollupText(storages.map((s) => s.grade));
  // Rolled up from the RESOLVED label, not the raw custom_fields one —
  // otherwise the collapsed header names a rack that its own expanded rows
  // (which resolve) no longer show. Kept as NAMES per row, because the count
  // below is a count of racks and a split row carries two of them inside one
  // label.
  const rackNames_ = items.map(bookRackNamesFor);
  const rackLabels_ = rackNames_.map((names) => (names.length > 0 ? names.join(', ') : null));
  const rack = rollupText(rackLabels_);
  // Colour is only a visual aid attached to a crate NUMBER, so both must agree
  // before a swatch is drawn — a coloured dot for a group whose placements sit
  // in different crates sends staff to the wrong crate.
  const crate = rollupText(
    storages.map((s) => (s.crateNumber ? `${s.crateColor ?? ''}|${s.crateNumber}` : null)),
  );
  // `crate.value` is only a comparison KEY — read the display values back off
  // the first placement rather than splitting it, so a crate number that ever
  // contains the '|' separator can't render a truncated number.
  // kind==='same' guarantees every placement carries this exact colour +
  // number.
  const crateColor = crate.kind === 'same' ? getCrateColor(storages[0]?.crateColor) : null;
  const crateNumber = crate.kind === 'same' ? (storages[0]?.crateNumber ?? '') : '';
  // Every DISTINCT rack present. The count below is a count of RACKS, not of
  // placements and not of LABELS: three placements sharing two racks is "2
  // racks", and printing items.length there said "3 racks" while this very
  // tooltip listed only two. Counting the composed labels had the mirror-image
  // fault — a single split placement's "39-B, 5-A" counted once, so the header
  // said "1 rack" above a tooltip naming two.
  const rackNames = Array.from(new Set(rackNames_.flat()));
  // Placements with no rack set at all are not a rack — counting them into "N
  // racks" would send staff looking for a shelf that doesn't exist, so they
  // get their own explicit "unset" tail.
  const rackUnset = rackNames_.filter((names) => names.length === 0).length;
  const rackCountLabel = `${rackNames.length} rack${rackNames.length === 1 ? '' : 's'}${
    rackUnset > 0 ? ` +${rackUnset} unset` : ''
  }`;
  const gradeContent =
    grade.kind === 'same' ? (
      <span className="font-mono">
        {/^\d{1,2}$/.test(grade.value) ? `Gr ${grade.value}` : grade.value}
      </span>
    ) : grade.kind === 'multiple' ? (
      <MultipleLabel title="Placements span multiple grades — expand to see each" />
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  // Rack is the books layout's analogue of the items "N locations" cell — and
  // the field the owner physically walks to. When every placement agrees the
  // concrete label is strictly more useful than a count; when they differ a
  // COUNT (never one placement's rack) is the only honest value, and it
  // preserves the how-many-placements information the items header carries.
  const rackContent = (
    <>
      {rack.kind === 'same' ? (
        <span className="font-mono tabular-nums">{rack.value}</span>
      ) : rack.kind === 'multiple' ? (
        <span
          title={
            rackNames.length > 0
              ? `Placements span: ${rackNames.join(', ')}${
                  rackUnset > 0 ? ` (+${rackUnset} with no rack set)` : ''
                }`
              : 'Placements span multiple racks — expand to see each'
          }
        >
          {table ? (
            <RackCountPhrase
              count={`${rackNames.length} rack${rackNames.length === 1 ? '' : 's'}`}
              unset={rackUnset}
            />
          ) : (
            rackCountLabel
          )}
        </span>
      ) : hasElsewhere(distinctItems) ? null : (
        <span className="text-muted-foreground">—</span>
      )}
      {/* 0371: the members' stock in warehouses the viewer cannot see. */}
      <ElsewhereTail items={distinctItems} />
    </>
  );
  const crateContent =
    crate.kind === 'same' ? (
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          title={crateColor ? crateColor.label : 'No color set'}
          className="inline-block h-2.5 w-2.5 rounded-full border border-[var(--ed-line-strong)]"
          style={crateColor ? { backgroundColor: crateColor.hex } : undefined}
        />
        <span className="font-mono tabular-nums">{crateNumber}</span>
      </span>
    ) : crate.kind === 'multiple' ? (
      <MultipleLabel title="Placements sit in different crates — expand to see each" />
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  return { gradeContent, rackContent, crateContent };
}

/** The 24 x 24 chevron that opens and closes a header (6.21), with its name. */
function HeaderChevron({
  expanded,
  onToggle,
  label,
}: {
  expanded: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={label}
      className={cn(
        touchTargetClass,
        'text-muted-foreground hover:bg-muted hover:text-foreground grid size-6 shrink-0 place-items-center rounded-md transition-colors',
      )}
    >
      <ChevronRight
        aria-hidden
        strokeWidth={1.8}
        className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-90')}
      />
    </button>
  );
}

/** Body cells pad top and bottom by the density's row padding (`--row-py`, 16 / 12). */
const ROW_PY = 'py-[var(--row-py)]';

/**
 * Each column's side padding. The header cell and the body cell of every row
 * kind take it from here, so a label always stands over its figures.
 *
 * Items: 12 px a side inside the table (DESIGN-SPEC 6.9), with On hand,
 * 14-day and Status trimmed to what they hold (owner decision 2026-10-19: no
 * extra space there). On hand and 14-day are right-aligned, so 4 px on their
 * left is enough beside the column before them; Status keeps its 12 px from
 * the trend and gives 4 px to Updated, which pads its own left 12 and keeps
 * 16 at the table's edge.
 *
 * Books shows two more columns (Grade, Rack and Crate where Items has Rack),
 * so every inner column there pads 8 px a side, 16 px between neighbours, and
 * the trimmed columns keep their 4 px sides. With the Item and Location floors
 * below, that keeps the Books table inside a 1440 screen with every column,
 * word and state on it (owner decision 2026-10-19), Out of stock and "59
 * seconds ago" in the same row and the 14-day toggle on "moves" included. The
 * Item cell pads 12 and Updated 12 and 16 on both.
 */
function columnPad(label: string, books: boolean): string {
  switch (label) {
    case 'Item':
      return 'px-3';
    case 'On hand':
    case '14-day':
      return books ? 'pl-1 pr-2' : 'pl-1 pr-3';
    case 'Status':
      return books ? 'pl-2 pr-1' : 'pl-3 pr-1';
    case 'Updated':
      return 'pl-3 pr-4';
    default:
      return books ? 'px-2' : 'px-3';
  }
}

/** A body cell of the `label` column, in every row kind: its side padding and the row padding. */
function columnTd(label: string, books: boolean): string {
  return `${columnPad(label, books)} ${ROW_PY}`;
}

/**
 * The Item cell of every row kind (DESIGN-SPEC 6.9 Item recipe; owner decision
 * 2026-10-19): the thumb, the name with its badge and chip, then the SKU on a
 * mono line of its own. On Items the 220 px floor leaves about 150 px beside
 * the thumb for the name, so a name of up to about 44 characters takes two
 * lines at most there; Books, with two more columns, has a 208 px floor
 * (about 138 px, some 40 characters in two lines). The column grows past the
 * floor when the screen has room. The name and the SKU (wrapSku) wrap inside
 * the column; what cannot break (a size badge, a chip, an action) can still
 * make it wider.
 */
function itemTd(books: boolean): string {
  return cn(books ? 'min-w-[208px]' : 'min-w-[220px]', columnTd('Item', books));
}

/**
 * A row's or a header's name. It wraps between words and is never cut: every
 * word stays on screen. A word longer than the column (a part number, a URL)
 * breaks inside the column instead of widening it.
 */
const ITEM_NAME_LINK = 'text-foreground font-medium hover:underline [overflow-wrap:anywhere]';

/**
 * Location: a site name wraps between its words. The floor keeps 64 px for
 * the name inside the column's padding on both tables (88 on Items, 80 on
 * Books), so a short site name such as "North DC" stays on one line.
 */
function locationTd(books: boolean): string {
  return cn(
    columnTd('Location', books),
    books ? 'min-w-[80px]' : 'min-w-[88px]',
    'text-[13px] text-[var(--ed-ink-2)]',
  );
}

/**
 * Rack (Items and Books): the cell may wrap between words ("+3 in other
 * warehouses", "In other warehouses"), while a rack or crate label (mono), an
 * amber "No rack" or staging label, and each part of a header's count ("2
 * locations", "+1 unset") stay whole.
 */
const RACK_TD =
  'text-[12.5px] text-[var(--ed-ink-2)] [&_.font-mono]:whitespace-nowrap [&_.text-warning]:whitespace-nowrap';

/** The On hand figure. Only the figure is mono; the notes under it are not. */
const ON_HAND_FIGURE = 'font-mono text-[13.5px] font-medium tabular-nums';

/** Status: an Archived and Auto-archived pair stacks in a narrow column (each pill stays whole). */
const STATUS_WRAP = '[&>div:has(>div)]:flex-wrap';

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
  explicit,
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
  /** Books layout renders 13 columns (Grade/Rack/Crate) where Items
   *  renders 11 (one Rack column) — the header must emit the SAME cell
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
  /**
   * Group selected (0400): render this header for an EXPLICIT display group
   * instead of a SKU: its name and record count in the name cell, the SKUs
   * rolled up (they differ by design), "N matching" under a search or filter,
   * and Rename / Remove when the viewer can edit items. Every figure is still
   * derived from `items`, the rows it expands to.
   */
  explicit?: {
    groupId: string;
    name: string;
    matching: boolean;
    onRename?: () => void;
    onRemove?: () => void;
  };
}) {
  const f = skuHeaderFacts({
    items,
    explicit: !!explicit,
    stockView,
    reservedByItem,
    lookups,
  });
  const { first, distinctItems } = f;
  // The sparkline is the group's series, not one placement's. Plotting
  // `first`'s 14-day trend beside a SUMMED number presented one member's
  // history as the whole group's; sum the members' series element-wise
  // instead so the curve and the number describe the same scope.
  const series = (() => {
    const members = distinctItems.map((it) =>
      seriesForRow(it.id, f.availableOf(it), sparkMode, trends),
    );
    const len = members.reduce((n, s) => Math.max(n, s.length), 0) || 14;
    return Array.from({ length: len }, (_, i) => members.reduce((sum, s) => sum + (s[i] ?? 0), 0));
  })();
  const count = explicit ? GROUP_COPY.headerCount(distinctItems.length, explicit.matching) : '';
  const partialTitle = group.totalIsPartial
    ? explicit
      ? GROUP_PARTIAL_TITLE
      : SKU_PARTIAL_TITLE
    : undefined;
  // Each body cell pads like its column's header cell (columnPad).
  const td = (label: string) => columnTd(label, showBookFields);

  return (
    <tr
      data-row-kind="header"
      data-group-key={explicit ? `display-group:${explicit.groupId}` : `sku-group:${group.sku}`}
      className="border-border bg-sunk hover:bg-muted border-b transition-colors last:border-0"
    >
      {/* Not selectable — no checkbox (bulk actions target placements). */}
      <td className="w-10 py-[var(--row-py)] pl-4 pr-0" />
      <td className={itemTd(showBookFields)}>
        {/* The header's name, then its SKU line: the shared SKU on a SKU
            header; on a named group's, the SKU its records share or "Multiple"
            (they keep their own). Rename and Remove come last, on a line that
            may wrap between them. */}
        <ItemCell
          wrapSku
          thumb={
            <>
              <HeaderChevron
                expanded={expanded}
                onToggle={onToggle}
                label={
                  explicit
                    ? `${expanded ? 'Collapse' : 'Expand'} group ${explicit.name} (${count})`
                    : `${expanded ? 'Collapse' : 'Expand'} ${group.sku} (${items.length} placements)`
                }
              />
              <ListThumb
                // `cover`: the first placement's picture on a SKU header, the first
                // record's with a picture on a group's (owner 2026-10-12,
                // overruling P5's "no cover"). A thumb-only row fetches its master
                // on hover, from that same record.
                photo={f.cover}
                alt={explicit ? explicit.name : first.name}
                title={explicit ? explicit.name : first.name}
                subtitle={explicit ? count : group.sku}
                priority={rowIdx < 12}
                meta={
                  <OnHandMeta
                    value={f.displayedTotal}
                    title={partialTitle}
                    partial={!!group.totalIsPartial}
                  />
                }
              />
            </>
          }
          name={
            explicit ? (
              <span className="[overflow-wrap:anywhere]">{explicit.name}</span>
            ) : (
              <Link
                href={`${rowLinkPrefix}/${first.id}?return=${encodeURIComponent(currentListUrl)}`}
                prefetch={false}
                className={ITEM_NAME_LINK}
              >
                {first.name}
              </Link>
            )
          }
          badge={
            explicit ? <span className="text-muted-foreground text-[12px]">{count}</span> : null
          }
          sku={<HeaderSkuContent items={items} explicit={!!explicit} sku={group.sku} />}
          actions={
            explicit && (explicit.onRename || explicit.onRemove) ? (
              <>
                {explicit.onRename ? (
                  <button
                    type="button"
                    onClick={explicit.onRename}
                    aria-label={GROUP_COPY.renameFor(explicit.name)}
                    className={cn(touchTargetClass, chipActionClass, 'shrink-0 whitespace-nowrap')}
                  >
                    {GROUP_COPY.renameAction}
                  </button>
                ) : null}
                {explicit.onRemove ? (
                  <button
                    type="button"
                    onClick={explicit.onRemove}
                    aria-label={GROUP_COPY.removeFor(explicit.name)}
                    className={cn(touchTargetClass, chipActionClass, 'shrink-0 whitespace-nowrap')}
                  >
                    {GROUP_COPY.removeAction}
                  </button>
                ) : null}
              </>
            ) : null
          }
        />
      </td>
      <td className={td('Category')}>
        {f.categoryRollup.kind === 'multiple' ? (
          <MultipleLabel title="Placements span multiple categories — expand to see each" />
        ) : (
          <CategoryLabel category={f.category} wrap />
        )}
      </td>
      <td className={cn(td('Charter'), 'whitespace-nowrap text-[13px]')}>
        <HeaderCharterContent
          first={first}
          distinctCharterIds={f.distinctCharterIds}
          lookups={lookups}
          multipleTitle="Placements span multiple charters — expand to see each"
        />
      </td>
      <td className={locationTd(showBookFields)}>
        {f.locationRollup.kind === 'multiple' ? (
          <MultipleLabel title="Placements span multiple sites — expand to see each" />
        ) : (
          // Plain em dash in the same token the BODY row's Location cell uses,
          // so a collapsed group and its expanded placements read identically.
          (f.location?.name ?? '—')
        )}
      </td>
      {!showBookFields && (
        <td className={cn(td('Rack'), RACK_TD)}>
          <ItemsHeaderRackContent items={items} distinctItems={distinctItems} table />
        </td>
      )}
      {showBookFields &&
        (() => {
          const books = booksHeaderContent(items, distinctItems, { table: true });
          return (
            <>
              <td
                className={cn(
                  td('Grade'),
                  'whitespace-nowrap text-[12.5px] text-[var(--ed-ink-2)]',
                )}
              >
                {books.gradeContent}
              </td>
              <td className={cn(td('Rack'), RACK_TD)}>{books.rackContent}</td>
              <td
                className={cn(
                  td('Crate'),
                  'whitespace-nowrap text-[12.5px] text-[var(--ed-ink-2)]',
                )}
              >
                {books.crateContent}
              </td>
            </>
          );
        })()}
      <td
        className={cn(td('On hand'), 'text-right')}
        // A named group's records are not placements of one SKU: its own
        // words, as its hover card already said (they used to read "of this
        // SKU" here too).
        title={partialTitle}
      >
        {/* The "*" stays with the figure it marks. */}
        <span className={ON_HAND_FIGURE}>
          {formatNumber(f.displayedTotal)}
          {group.totalIsPartial && (
            <span aria-hidden className="text-muted-foreground ml-0.5">
              *
            </span>
          )}
        </span>
      </td>
      <td className={td('Coverage')}>
        <StockBar stock={f.healthQuantity} par={f.par} status={f.status} />
      </td>
      <td className={cn(td('14-day'), 'text-right')}>
        <Sparkline data={series} width={56} height={18} />
      </td>
      <td className={cn(td('Status'), STATUS_WRAP)}>
        <StockStatusBadge
          quantity={f.healthQuantity}
          reorderPoint={f.groupReorderPoint}
          itemStatus={f.rolledUpStatus}
          autoArchived={f.allAutoArchived}
          awaitingFirstReceipt={f.allAwaitingFirstReceipt}
        />
      </td>
      <td className={cn(td('Updated'), 'text-muted-foreground text-right text-[12.5px]')}>—</td>
    </tr>
  );
}

/**
 * Everything a size-run header shows (its row and its Grid card read it
 * alike). A STORED group knows what it is and what it counts in, so its header
 * reads "3 variants · 18 pairs total". A name-derived run knows neither — its
 * "sizes" are tokens parsed out of a display string — so it keeps the older,
 * weaker claim. Byte-identical for every ungrouped org.
 */
function styleHeaderFacts(
  group: SizeRunGroup<RenderEntry>,
  items: Item[],
  lookups: Lookups,
  /** The table: the rack count may break before its "+N unset" tail. */
  { table = false }: { table?: boolean } = {},
) {
  const first = items[0]!;
  const status = deriveStatus(group.total, first.reorder_point);
  const par = Math.max(first.reorder_point * 4, group.total * 1.5, 10);
  const category = first.category_id ? lookups.categories.get(first.category_id) : null;
  const location = first.primary_location_id
    ? lookups.locations.get(first.primary_location_id)
    : null;
  const distinctCharterIds = new Set(items.map((it) => it.charter_id ?? ''));
  // Status is per-member and can differ; roll up conservatively (see group-by-sku).
  const rolledUpStatus = rollupStatus(items.map((it) => it.status));
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
  // compute holdings, exactly as the member rows do.
  const rackNames: string[] = [];
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
    for (const label of placed) if (!rackNames.includes(label)) rackNames.push(label);
  }
  const rackCountLabel = `${rackNames.length} rack${rackNames.length === 1 ? '' : 's'}${
    rackUnset > 0 ? ` +${rackUnset} unset` : ''
  }`;
  const rackContent =
    rackNames.length === 0 ? (
      <span className="text-muted-foreground">—</span>
    ) : rackNames.length === 1 && rackUnset === 0 ? (
      <span className="font-mono tabular-nums">{rackNames[0]}</span>
    ) : (
      <span
        title={`Placements span: ${rackNames.join(', ')}${
          rackUnset > 0 ? ` (+${rackUnset} with no rack set)` : ''
        }`}
      >
        {table ? (
          <RackCountPhrase
            count={`${rackNames.length} rack${rackNames.length === 1 ? '' : 's'}`}
            unset={rackUnset}
          />
        ) : (
          rackCountLabel
        )}
      </span>
    );
  return {
    first,
    status,
    par,
    category,
    location,
    distinctCharterIds,
    rolledUpStatus,
    sizeLabel,
    rackContent,
  };
}

/**
 * Size-run (apparel) group header — one collapsed row for a run of same-base
 * sized items ("L4L - Pink Shirt - L / - XL / - 2XL"). A clone of
 * SkuGroupHeaderRow adapted for a run: the SKU line reads "—" (members have
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
  const f = styleHeaderFacts(group, items, lookups, { table: true });
  const { first } = f;
  // Size runs are an Items-only row kind (Books lists draw none), so the cells
  // pad as the Items columns do.
  const td = (label: string) => columnTd(label, false);
  return (
    <tr
      data-row-kind="header"
      data-group-key={`style-group:${group.styleKey}`}
      className="border-border bg-sunk hover:bg-muted border-b transition-colors last:border-0"
    >
      {/* Not selectable — no checkbox (bulk actions target the member rows). */}
      <td className="w-10 py-[var(--row-py)] pl-4 pr-0" />
      <td className={itemTd(false)}>
        <ItemCell
          wrapSku
          thumb={
            <>
              <HeaderChevron
                expanded={expanded}
                onToggle={onToggle}
                label={`${expanded ? 'Collapse' : 'Expand'} ${group.baseName} (${f.sizeLabel})`}
              />
              <ListThumb
                photo={first}
                alt={first.name}
                title={group.baseName}
                subtitle={f.sizeLabel}
                meta={<OnHandMeta value={group.total} />}
              />
            </>
          }
          name={
            <Link
              href={`${rowLinkPrefix}/${first.id}?return=${encodeURIComponent(currentListUrl)}`}
              prefetch={false}
              className={ITEM_NAME_LINK}
            >
              {group.baseName}
            </Link>
          }
          badge={<SizeBadge>{f.sizeLabel}</SizeBadge>}
          // SKU — a run spans multiple SKUs, so no single value.
          sku={<span className="font-sans text-[12px] italic">—</span>}
        />
      </td>
      <td className={td('Category')}>
        <CategoryLabel category={f.category} wrap />
      </td>
      <td className={cn(td('Charter'), 'whitespace-nowrap text-[13px]')}>
        <HeaderCharterContent
          first={first}
          distinctCharterIds={f.distinctCharterIds}
          lookups={lookups}
          multipleTitle="Sizes span multiple charters — expand to see each"
        />
      </td>
      <td className={locationTd(false)}>{f.location?.name ?? '—'}</td>
      <td className={cn(td('Rack'), RACK_TD)}>{f.rackContent}</td>
      <td className={cn(td('On hand'), 'text-right')}>
        <span className={ON_HAND_FIGURE}>{formatNumber(group.total)}</span>
      </td>
      <td className={td('Coverage')}>
        <StockBar stock={group.total} par={f.par} status={f.status} />
      </td>
      <td className={cn(td('14-day'), 'text-muted-foreground text-right text-[12px]')}>—</td>
      <td className={cn(td('Status'), STATUS_WRAP)}>
        <StockStatusBadge
          quantity={group.total}
          reorderPoint={first.reorder_point}
          itemStatus={f.rolledUpStatus}
        />
      </td>
      <td className={cn(td('Updated'), 'text-muted-foreground text-right text-[12.5px]')}>—</td>
    </tr>
  );
}

function SortMenu({ value, onChange }: { value: SortKey; onChange: (k: SortKey) => void }) {
  const [open, setOpen] = React.useState(false);
  const current = SORT_OPTIONS.find((o) => o.value === value) ?? SORT_OPTIONS[0]!;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FilterTrigger
          label="Sort"
          value={current.label}
          active={value !== 'updated_desc'}
          aria-label={`Sort by ${current.label}`}
        />
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
                'hover:bg-muted flex min-h-8 items-center rounded-md px-2 text-left text-[13px] transition-colors max-sm:min-h-11',
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
 * the box itself is the non-interactive CheckboxGlyph (components/ui/checkbox).
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
        <FilterTrigger label={label} count={selected.size} aria-label={`Filter by ${label}`} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-1.5">
        <div className="space-y-1.5">
          {options.length > 8 && (
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-8 text-[13px]"
              aria-label={`Filter ${label} options`}
            />
          )}
          <div className="max-h-[260px] overflow-y-auto">
            {visible.length === 0 ? (
              <p className="text-muted-foreground px-2 py-3 text-center text-[13px]">No matches.</p>
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
                        className="hover:bg-muted flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors max-sm:min-h-11"
                      >
                        <CheckboxGlyph checked={isOn} />
                        <span className="truncate">{opt.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {selected.size > 0 && (
            <div className="border-border border-t px-1 pt-1.5">
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className={cn(touchTargetClass, chipActionClass, 'text-[12.5px]')}
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
          <FilterTrigger
            icon={<Download aria-hidden className="h-3.5 w-3.5" />}
            label="Export"
            aria-label="Export"
          />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[240px] p-1.5">
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => setScope('filtered')}
              className="hover:bg-muted rounded-md px-2 py-1.5 text-left text-[13px] transition-colors"
            >
              <span className="block font-medium">Export filtered</span>
              <span className="text-muted-foreground block text-[12px]">
                What&apos;s currently visible
              </span>
            </button>
            <button
              type="button"
              onClick={() => setScope('all')}
              className="hover:bg-muted rounded-md px-2 py-1.5 text-left text-[13px] transition-colors"
            >
              <span className="block font-medium">Export all</span>
              <span className="text-muted-foreground block text-[12px]">
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

  // The owner's share and delete controls appear on hover with a mouse, and
  // stay visible on a touch screen, below sm, and whenever keyboard focus is
  // inside the chip (CONFLICTS D18: hover-only controls could not be reached
  // by touch or by Tab-and-see). Focus inside the chip is the descendant
  // selector `.group\/view:focus-within &`, not Tailwind's group-focus-within
  // variant, which Safari pays for on every focus change of every page
  // (lib/group-focus-variants.guard.test.ts). String.raw keeps the one
  // backslash of the escaped "/" in the class the browser gets and in the text
  // Tailwind scans; an ordinary '\\/' string leaves two in the scanned text.
  const ownerControl = cn(
    String.raw`grid size-5 shrink-0 place-items-center rounded-full opacity-0 transition-opacity group-hover/view:opacity-100 [.group\/view:focus-within_&]:opacity-100 focus-visible:opacity-100 pointer-coarse:size-8 pointer-coarse:opacity-100 max-sm:size-8 max-sm:opacity-100`,
    isActive ? 'hover:bg-background/20' : 'hover:bg-foreground/10',
  );
  return (
    <span
      className={cn(
        'group/view inline-flex h-7 items-center gap-0.5 rounded-full border pl-2.5 pr-1 text-[12.5px] transition-colors max-sm:min-h-11',
        isActive
          ? 'border-foreground bg-foreground text-background'
          : 'hover:bg-muted border-[var(--ed-line-strong)] text-[var(--ed-ink-2)]',
      )}
      title={view.isShared ? `Shared by ${isOwner ? 'you' : 'a teammate'}` : undefined}
    >
      <button
        type="button"
        onClick={apply}
        className="inline-flex min-h-7 items-center gap-1.5 rounded-full pr-1 max-sm:min-h-11"
        aria-label={`Apply view ${view.name}`}
      >
        {view.isShared ? (
          <Users aria-hidden className="h-3 w-3" />
        ) : (
          <Pin aria-hidden className="h-3 w-3" />
        )}
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
          className={ownerControl}
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
          className={ownerControl}
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
  const nameId = React.useId();
  const shareNoteId = React.useId();

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
        <button type="button" className={filterChipClass({ dashed: true })}>
          <Plus aria-hidden className="h-3 w-3" /> Save view
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[280px] p-3">
        <div className="space-y-3">
          <div>
            <label
              htmlFor={nameId}
              className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]"
            >
              Name
            </label>
            <Input
              id={nameId}
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving) save();
              }}
              placeholder="Restock candidates"
              maxLength={80}
              className="mt-1 h-8 text-[13px]"
            />
          </div>
          <div className="border-border bg-sunk rounded-md border px-2.5 py-2">
            <div className="text-muted-foreground text-[11px] font-medium uppercase tracking-[0.06em]">
              Saving
            </div>
            <div className="mt-0.5 text-[12.5px] text-[var(--ed-ink-2)]">
              {describeState(currentState)}
            </div>
          </div>
          <div>
            <Checkbox
              checked={shareWithTeam}
              onCheckedChange={setShareWithTeam}
              aria-describedby={shareNoteId}
              className="font-medium"
            >
              Share with team
            </Checkbox>
            <p id={shareNoteId} className="text-muted-foreground mt-1 pl-7 text-[12px]">
              Everyone in your org will see this view. Only you can edit or delete it.
            </p>
          </div>
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
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* The same words as ever ("14-day · qty", "14-day · moves"), on two
            lines when the column is narrow: "14-day" over "· qty" and the
            chevron, each part kept whole (owner decision 2026-10-19: no extra
            space in the 14-day column). A block at the cell's right edge, so
            no text line of the cell adds to its height: two lines stay inside
            the 37 px header row. */}
        <button
          type="button"
          className="text-muted-foreground hover:bg-muted hover:text-foreground -mr-1 ml-auto block min-h-6 w-fit rounded-md px-1 py-0.5 text-right text-[11px] font-medium uppercase leading-[1.1] tracking-[0.06em] transition-colors"
          aria-label={`Sparkline mode: ${mode === 'qty' ? 'quantity trend' : 'movement count'}`}
        >
          <span className="whitespace-nowrap">14-day</span>{' '}
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            · {mode === 'qty' ? 'qty' : 'moves'}
            <ChevronDown aria-hidden className="h-3 w-3" strokeWidth={2} />
          </span>
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
                'hover:bg-muted flex min-h-8 items-center rounded-md px-2 text-left text-[13px] transition-colors max-sm:min-h-11',
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

/**
 * Group selected (0400): the chip on a record that is not under its group's
 * header here. "In group <name>": its group has only it on screen (a search
 * hit, a filter), so it keeps its context. "Same SKU as records in <name>":
 * it is in no group and shares a SKU with a group here; Add to group opens the
 * review to add it (nothing joins a group by itself).
 */
function DisplayGroupChipView({
  chip,
  name,
  recordName,
  onAddToGroup,
  wrapAction = false,
}: {
  chip: DisplayGroupChip;
  name: string;
  /** The row's record: each chip's button names it (P11). */
  recordName: string;
  onAddToGroup?: () => void;
  /** The table: Add to group may wrap under the chip (each stays whole). */
  wrapAction?: boolean;
}) {
  return (
    <MetaChip
      className={wrapAction && onAddToGroup ? 'flex-wrap gap-y-0.5' : undefined}
      action={
        onAddToGroup ? (
          <button
            type="button"
            onClick={onAddToGroup}
            aria-label={GROUP_COPY.addToGroupFor(name, recordName)}
            className={cn(touchTargetClass, chipActionClass, wrapAction && 'whitespace-nowrap')}
          >
            {GROUP_COPY.addToGroup}
          </button>
        ) : undefined
      }
    >
      {chip.kind === 'in-group' ? GROUP_COPY.chipInGroup(name) : GROUP_COPY.chipSameSku(name)}
    </MetaChip>
  );
}
