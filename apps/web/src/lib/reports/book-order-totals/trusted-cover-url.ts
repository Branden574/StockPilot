import { isAllowedCoverHost } from '@/lib/books/cover-hosts';

/**
 * Whether a cover URL the item-images service resolved may be shown or
 * fetched for the Book Order Totals report.
 *
 * Two kinds are trusted:
 *   - a SIGNED item-images URL on this project's own storage origin
 *     (/storage/v1/object/sign/item-images/...), which ItemImagesService
 *     minted for a path it validated;
 *   - an https URL on the book-cover host allowlist: the legacy
 *     custom_fields.thumbnail_url of bulk-imported books, which is checked
 *     only for type and length where it is stored and is writable by staff.
 *
 * Anything else (another scheme, another host, credentials in the URL, an
 * unsigned or other-bucket storage path) is dropped and the row shows its
 * placeholder. A missing cover never changes a number.
 */
export function isTrustedCoverUrl(raw: unknown, supabaseUrl: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length >= 2000) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  let storage: URL | null = null;
  try {
    storage = new URL(supabaseUrl);
  } catch {
    storage = null;
  }
  if (storage && url.origin === storage.origin) {
    return (
      url.pathname.startsWith('/storage/v1/object/sign/item-images/') &&
      !url.pathname.includes('..')
    );
  }
  return url.protocol === 'https:' && isAllowedCoverHost(url.hostname);
}
