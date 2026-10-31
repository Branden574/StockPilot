import 'server-only';

import { COVER_HOST_ALLOWLIST } from '@/lib/books/cover-hosts';
import { safeFetch } from '@/lib/ssrf-guard';

/**
 * Fetching an item's image URL on the server. Shared by the PDF image
 * prefetch (lib/pdf/image-prefetch.ts) and the inventory export
 * (lib/exports/export-images.ts), so both decide the same way.
 *
 * Two kinds of URL reach them (ItemImagesService.primaryImagesForServerDecoding):
 * signed URLs of the project's own storage, and the legacy
 * custom_fields.thumbnail_url that the ISBN bulk importer writes for book
 * covers. The second is checked only for type and length where it is stored,
 * and staff can edit it, so a bare fetch() of it lets anyone who can edit an
 * item make the server request an internal host. The storage origin gets plain
 * fetch; any other http(s) URL goes through safeFetch with the book-cover host
 * allowlist (pinned IP, every redirect hop re-validated); anything else is
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

/** Where a URL may be fetched from, or null when it may not be fetched. */
export function itemImageFetchRoute(url: string): 'storage' | 'external' | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const origin = storageOrigin();
  if (origin && parsed.origin === origin) return 'storage';
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return 'external';
  return null;
}

/** Thrown, before any request, for a URL that is neither storage nor http(s). */
export class ItemImageUrlRefusedError extends Error {
  constructor() {
    super('item image url is not fetchable');
    this.name = 'ItemImageUrlRefusedError';
  }
}

/**
 * Fetch an item image URL by its route. Rejects with ItemImageUrlRefusedError
 * for a URL with no route and with the guard's SsrfBlockedError for a host off
 * the cover allowlist (or one that resolves to a private address); both are
 * final, retrying the same URL is refused the same way. A failed lookup of the
 * host rejects with SsrfLookupFailedError (a subclass), which is not final.
 * Once `signal` aborts, the call rejects with its reason, even while the host
 * is still being looked up.
 */
export async function fetchItemImage(url: string, signal: AbortSignal): Promise<Response> {
  const route = itemImageFetchRoute(url);
  if (route === 'storage') return fetch(url, { signal });
  if (route === 'external') {
    return (await safeFetch(url, {
      signal,
      hostAllowlist: COVER_HOST_ALLOWLIST,
    })) as unknown as Response;
  }
  throw new ItemImageUrlRefusedError();
}
