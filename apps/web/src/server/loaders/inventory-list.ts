import 'server-only';

// Cached default-view loaders for /dashboard/inventory and /dashboard/books.
//
// WHY THIS LIVES OUTSIDE page.tsx (same rule as orders-new-catalog.ts,
// perf plan P3): `unstable_cache`'s implicit key includes a hash of the
// wrapped closure, so every edit to the module containing a cached
// loader rotates its cache key on deploy. Page files are edited
// constantly; this module must stay rarely-touched. Keep UI concerns
// out of this file.
//
// SECURITY CONTRACT (mirrors orders-new-catalog.ts):
//   • The permission perimeter lives in the PAGE, not here: the pages
//     call this loader only after requireOrgContext() succeeds, only
//     for manager-and-above roles (`isManagerOrAbove`), and only when
//     `can(ctx, 'items:read')` passes. These loaders trust their
//     arguments and never see cookies.
//   • For manager/admin/owner the list is org-uniform: warehouse
//     assignment scoping and viewer category restrictions only apply
//     to staff/viewer roles, which NEVER reach this loader (they take
//     the live RLS-scoped path). That role-class gate is this cache's
//     equivalent of the orders catalog's accessKey — only the 'ALL'
//     visibility variant is ever cached or served.
//   • The admin client (service role, RLS bypassed) is used inside the
//     cache so the cached value can't capture per-user cookies; every
//     query compensates with explicit `.eq('organization_id', …)` and
//     (when a warehouse filter is active) `.eq('warehouse_id', …)`.
//   • THROW-DON'T-CACHE (recurring bug pattern #6): any query error
//     throws, which skips the unstable_cache write. The page catches
//     and falls back to the live path for that request; the next
//     request retries.
//   • IMAGE URLS ARE NEVER MINTED IN HERE — cached rows carry storage
//     PATHS (+ raw lqip). ItemImagesService's per-path signed-URL
//     helper is itself an unstable_cache (25-day TTL, shared app-wide
//     by item detail pages, filtered live views, books rows). Next
//     BYPASSES nested unstable_cache READS inside an outer cached fn
//     but still WRITES the recomputed value back (unstable-cache.js
//     cacheNewResult fall-through), so signing inside this loader
//     would mint fresh URLs on every recompute (≤60s TTL + every
//     write invalidation + the 30-min cron) AND overwrite the shared
//     25-day per-path entries — rotating image URLs app-wide, busting
//     browser caches and re-paying the Vercel image-optimizer
//     re-encode per thumbnail. URLs are resolved per request AFTER
//     the cached payload is read — see resolveInventoryListImages.
//
// SUB-LOADER SPLIT (FILTERED-view reuse): the payload is computed by
// FOUR sibling top-level unstable_cache loaders sharing the same tag +
// TTL + security contract, composed OUTSIDE any cached fn (an
// unstable_cache nested inside another is a footgun: Next bypasses the
// nested READ but still writes the recompute back — recurring bug
// pattern #13):
//   • rows+placement   (org, warehouseKey, view)  'inventory-list-v3'
//   • lookup tables    (org)                      'inventory-lookups-v1'
//   • valueOnHand      (org, warehouseKey, view)  'inventory-value-v1'
//   • trend buckets    (org)                      'inventory-trend-buckets-v2'
//   • INSTANT dataset  (org, warehouseKey, view)  'inventory-dataset-v1'
//     (full ≤INSTANT_MODE_MAX_ROWS row set for client-side instant mode;
//      over-cap views THROW a sentinel → wrapper returns null, uncached)
// The default view (loadInventoryList) consumes all four. FILTERED
// views can't reuse rows/placement (they vary with searchParams) but —
// behind the SAME manager+ && items:read gate, see
// canUseSharedInventoryCaches — reuse the lookup tables and the
// org-wide trend buckets, so a filter navigation only pays for
// rows + placement + image resolution.
//   • Trend buckets are ORG-WIDE (every item's 14-day movement
//     aggregates), cold-filled by ONE SQL aggregate RPC
//     (inventory_trend_buckets, migration 0223 — service-role-only);
//     the per-row sparkline series are derived per request from
//     whatever rows the current filter surfaced, with the same shared
//     math getItemTrends uses (lib/item-trends.ts) — so any filtered
//     row set gets series identical to the live path's.
//   • valueOnHand is NOT reused on filtered views: InventoryService.
//     list()'s footer sum mirrors the active filters (q/cat/loc/charter/
//     stock/status/type), so the filtered figure must come from the live
//     rows call (which computes it in parallel — zero serial cost). The
//     cached figure serves only the default view, whose filters it
//     mirrors exactly.

import { revalidateTag, unstable_cache } from 'next/cache';

import { can, isManagerOrAbove, type Permission, type RackHoldingLike, type Role } from '@stockpilot/core';

import { INSTANT_MODE_MAX_ROWS } from '@/lib/inventory/instant-mode';
import { isSiteLocation } from '@/lib/locations/groups';
import { createAdminClient } from '@/lib/supabase/admin';
import { withContext, type ServiceContext } from '@/server/services/context';
import { ItemImagesService } from '@/server/services/item-images';
import {
  bucketsFromTrendAggregates,
  deriveItemTrend,
  TREND_WINDOW_DAYS,
  type ItemTrend,
  type ItemTrendBuckets,
  type TrendAggregateRow,
} from '@/server/services/lib/item-trends';
import { fetchAllRows } from '@/server/services/lib/paginate';

export type InventoryListView = 'items' | 'books';

/** Cache-key token for "no warehouse filter cookie" (managers see all). */
export const ALL_WAREHOUSES_KEY = 'all';

/**
 * Rows per page on the two list pages. MUST match `PAGE_SIZE` in
 * inventory/page.tsx and books/page.tsx — if a page changes its size it
 * must change here too or the cached default view will disagree with
 * page 2+ of the live path.
 */
const DEFAULT_VIEW_PAGE_SIZE = 30;

/** TTL matches the orders-new stock loader's staleness budget. */
const LIST_TTL_SEC = 60;

/* ---- cache tag + invalidation helper --------------------------------- */

/** Single source of truth for the per-org cache tag. */
export function inventoryListTag(organizationId: string): string {
  return `inventory-list-${organizationId}`;
}

/**
 * Invalidate the cached Items/Books default views for one org. Call from
 * every server-side write path that changes what the default list view
 * renders (item CRUD, stock adjust/transfer/put-away, PO receive,
 * returns, cycle-count post, imports, images, lookup-table CRUD).
 * Mobile-app writes that go straight to Supabase can't call this — the
 * 60s TTL bounds their staleness.
 */
export function revalidateInventoryList(organizationId: string): void {
  // The object form with expire:0 is REQUIRED here — it means
  // "expired now, recompute before serving". The 'max' profile is
  // stale-while-revalidate (stale=now, expire=+INFINITE), so
  // unstable_cache would serve the pre-write entry ONE more time and
  // only recompute in the background — every write lacking a matching
  // revalidatePath for the viewed page would deterministically show
  // pre-write data on the next view (e.g. delete a book →
  // /dashboard/books still lists it, server-shared for all managers).
  // The legacy single-arg call also expires immediately but logs a
  // deprecation warning on every write. (updateTag would be rejected
  // in Route Handler callers.)
  revalidateTag(inventoryListTag(organizationId), { expire: 0 });
}

/**
 * Server-action convenience wrapper: resolves the caller's org from the
 * request-cached context (free — the action already resolved it) and
 * invalidates its cached list views. NEVER throws — the write already
 * succeeded, and a failed invalidation only means up to 60s of
 * staleness, which must not turn a successful action into an error.
 */
export async function revalidateInventoryListForCurrentOrg(): Promise<void> {
  try {
    const { organizationId } = await withContext();
    revalidateInventoryList(organizationId);
  } catch (err) {
    console.warn('[inventory-list] revalidate skipped:', err);
  }
}

/* ---- shared-cache eligibility gate ------------------------------------ */

/**
 * THE gate for every org-shared inventory cache read (default-view
 * payload on both pages AND the filtered views' lookup/trend reuse).
 * Centralized so the pages can't drift apart:
 *   • isManagerOrAbove — staff/viewer results are user-scoped
 *     (warehouse assignments / viewer category restrictions) and must
 *     never be served from, or into, an org-shared cache. They take
 *     the fully-live RLS-scoped path.
 *   • can(items:read) — honors configurable-permission revocations
 *     (a manager with items:read revoked must not read cached rows the
 *     way raw RLS rows would already be denied).
 * Takes the page's requireOrgContext() result (role + effective
 * permission set).
 */
export function canUseSharedInventoryCaches(ctx: {
  readonly role: Role;
  readonly permissions?: ReadonlySet<Permission>;
}): boolean {
  return isManagerOrAbove(ctx.role) && can(ctx, 'items:read');
}

/* ---- default-view detection ------------------------------------------ */

/** The searchParams shape shared by the Items and Books list pages. */
export interface InventoryListSearchParamsLike {
  q?: string;
  status?: string;
  stock?: string;
  type?: string;
  page?: string;
  sort?: string;
  cat?: string | string[];
  loc?: string | string[];
  charter?: string | string[];
  rack?: string;
  /** '1' = the "Expected" chip view (only items awaiting first receipt,
   *  migration 0277). Any presence bypasses the cached default view. */
  expected?: string;
}

function hasIdFilter(value: string | string[] | undefined): boolean {
  if (!value) return false;
  return (Array.isArray(value) ? value : [value]).some(
    (v) => typeof v === 'string' && v.length > 0,
  );
}

/**
 * True only for the exact default view: page 1, default sort, no
 * search, no filters. Anything else — including malformed values the
 * live path would coerce back to a default — bypasses the cache and
 * takes today's live path, so the cache never has to reason about
 * coercion edge cases.
 */
export function isDefaultInventoryView(
  params: InventoryListSearchParamsLike,
  view: InventoryListView,
): boolean {
  // Whitespace-only q is still the default view — VERIFIED PARITY,
  // not an approximation: InventoryService.list() applies the search
  // filter only under `if (filters.q && filters.q.trim())` (main query
  // AND the value-footer sum query repeat the guard), so the live path
  // treats q='   ' as no filter at all. Same for rack below.
  if (typeof params.q === 'string' && params.q.trim()) return false;
  if (!isDefaultScalar(params.q)) return false;
  if (params.status !== undefined && params.status !== 'active') return false;
  if (params.stock !== undefined && params.stock !== '') return false;
  // The Books page has no type param (it hardcodes item_type='book');
  // Items defaults to 'product'.
  if (view === 'items' && params.type !== undefined && params.type !== 'product') return false;
  if (params.page !== undefined && params.page !== '1') return false;
  if (params.sort !== undefined && params.sort !== 'updated_desc') return false;
  // Any ?expected= presence (the Expected chip view, or garbage) takes
  // the live path — the cached default view only serves the unflagged set.
  if (params.expected !== undefined) return false;
  if (hasIdFilter(params.cat) || hasIdFilter(params.loc) || hasIdFilter(params.charter)) {
    return false;
  }
  // Whitespace-only rack = default view, same verified parity as q:
  // list() applies the rack filter only under
  // `if (filters.rack && filters.rack.trim())`.
  if (typeof params.rack === 'string' && params.rack.trim()) return false;
  return true;
}

/** Repeated params arrive as arrays at runtime — treat those as non-default. */
function isDefaultScalar(v: string | string[] | undefined): boolean {
  return v === undefined || typeof v === 'string';
}

/* ---- payload shape ---------------------------------------------------- */

/**
 * The columns shared by cached-payload rows and final table rows — the
 * same columns InventoryService.list() returns for the pages, plus the
 * derived placement fields. NOT byte-for-byte verbatim: see the
 * ITEM_SELECT_COLUMNS comment below for the one intentional omission
 * (reorder_quantity — no consumer of this loader reads it).
 */
interface InventoryListRowBase {
  id: string;
  sku: string;
  barcode: string | null;
  model_number: string | null;
  name: string;
  description: string | null;
  status: 'active' | 'archived' | 'discontinued';
  quantity_on_hand: number;
  reorder_point: number;
  unit_cost: number;
  retail_price: number;
  category_id: string | null;
  supplier_id: string | null;
  primary_location_id: string | null;
  warehouse_id: string | null;
  charter_id: string | null;
  tracking_type: 'none' | 'lot' | 'serial' | 'serial_optional';
  item_type: 'product' | 'book' | 'asset' | 'consumable';
  /** True only when the SYSTEM auto-archived this item on zero stock
   *  (migration 0266) — backs the Archived view's "Auto-archived"
   *  badge + filter chip. */
  auto_archived: boolean;
  /** True while an item auto-created from an inbound PO has never
   *  received any stock (migration 0277). Default views exclude these
   *  rows; the instant dataset carries them (with this flag) so the
   *  client-side "Expected" chip view + count derive locally. */
  awaiting_first_receipt: boolean;
  custom_fields: Record<string, unknown> | null;
  /** Sports (0298). NULL for every ungrouped item, which is every item in
   *  every org until an opt-in link is made — no heuristic backfill writes
   *  these. Carried on the list row so a grouped view can badge variants
   *  without a second round trip. */
  group_id: string | null;
  variant_size: string | null;
  variant_size_system: string | null;
  jersey_number: string | null;
  variant_key: string | null;
  created_at: string;
  updated_at: string;
  staged_quantity: number;
  unplaced_quantity: number;
  placed_quantity: number;
  placed_racks: string[];
  /** Count of DISTINCT rack/crate item_stock_levels HOLDINGS (by
   *  location_id, qty>0) — NOT the same as placed_racks.length, which
   *  dedupes by rack NAME and so collapses same-named racks in different
   *  warehouses (e.g. two "1-A"s) down to one entry. Mirrors the
   *  server's rackHoldingsByItem grouping in placeItemsOntoRackByName
   *  (InventoryService) — the bulk Set-rack split warning must agree
   *  with this count exactly, not with placed_racks. */
  rackHoldingsCount: number;
  /** The same holdings as `placed_racks`, but carrying QUANTITY and
   *  `locations.kind`, deduped by location_id like rackHoldingsCount. The
   *  input `resolvePlacement` needs — `placed_racks` is names only, so no
   *  consumer of it can tell a crate from a rack and every one of them keeps
   *  printing the rack a position-less put-away left behind (mig 0335). */
  placed_holdings: RackHoldingLike[];
}

/**
 * One CACHED row: primary-image storage PATHS + raw lqip, never URLs.
 * URL resolution happens per request via resolveInventoryListImages
 * (see the header note on nested unstable_cache clobbering).
 */
export interface InventoryListCachedRow extends InventoryListRowBase {
  image_storage_path: string | null;
  image_thumb_path: string | null;
  image_lqip: string | null;
}

/**
 * One RENDERED row — what the table components receive. Shape-identical
 * between the cached branch (resolveInventoryListImages output) and
 * the live branch (InventoryService.list rows merged with
 * primaryImagesWithThumbsForItems in the pages).
 */
export interface InventoryListItemRow extends InventoryListRowBase {
  image_url: string | null;
  image_thumb_url: string | null;
  image_lqip: string | null;
}

export interface InventoryPlacementLine {
  locationId: string;
  label: string;
  kind: string;
  quantity: number;
}

/**
 * The five filter-independent lookup tables the list pages' toolbars
 * need. Shapes match what the pages' live branch maps the services'
 * rows into — the cached and live filtered views must stay
 * shape-identical (asserted in inventory-list.test.ts).
 */
export interface InventoryListLookups {
  categories: Array<{ id: string; name: string; color: string | null }>;
  locations: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string; color: string | null }>;
  charters: Array<{ id: string; name: string; code: string | null }>;
}

export interface InventoryListPayload extends InventoryListLookups {
  items: InventoryListCachedRow[];
  total: number;
  valueOnHand: number;
  /** Serialized trend series (Maps don't survive the data cache). */
  trends: Record<string, ItemTrend>;
  /** Serialized placementBreakdown — one line per non-empty holding. */
  placement: Record<string, InventoryPlacementLine[]>;
  /** Count of ACTIVE items awaiting first receipt for this view — the
   *  badge on the "Expected" chip (mirrors InventoryService.
   *  countExpected; the 0277 partial index makes it ~free). */
  expectedCount: number;
}

/** The filter-dependent slice cached per (org, warehouseKey, view). */
interface InventoryListRowsPayload {
  items: InventoryListCachedRow[];
  total: number;
  placement: Record<string, InventoryPlacementLine[]>;
  /** See InventoryListPayload.expectedCount. */
  expectedCount: number;
}

/* ---- loader (composition) ---------------------------------------------- */

/**
 * Cached default-view list payload, composed from the four sibling
 * cached sub-loaders IN PARALLEL and OUTSIDE any cached fn (never nest
 * unstable_cache — pattern #13). Rows/value key = (organizationId,
 * warehouseKey, view); lookups/buckets key = (organizationId). All four
 * share tag = inventoryListTag(organizationId) so every write path
 * invalidates an org's variants at once. Each unstable_cache wrapper is
 * created per call because tags must carry the org id — the implicit
 * key (fn source + explicit keyParts + args) is identical across calls,
 * so entries are shared normally.
 *
 * Trend series are derived per request from the cached org-wide buckets
 * + the cached rows' quantities (same shared math as getItemTrends), so
 * the sparkline endpoint always equals the row's on-hand column.
 */
export async function loadInventoryList(
  organizationId: string,
  warehouseKey: string,
  view: InventoryListView,
): Promise<InventoryListPayload> {
  const [rows, lookups, valueOnHand, buckets] = await Promise.all([
    loadInventoryRows(organizationId, warehouseKey, view),
    loadInventoryLookups(organizationId),
    loadInventoryValueOnHand(organizationId, warehouseKey, view),
    loadInventoryTrendBuckets(organizationId),
  ]);

  const trends: InventoryListPayload['trends'] = {};
  for (const r of rows.items) {
    trends[r.id] = deriveItemTrend(Number(r.quantity_on_hand), buckets[r.id]);
  }

  return {
    items: rows.items,
    total: rows.total,
    valueOnHand,
    ...lookups,
    trends,
    placement: rows.placement,
    expectedCount: rows.expectedCount,
  };
}

/** Cached rows + placement for the exact default view. */
async function loadInventoryRows(
  organizationId: string,
  warehouseKey: string,
  view: InventoryListView,
): Promise<InventoryListRowsPayload> {
  // v5: the row shape gained the five variant columns (group_id, variant_size,
  // variant_size_system, variant_key, jersey_number) — a stale v4 entry would
  // serve rows missing them for a whole TTL after deploy.
  // (v4: rows EXCLUDE items awaiting first receipt (0277) + expectedCount.
  //  v3: rows+placement split out of the bundled v2 payload.) One-time
  // cold recompute per org — the */30 prewarm cron covers hot orgs.
  const cached = unstable_cache(loadInventoryRowsUncached, ['inventory-list-v5'], {
    revalidate: LIST_TTL_SEC,
    tags: [inventoryListTag(organizationId)],
  });
  return cached(organizationId, warehouseKey, view);
}

/**
 * Read-only synthetic context so resolveInventoryListImages can reuse
 * the 25-day per-path signed-URL cache in ItemImagesService (outside
 * the cache, per request) without re-deriving it. Same construction as
 * the cron routes' system contexts. NEVER pass this to a write method —
 * it carries the service role client.
 */
function adminReadContext(organizationId: string): ServiceContext {
  return {
    organizationId,
    userId: 'inventory-list-loader',
    role: 'owner',
    supabase: createAdminClient() as unknown as ServiceContext['supabase'],
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(),
  };
}

// Copy of InventoryService.list()'s select list so cached rows carry
// exactly the columns the live path ships — WITH ONE DELIBERATE OMISSION:
// InventoryService.list() also selects `reorder_quantity` (added by
// fix(inventory): stop exporting a reorder quantity that is always zero,
// solely to unblock the export builder's "Reorder quantity" column). This
// loader's only consumer is the default inventory/books list view
// (InventoryListRowBase below → inventory-table.tsx), which has no
// "Reorder quantity" column and reads no such field. This is a hot,
// 60s-cached, do-not-regress list path (perf memory), so an unused column
// is left off on purpose rather than copied in "to stay verbatim" — every
// other column here IS a byte-for-byte match. Add reorder_quantity here
// ONLY when a real consumer of loadInventoryList needs it, and update
// InventoryListRowBase + the comment above it at the same time.
const ITEM_SELECT_COLUMNS =
  'id, sku, barcode, model_number, name, description, status, quantity_on_hand, reorder_point, unit_cost, retail_price, category_id, supplier_id, primary_location_id, warehouse_id, charter_id, tracking_type, item_type, is_rental, auto_archived, awaiting_first_receipt, custom_fields, group_id, variant_size, variant_size_system, jersey_number, variant_key, created_at, updated_at, created_by, updated_by';

async function loadInventoryRowsUncached(
  organizationId: string,
  warehouseKey: string,
  view: InventoryListView,
): Promise<InventoryListRowsPayload> {
  const admin = createAdminClient();
  const itemType = view === 'books' ? 'book' : 'product';
  const warehouseId = warehouseKey === ALL_WAREHOUSES_KEY ? null : warehouseKey;

  // Default-view filters, mirroring InventoryService.list() with no
  // searchParams: active, non-rental, not deleted, item_type by view,
  // NOT awaiting first receipt (mig 0277 — phantoms from inbound POs are
  // hidden until stock arrives), updated_desc + stable id tiebreak,
  // page 1 of 30, exact count.
  let mainQuery = admin
    .from('inventory_items')
    .select(ITEM_SELECT_COLUMNS, { count: 'exact' })
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .eq('status', 'active')
    .eq('item_type', itemType)
    .eq('is_rental', false)
    .eq('awaiting_first_receipt', false)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: true })
    .range(0, DEFAULT_VIEW_PAGE_SIZE - 1);
  if (warehouseId) mainQuery = mainQuery.eq('warehouse_id', warehouseId);

  // Expected-chip badge count: flagged rows for this view ACROSS
  // lifecycles (no status filter — the Expected view spans them, same as
  // mobile's listStatusPredicate lifecycle:null) — mirrors
  // InventoryService.countExpected exactly (the manager+ / all-access,
  // no-extra-filters variant this default-view cache serves). Rides the
  // 0277 partial index.
  let expectedQuery = admin
    .from('inventory_items')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .eq('item_type', itemType)
    .eq('is_rental', false)
    .eq('awaiting_first_receipt', true);
  if (warehouseId) expectedQuery = expectedQuery.eq('warehouse_id', warehouseId);

  const [mainRes, expectedRes] = await Promise.all([mainQuery, expectedQuery]);

  // Throw on ANY read error so a failed pass is never cached.
  if (mainRes.error) throw new Error(`inventory-list items query failed: ${mainRes.error.message}`);
  if (expectedRes.error) {
    throw new Error(`inventory-list expected count query failed: ${expectedRes.error.message}`);
  }
  const expectedCount = expectedRes.count ?? 0;

  const rows = (mainRes.data ?? []) as unknown as RawItemRow[];
  const total = mainRes.count ?? 0;

  const ids = rows.map((r) => r.id);

  // Second wave: holdings (placement) + primary images — independent of
  // each other, both keyed on the page's item ids. (Trends are NOT
  // fetched here anymore — they derive per request from the org-wide
  // bucket cache, see loadInventoryTrendBuckets.)
  const [levelsRes, imageRowsRes] = await Promise.all([
    ids.length > 0
      ? admin
          .from('item_stock_levels')
          .select('item_id, location_id, quantity, locations!inner(name, kind)')
          .eq('organization_id', organizationId)
          .in('item_id', ids)
          .gt('quantity', 0)
      : Promise.resolve({ data: [], error: null }),
    ids.length > 0
      ? admin
          .from('item_images')
          .select('item_id, storage_path, thumb_path, lqip, is_primary, sort_order')
          .eq('organization_id', organizationId)
          .in('item_id', ids)
          .order('is_primary', { ascending: false })
          .order('sort_order', { ascending: true })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (levelsRes.error) {
    throw new Error(`inventory-list stock levels query failed: ${levelsRes.error.message}`);
  }
  if (imageRowsRes.error) {
    throw new Error(`inventory-list item_images query failed: ${imageRowsRes.error.message}`);
  }

  const { items, placement } = assembleInventoryRows(
    rows,
    (levelsRes.data ?? []) as unknown as HoldingLevelRow[],
    (imageRowsRes.data ?? []) as unknown as PrimaryImageRow[],
  );

  return { items, total, placement, expectedCount };
}

/** A main-query row before the derived placement/image fields land. */
type RawItemRow = Omit<
  InventoryListCachedRow,
  | 'staged_quantity'
  | 'unplaced_quantity'
  | 'placed_quantity'
  | 'placed_racks'
  | 'rackHoldingsCount'
  | 'image_storage_path'
  | 'image_thumb_path'
  | 'image_lqip'
>;

interface HoldingLevelRow {
  item_id: string;
  location_id: string;
  quantity: number;
  locations: { name: string; kind: string | null };
}

interface PrimaryImageRow {
  item_id: string;
  storage_path: string;
  thumb_path: string | null;
  lqip: string | null;
}

/**
 * The SHARED row-building tail for the paged rows loader AND the
 * instant-mode dataset loader: holdings scan (staged/unplaced/
 * placed_racks + placement lines) and primary-image pick, then the final
 * cached-row mapping. Extracted (not duplicated) so the two loaders'
 * rows can never drift in shape or math. Inputs must already be scoped
 * to the caller's item set; `imageRows` must arrive ordered
 * is_primary DESC, sort_order ASC (first row per item wins — same pick
 * as primaryImagesWithThumbsForItems).
 */
function assembleInventoryRows(
  rows: RawItemRow[],
  levels: HoldingLevelRow[],
  imageRows: PrimaryImageRow[],
): { items: InventoryListCachedRow[]; placement: Record<string, InventoryPlacementLine[]> } {
  // ONE holdings pass feeds both derivations the live path computes
  // separately (list()'s staged/unplaced/placed_racks scan and
  // placementBreakdown()) — identical inputs, identical outputs.
  const stagedByItem = new Map<string, number>();
  const unplacedByItem = new Map<string, number>();
  const placedRacksByItem = new Map<string, string[]>();
  // Distinct rack/crate HOLDINGS per item, keyed by location_id (never
  // name) — see the rackHoldingsCount field doc on InventoryListRowBase.
  // A rack named "1-A" in two different warehouses is ONE entry in
  // placedRacksByItem (name-deduped, for display) but TWO here.
  const rackHoldingsByItem = new Map<string, Set<string>>();
  // Kind-carrying holdings — see the field doc on InventoryListRowBase. Keyed
  // by location_id so this matches rackHoldingsCount's grouping, not
  // placed_racks' name-dedupe.
  const placedHoldingsByItem = new Map<string, Map<string, RackHoldingLike>>();
  const placement: Record<string, InventoryPlacementLine[]> = {};
  for (const lvl of levels) {
    // Row-summary math uses the RAW kind — identical to the live
    // list() scan in InventoryService, where a NULL locations.kind
    // counts toward neither staged, unplaced, nor placed_racks.
    const rawKind = lvl.locations?.kind;
    const qty = Number(lvl.quantity);
    if (rawKind === 'staging') {
      stagedByItem.set(lvl.item_id, (stagedByItem.get(lvl.item_id) ?? 0) + qty);
    } else if (rawKind === 'unplaced') {
      unplacedByItem.set(lvl.item_id, (unplacedByItem.get(lvl.item_id) ?? 0) + qty);
    } else if (rawKind === 'rack' || rawKind === 'crate') {
      const arr = placedRacksByItem.get(lvl.item_id) ?? [];
      if (lvl.locations.name && !arr.includes(lvl.locations.name)) arr.push(lvl.locations.name);
      placedRacksByItem.set(lvl.item_id, arr);

      const set = rackHoldingsByItem.get(lvl.item_id) ?? new Set<string>();
      set.add(lvl.location_id);
      rackHoldingsByItem.set(lvl.item_id, set);

      const byLoc = placedHoldingsByItem.get(lvl.item_id) ?? new Map<string, RackHoldingLike>();
      const prior = byLoc.get(lvl.location_id);
      byLoc.set(lvl.location_id, {
        name: lvl.locations.name,
        quantity: (prior?.quantity ?? 0) + qty,
        kind: rawKind,
      });
      placedHoldingsByItem.set(lvl.item_id, byLoc);
    }
    // The placement LINES coalesce NULL → 'unplaced' — exactly (and
    // only) where the live placementBreakdown() coalesces.
    const kind = rawKind ?? 'unplaced';
    const label =
      kind === 'staging' ? 'Staging' : kind === 'unplaced' ? 'Unplaced' : lvl.locations.name;
    (placement[lvl.item_id] ??= []).push({
      locationId: lvl.location_id,
      label,
      kind,
      quantity: qty,
    });
  }
  // Same ordering as placementBreakdown: racks/crates A→Z, then
  // Staging, then Unplaced.
  const rank = (k: string) => (k === 'staging' ? 1 : k === 'unplaced' ? 2 : 0);
  for (const lines of Object.values(placement)) {
    lines.sort((a, b) => rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label));
  }

  // Primary image per item (is_primary DESC, sort_order ASC — first row
  // wins). PATHS ONLY — no URL is ever minted inside a cached fn
  // (see the header note: a nested signedUrls call would overwrite the
  // shared 25-day per-path entries on every recompute). URLs are
  // resolved per request by resolveInventoryListImages.
  const pickByItem = new Map<string, PrimaryImageRow>();
  for (const row of imageRows) {
    if (!pickByItem.has(row.item_id)) pickByItem.set(row.item_id, row);
  }

  const items: InventoryListCachedRow[] = rows.map((r) => {
    const img = pickByItem.get(r.id);
    const staged = stagedByItem.get(r.id) ?? 0;
    const unplaced = unplacedByItem.get(r.id) ?? 0;
    return {
      ...r,
      // Same math as derivePlacement(): staging + unplaced are both
      // "not yet put away", so neither counts as placed.
      staged_quantity: staged,
      unplaced_quantity: unplaced,
      placed_quantity: Math.max(0, Number(r.quantity_on_hand) - staged - unplaced),
      placed_racks: (placedRacksByItem.get(r.id) ?? []).sort((a, b) => a.localeCompare(b)),
      rackHoldingsCount: rackHoldingsByItem.get(r.id)?.size ?? 0,
      placed_holdings: [...(placedHoldingsByItem.get(r.id)?.values() ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      image_storage_path: img?.storage_path ?? null,
      image_thumb_path: img?.thumb_path ?? null,
      image_lqip: img?.lqip ?? null,
    };
  });

  return { items, placement };
}

/* ---- instant-mode dataset loader --------------------------------------- */

/**
 * The FULL per-view dataset instant mode ships to the client: every
 * non-deleted, non-rental row of the view's item_type (ACTIVE, ARCHIVED
 * and DISCONTINUED — the status field rides along so the Active/Archived
 * tabs and ?status= deep links derive client-side), plus the placement
 * lines for the Items page's one-line-per-rack expansion. Rows are
 * shape-identical to the paged loader's (same assembleInventoryRows
 * tail), so the table renders either source interchangeably.
 */
export interface InventoryDatasetPayload {
  items: InventoryListCachedRow[];
  placement: Record<string, InventoryPlacementLine[]>;
}

/**
 * Sentinel THROWN (never returned) inside the cached fn when the view
 * exceeds INSTANT_MODE_MAX_ROWS. Throwing is load-bearing: it rides the
 * existing throw-don't-cache short-circuit, so "too large" — like every
 * other non-result — is never written to the data cache (recurring bug
 * pattern: never cache a null). The public wrapper translates it to the
 * `null` its callers switch on.
 */
const DATASET_TOO_LARGE = 'inventory-dataset: view exceeds INSTANT_MODE_MAX_ROWS';

function isDatasetTooLarge(err: unknown): boolean {
  return err instanceof Error && err.message === DATASET_TOO_LARGE;
}

/**
 * Cached instant-mode dataset for one (org, warehouseKey, view) — the
 * same key axes, org tag, 60s TTL, admin-read + explicit-org-filter
 * contract, and manager+/items:read page perimeter as the sibling
 * loaders above (see the header SECURITY CONTRACT; the pages gate with
 * canUseSharedInventoryCaches before calling this).
 *
 * Returns `null` — WITHOUT caching anything — when the view's row count
 * exceeds INSTANT_MODE_MAX_ROWS: callers fall back to server mode, and
 * the next request re-checks (a truncated or empty stand-in must never
 * be cached as if it were the full set). Real query errors still throw,
 * exactly like the other loaders, so the pages' catch → live-path
 * fallback keeps working.
 */
export async function loadInventoryDataset(
  organizationId: string,
  warehouseKey: string,
  view: InventoryListView,
): Promise<InventoryDatasetPayload | null> {
  // v2: rows now carry awaiting_first_receipt (migration 0277) — the
  // client derivation hides flagged rows by default and serves the
  // "Expected" chip view + count from them. Bumped so a stale v1 entry
  // (rows without the flag → phantoms would leak into the default view)
  // can't serve for a TTL post-deploy.
  const cached = unstable_cache(loadInventoryDatasetUncached, ['inventory-dataset-v2'], {
    revalidate: LIST_TTL_SEC,
    tags: [inventoryListTag(organizationId)],
  });
  try {
    return await cached(organizationId, warehouseKey, view);
  } catch (err) {
    if (isDatasetTooLarge(err)) return null;
    throw err;
  }
}

async function loadInventoryDatasetUncached(
  organizationId: string,
  warehouseKey: string,
  view: InventoryListView,
): Promise<InventoryDatasetPayload> {
  const admin = createAdminClient();
  const itemType = view === 'books' ? 'book' : 'product';
  const warehouseId = warehouseKey === ALL_WAREHOUSES_KEY ? null : warehouseKey;

  // The dataset filter = list()'s filter axes that are CONSTANT for the
  // view (org, not deleted, item_type, non-rental, optional warehouse).
  // Everything the user can change per request — status, q, stock,
  // cat/loc/charter, rack, sort, page, expected — deliberately stays OUT
  // so the client derives it (lib/inventory/instant-mode.ts mirrors
  // list()). Rows awaiting first receipt (mig 0277) are INCLUDED here,
  // carrying their flag: filterInstantRows hides them by default and the
  // "Expected" chip view + count derive from this same dataset.
  //
  // CAP FIRST, with a HEAD count — over-cap orgs pay one count query per
  // request (nothing cacheable exists for them), never the full fetch.
  let countQuery = admin
    .from('inventory_items')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .eq('item_type', itemType)
    .eq('is_rental', false);
  if (warehouseId) countQuery = countQuery.eq('warehouse_id', warehouseId);
  const countRes = await countQuery;
  if (countRes.error) {
    throw new Error(`inventory-dataset count query failed: ${countRes.error.message}`);
  }
  if ((countRes.count ?? 0) > INSTANT_MODE_MAX_ROWS) throw new Error(DATASET_TOO_LARGE);

  // Full row fetch, paginated past PostgREST's 1000-row cap. cap+1 so a
  // count-vs-fetch race (rows inserted in between) is still detectable
  // below instead of silently shipping a truncated set.
  const rows = await fetchAllRows<RawItemRow>(
    (from, to) => {
      let q = admin
        .from('inventory_items')
        .select(ITEM_SELECT_COLUMNS)
        .eq('organization_id', organizationId)
        .is('deleted_at', null)
        .eq('item_type', itemType)
        .eq('is_rental', false);
      if (warehouseId) q = q.eq('warehouse_id', warehouseId);
      return q.order('id', { ascending: true }).range(from, to) as unknown as PromiseLike<{
        data: RawItemRow[] | null;
        error: { message: string } | null;
      }>;
    },
    { cap: INSTANT_MODE_MAX_ROWS + 1 },
  );
  if (rows.length > INSTANT_MODE_MAX_ROWS) throw new Error(DATASET_TOO_LARGE);

  // Second wave: holdings + images, ID-SCOPED via chunked `.in('item_id',
  // …)` (scale-audit rank 7). The old org-wide fetch + in-memory pruning
  // read EVERY org holding/image row to serve ≤2000 items — at 50k SKUs
  // that is 50+ sequential 1000-row pages per table for a bounded
  // dataset. All 2000 uuids in ONE query string would blow the URL
  // length limit, so the ids go out in ID_CHUNK_SIZE batches (parallel,
  // each batch itself paginated past the 1000-row cap — a batch's items
  // can carry many holdings/images rows). An item's rows are confined to
  // its own chunk, so the per-item first-row-wins image pick in
  // assembleInventoryRows is unaffected by chunk merge order. The
  // ids-Set prune stays as defense-in-depth (it also keeps the loader's
  // behavior byte-identical if a chunk query ever over-returns).
  const idList = rows.map((r) => r.id);
  const ids = new Set(idList);
  const [levelsAll, imagesAll] = await Promise.all([
    fetchRowsForItemIdChunks<HoldingLevelRow>(idList, (chunk) => (from, to) =>
      admin
        .from('item_stock_levels')
        .select('item_id, location_id, quantity, locations!inner(name, kind)')
        .eq('organization_id', organizationId)
        .in('item_id', chunk)
        .gt('quantity', 0)
        .order('id', { ascending: true })
        // The to-one `locations` embed types as an array in generated
        // PostgREST types but is a single object at runtime — same
        // cast convention as the loaders above and placements().
        .range(from, to) as unknown as PromiseLike<{
        data: HoldingLevelRow[] | null;
        error: { message: string } | null;
      }>,
    ),
    fetchRowsForItemIdChunks<PrimaryImageRow>(idList, (chunk) => (from, to) =>
      admin
        .from('item_images')
        .select('item_id, storage_path, thumb_path, lqip, is_primary, sort_order')
        .eq('organization_id', organizationId)
        .in('item_id', chunk)
        // Same pick order as the paged loader (primary first, then
        // sort_order) + the id tiebreak fetchAllRows needs for a total
        // order across pages.
        .order('is_primary', { ascending: false })
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: PrimaryImageRow[] | null;
        error: { message: string } | null;
      }>,
    ),
  ]);

  return assembleInventoryRows(
    rows,
    levelsAll.filter((l) => ids.has(l.item_id)),
    imagesAll.filter((img) => ids.has(img.item_id)),
  );
}

/**
 * Uuids per `.in('item_id', …)` call. 100 uuids ≈ 3.7KB of query string —
 * comfortably under every proxy/URL limit in the chain (PostgREST/Kong
 * reject around 8–16KB), while keeping the fan-out for a full 2000-row
 * dataset to ≤20 parallel calls per table (vs 50+ SEQUENTIAL org-wide
 * pages at 50k SKUs before).
 */
const ID_CHUNK_SIZE = 100;

/**
 * Chunked-id fetch for the dataset's second wave: splits `itemIds` into
 * ID_CHUNK_SIZE batches, runs one fetchAllRows per batch IN PARALLEL
 * (each batch is still paginated internally so >1000 rows for a batch's
 * items can't be silently clamped), and merges. fetchAllRows THROWS on
 * any page error, so a failed chunk fails the whole dataset pass —
 * throw-don't-cache is preserved. Empty `itemIds` → no queries at all.
 */
async function fetchRowsForItemIdChunks<Row>(
  itemIds: string[],
  buildChunkPage: (
    chunk: string[],
  ) => (
    from: number,
    to: number,
  ) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
): Promise<Row[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < itemIds.length; i += ID_CHUNK_SIZE) {
    chunks.push(itemIds.slice(i, i + ID_CHUNK_SIZE));
  }
  const results = await Promise.all(
    chunks.map((chunk) => fetchAllRows<Row>(buildChunkPage(chunk))),
  );
  return results.flat();
}

/* ---- filter-independent sub-loaders ------------------------------------ */

/**
 * Cached lookup tables (categories / site locations / suppliers / tags /
 * charters) — the toolbar filter sources on both list pages. Key =
 * (organizationId): for manager-and-above these are org-uniform (the
 * only role class allowed near this cache — see
 * canUseSharedInventoryCaches). Queries mirror the pages' live-branch
 * services exactly:
 *   categories → CategoriesService.list()            (not deleted, name ASC)
 *   locations  → LocationsService.list({sitesOnly})   (not deleted, name ASC,
 *                isSiteLocation filter — same shared predicate)
 *   suppliers  → SuppliersService.list() behind the module gate
 *                (module off → [] fail-closed, see loadSuppliersIfEnabled)
 *   tags       → TagsService.list()                   (name ASC)
 *   charters   → ChartersService.list()               (status=active, name ASC)
 */
export async function loadInventoryLookups(
  organizationId: string,
): Promise<InventoryListLookups> {
  const cached = unstable_cache(loadInventoryLookupsUncached, ['inventory-lookups-v1'], {
    revalidate: LIST_TTL_SEC,
    tags: [inventoryListTag(organizationId)],
  });
  return cached(organizationId);
}

async function loadInventoryLookupsUncached(
  organizationId: string,
): Promise<InventoryListLookups> {
  const admin = createAdminClient();
  const [categoriesRes, locationsRes, suppliers, tagsRes, chartersRes] = await Promise.all([
    admin
      .from('categories')
      .select('id, name, color')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    admin
      .from('locations')
      .select('id, name, type, kind')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    loadSuppliersIfEnabled(admin, organizationId),
    admin
      .from('tags')
      .select('id, name, color')
      .eq('organization_id', organizationId)
      .order('name', { ascending: true }),
    admin
      .from('charters')
      .select('id, name, code')
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .order('name', { ascending: true }),
  ]);

  // Throw on ANY read error so a failed pass is never cached.
  if (categoriesRes.error) {
    throw new Error(`inventory-list categories query failed: ${categoriesRes.error.message}`);
  }
  if (locationsRes.error) {
    throw new Error(`inventory-list locations query failed: ${locationsRes.error.message}`);
  }
  if (tagsRes.error) throw new Error(`inventory-list tags query failed: ${tagsRes.error.message}`);
  if (chartersRes.error) {
    throw new Error(`inventory-list charters query failed: ${chartersRes.error.message}`);
  }

  return {
    categories: (categoriesRes.data ?? []).map((c) => ({
      id: c.id as string,
      name: c.name as string,
      color: (c.color as string | null) ?? null,
    })),
    locations: (locationsRes.data ?? [])
      .filter((l) => isSiteLocation(l as { type: string | null; kind: string | null }))
      .map((l) => ({ id: l.id as string, name: l.name as string })),
    suppliers,
    tags: (tagsRes.data ?? []).map((t) => ({
      id: t.id as string,
      name: t.name as string,
      color: (t.color as string | null) ?? null,
    })),
    charters: (chartersRes.data ?? []).map((c) => ({
      id: c.id as string,
      name: c.name as string,
      code: (c.code as string | null) ?? null,
    })),
  };
}

/**
 * Cached "$N on hand" footer figure for the DEFAULT view only. Key =
 * (organizationId, warehouseKey, view) — the skinny sum mirrors the
 * default-view filters (active, non-rental, item_type by view, optional
 * warehouse). NOT served on filtered views: the live list()'s footer
 * sum mirrors the active filters, so substituting this figure there
 * would pair an unfiltered dollar total with a filtered SKU count.
 */
export async function loadInventoryValueOnHand(
  organizationId: string,
  warehouseKey: string,
  view: InventoryListView,
): Promise<number> {
  const cached = unstable_cache(loadInventoryValueOnHandUncached, ['inventory-value-v1'], {
    revalidate: LIST_TTL_SEC,
    tags: [inventoryListTag(organizationId)],
  });
  return cached(organizationId, warehouseKey, view);
}

async function loadInventoryValueOnHandUncached(
  organizationId: string,
  warehouseKey: string,
  view: InventoryListView,
): Promise<number> {
  const admin = createAdminClient();
  const itemType = view === 'books' ? 'book' : 'product';
  const warehouseId = warehouseKey === ALL_WAREHOUSES_KEY ? null : warehouseKey;

  // ONE SQL aggregate round trip (scale-audit rank 6, migration 0227)
  // instead of paging every matching item row through sequential
  // 1000-row PostgREST pages and reducing qty × unit_cost in JS (50+
  // serial round trips per cache fill at 50k SKUs). The RPC reproduces
  // the skinny default-view mirror EXACTLY: org + deleted_at IS NULL +
  // status='active' + item_type by view + is_rental=false + optional
  // warehouse — asserted by the 0227 pgTAP behavioral test. (The 0179
  // valuation views and get_dashboard_summary were checked and rejected:
  // neither carries the item_type split, and the latter also lacks
  // is_rental.) SECURITY: execute is revoked from anon/authenticated;
  // only this service-role client may call it, and the ORG SCOPE comes
  // from the loader's own cache key — never from user input.
  // NOTE (mig 0277): the RPC does not carry the awaiting_first_receipt
  // predicate the live sum now applies, but flagged rows sit at qty 0
  // (the DB trigger clears the flag the moment qty rises), so their
  // qty × cost contribution is exactly 0 — the figures stay equal.
  const { data, error } = await admin.rpc('inventory_value_on_hand', {
    p_organization_id: organizationId,
    p_item_type: itemType,
    p_warehouse_id: warehouseId,
  });
  // THROW-DON'T-CACHE: an RPC error must skip the unstable_cache write.
  if (error) {
    throw new Error(`inventory-list value rpc failed: ${error.message}`);
  }

  // numeric may serialize as a number or a numeric string — coerce, and
  // treat null/non-numeric as an error rather than caching a bogus 0
  // (Number(null) is 0 — recurring bug pattern: never cache a null).
  const value = data == null ? Number.NaN : Number(data);
  if (!Number.isFinite(value)) {
    throw new Error(`inventory-list value rpc returned a non-numeric result: ${String(data)}`);
  }
  return value;
}

/**
 * Cached ORG-WIDE 14-day movement buckets — the expensive half of the
 * per-row trend sparklines. Key = (organizationId) only: buckets are
 * per-item aggregates, so any view/warehouse/filter combination reads
 * just the ids it surfaced (deriveInventoryTrends). No warehouse or
 * item_type narrowing so a single cache entry serves Items, Books, and
 * every filtered variant.
 *
 * The bucket window is anchored at cache-fill time; entries live ≤60s
 * and are invalidated by every stock-writing path via the shared tag,
 * so the anchor drifts at most one TTL from request time — the same
 * staleness class the fully-cached default view has always had.
 *
 * keyPart is v2 (was v1): the cold fill moved from a JS bucketing pass
 * over paged raw rows to the inventory_trend_buckets SQL aggregate
 * (migration 0223). Same value shape, different provenance — the bump
 * orphans the v1 entries deliberately (one cheap recompute per org,
 * covered by the prewarm cron) instead of mixing provenances in one key.
 */
export async function loadInventoryTrendBuckets(
  organizationId: string,
): Promise<ItemTrendBuckets> {
  const cached = unstable_cache(loadInventoryTrendBucketsUncached, ['inventory-trend-buckets-v2'], {
    revalidate: LIST_TTL_SEC,
    tags: [inventoryListTag(organizationId)],
  });
  return cached(organizationId);
}

async function loadInventoryTrendBucketsUncached(
  organizationId: string,
): Promise<ItemTrendBuckets> {
  const admin = createAdminClient();

  // ONE SQL aggregate round trip (cold-start plan item 2, migration
  // 0223) instead of paging every org movement row in the window
  // through sequential 1000-row PostgREST pages. The RPC reproduces
  // getItemTrends' window semantics (org + 14×24h created_at window, no
  // other narrowing) and bucketTrendMovements' day math exactly —
  // asserted by the vitest parity suite and the 0223 pgTAP behavioral
  // test. SECURITY: execute is revoked from anon/authenticated; only
  // this service-role client may call it, and the ORG SCOPE comes from
  // the loader's own cache key — never from user input.
  const { data, error } = await admin.rpc('inventory_trend_buckets', {
    p_organization_id: organizationId,
    p_days: TREND_WINDOW_DAYS,
  });
  // THROW-DON'T-CACHE: an RPC error must skip the unstable_cache write.
  if (error) {
    throw new Error(`inventory-list trend-buckets rpc failed: ${error.message}`);
  }

  return bucketsFromTrendAggregates((data ?? []) as TrendAggregateRow[]);
}

/**
 * Per-request trend derivation for a LIVE (filtered) row set from the
 * cached org-wide buckets. Pure CPU — no round trip. Returns the same
 * Map shape as getItemTrends and, for identical underlying movements,
 * the same series (both run the shared lib/item-trends math; asserted
 * by the parity test in inventory-list.test.ts).
 */
export function deriveInventoryTrends(
  items: Array<{ id: string; quantityOnHand: number }>,
  buckets: ItemTrendBuckets,
): Map<string, ItemTrend> {
  const result = new Map<string, ItemTrend>();
  for (const it of items) {
    result.set(it.id, deriveItemTrend(it.quantityOnHand, buckets[it.id]));
  }
  return result;
}

/* ---- per-request image-URL resolution -------------------------------- */

/**
 * Resolves the cached rows' image PATHS into signed URLs — the seam
 * that keeps signing OUTSIDE the outer unstable_cache. Called by the
 * pages (and the prewarm cron) AFTER loadInventoryList returns, it
 * goes through the SAME 25-day per-path signed-URL cache the live path
 * uses (ItemImagesService.signedUrls) — ~free on cache hit, and the
 * URLs stay stable app-wide instead of rotating on every loader
 * recompute.
 *
 * Failure behavior mirrors the live path EXACTLY
 * (primaryImagesWithThumbsForItems + the pages' merge): an individual
 * sign failure (e.g. the one known-corrupt master in prod) degrades
 * that row to its custom_fields.thumbnail_url fallback with thumb/lqip
 * nulled — signedUrls never throws on per-path failures, so a bad
 * image can't break the cached view. No aggregate fail-closed
 * threshold is needed out here: nothing from this pass is ever cached
 * for a TTL, the next request simply resolves again.
 *
 * Output rows are shape-identical to the live branch's merged rows.
 *
 * PAYLOAD DIET (`opts.payloadDiet` — cold-start plan rank 5, instant-mode
 * dataset only): rows that HAVE a pre-resized thumb ship ONLY the thumb
 * URL — the 2048px master URL (used solely by hover-preview/lightbox) and
 * the lqip base64 are dropped, roughly halving both the Flight payload
 * and this function's sign fan-out. The client fetches the master on
 * demand from the org-scoped /api/items/[id]/image-master route (same
 * 25-day per-path cache → same stable URL). Rows WITHOUT a thumb keep
 * their master/cfThumb inline — it's their only image. The default-view
 * 30-row payload and every server-mode path stay full-fidelity.
 */
export async function resolveInventoryListImages(
  organizationId: string,
  rows: InventoryListCachedRow[],
  opts: { payloadDiet?: boolean } = {},
): Promise<InventoryListItemRow[]> {
  const diet = opts.payloadDiet === true;
  const paths = new Set<string>();
  for (const r of rows) {
    // Diet: don't even request a master sign for thumb-carrying rows —
    // this is where the rank-3 batch's fan-out halves.
    if (r.image_storage_path && !(diet && r.image_thumb_path)) paths.add(r.image_storage_path);
    if (r.image_thumb_path) paths.add(r.image_thumb_path);
  }
  const urlByPath =
    paths.size > 0
      ? await new ItemImagesService(adminReadContext(organizationId)).signedUrls([...paths])
      : new Map<string, string>();

  return rows.map((r) => {
    const { image_storage_path, image_thumb_path, image_lqip, ...rest } = r;
    const cf = rest.custom_fields;
    const cfThumb =
      cf && typeof cf === 'object' && typeof (cf as { thumbnail_url?: unknown }).thumbnail_url === 'string'
        ? ((cf as { thumbnail_url: string }).thumbnail_url)
        : null;
    if (diet && image_thumb_path) {
      const thumbUrl = urlByPath.get(image_thumb_path) ?? null;
      return {
        ...rest,
        // Master intentionally absent (fetched on demand); if the thumb
        // failed to sign, degrade to the cfThumb fallback like the full
        // path would for a failed master.
        image_url: thumbUrl ? null : cfThumb,
        image_thumb_url: thumbUrl,
        image_lqip: null,
      };
    }
    const masterUrl = image_storage_path ? (urlByPath.get(image_storage_path) ?? null) : null;
    const thumbUrl = image_thumb_path ? (urlByPath.get(image_thumb_path) ?? null) : null;
    return {
      ...rest,
      image_url: masterUrl ?? cfThumb ?? null,
      // The lqip/thumb only apply when the master URL resolved —
      // mirrors primaryImagesWithThumbsForItems, which omits items
      // whose master URL failed to sign (the pages then fall back to
      // cfThumb with no thumb/lqip, same as above).
      image_thumb_url: masterUrl ? thumbUrl : null,
      image_lqip: masterUrl ? image_lqip : null,
    };
  });
}

/**
 * The suppliers filter list is module-gated ('suppliers', optional
 * tier). The live path throws when the module is off; here we return
 * [] instead — fail-closed (no entitlement widening) without turning a
 * module toggle into a cached page error.
 *
 * Enablement MUST mirror getModulesForRequest (lib/dashboard/
 * request-cache.ts): a module is on either via an explicit
 * organization_modules row with enabled=true OR via the platform-console
 * "Comped — all modules" flag (organizations.all_modules_comp), which
 * enables every non-core module WITHOUT writing organization_modules
 * rows — and 'suppliers' is tier 'optional', so the comp covers it.
 * Checking only organization_modules would render a comped org's cached
 * default view with an empty suppliers list while every live-path view
 * shows the full one.
 */
async function loadSuppliersIfEnabled(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
): Promise<Array<{ id: string; name: string }>> {
  const [modRes, orgRes] = await Promise.all([
    admin
      .from('organization_modules')
      .select('enabled')
      .eq('organization_id', organizationId)
      .eq('module_id', 'suppliers')
      .maybeSingle(),
    admin
      .from('organizations')
      .select('all_modules_comp')
      .eq('id', organizationId)
      .maybeSingle(),
  ]);
  // FAIL CLOSED on read errors: throw so a failed pass is never cached
  // (the page falls back to the live path for this request).
  if (modRes.error) {
    throw new Error(`inventory-list module check failed: ${modRes.error.message}`);
  }
  if (orgRes.error) {
    throw new Error(`inventory-list org comp check failed: ${orgRes.error.message}`);
  }
  const comped = Boolean(
    (orgRes.data as { all_modules_comp?: boolean | null } | null)?.all_modules_comp,
  );
  // Comp wins even over an explicit enabled=false row — identical to
  // getModulesForRequest, which adds all non-core ids after the query.
  if (!modRes.data?.enabled && !comped) return [];
  const { data, error: listErr } = await admin
    .from('suppliers')
    .select('id, name')
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .order('name', { ascending: true });
  if (listErr) throw new Error(`inventory-list suppliers query failed: ${listErr.message}`);
  return (data ?? []).map((s) => ({ id: s.id as string, name: s.name as string }));
}

/* ---- prewarm (cron) ---------------------------------------------------- */

export interface InventoryListPrewarmResult {
  organizationId: string;
  /** 'all' (no warehouse-filter cookie — the common case) or a warehouse id. */
  warehouseKey: string;
  itemCount: number;
  bookCount: number;
  itemsMs: number;
  booksMs: number;
  itemsError: string | null;
  booksError: string | null;
}

/**
 * Warms the (org, warehouseKey) Items + Books default-view caches a
 * real manager-class visitor would hit — called by the prewarm cron so
 * a robot pays every cold path instead of the first human after a
 * deploy. Because loadInventoryList is a composition of the four
 * sub-loaders, each pass ALSO warms the shared lookup + trend-bucket +
 * value caches the FILTERED views reuse — no cron/signature change
 * needed. Errors are caught per view so one bad view doesn't fail the
 * whole cron run.
 */
export async function prewarmInventoryList(
  organizationId: string,
  warehouseId?: string | null,
): Promise<InventoryListPrewarmResult> {
  const warehouseKey = warehouseId ?? ALL_WAREHOUSES_KEY;
  let itemCount = 0;
  let bookCount = 0;
  let itemsError: string | null = null;
  let booksError: string | null = null;

  // Instant-mode dataset warm (≤ INSTANT_MODE_MAX_ROWS orgs): the full-
  // view rows AND their per-path signed URLs, same robot-pays-cold
  // philosophy as the default view below. Over-cap orgs return null
  // after one cheap head count — nothing to warm. Failures only warn:
  // the dataset cache is independent of the default-view cache, so a
  // dataset hiccup must not report the view's warm as failed (the pages
  // fall back to server mode on their own).
  const warmDataset = async (view: InventoryListView): Promise<void> => {
    try {
      const dataset = await loadInventoryDataset(organizationId, warehouseKey, view);
      if (dataset) await resolveInventoryListImages(organizationId, dataset.items);
    } catch (err) {
      console.warn(`[inventory-list] ${view} dataset prewarm skipped:`, err);
    }
  };

  const t0 = Date.now();
  try {
    const payload = await loadInventoryList(organizationId, warehouseKey, 'items');
    itemCount = payload.items.length;
    // Also walk the per-request URL-resolution seam so the robot pays
    // any cold per-path signs (25-day cache) instead of the first
    // human. Never throws — per-path failures degrade like a real
    // request would.
    await resolveInventoryListImages(organizationId, payload.items);
  } catch (err) {
    itemsError = err instanceof Error ? err.message : String(err);
  }
  await warmDataset('items');
  const t1 = Date.now();
  try {
    const payload = await loadInventoryList(organizationId, warehouseKey, 'books');
    bookCount = payload.items.length;
    await resolveInventoryListImages(organizationId, payload.items);
  } catch (err) {
    booksError = err instanceof Error ? err.message : String(err);
  }
  await warmDataset('books');
  const t2 = Date.now();

  return {
    organizationId,
    warehouseKey,
    itemCount,
    bookCount,
    itemsMs: t1 - t0,
    booksMs: t2 - t1,
    itemsError,
    booksError,
  };
}
