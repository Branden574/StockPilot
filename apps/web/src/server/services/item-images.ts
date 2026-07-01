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

// THROWS on failure (no try/catch here) so `unstable_cache` does NOT persist a
// null for the 25-day TTL — a transient signing/quota error self-heals on the
// next call instead of poisoning the entry until a version bump. The public
// wrapper below catches → null so callers are unchanged.
const signItemImageMaster = unstable_cache(
  async (storagePath: string): Promise<string> => {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from('item-images')
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC);
    if (error || !data?.signedUrl) {
      throw new Error(`sign master failed: ${error?.message ?? 'no signedUrl'}`);
    }
    return data.signedUrl;
  },
  // v3 (2026-06-02): bumped to evict 25-day-poisoned null entries AND the fn now
  // throws-instead-of-caching-null so transient failures stop sticking.
  ['item-image-signed-url-v3'],
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

/**
 * Width-only variant for on-screen DISPLAY: preserves the image's aspect
 * ratio (no forced square center-crop). The square signer above stays for
 * PDF rendering, whose fixed-cell layouts depend on it. Book covers are
 * portrait — square-cropping them for the order picker chopped titles, and
 * the picker's ~300px retina cells then re-cropped and upscaled the result.
 */
// THROWS on failure (see signItemImageMaster note); public wrapper catches → null.
const signItemImageTransformedFit = unstable_cache(
  async (storagePath: string, width: number): Promise<string> => {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from('item-images')
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC, {
        transform: { width },
      });
    if (error || !data?.signedUrl) {
      throw new Error(`sign fit-transform failed: ${error?.message ?? 'no signedUrl'}`);
    }
    return data.signedUrl;
  },
  ['item-image-signed-url-fit-v1'],
  { revalidate: SIGNED_URL_CACHE_SEC, tags: ['item-image-signed-url'] },
);
async function getCachedItemImageFitSignedUrl(
  storagePath: string,
  width: number,
): Promise<string | null> {
  try {
    return await signItemImageTransformedFit(storagePath, width);
  } catch (err) {
    console.warn(
      `[item-image] fit sign failed (${storagePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

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
    // Each path is looked up through Vercel's data cache (25-day TTL).
    // Same path → same URL across requests for ~25 days, which is what
    // lets the downstream Vercel image optimizer cache hit instead of
    // re-encoding every page refresh. Parallel resolution keeps the
    // first-request fan-out cheap (one createSignedUrl per uncached
    // path) and amortizes the cost across the deployment lifetime.
    const entries = await Promise.all(
      paths.map(async (path) => {
        const url = await getCachedItemImageSignedUrl(path);
        return url ? ([path, url] as const) : null;
      }),
    );
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (entry) map.set(entry[0], entry[1]);
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
   * Primary image per item for ON-SCREEN catalog cards (order picker, public
   * portal, rental form). Differs from primaryImagesForPdfRendering in two
   * deliberate ways:
   *   - resolves the MASTER through a width-only transform (aspect ratio
   *     preserved — no square center-crop chopping book covers), and
   *   - defaults to 400px so ~170-300 CSS px retina cells render sharp
   *     instead of 2-4x upscaling a 200px source.
   * Falls back to the stored 200px thumb when the transform fails, then to
   * custom_fields.thumbnail_url (bulk-imported book covers), same as the PDF
   * resolver. The PDF path is untouched — its fixed square cells depend on
   * the 200px cover-crop variant.
   */
  async primaryImagesForDisplay(
    itemIds: string[],
    targetWidth = 400,
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

    type Row = { item_id: string; storage_path: string; thumb_path: string | null };
    const pickByItem = new Map<string, Row>();
    for (const row of (data ?? []) as Row[]) {
      if (!pickByItem.has(row.item_id)) pickByItem.set(row.item_id, row);
    }

    const signed = await Promise.all(
      [...pickByItem.entries()].map(async ([itemId, row]) => {
        const url =
          (await getCachedItemImageFitSignedUrl(row.storage_path, targetWidth)) ??
          (row.thumb_path ? await getCachedItemImageSignedUrl(row.thumb_path) : null);
        return url ? ([itemId, url] as const) : null;
      }),
    );
    const result = new Map<string, string>();
    for (const entry of signed) {
      if (entry) result.set(entry[0], entry[1]);
    }

    // Same external-cover fallback as the PDF resolver (bulk-imported books).
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
