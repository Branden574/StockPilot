import 'server-only';

import { unstable_cache } from 'next/cache';

import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { sha256Hex } from '@/lib/token-hash';

import {
  EMPTY_PUBLIC_CATALOG,
  PUBLIC_CATALOG_ROW_CEILING,
  stockForRow,
  type PublicCatalogCategory,
  type PublicCatalogIndex,
  type PublicCatalogRow,
} from '@/components/orders/public-v2/catalog-index';
import {
  PUBLIC_PHOTO_PAGE_ITEMS,
  PUBLIC_PHOTO_PAGES,
} from '@/components/orders/public-v2/photo-pages';
import type {
  PublicAvailability,
  PublicAvailabilityDisplay,
  PublicCatalogItem,
} from '@/components/orders/public-v2/types';

import { ServiceError } from './context';
import {
  fetchAllRowsByIds,
  mapIdBatches,
  reportDegradedRead,
  settleAsDataError,
} from './lib/fetch-by-ids';
import { fetchAllRows, PAGE_SIZE } from './lib/paginate';
import { postgrestErrorText } from './lib/postgrest-error';
import { publicCatalogTag } from './public-links';

/**
 * Public, link-aware catalog loader for the `/r/[token]` order page
 * (migration 0261; plan:
 * docs/superpowers/plans/2026-07-12-public-catalog-visibility-plan.md).
 *
 * ELIGIBILITY is decided by ONE SQL predicate —
 * `public.public_link_eligible_items(link_id, warehouse_id)` — shared with
 * the submit endpoint (/api/v1/public/order-requests), so what the page
 * renders and what the API accepts can never drift. The predicate encodes:
 * item active + not deleted + warehouse publicly orderable + item not
 * 'hidden' + (explicit catalog entry OR public-pool item in a public
 * category on a pool-enabled link) + link active/not expired/inside date
 * window + per-type toggle (books_enabled/items_enabled).
 *
 * SHAPE: the compact PublicCatalogIndex (components/orders/public-v2/
 * catalog-index.ts), the ONLY thing cached for and serialized into the
 * anonymous page; the photo route answers the lazy fields a page of 500
 * items at a time (readPublicPhotoPage, photo-pages.ts PublicPhotoPage).
 * Neither has a field for cost, price, sku, rack/bin location, reserved
 * quantities, reorder point, or charter data; leaking any of those is a
 * compile error, not a remember-to-null-it convention.
 *
 * CACHE: one unstable_cache entry per (link, warehouse), and nothing else in
 * its key, 60s revalidate, tag `public-catalog-<linkId>`. Admin mutations
 * (PublicLinksService) call revalidateTag(tag, 'max') so config changes
 * surface immediately; the 60s window only covers organic stock drift.
 * Submit always re-validates fresh, so a stale render fails closed. The
 * entry stays under 1.5 MB by Next's own measure at PUBLIC_CATALOG_ROW_CEILING
 * items whatever the text (B32, integrator decision 3): Next does not store
 * an entry over 2 MB, and every view would then read the catalog again.
 */

// ── Public schema ───────────────────────────────────────────────────────────
// PublicCatalogItem/PublicAvailability live in
// components/orders/public-v2/types.ts (types only — shared verbatim with
// the anonymous UI so server payload and client rendering can't drift).
// Re-exported here so server-side callers keep importing from the service.

export type { PublicAvailability, PublicCatalogIndex, PublicCatalogItem };

/** Minimal link config the public read path needs. */
export interface PublicLinkConfig {
  id: string;
  organizationId: string;
  name: string;
  instructions: string | null;
  active: boolean;
  expiresAt: string | null;
  availableFrom: string | null;
  availableUntil: string | null;
  availabilityDisplay: 'exact' | 'bucket' | 'none';
  booksEnabled: boolean;
  itemsEnabled: boolean;
  includePublicPool: boolean;
  defaultMaxQty: number | null;
}

export interface PublicRequestContext {
  org: {
    id: string;
    name: string;
    logo_url: string | null;
    public_request_blurb: string | null;
  };
  /**
   * null = legacy fallback: the token matched organizations.
   * public_request_token but no links row (possible only for tokens minted
   * outside the links table after migration 0261 backfilled every org).
   */
  link: PublicLinkConfig | null;
}

/**
 * The most items one link's page lists for one warehouse, and the photo
 * pages that cover them (components/orders/public-v2: catalog-index.ts and
 * photo-pages.ts, shared with the storefront). At the ceiling, with every
 * field at its maximum length, the cached catalog measures 1,425,037 by Next's
 * own measure, under the 1.5 MB this module allows itself
 * (public-catalog.caps.test.ts).
 */
export { PUBLIC_CATALOG_ROW_CEILING, PUBLIC_PHOTO_PAGE_ITEMS, PUBLIC_PHOTO_PAGES };

/**
 * The longest name, category label and cover URL a cached row keeps, counted
 * as the cached entry counts them: characters once the value's JSON is encoded
 * again (capForCache). A plain character counts 1, an emoji 2, a quote or
 * backslash 4, a control character 7. 300 is the public display name's own
 * limit (0261) and 120 the category form's; no name the item or category form
 * accepts is cut. A cover past its limit is left to the photo pages whole,
 * never cut (a cut URL is a broken one).
 */
export const PUBLIC_NAME_MAX = 300;
export const PUBLIC_CATEGORY_LABEL_MAX = 120;
export const PUBLIC_ROW_COVER_MAX = 160;

/**
 * The most one item takes of a photo page, in bytes of the JSON answer
 * (jsonBytes): its photo or cover URL, its blur and its description together.
 * A URL or a blur past its own limit is left out (a cut URL or data URI draws
 * nothing); the description is cut, between two characters, to what the item
 * has left. So a page of PUBLIC_PHOTO_PAGE_ITEMS items is at most
 * 500 x (8,000 + 126 for the three id keys) bytes plus its envelope, about
 * 4.06 MB, under the 4.5 MB Vercel answers a larger function response with an
 * error (B32 review round 2). It used to be bounded only by the items' text:
 * 2,000 control characters, which JSON writes as 6 bytes each, made a page of
 * 7.4 MB.
 *
 * A description of 2,000 characters in any script (6,000 bytes at 3 a
 * character) is not cut on an item whose URL and blur are of a real size
 * (about 500 and 400 bytes). Only text JSON writes long can be: many control
 * characters, or more emoji than the item form takes (it stops at 1,000).
 */
export const PHOTO_PAGE_ITEM_MAX_BYTES = 8_000;
/** The longest photo or cover URL a photo page sends, in JSON bytes. A cover
 *  past it is not used (the item shows its photo), a signed URL past it is
 *  left out; a real signed URL is about 500 bytes. */
export const PHOTO_PAGE_URL_MAX_BYTES = 2_000;
/** The longest blur a photo page sends, in JSON bytes: the column's
 *  2,000-character limit (0122) in base64, which is all a real blur is. */
export const PHOTO_PAGE_BLUR_MAX_BYTES = 2_000;

/** Pages of open reservations one batch of 100 items may take (10,000 rows)
 *  before the load fails instead of reading on (see readOpenReservations). */
const RESERVATION_PAGES_PER_BATCH = 10;

/** One row of `public_link_eligible_items`. */
export interface EligibleItem {
  item_id: string;
  max_qty: number | null;
}

/** An eligibility page as supabase-js answers it. */
type EligibleRead = PromiseLike<{
  data: EligibleItem[] | null;
  error: { message: string } | null;
  status?: number;
  statusText?: string;
}>;

function eligibleItemsRead(
  admin: ReturnType<typeof createAdminClient>,
  linkId: string,
  warehouseId: string,
  from: number,
  to: number,
): EligibleRead {
  return admin
    .rpc('public_link_eligible_items', { p_link_id: linkId, p_warehouse_id: warehouseId })
    .order('item_id', { ascending: true })
    .range(from, to) as unknown as EligibleRead;
}

/**
 * The items `public_link_eligible_items` admits for a link and warehouse, to
 * `ceiling` (PUBLIC_CATALOG_ROW_CEILING), read in item_id order in 1000-row
 * pages, one row past the ceiling so `cut` says whether the link has more.
 * Reaching it is logged.
 *
 * One unpaged call used to be enough to look right: PostgREST answers any
 * request with at most 1000 rows (`max_rows`), and the function has no ORDER
 * BY, so past 1000 eligible items an arbitrary set silently dropped out.
 * THROWS on a failed page (fetchAllRows), never returning the pages before it
 * as the whole catalog.
 */
export async function readEligibleItems(
  admin: ReturnType<typeof createAdminClient>,
  linkId: string,
  warehouseId: string,
  opts: { ceiling?: number } = {},
): Promise<{ items: EligibleItem[]; cut: boolean }> {
  const ceiling = opts.ceiling ?? PUBLIC_CATALOG_ROW_CEILING;
  const rows = await fetchAllRows<EligibleItem>(
    (from, to) => eligibleItemsRead(admin, linkId, warehouseId, from, to),
    { cap: ceiling + 1 },
  );
  const cut = rows.length > ceiling;
  if (cut) {
    console.error(
      `[public-catalog] link ${linkId} has more than ${ceiling} eligible items for warehouse ${warehouseId}: the page lists the first ${ceiling} by item id and says the list stops there`,
    );
  }
  return { items: cut ? rows.slice(0, ceiling) : rows, cut };
}

/**
 * One photo page: the link's eligible items from `page * PUBLIC_PHOTO_PAGE_ITEMS`
 * in item_id order, at most PUBLIC_PHOTO_PAGE_ITEMS of them, in ONE request
 * for one row more than that (it says whether another page follows). `next`
 * is the following page, or null past the last one or past the page's
 * ceiling. The function computes the link's whole eligible set and PostgREST
 * returns only this window: that is as narrow as the function allows (it is
 * SECURITY DEFINER, so the planner cannot push the window into it). THROWS on
 * a failed read.
 */
export async function readEligiblePage(
  admin: ReturnType<typeof createAdminClient>,
  linkId: string,
  warehouseId: string,
  page: number,
): Promise<{ items: EligibleItem[]; next: number | null }> {
  const from = page * PUBLIC_PHOTO_PAGE_ITEMS;
  const res = await eligibleItemsRead(
    admin,
    linkId,
    warehouseId,
    from,
    from + PUBLIC_PHOTO_PAGE_ITEMS,
  );
  if (res.error) throw new ServiceError('internal_error', postgrestErrorText(res.error, res));
  const rows = res.data ?? [];
  const more = rows.length > PUBLIC_PHOTO_PAGE_ITEMS && page + 1 < PUBLIC_PHOTO_PAGES;
  return { items: rows.slice(0, PUBLIC_PHOTO_PAGE_ITEMS), next: more ? page + 1 : null };
}

/** One photo page's window of a link's eligible items, as the data cache
 *  keeps it (JSON: about 20 KB at 500 ids). */
interface EligibleWindow {
  /** The page's item ids, in item_id order. */
  ids: string[];
  /** The page after it, or null. */
  next: number | null;
}

/**
 * The eligible item ids of one photo page (readEligiblePage), from the data
 * cache: one entry per link, warehouse and page, kept 60 s and tagged with the
 * link's catalog tag, so a change to the link or to an item's visibility drops
 * it with the catalog (PublicLinksService, item-visibility.ts). The wrapper is
 * made per call so its tag can carry the link id, as getPublicCatalogForLink's.
 *
 * WHY IT IS CACHED (B32 review round 2). The photo route answers only a page's
 * one URL, but Next rewrites the request's URL before the route sees it
 * (normalizeCdnUrl in next/dist/server/server-utils.js): a parameter whose name
 * starts with nxtP or nxtI, and nextInternalLocale, are dropped, and the query
 * is written again, which decodes a percent-escape and drops an empty `&`
 * segment. Each such spelling is a CDN cache key of its own, and the route sees
 * the page's own URL, so it cannot refuse them. This window is the costly read
 * of a page (the function computes the link's whole eligible set), and its key
 * is the page, never the URL: however many spellings arrive, the function runs
 * once a minute per link, warehouse and page. THROWS on a failed read, which
 * the data cache does not keep.
 */
async function readEligibleWindow(
  linkId: string,
  warehouseId: string,
  page: number,
): Promise<EligibleWindow> {
  const cached = unstable_cache(loadEligibleWindow, ['public-link-photo-window-v1'], {
    revalidate: 60,
    tags: [publicCatalogTag(linkId)],
  });
  return cached(linkId, warehouseId, page);
}

async function loadEligibleWindow(
  linkId: string,
  warehouseId: string,
  page: number,
): Promise<EligibleWindow> {
  const { items, next } = await readEligiblePage(createAdminClient(), linkId, warehouseId, page);
  return { ids: items.map((r) => r.item_id), next };
}

/** The lazy fields of one photo page, by item id. */
export interface PublicCatalogPageDetails {
  /** The storage path of the item's first photo (primary first), to sign. */
  photoPaths: Map<string, string>;
  /** That photo's blur placeholder. */
  lqip: Map<string, string>;
  /** The item's public description. */
  descriptions: Map<string, string>;
  /** An external http(s) cover URL (ISBN imports keep one in custom_fields). */
  covers: Map<string, string>;
}

/**
 * The lazy fields of up to PUBLIC_PHOTO_PAGE_ITEMS items (one photo page),
 * in two batched reads of at most one page each per 100 ids: each item's first
 * photo (with its blur), and each item's public description and cover. The
 * photo read keeps the first PAGE_SIZE image rows of a batch, primaries first;
 * a batch that fills them is reported, and only an item with no primary photo
 * and many images can miss its photo there. THROWS on a failed read, so the
 * photo route answers 500 and the CDN keeps nothing short.
 */
export async function readPublicPageDetails(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  itemIds: readonly string[],
): Promise<PublicCatalogPageDetails> {
  type ImageRow = { item_id: string; storage_path: string; lqip: string | null };
  type ItemRow = { id: string; public_description: string | null; thumbnail_url: string | null };
  const [imageBatches, itemBatches] = await Promise.all([
    mapIdBatches(itemIds, async (batch) => {
      const res = await admin
        .from('item_images')
        .select('item_id, storage_path, lqip')
        .eq('organization_id', organizationId)
        .in('item_id', batch)
        .order('is_primary', { ascending: false })
        .order('sort_order', { ascending: true })
        .order('id')
        .range(0, PAGE_SIZE - 1);
      if (res.error) throw new ServiceError('internal_error', postgrestErrorText(res.error, res));
      const rows = (res.data ?? []) as ImageRow[];
      if (rows.length >= PAGE_SIZE) {
        reportDegradedRead('public_catalog.photo_page_full', 'one page of image rows', {
          items: batch.length,
        });
      }
      return rows;
    }),
    mapIdBatches(itemIds, async (batch) => {
      const res = await admin
        .from('inventory_items')
        .select('id, public_description, thumbnail_url:custom_fields->>thumbnail_url')
        .eq('organization_id', organizationId)
        .in('id', batch);
      if (res.error) throw new ServiceError('internal_error', postgrestErrorText(res.error, res));
      return (res.data ?? []) as unknown as ItemRow[];
    }),
  ]);
  const details: PublicCatalogPageDetails = {
    photoPaths: new Map(),
    lqip: new Map(),
    descriptions: new Map(),
    covers: new Map(),
  };
  for (const row of imageBatches.flat()) {
    if (details.photoPaths.has(row.item_id)) continue;
    details.photoPaths.set(row.item_id, row.storage_path);
    if (row.lqip) details.lqip.set(row.item_id, row.lqip);
  }
  for (const row of itemBatches.flat()) {
    if (row.public_description) details.descriptions.set(row.id, row.public_description);
    const cover = externalCoverUrl(row.thumbnail_url);
    if (cover) details.covers.set(row.id, cover);
  }
  return details;
}

/** One photo page as /api/v1/public/catalog-thumbnails answers it, with the
 *  number of the page after it (the route turns it into that page's URL). */
export interface PublicPhotoPageContent {
  urls: Record<string, string>;
  lqip: Record<string, string>;
  descriptions: Record<string, string>;
  nextPage: number | null;
}

/**
 * One photo page of a link's catalog: the page's eligible items
 * (readEligibleWindow, at most PUBLIC_PHOTO_PAGE_ITEMS, from the data cache),
 * their lazy fields (readPublicPageDetails) and their photos, signed by `sign`
 * (the route passes ItemImagesService.signedUrls).
 *
 * An item with an external cover is shown by its cover, as the page always
 * preferred, so its photo is not signed and its blur is not sent. Every other
 * item with a photo is signed once (a path two items share, once). So one
 * request signs at most PUBLIC_PHOTO_PAGE_ITEMS photos and reads the database
 * at most 1 + 2 * ceil(PUBLIC_PHOTO_PAGE_ITEMS / 100) times: 11, and the 1 only
 * when the data cache does not hold the window.
 *
 * Each item takes at most PHOTO_PAGE_ITEM_MAX_BYTES of the answer: a URL or a
 * blur past its limit is left out (reported: neither is what the app writes),
 * and the description is cut to what the item has left. THROWS on a failed
 * read.
 */
export async function readPublicPhotoPage(
  admin: ReturnType<typeof createAdminClient>,
  link: { id: string; organizationId: string },
  warehouseId: string,
  page: number,
  sign: (paths: string[]) => Promise<Map<string, string>>,
): Promise<PublicPhotoPageContent> {
  const eligible = await readEligibleWindow(link.id, warehouseId, page);
  const out: PublicPhotoPageContent = {
    urls: {},
    lqip: {},
    descriptions: {},
    nextPage: eligible.next,
  };
  const itemIds = eligible.ids;
  if (itemIds.length === 0) return out;

  const details = await readPublicPageDetails(admin, link.organizationId, itemIds);
  const photoOf = new Map<string, string>();
  for (const id of itemIds) {
    if (details.covers.has(id)) continue;
    const path = details.photoPaths.get(id);
    if (path) photoOf.set(id, path);
  }
  const signed =
    photoOf.size === 0 ? new Map<string, string>() : await sign([...new Set(photoOf.values())]);

  let urlsLeftOut = 0;
  let blursLeftOut = 0;
  for (const id of itemIds) {
    let room = PHOTO_PAGE_ITEM_MAX_BYTES;
    const path = photoOf.get(id);
    const url = details.covers.get(id) ?? (path === undefined ? undefined : signed.get(path));
    if (url !== undefined) {
      const bytes = jsonBytes(url);
      if (bytes <= PHOTO_PAGE_URL_MAX_BYTES) {
        out.urls[id] = url;
        room -= bytes;
      } else {
        urlsLeftOut += 1;
      }
    }
    const blur = path === undefined ? undefined : details.lqip.get(id);
    if (blur !== undefined) {
      const bytes = jsonBytes(blur);
      if (bytes <= PHOTO_PAGE_BLUR_MAX_BYTES) {
        out.lqip[id] = blur;
        room -= bytes;
      } else {
        blursLeftOut += 1;
      }
    }
    const description = details.descriptions.get(id);
    if (description) {
      const fitted = capJsonBytes(description, room);
      if (fitted) out.descriptions[id] = fitted;
    }
  }
  if (urlsLeftOut > 0 || blursLeftOut > 0) {
    void reportError(new Error('A public photo page left out a URL or a blur too long to send'), {
      tag: 'public_catalog.photo_page_field_too_long',
      level: 'warning',
      organizationId: link.organizationId,
      extra: { linkId: link.id, page, urlsLeftOut, blursLeftOut },
    });
  }
  return out;
}

/**
 * External cover URL from `custom_fields.thumbnail_url`. ISBN-imported books
 * store their cover there: a public CDN link (Open Library / Google Books)
 * that needs no signing, so a short one ships with the page and draws with
 * the HTML. Returns the cover at FULL size (e.g. Open Library `-L`): the card
 * renders through next/image, which downscales to the exact display size and
 * re-encodes to WebP/AVIF, so shipping the large source keeps covers SHARP on
 * retina without a large byte cost. (An earlier `-L`→`-M` downsize here made
 * covers upscale ~2.5× in the 220-260px retina cells and read blurry.)
 * Returns null unless the field is a plain http(s) URL under 2,000
 * characters, so no other custom field value reaches the public page, and
 * at most PHOTO_PAGE_URL_MAX_BYTES once written in JSON, so a cover's share of
 * a photo page stays bounded (a real cover URL is ASCII, 1 byte a character,
 * so only text that is not a URL goes past it; the item then shows its photo).
 */
function externalCoverUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url) || url.length >= 2000) return null;
  if (jsonBytes(url) > PHOTO_PAGE_URL_MAX_BYTES) return null;
  return url;
}

/** Bytes `text` adds to a JSON answer: its JSON form in UTF-8, less the
 *  quotes. A plain character is 1, an accented letter 2, a character of most
 *  other scripts 3, an emoji 4; a quote, a backslash, a tab or a newline 2,
 *  and most other control characters 6. */
function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
}

/**
 * `text` cut to at most `max` bytes of a JSON answer (jsonBytes), between two
 * characters, never inside one (an emoji cut in half is a lone surrogate,
 * which JSON writes as 6 bytes and no browser draws). Text that fits is
 * returned as it is. JSON writes each character on its own, so the bytes of
 * the characters kept add up to the bytes of the text kept.
 */
function capJsonBytes(text: string, max: number): string {
  if (jsonBytes(text) <= max) return text;
  let used = 0;
  let end = 0;
  // A string iterates by code point: an emoji comes whole, a lone surrogate
  // alone.
  for (const ch of text) {
    const bytes = jsonBytes(ch);
    if (used + bytes > max) break;
    used += bytes;
    end += ch.length;
  }
  return text.slice(0, end);
}

/**
 * Characters `text` adds to the cached entry: its JSON once encoded again,
 * less the quotes around it, the measure Next applies to the entry
 * (nextDataCacheEntrySize in public-catalog.caps.test.ts).
 */
function cachedLength(text: string): number {
  return JSON.stringify(JSON.stringify(text)).length - 6;
}

/**
 * `text` cut to at most `max` characters of the cached entry (cachedLength),
 * never in the middle of an emoji. Text that fits is returned as it is.
 */
function capForCache(text: string, max: number): string {
  if (cachedLength(text) <= max) return text;
  let out = text.slice(0, max);
  while (out.length > 0 && cachedLength(out) > max) out = out.slice(0, -1);
  // A high surrogate with its pair cut off would read as a broken character.
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/**
 * The open reservations of a list of items, in batches of 100 ids, each
 * batch paged past the 1000-row cap to at most RESERVATION_PAGES_PER_BATCH
 * pages. Reservations decide the availability shown, so a batch that fills
 * them fails the load (logged, never cached) instead of reading on without
 * end or showing reserved stock as available. THROWS on a failed page.
 */
async function readOpenReservations(
  admin: ReturnType<typeof createAdminClient>,
  organizationId: string,
  linkId: string,
  itemIds: readonly string[],
): Promise<Array<{ item_id: string; quantity: number }>> {
  const limit = RESERVATION_PAGES_PER_BATCH * PAGE_SIZE;
  const perBatch = await mapIdBatches(itemIds, async (batch) => {
    const rows = await fetchAllRows<{ item_id: string; quantity: number }>(
      (from, to) =>
        admin
          .from('stock_reservations')
          .select('item_id, quantity')
          .eq('organization_id', organizationId)
          .in('item_id', batch)
          .is('released_at', null)
          .order('id')
          .range(from, to),
      { cap: limit },
    );
    if (rows.length >= limit) {
      console.error(
        `[public-catalog] link ${linkId}: ${batch.length} items have ${limit} or more open reservations; the catalog fails to load rather than read on`,
      );
      throw new ServiceError('internal_error', `more than ${limit} open reservations in one batch`);
    }
    return rows;
  });
  return perBatch.flat();
}

// ── Token → link/org resolution ─────────────────────────────────────────────

/**
 * Resolves a /r/<token> token: links-table-FIRST (the migrated "General
 * request link" carries each org's legacy token, so existing URLs land
 * here), then the organizations.public_request_token fallback for any
 * token that predates/escaped the 0261 backfill. Cached 60s — same
 * staleness posture as the old getOrgByPublicToken: renders may lag a
 * rotation by up to 60s but submit validates fresh and fails closed.
 */
export async function resolvePublicRequestToken(
  token: string,
): Promise<PublicRequestContext | null> {
  return resolvePublicRequestTokenCached(token);
}

const resolvePublicRequestTokenCached = unstable_cache(
  async (token: string): Promise<PublicRequestContext | null> => {
    const admin = createAdminClient();

    // Module gate for the READ path (review finding 2026-07-12): the submit
    // route already 404s when `public_requests` is disabled, but without
    // this check a previously-shared /r/<token> URL kept rendering the full
    // catalog after an org turned the module off (entitlement boundary
    // enforced write-only). Same posture as submit: optional module, an
    // explicit enabled row is required; resolver returns null → the page
    // 404s without leaking that the org exists. A query error also lands on
    // null (fail closed). Cached with the resolution (60s TTL bounds a
    // module toggle; link mutations revalidate the tag).
    const moduleEnabled = async (orgId: string): Promise<boolean> => {
      const { data } = await admin
        .from('organization_modules')
        .select('module_id')
        .eq('organization_id', orgId)
        .eq('module_id', 'public_requests')
        .eq('enabled', true)
        .maybeSingle();
      return Boolean(data);
    };

    // Migration 0330: the DB stores sha256(token); hash the presented
    // plaintext and compare on the hash column. Equality via the btree
    // index is fine here — see sha256Hex()'s doc comment for why a
    // timing-safe compare buys nothing on this path.
    const tokenHash = sha256Hex(token);
    const { data: linkRow } = await admin
      .from('public_request_links')
      .select(
        'id, organization_id, name, instructions, active, expires_at, available_from, available_until, availability_display, books_enabled, items_enabled, include_public_pool, default_max_qty',
      )
      .eq('token_hash', tokenHash)
      .maybeSingle();

    type LinkRow = {
      id: string;
      organization_id: string;
      name: string;
      instructions: string | null;
      active: boolean;
      expires_at: string | null;
      available_from: string | null;
      available_until: string | null;
      availability_display: 'exact' | 'bucket' | 'none';
      books_enabled: boolean;
      items_enabled: boolean;
      include_public_pool: boolean;
      default_max_qty: number | null;
    };

    const orgSelect = 'id, name, logo_url, public_request_blurb';
    type OrgRow = {
      id: string;
      name: string;
      logo_url: string | null;
      public_request_blurb: string | null;
    };

    if (linkRow) {
      const l = linkRow as LinkRow;
      const { data: orgRow } = await admin
        .from('organizations')
        .select(orgSelect)
        .eq('id', l.organization_id)
        .maybeSingle();
      if (!orgRow || !(await moduleEnabled(l.organization_id))) return null;
      return {
        org: orgRow as OrgRow,
        link: {
          id: l.id,
          organizationId: l.organization_id,
          name: l.name,
          instructions: l.instructions,
          active: l.active,
          expiresAt: l.expires_at,
          availableFrom: l.available_from,
          availableUntil: l.available_until,
          availabilityDisplay: l.availability_display,
          booksEnabled: l.books_enabled,
          itemsEnabled: l.items_enabled,
          includePublicPool: l.include_public_pool,
          defaultMaxQty: l.default_max_qty,
        },
      };
    }

    // Legacy fallback — org token without a links row. Droppable once
    // verified unused in prod (plan, locked decision 1).
    const { data: orgByToken } = await admin
      .from('organizations')
      .select(orgSelect)
      .eq('public_request_token_hash', tokenHash)
      .maybeSingle();
    const legacyOrg = orgByToken as OrgRow | null;
    if (!legacyOrg || !(await moduleEnabled(legacyOrg.id))) return null;
    return { org: legacyOrg, link: null };
  },
  ['public-link-by-token-v1'],
  { revalidate: 60, tags: ['public-org-by-token'] },
);

/** true when the link is enabled AND inside its expiry/date window. */
export function isLinkOpen(
  link: Pick<PublicLinkConfig, 'active' | 'expiresAt' | 'availableFrom' | 'availableUntil'>,
  now: Date = new Date(),
): boolean {
  if (!link.active) return false;
  const t = now.getTime();
  if (link.expiresAt && Date.parse(link.expiresAt) <= t) return false;
  if (link.availableFrom && Date.parse(link.availableFrom) > t) return false;
  if (link.availableUntil && Date.parse(link.availableUntil) < t) return false;
  return true;
}

// ── Link-aware catalog ──────────────────────────────────────────────────────

/**
 * The page's catalog for one link and warehouse, from the data cache. The
 * key is the link id and the warehouse id and nothing else (the page checks
 * that the warehouse is one of the link organization's publicly orderable
 * ones before it asks), so no request can make a new entry or force a load
 * past the cache; the loader reads the link's organization and display mode
 * itself. The wrapper is created per call so its TAG can carry the link id
 * (unstable_cache fixes tags at wrap time).
 */
export async function getPublicCatalogForLink(
  linkId: string,
  warehouseId: string,
): Promise<PublicCatalogIndex> {
  // v2: the compact catalog (B32). An entry of the old shape is never read.
  const cached = unstable_cache(loadPublicCatalogUncached, ['public-link-catalog-v2'], {
    revalidate: 60,
    tags: [publicCatalogTag(linkId)],
  });
  return cached(linkId, warehouseId);
}

/**
 * A cache miss. Every read is a batch of at most 100 ids or a page of at most
 * PAGE_SIZE rows, and the whole miss is bounded: at the ceiling (2,000 items
 * in 20 batches), 1 link read, 3 eligibility pages, 20 item reads, 20 to 200
 * reservation pages (10 at most per batch) and up to 20 category reads.
 */
async function loadPublicCatalogUncached(
  linkId: string,
  warehouseId: string,
): Promise<PublicCatalogIndex> {
  const admin = createAdminClient();

  // 0. The link's organization and display mode, from the link itself, so
  // they are never part of the cache key. A failed read throws (never cached).
  const linkRes = await admin
    .from('public_request_links')
    .select('organization_id, availability_display')
    .eq('id', linkId)
    .maybeSingle();
  if (linkRes.error) {
    throw new ServiceError('internal_error', postgrestErrorText(linkRes.error, linkRes));
  }
  const linkRow = linkRes.data as {
    organization_id: string;
    availability_display: PublicAvailabilityDisplay;
  } | null;
  if (!linkRow) return EMPTY_PUBLIC_CATALOG;
  const orgId = linkRow.organization_id;
  const mode = linkRow.availability_display;
  const empty: PublicCatalogIndex = { ...EMPTY_PUBLIC_CATALOG, mode };

  // 1. THE eligibility predicate (shared with submit) → eligible ids + caps,
  // to the ceiling (readEligibleItems). A failed page throws: never cached.
  const eligible = await readEligibleItems(admin, linkId, warehouseId);
  if (eligible.items.length === 0) return { ...empty, cut: eligible.cut };

  const maxQtyByItem = new Map<string, number | null>(
    eligible.items.map((r) => [r.item_id, r.max_qty]),
  );
  const eligibleIds = eligible.items.map((r) => r.item_id);

  // 2. Item rows for the eligible set. ONLY the columns the list needs, all
  // public-safe: never unit_cost, retail_price, sku, reorder_point,
  // bin_location, charter_id, the description or the custom fields (only
  // their cover URL). Batched (100 ids per request) and THROWS on a failed
  // batch: a short list would be cached for 60 s.
  type ItemRow = {
    id: string;
    name: string;
    public_display_name: string | null;
    quantity_on_hand: number | null;
    category_id: string | null;
    thumbnail_url: string | null;
  };
  const items = await fetchAllRowsByIds<ItemRow>(
    eligibleIds,
    (batch) => (from, to) =>
      admin
        .from('inventory_items')
        .select(
          'id, name, public_display_name, quantity_on_hand, category_id, thumbnail_url:custom_fields->>thumbnail_url',
        )
        .eq('organization_id', orgId)
        .in('id', batch)
        .order('id')
        .range(from, to),
  );
  if (items.length === 0) return { ...empty, cut: eligible.cut };

  const nameOf = (it: ItemRow) => it.public_display_name?.trim() || it.name;
  // Every listed item, by name. The page's search runs over this list.
  items.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  const listedIds = items.map((i) => i.id);
  const categoryIds = [
    ...new Set(items.map((i) => i.category_id).filter((v): v is string => Boolean(v))),
  ];

  // 3. Reservations (only when a stock signal ships) and category labels, in
  // parallel. Reservations decide the availability shown, so a failed or
  // runaway read THROWS (never cached); category labels are cosmetic and
  // degrade, reported.
  const [reservations, categoriesRes] = await Promise.all([
    mode === 'none'
      ? Promise.resolve([] as Array<{ item_id: string; quantity: number }>)
      : readOpenReservations(admin, orgId, linkId, listedIds),
    settleAsDataError(
      fetchAllRowsByIds<{ id: string; name: string }>(
        categoryIds,
        (batch) => (from, to) =>
          admin
            .from('categories')
            .select('id, name')
            .eq('organization_id', orgId)
            .in('id', batch)
            .order('id')
            .range(from, to),
      ),
    ),
  ]);
  if (categoriesRes.error) {
    reportDegradedRead('public_catalog.categories', categoriesRes.error.message, {
      categories: categoryIds.length,
    });
  }

  const reservedByItem = new Map<string, number>();
  for (const row of reservations) {
    reservedByItem.set(row.item_id, (reservedByItem.get(row.item_id) ?? 0) + Number(row.quantity));
  }
  const labelById = new Map<string, string>();
  for (const c of categoriesRes.data ?? []) labelById.set(c.id, c.name);

  // Categories are stored once, in the order the list first meets them.
  const categories: PublicCatalogCategory[] = [];
  const categoryIndex = new Map<string, number>();
  const categoryOf = (id: string | null): number => {
    if (!id) return -1;
    let index = categoryIndex.get(id);
    if (index === undefined) {
      index = categories.length;
      // An empty label when it could not be read: the items still group under
      // their category, and the storefront names it as it always did then.
      categories.push([id, capForCache(labelById.get(id) ?? '', PUBLIC_CATEGORY_LABEL_MAX)]);
      categoryIndex.set(id, index);
    }
    return index;
  };

  const rows: PublicCatalogRow[] = items.map((it) => {
    const net = (Number(it.quantity_on_hand) || 0) - (reservedByItem.get(it.id) ?? 0);
    const cover = externalCoverUrl(it.thumbnail_url);
    return [
      it.id,
      capForCache(nameOf(it), PUBLIC_NAME_MAX),
      categoryOf(it.category_id),
      stockForRow(mode, Math.max(0, net)),
      maxQtyByItem.get(it.id) ?? null,
      // A longer cover comes with the item's photo page, whole.
      cover !== null && cachedLength(cover) <= PUBLIC_ROW_COVER_MAX ? cover : null,
    ];
  });
  return { mode, categories, rows, cut: eligible.cut };
}
