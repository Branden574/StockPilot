import 'server-only';

import { COVER_HOST_ALLOWLIST } from '@/lib/books/cover-hosts';
import { safeFetch } from '@/lib/ssrf-guard';

/**
 * Fetching an item's image URL, or an organization's logo, on the server.
 * Shared by the PDF image prefetch and the PDF logo (lib/pdf/image-prefetch.ts)
 * and the inventory export (lib/exports/export-images.ts), so all of them
 * decide the same way.
 *
 * Three kinds of URL reach them: signed URLs of the project's own storage
 * (ItemImagesService.primaryImagesForServerDecoding), the legacy
 * custom_fields.thumbnail_url that the ISBN bulk importer writes for book
 * covers, and organizations.logo_url. The second is checked only for type and
 * length where it is stored, and staff can edit it; the third is set by an org
 * owner or admin, and the database does not hold it to the logo bucket. So a
 * bare fetch() of either lets its editor make the server request an internal
 * host.
 *
 * A Storage read on the project origin gets plain fetch, and never follows a
 * redirect. Any other http(s) URL goes through safeFetch with the book-cover
 * host allowlist (pinned IP, every redirect hop re-validated); anything else is
 * refused before any request.
 */

/** The project's storage origin (the signed item-image URLs). */
function storageOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!raw) return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * The Storage object reads, signed or public, plain or transformed: every URL
 * the app hands these helpers on the project origin is one of them. The same
 * origin serves GoTrue, PostgREST and Edge Functions too, and GoTrue's
 * /auth/v1/verify answers any bogus token with a 303 to the request's
 * redirect_to (when it is on the auth redirect allow list) or to the Site URL.
 * So a path that is not a Storage read is treated like any other host: it goes
 * through the guard, whose cover allowlist refuses it. The check reads the
 * parsed pathname, after dot segments are resolved, as fetch requests it.
 */
const STORAGE_READ_PATH_PREFIXES = ['/storage/v1/object/', '/storage/v1/render/image/'];

/** Where a URL may be fetched from, or null when it may not be fetched. */
export function itemImageFetchRoute(url: string): 'storage' | 'external' | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const origin = storageOrigin();
  if (
    origin &&
    parsed.origin === origin &&
    STORAGE_READ_PATH_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))
  ) {
    return 'storage';
  }
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return 'external';
  return null;
}

/**
 * Thrown before any request for a URL that is neither storage nor http(s), and
 * after one request when a Storage read answers with a redirect, which is
 * never followed. Retrying the same URL is refused the same way.
 */
export class ItemImageUrlRefusedError extends Error {
  constructor(reason = 'item image url is not fetchable') {
    super(reason);
    this.name = 'ItemImageUrlRefusedError';
  }
}

/**
 * Fetch an item image URL by its route. Rejects with ItemImageUrlRefusedError
 * for a URL with no route or a Storage answer that redirects, and with the
 * guard's SsrfBlockedError for a host off the cover allowlist (or one that
 * resolves to a private address); both are final, retrying the same URL is
 * refused the same way. A failed lookup of the host rejects with
 * SsrfLookupFailedError (a subclass), which is not final. Once `signal`
 * aborts, the call rejects with its reason, even while the host is still being
 * looked up.
 */
export async function fetchItemImage(url: string, signal: AbortSignal): Promise<Response> {
  const route = itemImageFetchRoute(url);
  if (route === 'storage') {
    // Storage answers a read with the object or an error, never a redirect.
    // Plain fetch would follow one to any host without checking it, so the
    // redirect is refused instead: one request, and nothing else is asked.
    const res = await fetch(url, { signal, redirect: 'manual' });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      await res.body?.cancel().catch(() => {});
      throw new ItemImageUrlRefusedError(
        `storage answered ${res.status}, a redirect is not followed`,
      );
    }
    return res;
  }
  if (route === 'external') {
    return (await safeFetch(url, {
      signal,
      hostAllowlist: COVER_HOST_ALLOWLIST,
    })) as unknown as Response;
  }
  throw new ItemImageUrlRefusedError();
}
