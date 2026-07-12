import 'server-only';

import { unstable_cache } from 'next/cache';

import { createAdminClient } from '@/lib/supabase/admin';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

/**
 * Long-lived signed URL per storage path. The signed URL itself is
 * valid for 30 days; we cache the value via Vercel's data cache for
 * 25 days so every page load returns the SAME URL for the same image
 * for ~25 days.
 *
 * Why this matters for perceived load speed:
 *   The current code path mints a fresh signed URL on every request.
 *   Each fresh URL has a different `sig` + `exp` query, so Vercel's
 *   image optimizer (which keys on the full URL) sees a brand-new
 *   entry every refresh and re-encodes from scratch. That's the
 *   200-500ms-per-thumbnail tax users were feeling on revisits.
 *   Stable URL ⇒ optimizer cache hit ⇒ near-zero latency thumbs.
 *
 * Why service-role: signing a path is org-agnostic — the resulting
 * URL is identical regardless of who minted it, so caching across
 * users is safe. Authorization already happened in the outer
 * primaryImagesForItems / list call (the storage_path was selected
 * via the user's RLS-scoped query). The admin client just performs
 * the signing op without needing a per-request supabase instance.
 */
const SIGNED_URL_TTL_SEC = 30 * 24 * 60 * 60;
const SIGNED_URL_CACHE_SEC = 25 * 24 * 60 * 60;

/* ---- batch-sign plumbing (cold-start plan rank 3, 2026-07-06) ----------
 *
 * `signedUrls` used to resolve a whole list page as N independent
 * per-path cache reads, each of which — on a cache miss — issued its own
 * `createSignedUrl` HTTP call. For the instant-mode dataset that meant up
 * to ~500 sequential-ish storage calls after any deploy that rotated this
 * chunk (the exact per-path fan-out the orders storefront already ripped
 * out — see the FIX 6 note below). The fix has three cooperating layers,
 * chosen so SAME PATH → SAME URL stability for the ~25-day window is
 * preserved (the loader-header warning about URL rotation is law):
 *
 *   1. The per-path `unstable_cache` entries remain THE source of URL
 *      stability — nothing about their key axes (one explicit string +
 *      the path arg) or 25-day TTL changes.
 *   2. On a batch resolve, ONE `createSignedUrls` call covering every
 *      not-in-memo path is started (not awaited) and primed into
 *      `pendingBatchSigns`. The per-path cached fns are then read in
 *      parallel: HITS return their existing stable URL without ever
 *      touching the batch; MISSES consume the batch result inside the
 *      wrapped fn — so a fully-cold page pays ONE storage round trip
 *      instead of hundreds, and the batch-minted URL becomes the stable
 *      cached value. A path the batch failed to sign falls back to the
 *      original single `createSignedUrl`, keeping per-path resilience.
 *   3. A bounded in-process memo short-circuits the per-path Data Cache
 *      GET storm on warm instances (hundreds of network GETs per render
 *      otherwise). It only ever stores values that came out of the
 *      per-path cache, so it can't introduce URL rotation — worst case it
 *      serves a URL for MEMO_TTL_MS after a tag-invalidation that the
 *      Data Cache would have already dropped, which for signed image URLs
 *      (30-day validity, path-immutable content) is harmless.
 *
 * Concurrency note: two overlapping requests may prime overlapping paths
 * with different batch promises; whichever wrapped-fn write lands in the
 * Data Cache becomes the stable URL — the same last-write-wins behavior
 * two concurrent single-sign misses have always had.
 */
const pendingBatchSigns = new Map<string, Promise<Map<string, string>>>();

/** In-process memo of per-path SUCCESSES (never nulls — pattern #6). */
const signedUrlMemo = new Map<string, { url: string; expiresAtMs: number }>();
const MEMO_TTL_MS = 60 * 60 * 1000; // 1h — tiny vs the 25-day cache window
const MEMO_MAX_ENTRIES = 20_000;

function memoGet(path: string): { url: string } | null {
  const hit = signedUrlMemo.get(path);
  if (!hit) return null;
  if (hit.expiresAtMs < Date.now()) {
    signedUrlMemo.delete(path);
    return null;
  }
  return hit;
}

function memoSet(path: string, url: string): void {
  if (signedUrlMemo.size >= MEMO_MAX_ENTRIES) {
    // Crude but sufficient eviction at this scale: drop the oldest
    // insertion-order entries (Map preserves insertion order).
    let toDrop = Math.ceil(MEMO_MAX_ENTRIES / 10);
    for (const key of signedUrlMemo.keys()) {
      signedUrlMemo.delete(key);
      if (--toDrop <= 0) break;
    }
  }
  signedUrlMemo.set(path, { url, expiresAtMs: Date.now() + MEMO_TTL_MS });
}

/** ONE createSignedUrls covering `paths`. Never throws — per-path
 *  failures (and a whole-call failure) just leave paths out of the map,
 *  and the per-path signer falls back to its single-sign path. */
async function batchSignPaths(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from('item-images')
      .createSignedUrls(paths, SIGNED_URL_TTL_SEC);
    if (error || !data) return out;
    for (const entry of data) {
      if (entry.signedUrl && !entry.error && entry.path) {
        out.set(entry.path, entry.signedUrl);
      }
    }
  } catch {
    // fall through — misses single-sign individually
  }
  return out;
}

// THROWS on failure (no try/catch here) so `unstable_cache` does NOT persist a
// null for the 25-day TTL — a transient signing/quota error self-heals on the
// next call instead of poisoning the entry until a version bump. The public
// wrapper below catches → null so callers are unchanged.
const signItemImageMaster = unstable_cache(
  async (storagePath: string): Promise<string> => {
    // Batch-primed path (rank 3): a surrounding signedUrls() call already
    // started ONE createSignedUrls covering this path — consume it instead
    // of issuing an individual storage call. Only runs on a cache MISS
    // (hits never enter this fn), so cached URLs stay byte-stable.
    const primed = pendingBatchSigns.get(storagePath);
    if (primed) {
      const url = (await primed).get(storagePath);
      if (url) return url;
      // batch didn't cover it (partial failure) → single-sign below
    }
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from('item-images')
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
    if (error || !data?.signedUrl) {
      throw new Error(`sign master failed: ${error?.message ?? 'no signedUrl'}`);
    }
    return data.signedUrl;
  },
  // v4 (2026-07-06): batch-primed signer (rank 3). The source change would
  // have rotated the implicit key anyway; the explicit bump keeps the
  // versioning honest. One-time cold refill per path — now paid as ONE
  // batched call per page instead of a per-path storm.
  ['item-image-signed-url-v4'],
  { revalidate: SIGNED_URL_CACHE_SEC, tags: ['item-image-signed-url'] },
);
async function getCachedItemImageSignedUrl(storagePath: string): Promise<string | null> {
  try {
    return await signItemImageMaster(storagePath);
  } catch (err) {
    console.warn(
      `[item-image] master sign failed (${storagePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Signed URL that points at a server-side resized variant of the
 * master via Supabase Storage's transform option. Used as a fallback
 * when the row has no pre-resized `thumb_path` (items uploaded
 * before migration 0122). Supabase resizes on demand (Pro plan
 * feature) so we still get ~20-50 KB instead of the 2048px master,
 * which is critical for PDF rendering: react-pdf fetches each
 * `<Image>` src at render time and the master would balloon a PDF
 * to hundreds of MB.
 *
 * Cached separately from the plain signed URL because the
 * transform params are part of the URL signature.
 */
// THROWS on failure (see signItemImageMaster note) so transient transform/quota
// errors aren't negatively cached for 25 days. Public wrapper catches → null.
const signItemImageTransformed = unstable_cache(
  async (storagePath: string, width: number): Promise<string> => {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from('item-images')
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC, {
        transform: { width, height: width, resize: 'cover' },
      });
    if (error || !data?.signedUrl) {
      throw new Error(`sign transform failed: ${error?.message ?? 'no signedUrl'}`);
    }
    return data.signedUrl;
  },
  // v3 (2026-06-02): companion bump to the plain signer; throws-instead-of-null.
  ['item-image-signed-url-transform-v3'],
  { revalidate: SIGNED_URL_CACHE_SEC, tags: ['item-image-signed-url'] },
);
async function getCachedItemImageTransformedSignedUrl(
  storagePath: string,
  width: number,
): Promise<string | null> {
  try {
    return await signItemImageTransformed(storagePath, width);
  } catch (err) {
    console.warn(
      `[item-image] transform sign failed (${storagePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// NOTE (2026-07-01, media audit): a "width-only on-demand transform of the
// master at 400px" variant for picker cards was tried here and REVERTED the
// same day. On-demand transforms re-render from the 2048px master on first
// view (seconds-long stalls + failures under a 350-item burst), and
// aspect-preserving variants get grossly re-cropped by the cards'
// object-cover cells. Picker sharpness should come from PRE-GENERATED
// thumbs instead — see THUMB_DIMENSION in lib/image-variants.ts.
//
// NOTE (2026-07-01, storefront FIX 6): a per-path `cachedCatalogThumbUrl`
// helper briefly lived here for the orders storefront. It was removed —
// resolving a whole catalog through per-path unstable_cache reads means
// hundreds of nested cache GETs per recompute (~5s cold). Whole-catalog
// consumers should BATCH via storage.createSignedUrls inside their own
// coarse-grained cache instead (see orders/new/page.tsx's thumb map).

export class ItemImagesService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ItemImagesService(await withContext());
  }

  async list(itemId: string) {
    const { data, error } = await this.ctx.supabase
      .from('item_images')
      .select('id, storage_path, alt, sort_order, is_primary')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', itemId)
      .order('sort_order', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    return data ?? [];
  }

  async signedUrls(paths: string[]): Promise<Map<string, string>> {
    if (paths.length === 0) return new Map();
    // Three-layer resolve (rank 3 — see the batch-sign plumbing header):
    //   1. in-process memo (zero network) for warm instances,
    //   2. per-path Data Cache entries (25-day TTL — THE URL-stability
    //      source: same path → same URL, which is what keeps browser +
    //      Vercel image-optimizer caches hitting),
    //   3. cache misses consume ONE batched createSignedUrls started in
    //      parallel with layer 2, instead of a per-path storage-call storm.
    const map = new Map<string, string>();
    const unmemoized: string[] = [];
    for (const path of paths) {
      const memo = memoGet(path);
      if (memo) map.set(path, memo.url);
      else unmemoized.push(path);
    }
    if (unmemoized.length === 0) return map;

    // Start the batch WITHOUT awaiting so it overlaps the per-path cache
    // reads; only misses (inside the wrapped fn) ever await it. Total
    // latency ≈ max(dataCacheReads, batchSign) instead of their sum.
    const batchPromise = batchSignPaths(unmemoized);
    for (const path of unmemoized) pendingBatchSigns.set(path, batchPromise);
    try {
      const entries = await Promise.all(
        unmemoized.map(async (path) => {
          const url = await getCachedItemImageSignedUrl(path);
          return [path, url] as const;
        }),
      );
      for (const [path, url] of entries) {
        // Memoize SUCCESSES only (recurring bug pattern #6: never cache a
        // null) — a transient sign failure retries on the next request
        // instead of sticking for MEMO_TTL_MS.
        if (url) {
          memoSet(path, url);
          map.set(path, url);
        }
      }
    } finally {
      // Only clear our own primes — an overlapping request may have
      // re-primed some of these paths with its own batch.
      for (const path of unmemoized) {
        if (pendingBatchSigns.get(path) === batchPromise) pendingBatchSigns.delete(path);
      }
    }
    return map;
  }

  /**
   * Returns a Map<itemId, masterSignedUrl> for the primary (or first)
   * image per item across the given list. Two round trips total: one
   * `item_images IN (...)` query, one `createSignedUrls` for all
   * matched paths. Used by PDF + JSON-API surfaces that want the full
   * image URL.
   *
   * For list-page row thumbnails — which want the 200px pre-resized
   * thumb + LQIP blur placeholder — use {@link primaryImagesWithThumbsForItems}
   * instead.
   */
  async primaryImagesForItems(itemIds: string[]): Promise<Map<string, string>> {
    if (itemIds.length === 0) return new Map();

    const { data, error } = await this.ctx.supabase
      .from('item_images')
      .select('item_id, storage_path, is_primary, sort_order')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', itemIds)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    const pathByItem = new Map<string, string>();
    for (const row of (data ?? []) as Array<{
      item_id: string;
      storage_path: string;
    }>) {
      if (!pathByItem.has(row.item_id)) {
        pathByItem.set(row.item_id, row.storage_path);
      }
    }

    const urlByPath = await this.signedUrls([...pathByItem.values()]);
    const result = new Map<string, string>();
    for (const [itemId, path] of pathByItem) {
      const url = urlByPath.get(path);
      if (url) result.set(itemId, url);
    }
    return result;
  }

  /**
   * Like {@link primaryImagesForItems} but returns the richer shape
   * the list pages need:
   *   • `url`       — signed URL of the master (2048px) — used by the
   *                   hover-preview prefetch + lightbox.
   *   • `thumbUrl`  — signed URL of the pre-resized ~200px thumb when
   *                   the row has one (uploads after 0122); null
   *                   otherwise so the caller falls back to `url`.
   *   • `lqip`      — base64 data URL of the 16x16 blur placeholder
   *                   for use as next/image's blurDataURL; null when
   *                   the row pre-dates the LQIP column.
   *
   * Same two-round-trip cost as primaryImagesForItems — one query for
   * the rows, one batched signed-URLs call covering master + thumb
   * paths together.
   */
  async primaryImagesWithThumbsForItems(
    itemIds: string[],
  ): Promise<
    Map<string, { url: string; thumbUrl: string | null; lqip: string | null }>
  > {
    if (itemIds.length === 0) return new Map();

    const { data, error } = await this.ctx.supabase
      .from('item_images')
      .select('item_id, storage_path, thumb_path, lqip, is_primary, sort_order')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', itemIds)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    type Row = {
      item_id: string;
      storage_path: string;
      thumb_path: string | null;
      lqip: string | null;
    };
    const pickByItem = new Map<string, Row>();
    for (const row of (data ?? []) as Row[]) {
      if (!pickByItem.has(row.item_id)) pickByItem.set(row.item_id, row);
    }

    // Batch every distinct path (master + thumb) into one signed-URL
    // resolution. The unstable_cache layer keys per path so multiple
    // items sharing a thumb path are a single cache hit either way.
    const paths = new Set<string>();
    for (const row of pickByItem.values()) {
      paths.add(row.storage_path);
      if (row.thumb_path) paths.add(row.thumb_path);
    }
    const urlByPath = await this.signedUrls([...paths]);

    const result = new Map<
      string,
      { url: string; thumbUrl: string | null; lqip: string | null }
    >();
    for (const [itemId, row] of pickByItem) {
      const url = urlByPath.get(row.storage_path);
      if (!url) continue;
      const thumbUrl = row.thumb_path ? urlByPath.get(row.thumb_path) ?? null : null;
      result.set(itemId, { url, thumbUrl, lqip: row.lqip });
    }
    return result;
  }

  /**
   * Returns a Map<itemId, smallSignedUrl> sized for PDF rendering.
   *
   * Per-item resolution order:
   *   1. If the row has `thumb_path` (uploads after 0122) — sign the
   *      stored 200px WebP directly. Fastest path.
   *   2. Otherwise — sign the master path WITH Supabase Storage's
   *      transform option (width: targetWidth, resize: cover). This
   *      asks Supabase's image-transformations service to resize on
   *      the fly so the fetched bytes are still small even though
   *      no pre-resized variant exists in storage.
   *
   * Either way the caller receives a URL that, when fetched, returns
   * a ~20-50 KB image — small enough to embed in a PDF without
   * blowing up the request. Rows whose item has no `item_images` row
   * at all simply don't appear in the result map; the caller renders
   * a placeholder.
   *
   * `targetWidth` defaults to 200 to match the stored thumb_path
   * dimension and the typical PDF thumbnail cell (22pt × ~2x density).
   */
  async primaryImagesForPdfRendering(
    itemIds: string[],
    targetWidth = 200,
  ): Promise<Map<string, string>> {
    if (itemIds.length === 0) return new Map();

    const { data, error } = await this.ctx.supabase
      .from('item_images')
      .select('item_id, storage_path, thumb_path, is_primary, sort_order')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', itemIds)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    type Row = {
      item_id: string;
      storage_path: string;
      thumb_path: string | null;
    };
    const pickByItem = new Map<string, Row>();
    for (const row of (data ?? []) as Row[]) {
      if (!pickByItem.has(row.item_id)) pickByItem.set(row.item_id, row);
    }

    // Phase 1 — sign each `item_images` row's preferred URL. Stored
    // thumbs go through the plain signer (no transform). Masters get
    // the transform signer so Supabase resizes on the way out. Both
    // paths cached 25 days via unstable_cache.
    const signed = await Promise.all(
      [...pickByItem.entries()].map(async ([itemId, row]) => {
        const url = row.thumb_path
          ? await getCachedItemImageSignedUrl(row.thumb_path)
          : await getCachedItemImageTransformedSignedUrl(
              row.storage_path,
              targetWidth,
            );
        return url ? ([itemId, url] as const) : null;
      }),
    );

    const result = new Map<string, string>();
    for (const entry of signed) {
      if (entry) result.set(entry[0], entry[1]);
    }

    // Phase 2 — fallback to inventory_items.custom_fields.thumbnail_url
    // for any items NOT already resolved above. Bulk-imported books
    // (the ISBN importer in apps/web/src/server/actions/books-bulk-import.ts
    // line 79) store the cover URL there instead of creating an
    // item_images row. Without this fallback the entire books portion
    // of every PDF would show placeholder squares.
    //
    // These URLs are typically public CDN links (Google Books,
    // Open Library, archive.org); no signing required.
    const unresolved = itemIds.filter((id) => !result.has(id));
    if (unresolved.length > 0) {
      const { data: cfRows, error: cfErr } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, custom_fields')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', unresolved);
      if (cfErr) throw new ServiceError('internal_error', cfErr.message);
      for (const row of (cfRows ?? []) as Array<{
        id: string;
        custom_fields: Record<string, unknown> | null;
      }>) {
        const cf = row.custom_fields;
        if (cf && typeof cf === 'object') {
          const url = (cf as { thumbnail_url?: unknown }).thumbnail_url;
          if (typeof url === 'string' && url.length > 0 && url.length < 2000) {
            result.set(row.id, url);
          }
        }
      }
    }
    return result;
  }

  /**
   * Primary image URL per item pointing at the SHARP source — the master
   * (`storage_path`, capped 2048px WebP) rather than the 200-400px
   * pre-generated thumb. The PUBLIC catalog renders these through next/image,
   * whose optimizer downscales + re-encodes to the exact ~240px card cell, so
   * a large source yields a crisp retina card at a small delivered byte size.
   * The thumb path stays right for PDF rendering and the internal picker
   * (react-pdf can't optimize; the picker wants pre-baked thumbs) — those keep
   * {@link primaryImagesForPdfRendering}. Falls back to
   * `custom_fields.thumbnail_url` (external ISBN covers) for items with no
   * `item_images` row, same as the PDF signer.
   */
  async primaryMasterUrlsForItems(itemIds: string[]): Promise<Map<string, string>> {
    if (itemIds.length === 0) return new Map();

    const { data, error } = await this.ctx.supabase
      .from('item_images')
      .select('item_id, storage_path, is_primary, sort_order')
      .eq('organization_id', this.ctx.organizationId)
      .in('item_id', itemIds)
      .order('is_primary', { ascending: false })
      .order('sort_order', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);

    type Row = { item_id: string; storage_path: string };
    const pickByItem = new Map<string, Row>();
    for (const row of (data ?? []) as Row[]) {
      if (!pickByItem.has(row.item_id)) pickByItem.set(row.item_id, row);
    }

    const signed = await Promise.all(
      [...pickByItem.entries()].map(async ([itemId, row]) => {
        const url = await getCachedItemImageSignedUrl(row.storage_path);
        return url ? ([itemId, url] as const) : null;
      }),
    );
    const result = new Map<string, string>();
    for (const entry of signed) {
      if (entry) result.set(entry[0], entry[1]);
    }

    // Fallback: external ISBN covers stored on the item (no item_images row).
    const unresolved = itemIds.filter((id) => !result.has(id));
    if (unresolved.length > 0) {
      const { data: cfRows, error: cfErr } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, custom_fields')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', unresolved);
      if (cfErr) throw new ServiceError('internal_error', cfErr.message);
      for (const row of (cfRows ?? []) as Array<{
        id: string;
        custom_fields: Record<string, unknown> | null;
      }>) {
        const cf = row.custom_fields;
        if (cf && typeof cf === 'object') {
          const url = (cf as { thumbnail_url?: unknown }).thumbnail_url;
          if (typeof url === 'string' && url.length > 0 && url.length < 2000) {
            result.set(row.id, url);
          }
        }
      }
    }
    return result;
  }

  async record(
    itemId: string,
    storagePath: string,
    isFirst: boolean,
    opts: { thumbPath?: string | null; lqip?: string | null } = {},
  ) {
    assertPermission(this.ctx, 'items:update');
    // Defense-in-depth: the action schema validates `storagePath` as a
    // bare string, so a hostile client could send another org's path
    // here. Storage RLS would still refuse to mint a signed URL for
    // the wrong org's bucket folder (the rendered image stays
    // private), but we'd be inserting a pointer row tagged with OUR
    // organization_id pointing at THEIR file — a row that has no
    // business existing. Reject it before it ever hits the DB.
    const requiredPrefix = `${this.ctx.organizationId}/`;
    if (!storagePath.startsWith(requiredPrefix)) {
      throw new ServiceError(
        'validation_error',
        'Invalid storage path — wrong org prefix.',
      );
    }
    // Same prefix gate on the thumb path — a thumb path pointing at a
    // different org's folder would never resolve to a real upload, but
    // an inserted pointer is still a row we don't want.
    if (opts.thumbPath && !opts.thumbPath.startsWith(requiredPrefix)) {
      throw new ServiceError(
        'validation_error',
        'Invalid thumb path — wrong org prefix.',
      );
    }
    // The 0122 CHECK constraint enforces this on the DB side too, but
    // failing here gives a friendly error instead of a generic
    // internal_error if a client ever sends an oversize blob.
    if (opts.lqip && opts.lqip.length > 2000) {
      throw new ServiceError('validation_error', 'LQIP blob too large.');
    }

    // Verify the target item exists in this org. Without this, a forged
    // item_id from a hostile client lets us insert a pointer row that
    // either references nothing or — if RLS were ever loosened —
    // attaches our org's storage path to someone else's item view.
    const { data: itemRow, error: itemErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', itemId)
      .is('deleted_at', null)
      .maybeSingle();
    if (itemErr) throw new ServiceError('internal_error', itemErr.message);
    if (!itemRow) throw new ServiceError('not_found', 'Item not found');
    const { data, error } = await this.ctx.supabase
      .from('item_images')
      .insert({
        organization_id: this.ctx.organizationId,
        item_id: itemId,
        storage_path: storagePath,
        thumb_path: opts.thumbPath ?? null,
        lqip: opts.lqip ?? null,
        is_primary: isFirst,
      })
      .select('id, storage_path, sort_order, is_primary')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }

  async remove(imageId: string) {
    assertPermission(this.ctx, 'items:update');
    const { data: img } = await this.ctx.supabase
      .from('item_images')
      .select('storage_path')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', imageId)
      .maybeSingle();
    if (!img) throw new ServiceError('not_found', 'Image not found');

    await this.ctx.supabase.storage.from('item-images').remove([img.storage_path as string]);
    const { error } = await this.ctx.supabase
      .from('item_images')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', imageId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  /**
   * Returns a presigned upload URL the client can PUT directly to.
   * Path scheme: {organization_id}/items/{item_id}/{uuid}.{ext}
   * Storage RLS already restricts by organization id in the path.
   */
  async createUploadUrl(itemId: string, fileExt: string) {
    assertPermission(this.ctx, 'items:update');
    // Verify the item exists in this org BEFORE minting an upload URL.
    // Without this, a forged item_id from a hostile client would mint a
    // valid signed upload URL pointing at our bucket folder for an item
    // we have no business touching.
    const { data: itemRow, error: itemErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', itemId)
      .is('deleted_at', null)
      .maybeSingle();
    if (itemErr) throw new ServiceError('internal_error', itemErr.message);
    if (!itemRow) throw new ServiceError('not_found', 'Item not found');

    const safeExt = fileExt.replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase() || 'jpg';
    const uuid = crypto.randomUUID();
    const fileName = `${uuid}.${safeExt}`;
    const path = `${this.ctx.organizationId}/items/${itemId}/${fileName}`;
    // Sister path for the 200px pre-resized thumbnail. Always WebP
    // because the uploader transcodes deterministically. Stored next
    // to the master so a future "rm by item folder" cleans both.
    const thumbPath = `${this.ctx.organizationId}/items/${itemId}/${uuid}-thumb.webp`;

    const [masterRes, thumbRes] = await Promise.all([
      this.ctx.supabase.storage.from('item-images').createSignedUploadUrl(path),
      this.ctx.supabase.storage
        .from('item-images')
        .createSignedUploadUrl(thumbPath),
    ]);
    if (masterRes.error)
      throw new ServiceError('internal_error', masterRes.error.message);
    if (thumbRes.error)
      throw new ServiceError('internal_error', thumbRes.error.message);
    return {
      path,
      signedUrl: masterRes.data.signedUrl,
      token: masterRes.data.token,
      thumbPath,
      thumbSignedUrl: thumbRes.data.signedUrl,
    };
  }
}
