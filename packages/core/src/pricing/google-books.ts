/**
 * Pure helpers for Google Books price monitoring (Phase 6). No I/O.
 */

export interface ParsedBookObservation {
  listPrice: number | null;
  retailPrice: number | null;
  currency: string | null;
  title: string | null;
  authors: string | null;
  averageRating: number | null;
  ratingsCount: number | null;
  categories: string | null;
  thumbnailUrl: string | null;
  infoLink: string | null;
  saleability: string | null;
}

/** Cheap pre-filter: true iff the barcode is a 10- or 13-digit ISBN (hyphens/spaces ok). */
export function isLikelyIsbn(barcode: string | null | undefined): boolean {
  if (!barcode) return false;
  const digits = barcode.replace(/[\s-]/g, '');
  return /^[0-9]{13}$/.test(digits) || /^[0-9]{9}[0-9Xx]$/.test(digits);
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse a Google Books `volumes` response → the first item's price + metadata, or null. */
export function parseGoogleBooksVolume(json: unknown): ParsedBookObservation | null {
  const items = (json as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const item = items[0] as {
    volumeInfo?: {
      title?: string;
      authors?: string[];
      averageRating?: number;
      ratingsCount?: number;
      categories?: string[];
      imageLinks?: { thumbnail?: string };
      infoLink?: string;
    };
    saleInfo?: {
      saleability?: string;
      listPrice?: { amount?: number; currencyCode?: string };
      retailPrice?: { amount?: number; currencyCode?: string };
    };
  };
  const vi = item.volumeInfo ?? {};
  const si = item.saleInfo ?? {};
  return {
    listPrice: num(si.listPrice?.amount),
    retailPrice: num(si.retailPrice?.amount),
    currency: si.retailPrice?.currencyCode ?? si.listPrice?.currencyCode ?? null,
    title: vi.title ?? null,
    authors: Array.isArray(vi.authors) && vi.authors.length ? vi.authors.join(', ') : null,
    averageRating: num(vi.averageRating),
    ratingsCount: num(vi.ratingsCount) === null ? null : Math.trunc(num(vi.ratingsCount) as number),
    categories: Array.isArray(vi.categories) && vi.categories.length ? vi.categories.join(', ') : null,
    thumbnailUrl: vi.imageLinks?.thumbnail ?? null,
    infoLink: vi.infoLink ?? null,
    saleability: si.saleability ?? null,
  };
}
