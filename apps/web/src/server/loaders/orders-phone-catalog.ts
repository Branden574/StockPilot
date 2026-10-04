import 'server-only';

// Cached loaders for the phone storefront's photo route (phone ordering PO-3,
// GET /api/v1/orders/catalog/photos).
//
// WHY A FILE OF ITS OWN. unstable_cache builds its key from the wrapped
// callback's compiled text (next/dist/server/web/spec-extension/
// unstable-cache.js: `${cb.toString()}-${keyParts}`), so an edit that moves the
// compiled text of a cached callback rotates its cache on deploy. The web
// storefront's cached loaders live in orders-new-catalog.ts and are frozen
// (their initializers are pinned by orders-new-catalog.cached.guard.test.ts);
// the phone's own cached map lives here, with its own key and tag, so neither
// can move the other. Keep UI and request logic out of this file.
//
// BEARER-SAFE. Nothing here reads a cookie session: the map is per
// organization and warehouse (photos are not access-scoped; the caller's own
// catalog decides which entries leave the server, in OrderStorefrontService),
// read with the admin client inside the cache so no user's session is
// captured in the cached value. A guard test fails on any cookie-session
// helper named in this file.

import { unstable_cache } from 'next/cache';

import { ORDER_PHOTO_URL_TTL_SECONDS } from '@stockpilot/core';

import { createAdminClient } from '@/lib/supabase/admin';
import { ServiceError } from '@/server/services/context';
import { fetchAllRows } from '@/server/services/lib/paginate';

/**
 * One warehouse's photo URLs for the phone: item id to a signed URL of the
 * item's first photo (is_primary first, then sort_order, then id), its
 * pre-made thumbnail when it has one, else the master. `signedAt` is when the
 * URLs were signed: each is valid for ORDER_PHOTO_URL_TTL_SECONDS from then.
 */
export interface PhoneThumbMap {
  signedAt: string;
  photos: Record<string, string>;
}

/**
 * Paths per createSignedUrls call: NEVER more than 1000. storage-api refuses a
 * longer `paths` list with a 400 for the whole call (MAX_OBJECTS_PER_REQUEST,
 * supabase/storage#1160; memory reference_storage_signed_urls_1000_cap), and
 * storage-js does not chunk. One call at a time: the chunks keep each body
 * small, they are not there to add parallel load on storage.
 */
export const PHONE_SIGN_PATHS_PER_CALL = 1000;

/**
 * FAIL CLOSED: past this fraction of failed signs the map THROWS, so
 * unstable_cache stores nothing and the next request retries. A storage blip
 * would otherwise blank the photos for 4 h (pattern #6). Below it, the few
 * items whose sign failed are left out and show their glyph.
 */
const SIGN_FAILURE_THROW_RATIO = 0.1;

/**
 * Serialized-size warning. Next 16 does not cache an unstable_cache entry over
 * 2 MB (it warns and skips the write), so every request would then re-page the
 * image rows and re-sign every photo. Each entry is one signed URL (~500
 * bytes); 1.5 MB is ~3,000 photographed items.
 */
const PHONE_THUMB_MAP_WARN_CHARS = 1.5 * 1024 * 1024;

type ImageRow = {
  item_id: string;
  thumb_path: string | null;
  storage_path: string | null;
};

/**
 * The phone's photo map, cached per (organization, warehouse) for 4 hours
 * (the URLs are valid 30 days, so a 4-hour-old URL has weeks left).
 *
 * THUMBNAIL FIRST. The web map signs the master because next/image downscales
 * it; the phone shows the URL as it is, in a 56-point cell, so the 200 px
 * thumbnail (thumb_path) is the right file and a fraction of the bytes. An
 * item with no thumbnail yet gets its master until the backfill makes one.
 *
 * The same image rows as the web map: EVERY row, paged past PostgREST's
 * 1000-row cap, of not-deleted items of this warehouse (archived items keep
 * theirs: an unarchived item is back in the catalog within 60 s). Never calls
 * another cached helper (pattern #13): a cache inside a cache freezes the
 * inner value under the outer key.
 *
 * THROWS (never caches) when the image rows cannot be read, when any sign call
 * fails, or when more than 10% of the signs fail.
 */
export const loadPhoneThumbMapCached = unstable_cache(
  async (organizationId: string, warehouseId: string): Promise<PhoneThumbMap> => {
    const supabase = createAdminClient();
    let rows: ImageRow[];
    try {
      rows = await fetchAllRows<ImageRow>(
        (from, to) =>
          supabase
            .from('item_images')
            .select(
              'item_id, thumb_path, storage_path, is_primary, sort_order, item:inventory_items!inner(warehouse_id)',
            )
            .eq('organization_id', organizationId)
            .eq('item.warehouse_id', warehouseId)
            .is('item.deleted_at', null)
            .order('is_primary', { ascending: false })
            .order('sort_order', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to) as unknown as PromiseLike<{
            data: ImageRow[] | null;
            error: { message: string } | null;
          }>,
      );
    } catch (err) {
      const cause =
        err instanceof ServiceError
          ? (err.internalDetail ?? err.message)
          : err instanceof Error
            ? err.message
            : String(err);
      throw new Error(`[orders-phone] photo map image rows read failed: ${cause}`);
    }

    // First row per item wins (is_primary DESC, sort_order ASC, id ASC).
    const pathByItem = new Map<string, string>();
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.item_id)) continue;
      seen.add(row.item_id);
      const path = row.thumb_path ?? row.storage_path;
      if (path) pathByItem.set(row.item_id, path);
    }

    const toSign = [...pathByItem.entries()].map(([itemId, path]) => ({ itemId, path }));
    const signedAt = new Date();
    const photos: Record<string, string> = {};
    let failed = 0;
    for (let i = 0; i < toSign.length; i += PHONE_SIGN_PATHS_PER_CALL) {
      const chunk = toSign.slice(i, i + PHONE_SIGN_PATHS_PER_CALL);
      const { data, error } = await supabase.storage
        .from('item-images')
        .createSignedUrls(
          chunk.map((t) => t.path),
          ORDER_PHOTO_URL_TTL_SECONDS,
        );
      // Any failed call fails the whole map: never a partly photo-less map
      // cached for 4 h.
      if (error) {
        throw new Error(
          `[orders-phone] photo sign failed (paths ${i + 1}-${i + chunk.length} of ${toSign.length}): ${error.message}`,
        );
      }
      const urlByPath = new Map<string, string>();
      for (const s of data ?? []) {
        if (s.path && s.signedUrl && !s.error) urlByPath.set(s.path, s.signedUrl);
      }
      for (const t of chunk) {
        const url = urlByPath.get(t.path);
        if (url) photos[t.itemId] = url;
        else failed += 1;
      }
    }

    if (toSign.length > 0 && failed / toSign.length > SIGN_FAILURE_THROW_RATIO) {
      throw new Error(
        `[orders-phone] photo map sign failure ratio too high (${failed}/${toSign.length}), not caching`,
      );
    }

    const map: PhoneThumbMap = { signedAt: signedAt.toISOString(), photos };
    const chars = JSON.stringify(map).length;
    if (chars > PHONE_THUMB_MAP_WARN_CHARS) {
      console.warn(
        `[orders-phone] photo map for warehouse ${warehouseId}: ${Object.keys(photos).length} entries, ${chars} chars serialized, past the 1.5 MB warning line; Next does not cache an entry over 2 MB, so past that every request rebuilds and re-signs it`,
      );
    }
    return map;
  },
  ['orders-phone-thumbmap-v1'],
  { revalidate: 4 * 60 * 60, tags: ['orders-phone-thumbmap'] },
);

export interface PhoneThumbMapPrewarmResult {
  organizationId: string;
  warehouseId: string;
  photoCount: number;
  ms: number;
  error: string | null;
}

/**
 * Warms the phone's photo map for one pair. Called by the prewarm cron only
 * (never from a request path: no-request-path-prewarm.guard.test.ts). Never
 * rejects: a failure is reported in the result and the sweep goes on.
 */
export async function prewarmPhoneThumbMap(
  organizationId: string,
  warehouseId: string,
): Promise<PhoneThumbMapPrewarmResult> {
  const t0 = Date.now();
  try {
    const map = await loadPhoneThumbMapCached(organizationId, warehouseId);
    return {
      organizationId,
      warehouseId,
      photoCount: Object.keys(map.photos).length,
      ms: Date.now() - t0,
      error: null,
    };
  } catch (err) {
    return {
      organizationId,
      warehouseId,
      photoCount: 0,
      ms: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
