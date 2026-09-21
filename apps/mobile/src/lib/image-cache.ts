import { supabase } from './supabase';

/**
 * Signed-URL cache for the private `item-images` storage bucket.
 *
 * Two problems this solves:
 *   1. Every screen (list, detail, scan) used to call createSignedUrl
 *      on each load — a round-trip per render. We cache the result in
 *      memory keyed by storage path so repeat views are instant.
 *   2. Signed URLs carry a rotating `?token=...`, so the OS/image cache
 *      never gets a hit across loads. We mint long-lived URLs (7 days)
 *      and reuse them for the whole session; combined with expo-image's
 *      stable cacheKey (the path, not the token) the bitmap is served
 *      from disk on every subsequent view.
 */
const BUCKET = 'item-images';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
// Refresh a little before the real expiry so we never hand out a URL
// that 403s mid-render.
const SAFETY_MS = 60 * 60 * 1000; // 1 hour

/**
 * Optional Supabase storage transform — when set, the signed URL serves
 * a resized JPEG generated on Supabase's edge instead of the original
 * megapixel photo. Crucial for list thumbnails: drops a ~1.5MB payload
 * to ~12KB and a ~120ms JPEG decode to ~3ms. Detail screens omit this
 * and get the original.
 *
 * Note: Image Transformation requires Supabase Pro plan or above. Without
 * Pro, transforms silently return the original — same perf as before, no
 * error.
 */
export interface ImageTransform {
  width: number;
  height?: number;
  quality?: number;
  resize?: 'cover' | 'contain' | 'fill';
}

// Cache keyed by `${path}|${transformSignature}` so the same path can be
// signed for a thumbnail AND the full-size variant independently.
const cache = new Map<string, { url: string; expiresAt: number }>();

function cacheKey(path: string, t?: ImageTransform): string {
  if (!t) return path;
  return `${path}|w=${t.width}|h=${t.height ?? ''}|q=${t.quality ?? ''}|r=${t.resize ?? ''}`;
}

function remember(key: string, url: string) {
  cache.set(key, { url, expiresAt: Date.now() + TTL_SECONDS * 1000 - SAFETY_MS });
}

/** Signs a single storage path, reusing a cached URL when still valid. */
export async function signItemImage(
  path: string,
  transform?: ImageTransform,
): Promise<string | null> {
  const key = cacheKey(path, transform);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.url;
  const { data } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, TTL_SECONDS, transform ? { transform } : undefined);
  if (!data?.signedUrl) return null;
  remember(key, data.signedUrl);
  return data.signedUrl;
}

/**
 * Signs many paths at once. Returns a Map<path, url>. Only the paths
 * not already cached hit the network, batched into one request. The
 * batched createSignedUrls endpoint doesn't accept transform options,
 * so when a transform is requested we fall back to per-path signing in
 * parallel — still cheap because the cache absorbs repeat visits.
 */
export async function signItemImages(
  paths: string[],
  transform?: ImageTransform,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  const missing: string[] = [];
  for (const p of paths) {
    const hit = cache.get(cacheKey(p, transform));
    if (hit && hit.expiresAt > now) out.set(p, hit.url);
    else missing.push(p);
  }
  if (missing.length === 0) return out;

  if (transform) {
    const results = await Promise.all(
      missing.map((p) =>
        supabase.storage
          .from(BUCKET)
          .createSignedUrl(p, TTL_SECONDS, { transform })
          .then((r) => ({ path: p, signedUrl: r.data?.signedUrl ?? null })),
      ),
    );
    for (const r of results) {
      if (r.signedUrl) {
        remember(cacheKey(r.path, transform), r.signedUrl);
        out.set(r.path, r.signedUrl);
      }
    }
  } else {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrls(missing, TTL_SECONDS);
    for (const s of (data ?? []) as Array<{ path: string | null; signedUrl: string }>) {
      if (s.path && s.signedUrl) {
        remember(cacheKey(s.path), s.signedUrl);
        out.set(s.path, s.signedUrl);
      }
    }
  }
  return out;
}

/**
 * List-row photo URLs, keyed by the photo's `storage_path`.
 *
 * A photo uploaded on the web already has a ~200 px thumbnail stored next to it
 * (`thumb_path`). This signs THOSE, all in one batched request, and asks
 * Supabase to resize on demand only for the photos that have no thumbnail
 * (mobile uploads, a handful of old rows).
 *
 * Why it matters: the lists used to ask for an on-demand 200 x 200 transform of
 * the MASTER for every row. Supabase bills each distinct photo transformed in a
 * month (100 included, then $5 per 1,000), so browsing the catalog once billed
 * nearly every photo in it, and each row needed its own signing request because
 * the batched endpoint cannot take a transform. The stored thumbnail is the
 * same size, free, and signs in one request.
 *
 * A thumbnail that fails to sign falls back to the transform, so a row is never
 * left without a picture it could have had.
 */
export async function signListThumbnails(
  photos: ReadonlyArray<{ storage_path: string; thumb_path?: string | null }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const masterByThumb = new Map<string, string>();
  const needTransform: string[] = [];
  for (const p of photos) {
    if (p.thumb_path) masterByThumb.set(p.thumb_path, p.storage_path);
    else needTransform.push(p.storage_path);
  }
  if (masterByThumb.size > 0) {
    const signed = await signItemImages(Array.from(masterByThumb.keys()));
    for (const [thumbPath, master] of masterByThumb) {
      const url = signed.get(thumbPath);
      if (url) out.set(master, url);
      else needTransform.push(master);
    }
  }
  if (needTransform.length > 0) {
    const transformed = await signItemImages(needTransform, THUMB_TRANSFORM);
    for (const [master, url] of transformed) out.set(master, url);
  }
  return out;
}

/** Fallback preset for list rows whose photo has no stored thumbnail. */
export const THUMB_TRANSFORM: ImageTransform = {
  width: 200,
  height: 200,
  quality: 70,
  resize: 'cover',
};

/**
 * Stable cache key for a signed URL: strip the rotating query string so
 * expo-image serves the same object from disk even after the token
 * rotates between sessions.
 */
export function cacheKeyForUrl(uri: string): string {
  const q = uri.indexOf('?');
  return q >= 0 ? uri.slice(0, q) : uri;
}
