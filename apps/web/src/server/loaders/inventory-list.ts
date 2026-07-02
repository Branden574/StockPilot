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

import { revalidateTag, unstable_cache } from 'next/cache';

import { isSiteLocation } from '@/lib/locations/groups';
import { createAdminClient } from '@/lib/supabase/admin';
import { withContext, type ServiceContext } from '@/server/services/context';
import { ItemImagesService } from '@/server/services/item-images';
import { fetchAllRows } from '@/server/services/lib/paginate';
import { getItemTrends } from '@/server/services/movements';

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
 * same columns InventoryService.list() returns for the pages (its
 * select list verbatim) plus the derived placement fields.
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
  tracking_type: 'none' | 'lot' | 'serial';
  item_type: 'product' | 'book' | 'asset' | 'consumable';
  custom_fields: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  staged_quantity: number;
  unplaced_quantity: number;
  placed_quantity: number;
  placed_racks: string[];
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

export interface InventoryListPayload {
  items: InventoryListCachedRow[];
  total: number;
  valueOnHand: number;
  categories: Array<{ id: string; name: string; color: string | null }>;
  locations: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string; color: string | null }>;
  charters: Array<{ id: string; name: string; code: string | null }>;
  /** Serialized getItemTrends output (Maps don't survive the data cache). */
  trends: Record<string, { qtySeries: number[]; moveSeries: number[] }>;
  /** Serialized placementBreakdown — one line per non-empty holding. */
  placement: Record<string, InventoryPlacementLine[]>;
}

/* ---- loader ------------------------------------------------------------ */

/**
 * Cached default-view list payload. Key = (organizationId,
 * warehouseKey, view); tag = inventoryListTag(organizationId) so every
 * write path can invalidate all of an org's variants at once. The
 * unstable_cache wrapper is created per call because tags must carry
 * the org id — the implicit key (fn source + explicit keyParts + args)
 * is identical across calls, so entries are shared normally.
 */
export async function loadInventoryList(
  organizationId: string,
  warehouseKey: string,
  view: InventoryListView,
): Promise<InventoryListPayload> {
  // v2: rows carry image storage PATHS instead of signed URLs (URL
  // resolution moved outside the cache) — bumped so stale v1
  // URL-carrying entries can't be read as the new shape for a TTL.
  const cached = unstable_cache(loadInventoryListUncached, ['inventory-list-v2'], {
    revalidate: LIST_TTL_SEC,
    tags: [inventoryListTag(organizationId)],
  });
  return cached(organizationId, warehouseKey, view);
}

/**
 * Read-only synthetic context so the loader can reuse getItemTrends
 * (inside the cache) and resolveInventoryListImages can reuse the
 * 25-day per-path signed-URL cache in ItemImagesService (outside the
 * cache, per request) without re-deriving either. Same construction as
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

// Verbatim copy of InventoryService.list()'s select list so cached rows
// carry exactly the columns the live path ships.
const ITEM_SELECT_COLUMNS =
  'id, sku, barcode, model_number, name, description, status, quantity_on_hand, reorder_point, unit_cost, retail_price, category_id, supplier_id, primary_location_id, warehouse_id, charter_id, tracking_type, item_type, is_rental, custom_fields, created_at, updated_at, created_by, updated_by';

async function loadInventoryListUncached(
  organizationId: string,
  warehouseKey: string,
  view: InventoryListView,
): Promise<InventoryListPayload> {
  const admin = createAdminClient();
  const itemType = view === 'books' ? 'book' : 'product';
  const warehouseId = warehouseKey === ALL_WAREHOUSES_KEY ? null : warehouseKey;

  // Default-view filters, mirroring InventoryService.list() with no
  // searchParams: active, non-rental, not deleted, item_type by view,
  // updated_desc + stable id tiebreak, page 1 of 30, exact count.
  let mainQuery = admin
    .from('inventory_items')
    .select(ITEM_SELECT_COLUMNS, { count: 'exact' })
    .eq('organization_id', organizationId)
    .is('deleted_at', null)
    .eq('status', 'active')
    .eq('item_type', itemType)
    .eq('is_rental', false)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: true })
    .range(0, DEFAULT_VIEW_PAGE_SIZE - 1);
  if (warehouseId) mainQuery = mainQuery.eq('warehouse_id', warehouseId);

  // Skinny mirror of the same filter for the org-wide "$N on hand"
  // footer — paginated past PostgREST's 1000-row cap like the service.
  const buildSumPage = (from: number, to: number) => {
    let q = admin
      .from('inventory_items')
      .select('quantity_on_hand, unit_cost, reorder_point')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .eq('status', 'active')
      .eq('item_type', itemType)
      .eq('is_rental', false);
    if (warehouseId) q = q.eq('warehouse_id', warehouseId);
    return q.order('id', { ascending: true }).range(from, to);
  };

  const [mainRes, sumRows, categoriesRes, locationsRes, suppliers, tagsRes, chartersRes] =
    await Promise.all([
      mainQuery,
      fetchAllRows<{ quantity_on_hand: number; unit_cost: number; reorder_point: number }>(
        (from, to) => buildSumPage(from, to),
      ),
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
  if (mainRes.error) throw new Error(`inventory-list items query failed: ${mainRes.error.message}`);
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

  type RawRow = Omit<
    InventoryListCachedRow,
    | 'staged_quantity'
    | 'unplaced_quantity'
    | 'placed_quantity'
    | 'placed_racks'
    | 'image_storage_path'
    | 'image_thumb_path'
    | 'image_lqip'
  >;
  const rows = (mainRes.data ?? []) as unknown as RawRow[];
  const total = mainRes.count ?? 0;
  const valueOnHand = sumRows.reduce(
    (acc, r) => acc + (Number(r.quantity_on_hand) || 0) * (Number(r.unit_cost) || 0),
    0,
  );

  const ids = rows.map((r) => r.id);
  const ctx = adminReadContext(organizationId);

  // Second wave: holdings (placement), 14-day trends, primary images —
  // independent of each other, all keyed on the page's item ids.
  const [levelsRes, trendsMap, imageRowsRes] = await Promise.all([
    ids.length > 0
      ? admin
          .from('item_stock_levels')
          .select('item_id, location_id, quantity, locations!inner(name, kind)')
          .eq('organization_id', organizationId)
          .in('item_id', ids)
          .gt('quantity', 0)
      : Promise.resolve({ data: [], error: null }),
    getItemTrends(
      rows.map((r) => ({ id: r.id, quantityOnHand: Number(r.quantity_on_hand) })),
      { ctx },
    ),
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

  // ONE holdings query feeds both derivations the live path computes
  // separately (list()'s staged/unplaced/placed_racks scan and
  // placementBreakdown()) — identical inputs, identical outputs.
  const stagedByItem = new Map<string, number>();
  const unplacedByItem = new Map<string, number>();
  const placedRacksByItem = new Map<string, string[]>();
  const placement: Record<string, InventoryPlacementLine[]> = {};
  for (const lvl of (levelsRes.data ?? []) as unknown as Array<{
    item_id: string;
    location_id: string;
    quantity: number;
    locations: { name: string; kind: string | null };
  }>) {
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
  // wins). PATHS ONLY — no URL is ever minted inside this cached fn
  // (see the header note: a nested signedUrls call would overwrite the
  // shared 25-day per-path entries on every recompute). URLs are
  // resolved per request by resolveInventoryListImages.
  type ImageRow = {
    item_id: string;
    storage_path: string;
    thumb_path: string | null;
    lqip: string | null;
  };
  const pickByItem = new Map<string, ImageRow>();
  for (const row of (imageRowsRes.data ?? []) as ImageRow[]) {
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
      image_storage_path: img?.storage_path ?? null,
      image_thumb_path: img?.thumb_path ?? null,
      image_lqip: img?.lqip ?? null,
    };
  });

  const trends: InventoryListPayload['trends'] = {};
  for (const [id, t] of trendsMap) trends[id] = t;

  return {
    items,
    total,
    valueOnHand,
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
    trends,
    placement,
  };
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
 */
export async function resolveInventoryListImages(
  organizationId: string,
  rows: InventoryListCachedRow[],
): Promise<InventoryListItemRow[]> {
  const paths = new Set<string>();
  for (const r of rows) {
    if (r.image_storage_path) paths.add(r.image_storage_path);
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
 * deploy. Errors are caught per view so one bad view doesn't fail the
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
  const t1 = Date.now();
  try {
    const payload = await loadInventoryList(organizationId, warehouseKey, 'books');
    bookCount = payload.items.length;
    await resolveInventoryListImages(organizationId, payload.items);
  } catch (err) {
    booksError = err instanceof Error ? err.message : String(err);
  }
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
