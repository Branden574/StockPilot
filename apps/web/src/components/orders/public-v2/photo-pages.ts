// The photo pages of a request link's public catalog (B32, integrator
// decisions 1 to 3). The page ships the compact catalog (catalog-index.ts);
// /api/v1/public/catalog-thumbnails answers the rest a page at a time: each
// item's photo, its blur placeholder and its public description, for at most
// PUBLIC_PHOTO_PAGE_ITEMS items per request. Shared by that route and the
// storefront, so the URL the browser asks for and the URL the route accepts are
// built by one function.
//
// ONE URL PER PAGE, AS FAR AS THE ROUTE CAN SEE. The CDN caches the route's
// answer per URL, so any other spelling of the same page (another parameter,
// another order, page=0) would be a cache key of its own, and a fresh read and
// a fresh round of signing on every request. The route answers only the URL
// publicPhotoPageUrl builds, and refuses every other spelling it sees before it
// reads anything.
//
// It does not see every spelling. Next rewrites the request's URL before the
// route runs (normalizeCdnUrl in next/dist/server/server-utils.js): it drops a
// parameter whose name starts with nxtP or nxtI, and nextInternalLocale, and
// writes the query again, which decodes a percent-escape and drops an empty
// `&` segment. Those spellings reach the route as the page's own URL, so it
// answers them, and the CDN still keeps each apart. What bounds them is that
// the costly read of a page, its eligibility window, comes from the data cache
// keyed by the link, the warehouse and the page (readEligibleWindow in
// server/services/public-catalog.ts), and #380's limit per address. Exactly
// one cache key per page needs a check where the raw request is seen, such as
// a Vercel Firewall rule (B32 review round 2).

import { PUBLIC_CATALOG_ROW_CEILING } from './catalog-index';

export const PUBLIC_PHOTO_ROUTE = '/api/v1/public/catalog-thumbnails';

/** Items per photo page: the route signs at most this many photos per
 *  request (decision 1, the old cap), in the eligible items' item_id order. */
export const PUBLIC_PHOTO_PAGE_ITEMS = 500;

/** The photo pages that cover a full catalog (PUBLIC_CATALOG_ROW_CEILING). */
export const PUBLIC_PHOTO_PAGES = Math.ceil(PUBLIC_CATALOG_ROW_CEILING / PUBLIC_PHOTO_PAGE_ITEMS);

/** One photo page, by item id. */
export interface PublicPhotoPage {
  /** The image a card shows: the item's external cover when it has one (as
   *  the page always preferred), else its signed photo. */
  urls: Record<string, string>;
  /** The photo's blur placeholder, for an item shown by its photo. */
  lqip: Record<string, string>;
  /** The item's public description, cut between two characters when the
   *  item's URL, blur and description would pass its share of the page
   *  (PHOTO_PAGE_ITEM_MAX_BYTES in server/services/public-catalog.ts). */
  descriptions: Record<string, string>;
  /** The next page's URL, or null after the last one. */
  next: string | null;
}

export const EMPTY_PUBLIC_PHOTO_PAGE: PublicPhotoPage = {
  urls: {},
  lqip: {},
  descriptions: {},
  next: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The page's own minimum (r/[token]/page.tsx answers 404 below it). */
const TOKEN_MIN = 16;
const TOKEN_MAX = 256;

function canonicalQuery(token: string, warehouseId: string, page: number): string {
  const base = `token=${encodeURIComponent(token)}&warehouseId=${encodeURIComponent(warehouseId)}`;
  // The first page has no page parameter, so its URL is the one the page has
  // always asked for.
  return page === 0 ? base : `${base}&page=${page}`;
}

/** The one URL of a photo page (0 is the first). */
export function publicPhotoPageUrl(token: string, warehouseId: string, page = 0): string {
  return `${PUBLIC_PHOTO_ROUTE}?${canonicalQuery(token, warehouseId, page)}`;
}

/**
 * The photo page a request's query names, or null when the query is not
 * exactly the URL publicPhotoPageUrl builds for it: a missing or extra
 * parameter, another order, another spelling of a value, a token shorter than
 * the page accepts, a warehouse id that is not a lowercase uuid, or a page
 * outside 1 to PUBLIC_PHOTO_PAGES - 1 (the first page has no page parameter).
 * The route passes the query Next leaves (see the note at the top), so a
 * spelling Next rewrites into the page's own URL is not refused here.
 */
export function parsePublicPhotoPageQuery(
  search: string,
): { token: string; warehouseId: string; page: number } | null {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const token = params.get('token');
  const warehouseId = params.get('warehouseId');
  if (!token || token.length < TOKEN_MIN || token.length > TOKEN_MAX) return null;
  if (!warehouseId || !UUID.test(warehouseId)) return null;
  let page = 0;
  const pageParam = params.get('page');
  if (pageParam !== null) {
    if (!/^[1-9][0-9]?$/.test(pageParam)) return null;
    page = Number(pageParam);
    if (page >= PUBLIC_PHOTO_PAGES) return null;
  }
  return raw === canonicalQuery(token, warehouseId, page) ? { token, warehouseId, page } : null;
}
