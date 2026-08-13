import 'server-only';

// Data loaders for /dashboard/orders/new (storefront picker).
//
// WHY THIS LIVES OUTSIDE page.tsx (perf plan P3, 2026-07-01):
// `unstable_cache`'s implicit key includes a hash of the wrapped
// closure, so every edit to the module containing a cached loader
// rotates its cache key on deploy. While these loaders lived in
// page.tsx, every UI tweak hard-reset the catalog/thumb-map/charters
// caches — the owner's "reload right after deploy" always hit the
// fully cold path. In this rarely-touched module, UI edits no longer
// annihilate the caches. Keep UI concerns out of this file.

import { unstable_cache } from 'next/cache';

import type { StorefrontCatalogData } from '@/components/orders/storefront/orders-storefront';
import type { AisleSummary, CatalogItem, StorefrontCharter } from '@/components/orders/v2/types';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Catalog items + thumbnail media merged into the streamed payload.
 *
 * PAYLOAD DIET: an item that has a resolved thumbnail URL ships with
 * `lqip: null` — the blur-up only matters while no real image URL
 * exists, and 350 inline base64 blurs were dead weight in the RSC
 * payload. Items whose URL failed to sign keep their lqip so cards
 * still blur-up instead of flashing the glyph.
 */
export async function loadCatalogBundle(
  organizationId: string,
  warehouseId: string,
  userId: string,
): Promise<StorefrontCatalogData> {
  const [items, mediaMap] = await Promise.all([
    loadCatalogItems(organizationId, warehouseId, userId),
    // A thrown batch-sign failure is deliberately NOT cached (see the
    // map fn); degrade to a photo-less catalog for THIS request and
    // let the next one retry instead of rejecting the Suspense
    // boundary into the error page.
    loadCatalogThumbMapCached(organizationId, warehouseId).catch((err) => {
      console.warn(
        `[orders-new] thumb map unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {} as Record<string, CatalogItemMedia>;
    }),
  ]);

  const merged = items.map((it) => {
    const media = mediaMap[it.id];
    if (!media) return it;
    return {
      ...it,
      imageUrl: media.url,
      lqip: media.url ? null : media.lqip,
    };
  });

  return { items: merged, aisles: buildAisles(merged) };
}

/**
 * Warehouse-scoped thumbnail-URL map, cached INDEPENDENTLY of the
 * stock loader. Decoupled cadences: stock stays fresh at 60s, the URL
 * map recomputes at most every 4 hours — safe because the signed URLs
 * are 30-day valid. Thumbnails aren't access-scoped (any org member
 * who can open the picker may see product photos), so no accessKey in
 * the cache key.
 *
 * Also carries each item's LQIP blur: image rows change on the same
 * cadence as their thumbnails, so pulling the blurs out of the stock
 * loader saves that loader an entire item_images query.
 */
export interface CatalogItemMedia {
  url: string | null;
  lqip: string | null;
}

/** Signed URLs valid 30 days; the 4h map cadence re-signs well inside it. */
const THUMB_SIGNED_URL_TTL_SEC = 30 * 24 * 60 * 60;
const THUMB_TRANSFORM_WIDTH = 200;
/**
 * Legacy transform signs are individual POSTs to Supabase storage —
 * cap the parallelism so a catalog with hundreds of pre-0122 images
 * (L4L had 270) doesn't fire an unbounded sign storm per recompute.
 * scripts/backfill-item-thumbs.mjs exists to shrink this branch to
 * zero; the cap protects any org that hasn't been backfilled yet.
 */
const TRANSFORM_SIGN_CONCURRENCY = 20;
/**
 * FAIL-CLOSED threshold: if more than this fraction of attempted signs
 * fail, THROW so unstable_cache does not persist a partially photo-less
 * map for 4h (a storage blip would otherwise blank images until the
 * next recompute). Below the threshold, isolated per-path failures
 * degrade to lqip-only for just those items.
 */
const SIGN_FAILURE_THROW_RATIO = 0.1;

// v2 (FIX 5): value shape changed from Record<string, string> to
// Record<string, CatalogItemMedia> — key bumped so stale v1 entries
// can't be read as the new shape for up to 4h. (Later signing-strategy
// changes kept the shape, so the key stays v2.)
export const loadCatalogThumbMapCached = unstable_cache(
  async (
    organizationId: string,
    warehouseId: string,
  ): Promise<Record<string, CatalogItemMedia>> => {
    const supabase = createAdminClient();
    // Mirror the catalog loader's item scoping with an inner join on
    // inventory_items so only this warehouse's images get signed.
    const { data } = await supabase
      .from('item_images')
      .select(
        'item_id, lqip, thumb_path, storage_path, is_primary, sort_order, item:inventory_items!inner(warehouse_id)',
      )
      .eq('organization_id', organizationId)
      .eq('item.warehouse_id', warehouseId)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true });

    // First row per item wins (is_primary DESC + sort_order ASC).
    const rowByItem = new Map<
      string,
      { lqip: string | null; thumbPath: string | null; storagePath: string | null }
    >();
    for (const row of (data ?? []) as Array<{
      item_id: string;
      lqip: string | null;
      thumb_path: string | null;
      storage_path: string | null;
    }>) {
      if (!rowByItem.has(row.item_id)) {
        rowByItem.set(row.item_id, {
          lqip: row.lqip ?? null,
          thumbPath: row.thumb_path ?? null,
          storagePath: row.storage_path ?? null,
        });
      }
    }

    // BATCH signing: ONE createSignedUrls call covers every
    // pre-generated thumb; only legacy rows without a thumb_path
    // (uploads predating migration 0122) need individual transform
    // signs, because createSignedUrls doesn't support transforms.
    const media: Record<string, CatalogItemMedia> = {};
    const thumbBatch: Array<{ itemId: string; path: string }> = [];
    const transformBatch: Array<{ itemId: string; path: string }> = [];
    for (const [itemId, row] of rowByItem) {
      // Sign the MASTER (storage_path), not the 200px thumb: the storefront
      // card renders through next/image (SfPhoto), whose optimizer downscales
      // the master to the exact retina cell + AVIF/WebP + 24h edge cache.
      // Feeding a 200px thumb to a plain <img> made it upscale (blurry on
      // retina). One batched createSignedUrls covers all masters — same
      // signing cost as before. thumb_path is the fallback if a row somehow
      // lacks a master; the legacy transform branch is now unused.
      const path = row.storagePath ?? row.thumbPath;
      if (path) thumbBatch.push({ itemId, path });
      else if (row.lqip) media[itemId] = { url: null, lqip: row.lqip };
    }

    let failedSigns = 0;
    const attemptedSigns = thumbBatch.length + transformBatch.length;

    if (thumbBatch.length > 0) {
      const { data: signed, error } = await supabase.storage
        .from('item-images')
        .createSignedUrls(
          thumbBatch.map((t) => t.path),
          THUMB_SIGNED_URL_TTL_SEC,
        );
      // THROW on whole-batch failure so unstable_cache does NOT persist
      // a photo-less map for 4h (same throw-don't-cache posture as the
      // signers in item-images.ts). loadCatalogBundle catches → the
      // page degrades to glyph/lqip cards and the next visit retries.
      if (error) {
        throw new Error(`thumb batch sign failed: ${error.message}`);
      }
      const urlByPath = new Map<string, string>();
      for (const s of signed ?? []) {
        if (s.path && s.signedUrl && !s.error) urlByPath.set(s.path, s.signedUrl);
      }
      for (const t of thumbBatch) {
        const row = rowByItem.get(t.itemId)!;
        const url = urlByPath.get(t.path) ?? null;
        if (!url) failedSigns += 1;
        if (url || row.lqip) media[t.itemId] = { url, lqip: row.lqip };
      }
    }

    // Legacy no-thumb rows: individually signed 200px transforms, in
    // bounded chunks (see TRANSFORM_SIGN_CONCURRENCY).
    for (let i = 0; i < transformBatch.length; i += TRANSFORM_SIGN_CONCURRENCY) {
      const chunk = transformBatch.slice(i, i + TRANSFORM_SIGN_CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ itemId, path }) => {
          const row = rowByItem.get(itemId)!;
          try {
            const { data: t, error } = await supabase.storage
              .from('item-images')
              .createSignedUrl(path, THUMB_SIGNED_URL_TTL_SEC, {
                transform: {
                  width: THUMB_TRANSFORM_WIDTH,
                  height: THUMB_TRANSFORM_WIDTH,
                  resize: 'cover',
                },
              });
            const url = error ? null : (t?.signedUrl ?? null);
            if (!url) failedSigns += 1;
            if (url || row.lqip) media[itemId] = { url, lqip: row.lqip };
          } catch {
            failedSigns += 1;
            if (row.lqip) media[itemId] = { url: null, lqip: row.lqip };
          }
        }),
      );
    }

    // FAIL-CLOSED: a mostly-failed sign pass must not become the 4h
    // truth. Throwing skips the cache write; the next request retries.
    if (attemptedSigns > 0 && failedSigns / attemptedSigns > SIGN_FAILURE_THROW_RATIO) {
      throw new Error(
        `thumb map sign failure ratio too high (${failedSigns}/${attemptedSigns}) — not caching`,
      );
    }

    return media;
  },
  // v3: URLs now point at the master (storage_path) for next/image, not the
  // 200px thumb — bump so the 4h-cached thumb URLs don't linger post-deploy.
  ['orders-new-thumbmap-v3'],
  { revalidate: 4 * 60 * 60, tags: ['orders-new-thumbmap'] },
);

/**
 * Charters per warehouse change rarely — cache for 5 minutes. Same
 * admin-client + page-perimeter argument as the catalog cache.
 *
 * `address` (jsonb) rides along so the delivery-request assistant can print a
 * street address on the success screen WITHOUT a server round-trip inside the
 * click handler. That matters: window.open must run in the same tick as the
 * click or the browser blocks the popup, so any await before it is fatal.
 *
 * The key is v2 because the returned SHAPE changed. Leaving it at v1 would let
 * up-to-5-minute-old entries without `address` linger after the deploy, and the
 * address would silently be missing for the first users — the same trap the
 * thumbmap loader above documents.
 */
const loadChartersForWarehouseCached = unstable_cache(
  async (warehouseId: string): Promise<StorefrontCharter[]> => {
    const supabase = createAdminClient();
    const { data: pairs } = await supabase
      .from('warehouse_charters')
      .select('charter:charters!inner (id, name, code, status, address)')
      .eq('warehouse_id', warehouseId);
    return (pairs ?? []).flatMap((p) => {
      const c = Array.isArray((p as { charter?: unknown }).charter)
        ? ((p as { charter: unknown[] }).charter[0] as Record<string, unknown>)
        : ((p as { charter: unknown }).charter as Record<string, unknown> | null);
      if (!c || (c.status as string) !== 'active') return [];
      const raw = c.address;
      // jsonb: could be null, an object, or (defensively) a scalar. Anything
      // that is not a plain object is treated as "no address".
      const address =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as StorefrontCharter['address'])
          : null;
      return [
        {
          id: c.id as string,
          name: c.name as string,
          code: (c.code as string | null) ?? null,
          address,
        },
      ];
    });
  },
  ['orders-new-v2-charters-v2'],
  { revalidate: 300, tags: ['orders-new-v2-charters'] },
);

export async function loadChartersForWarehouse(
  warehouseId: string,
): Promise<StorefrontCharter[]> {
  return loadChartersForWarehouseCached(warehouseId);
}

/**
 * Returns a stable string that uniquely identifies a user's
 * category-access pattern. Used as a cache-key component so a
 * restricted viewer's payload doesn't get served to other users
 * (or vice versa). Truth table mirrors
 * `user_can_see_item_category` from migration 0128:
 *
 *   role = manager/admin/owner/staff               → 'ALL'
 *   role = viewer + 0 grants                        → 'ALL' (unrestricted default)
 *   role = viewer + N grants                        → 'v:c1,c2,c3...' (sorted)
 *   no membership                                   → 'NONE'
 *
 * Cached 60s per (org, user) — perf plan P4. These are 1–2 serial
 * admin queries that used to run on EVERY request inside the catalog
 * promise. SECURITY TRADEOFF, documented deliberately: a role change
 * or category-grant change takes up to 60s to affect which CACHED
 * CATALOG VARIANT a user is served (e.g. a just-restricted viewer may
 * see the broader item list for ≤60s). This only scopes the picker
 * payload — RLS still governs every read/write the user actually
 * performs, and order submission re-validates server-side.
 */
const loadAccessibleCategoryKeyCached = unstable_cache(
  async (organizationId: string, userId: string): Promise<string> => {
    const admin = createAdminClient();
    const { data: member } = await admin
      .from('organization_members')
      .select('role')
      .eq('user_id', userId)
      .eq('organization_id', organizationId)
      .maybeSingle();
    const role = (member as { role?: string } | null)?.role;
    if (!role) return 'NONE';
    if (role !== 'viewer') return 'ALL';

    const { data: rows } = await admin
      .from('user_category_assignments')
      .select('category_id')
      .eq('user_id', userId)
      .eq('organization_id', organizationId);
    const ids = ((rows ?? []) as Array<{ category_id: string }>)
      .map((r) => r.category_id)
      .sort();
    if (ids.length === 0) return 'ALL';
    return 'v:' + ids.join(',');
  },
  ['orders-new-accesskey-v1'],
  { revalidate: 60, tags: ['orders-new-accesskey'] },
);

async function loadAccessibleCategoryKey(
  organizationId: string,
  userId: string,
): Promise<string> {
  return loadAccessibleCategoryKeyCached(organizationId, userId);
}

/**
 * Loads catalog items for the storefront picker. Returns CatalogItem[]
 * with everything the card grid needs to render: price,
 * available-to-promise, rack label, category name. Bundles are
 * filtered out (phantom rows).
 *
 * Wrapped in unstable_cache (60s TTL, keyed by orgId + warehouseId +
 * accessKey). The accessKey is critical: without it a manager's
 * full-catalog payload would be served to a restricted viewer
 * hitting the same warehouse (RLS is bypassed in here because the
 * admin client is used to dodge cookies). Bumped to v2 prefix when
 * the access-key component was added — cold cache forced.
 *
 * Admin client is used inside the cache so the cached value doesn't
 * capture per-user cookies. The page-level perimeter (requireOrgContext
 * + warehouse list scoping) guarantees only warehouseIds the user
 * is authorized to see ever get passed in.
 *
 * TTL tradeoff (FIX 5): 30s → 60s halves the cache-miss rate for the
 * heaviest per-request work. The cost is availability numbers being up
 * to a minute stale on cards — acceptable because they're advisory:
 * the submit path re-validates against live stock/reservations, and
 * the cap warnings in the cart handle any drift.
 */
export const loadCatalogItemsCached = unstable_cache(
  async (
    organizationId: string,
    warehouseId: string,
    accessKey: string,
  ): Promise<CatalogItem[]> => {
    return loadCatalogItemsUncached(organizationId, warehouseId, accessKey);
  },
  ['orders-new-v2-catalog-v2'],
  { revalidate: 60, tags: ['orders-new-v2-catalog'] },
);

export async function loadCatalogItems(
  organizationId: string,
  warehouseId: string,
  userId: string,
): Promise<CatalogItem[]> {
  const accessKey = await loadAccessibleCategoryKey(organizationId, userId);
  return loadCatalogItemsCached(organizationId, warehouseId, accessKey);
}

/** The four flattened rack keys this loader selects, plus what decides between
 *  them. Declared so `rackLabelFor` can live at module scope and be TESTED. */
export interface OrdersCatalogRackRow {
  item_type: string | null;
  bin_location: string | null;
  rack_number: string | null;
  rack_row: string | null;
  book_rack_number: string | null;
  book_rack_row: string | null;
}

/**
 * The storefront card's walk-to label — and THE ONE DELIBERATE EXCEPTION to
 * `resolvePlacement` (packages/core/src/inventory/placement-resolution.ts).
 *
 * ═══ DO NOT "HARMONISE" THIS TO THE OTHERS ═══
 *
 * Every other picker-facing formatter prefers the structured rack pair over
 * `bin_location`. This one is BIN-FIRST, and post-0335 that inversion is what
 * makes it the only pair-reader in the repo that was never wrong: a put-away
 * stamps `bin_location` and nothing else, so the label names the crate the
 * stock is actually in, while `custom_fields.rack_number` can still name the
 * rack it left.
 *
 * The reason this loader does not simply call `resolvePlacement` is that it
 * carries NO HOLDINGS. It is `unstable_cache`d and perf-critical (see the
 * orders-storefront perf notes), and the resolver with an empty holdings array
 * falls through to the structured pair FIRST — so adopting it here WITHOUT
 * also fetching holdings would replace a correct rule with a stale one.
 *
 * The right end state is holdings + `resolvePlacement`, same as everywhere
 * else; that is a measured perf change, not a drive-by. Until then the rule
 * below is pinned BY LITERAL VALUE in placement-label.guard.test.ts so it
 * cannot drift in either direction.
 */
export function rackLabelFor(it: OrdersCatalogRackRow): string | null {
  if (it.bin_location && it.bin_location.trim()) return it.bin_location.trim();
  const num = it.item_type === 'book' ? it.book_rack_number : it.rack_number;
  const row = it.item_type === 'book' ? it.book_rack_row : it.rack_row;
  if (!num) return null;
  return row ? `${num}-${row}` : String(num);
}

async function loadCatalogItemsUncached(
  organizationId: string,
  warehouseId: string,
  accessKey: string,
): Promise<CatalogItem[]> {
  const supabase = createAdminClient();

  // Parse the allow-list (if any) from the access key. NONE = no
  // memberships, return empty payload defensively. ALL = unrestricted,
  // skip the filter entirely.
  let allowedCategoryIds: Set<string> | null = null;
  if (accessKey === 'NONE') return [];
  if (accessKey.startsWith('v:')) {
    allowedCategoryIds = new Set(accessKey.slice(2).split(',').filter(Boolean));
  }

  // custom_fields is fetched as FOUR flattened rack keys (PostgREST
  // `->>` extraction) instead of wholesale: the picker only needs the
  // rack/row pair for the rackLabel, and book rows carry large
  // custom_fields blobs (descriptions, grades, authors) that were
  // inflating the query transfer for nothing. `is_bundle` is filter-only
  // (the .or below), so it isn't selected either.
  let itemsQuery = supabase
    .from('inventory_items')
    .select(
      'id, name, sku, quantity_on_hand, warehouse_id, item_type, bin_location, category_id, charter_id, retail_price, unit_cost, reorder_point, rack_number:custom_fields->>rack_number, rack_row:custom_fields->>rack_row, book_rack_number:custom_fields->>book_rack_number, book_rack_row:custom_fields->>book_rack_row',
    )
    .eq('organization_id', organizationId)
    .eq('warehouse_id', warehouseId)
    .eq('status', 'active')
    // Rental items (canopies, supplies for school events) are a
    // separate inventory class — they circulate via /dashboard/rentals,
    // not the order request flow. Never show them in the order picker.
    .eq('is_rental', false)
    // Expected items (mig 0277): auto-created from an inbound PO and
    // never received — not orderable until the first stock arrives
    // (server-side line validation rejects them too, so a stale cached
    // catalog can't sneak one through).
    .eq('awaiting_first_receipt', false)
    .is('deleted_at', null)
    .or('is_bundle.is.null,is_bundle.eq.false')
    .order('name', { ascending: true })
    .limit(500);

  // Defense-in-depth: filter by the user's category allow-list at the
  // admin-client query level too. Restricted viewers never see
  // null-category items (matches the RLS truth table). Unrestricted
  // (ALL) callers skip this filter entirely.
  if (allowedCategoryIds !== null) {
    if (allowedCategoryIds.size === 0) return [];
    itemsQuery = itemsQuery.in('category_id', [...allowedCategoryIds]);
  }

  const { data: itemsData } = await itemsQuery;

  const items = (itemsData ?? []) as unknown as Array<{
    id: string;
    name: string;
    sku: string;
    quantity_on_hand: number;
    warehouse_id: string;
    item_type: string | null;
    bin_location: string | null;
    category_id: string | null;
    charter_id: string | null;
    retail_price: number | null;
    unit_cost: number | null;
    reorder_point: number | null;
    // Flattened from custom_fields via `->>` (always text or null).
    rack_number: string | null;
    rack_row: string | null;
    book_rack_number: string | null;
    book_rack_row: string | null;
  }>;
  if (items.length === 0) return [];

  const itemIds = items.map((i) => i.id);
  const categoryIds = [...new Set(items.map((i) => i.category_id).filter((v): v is string => Boolean(v)))];
  const charterIds = [...new Set(items.map((i) => i.charter_id).filter((v): v is string => Boolean(v)))];

  // Reservations + category names + charter names in parallel. NO
  // media work happens in here: thumbnail URLs and LQIP blurs come
  // from loadCatalogThumbMapCached (4h cadence) and are merged in
  // loadCatalogBundle — this loader is pure stock/catalog reads.
  const [rsRes, categoriesRes, chartersRes] = await Promise.all([
    supabase
      .from('stock_reservations')
      .select('item_id, quantity')
      .eq('organization_id', organizationId)
      .in('item_id', itemIds)
      .is('released_at', null),
    categoryIds.length > 0
      ? supabase
          .from('categories')
          .select('id, name')
          .eq('organization_id', organizationId)
          .in('id', categoryIds)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }> }),
    charterIds.length > 0
      ? supabase
          .from('charters')
          .select('id, name, code')
          .eq('organization_id', organizationId)
          .in('id', charterIds)
      : Promise.resolve({
          data: [] as Array<{ id: string; name: string; code: string | null }>,
        }),
  ]);

  const reservedByItem = new Map<string, number>();
  for (const row of (rsRes.data ?? []) as Array<{ item_id: string; quantity: number }>) {
    reservedByItem.set(
      row.item_id,
      (reservedByItem.get(row.item_id) ?? 0) + Number(row.quantity),
    );
  }

  const categoryNameById = new Map<string, string>();
  for (const c of (categoriesRes.data ?? []) as Array<{ id: string; name: string }>) {
    categoryNameById.set(c.id, c.name);
  }

  const charterById = new Map<string, { name: string; code: string | null }>();
  for (const c of (chartersRes.data ?? []) as Array<{
    id: string;
    name: string;
    code: string | null;
  }>) {
    charterById.set(c.id, { name: c.name, code: c.code ?? null });
  }

  return items.map((it) => ({
    id: it.id,
    sku: it.sku,
    name: it.name,
    warehouseId: it.warehouse_id,
    quantityOnHand: Number(it.quantity_on_hand) || 0,
    reservedQuantity: reservedByItem.get(it.id) ?? 0,
    itemType: it.item_type ?? null,
    categoryId: it.category_id ?? null,
    categoryName: it.category_id ? categoryNameById.get(it.category_id) ?? null : null,
    charterId: it.charter_id ?? null,
    charterName: it.charter_id ? charterById.get(it.charter_id)?.name ?? null : null,
    charterCode: it.charter_id ? charterById.get(it.charter_id)?.code ?? null : null,
    rackLabel: rackLabelFor(it),
    // Both merged in loadCatalogBundle from loadCatalogThumbMapCached —
    // media lives on a 4h cadence, not this 60s stock loader.
    imageUrl: null,
    lqip: null,
    // Price: retail first, then cost, then null. The v2 picker shows
    // "—" for null, and the cart estimated total excludes them.
    price:
      typeof it.retail_price === 'number'
        ? it.retail_price
        : typeof it.unit_cost === 'number'
        ? it.unit_cost
        : null,
    reorderPoint: Number(it.reorder_point) || 0,
  }));
}

/**
 * Derives the aisle summary list from the loaded catalog items.
 * Named aisles are sorted alphabetically; the synthetic "Uncategorized"
 * bucket appears last if any items have no category.
 */
function buildAisles(items: CatalogItem[]): AisleSummary[] {
  const countById = new Map<string, number>();
  let uncategorizedCount = 0;
  const nameById = new Map<string, string>();

  for (const it of items) {
    if (it.categoryId === null) {
      uncategorizedCount++;
    } else {
      countById.set(it.categoryId, (countById.get(it.categoryId) ?? 0) + 1);
      if (it.categoryName) nameById.set(it.categoryId, it.categoryName);
    }
  }

  const named: AisleSummary[] = Array.from(countById.entries())
    .map(([id, itemCount]) => ({
      id,
      name: nameById.get(id) ?? id,
      itemCount,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (uncategorizedCount > 0) {
    named.push({ id: null, name: 'Uncategorized', itemCount: uncategorizedCount });
  }

  return named;
}

/* ---- prewarm (cron) -------------------------------------------------- */

export interface PrewarmPairResult {
  organizationId: string;
  warehouseId: string;
  itemCount: number;
  mediaCount: number;
  charterCount: number;
  catalogMs: number;
  thumbMapMs: number;
  chartersMs: number;
  thumbMapError: string | null;
}

/**
 * Warms the caches a real visitor would hit, for one org×warehouse
 * pair. Uses accessKey 'ALL' — the variant every manager/admin/staff
 * request resolves to (restricted-viewer variants are per-user and
 * not worth prewarming). Called by the prewarm cron so the first human
 * after a deploy lands on warm caches instead of the sign-storm path.
 */
export async function prewarmOrdersNewCatalog(
  organizationId: string,
  warehouseId: string,
): Promise<PrewarmPairResult> {
  const t0 = Date.now();
  const items = await loadCatalogItemsCached(organizationId, warehouseId, 'ALL');
  const t1 = Date.now();
  let mediaCount = 0;
  let thumbMapError: string | null = null;
  try {
    const media = await loadCatalogThumbMapCached(organizationId, warehouseId);
    mediaCount = Object.keys(media).length;
  } catch (err) {
    thumbMapError = err instanceof Error ? err.message : String(err);
  }
  const t2 = Date.now();
  const charters = await loadChartersForWarehouse(warehouseId);
  const t3 = Date.now();

  return {
    organizationId,
    warehouseId,
    itemCount: items.length,
    mediaCount,
    charterCount: charters.length,
    catalogMs: t1 - t0,
    thumbMapMs: t2 - t1,
    chartersMs: t3 - t2,
    thumbMapError,
  };
}
