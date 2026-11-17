import 'server-only';

import { isLikelyIsbn, parseGoogleBooksVolume } from '@stockpilot/core';

import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';
import {
  googleBooksClient,
  GoogleBooksUnavailableError,
  type GoogleBooksClient,
} from '@/server/pricing/google-books-client';

export interface PriceObservationRow {
  item_id: string;
  isbn: string | null;
  list_price: number | null;
  retail_price: number | null;
  currency: string | null;
  title: string | null;
  authors: string | null;
  average_rating: number | null;
  ratings_count: number | null;
  categories: string | null;
  thumbnail_url: string | null;
  info_link: string | null;
  saleability: string | null;
  observed_at: string;
}

interface BookItem {
  id: string;
  barcode: string | null;
  last_priced_at?: string | null;
}

/**
 * Fetch one item's Google Books data (if its barcode is an ISBN) and insert an
 * observation. Works with ANY supabase client — the user-scoped one (on-demand,
 * RLS) or the service-role admin client (cron). Returns whether a row was written.
 * Every lookup Google ANSWERS stamps the book's rotation cursor
 * (last_priced_at), with a price or without one. When Google does not answer
 * (a rate limit, an error, no reply) the client's GoogleBooksUnavailableError
 * is thrown on with nothing written or stamped: that is not "no price found",
 * and the book keeps its place in the line.
 */
export async function recordBookObservation(
  supabase: { from: (t: string) => any },
  orgId: string,
  item: BookItem,
  client: GoogleBooksClient,
): Promise<boolean> {
  if (!isLikelyIsbn(item.barcode)) return false;
  const json = await client.fetchVolumeByIsbn(item.barcode as string);
  const parsed = parseGoogleBooksVolume(json);
  if (parsed) await insertObservation(supabase, orgId, item, parsed);

  // Stamp the rotation cursor so the cron can fairly cycle catalogs >limit,
  // after an answer that gave no price too: a book Google does not know then
  // goes to the back of the line instead of being asked for first on every
  // run (and keeping the books after it from being reached).
  // Non-fatal: an observation is already durably written by now, so a stamp
  // hiccup must never lose it — log and continue. Uses the SAME client, so it
  // works under both the admin (cron) and RLS (on-demand) paths. The stamp
  // does NOT fire the search-vector trigger (scoped to name/sku/barcode/desc).
  const { error: stampError } = await supabase
    .from('inventory_items')
    .update({ last_priced_at: new Date().toISOString() })
    .eq('organization_id', orgId)
    .eq('id', item.id);
  if (stampError) {
    // eslint-disable-next-line no-console
    console.warn(`price-tracking: last_priced_at stamp failed for ${item.id}: ${stampError.message}`);
  } else {
    // No list view shows last_priced_at, but every inventory_items UPDATE
    // bumps updated_at (tg_inventory_items_set_updated_at; 0242 spares only
    // embedding/search_vector) and updated_at is the default sort key. Next
    // de-duplicates the tag per request, so the cron's per-book loop records
    // it once.
    invalidateInventoryListAfterWrite(orgId, 'price.record_observation');
  }
  return parsed !== null;
}

/** Inserts one observation of a looked-up book (throws on a failed insert). */
async function insertObservation(
  supabase: { from: (t: string) => any },
  orgId: string,
  item: BookItem,
  parsed: NonNullable<ReturnType<typeof parseGoogleBooksVolume>>,
): Promise<void> {
  const { error } = await supabase.from('item_price_observations').insert({
    organization_id: orgId,
    item_id: item.id,
    source: 'google_books',
    isbn: (item.barcode as string).replace(/[\s-]/g, ''),
    list_price: parsed.listPrice,
    retail_price: parsed.retailPrice,
    currency: parsed.currency,
    title: parsed.title,
    authors: parsed.authors,
    average_rating: parsed.averageRating,
    ratings_count: parsed.ratingsCount,
    categories: parsed.categories,
    thumbnail_url: parsed.thumbnailUrl,
    info_link: parsed.infoLink,
    saleability: parsed.saleability,
  });
  if (error) throw new ServiceError('internal_error', error.message);
}

const RECENT_MS = 20 * 60 * 60 * 1000; // skip items observed within ~20h
const DEFAULT_LIMIT = 300;

/**
 * Batch-refresh book prices for one org. Client-agnostic (cron passes the admin
 * client; the service passes ctx.supabase). Selects active book items with an
 * ISBN-ish barcode ordered by `last_priced_at` (nulls first → never-priced win,
 * then oldest), so catalogs larger than `limit` rotate fairly across runs.
 * Skips items priced within RECENT_MS, throttles, caps at `limit`, and stops
 * gracefully at `deadlineMs` so a platform hard-kill never silently drops orgs.
 *
 * `maxLookups` stops once that many Google lookups are made (the scheduled
 * job's share of its run), apart from `limit`, which bounds the read. An
 * answer that gives no price stamps the book's rotation cursor (last_priced_at)
 * all the same (recordBookObservation), so a book Google does not know goes to the back of the line
 * instead of being asked for first on every run (and keeping the books after
 * it from ever being reached). `tried` (the scheduled job's, per
 * organization, kept across its rounds) skips the items already looked up in
 * this run without asking Google again, and records each item looked up now.
 * `lookups` in the answer counts the calls to Google.
 *
 * When Google does not answer (GoogleBooksUnavailableError: a rate limit, an
 * error, no reply) the refresh stops at once with `googleUnavailable: true`:
 * that book and the ones after it are left as they were (not stamped, not
 * marked tried), and the caller asks Google nothing more this run.
 */
export async function refreshBookPricesForOrg(
  supabase: { from: (t: string) => any },
  orgId: string,
  client: GoogleBooksClient,
  opts: { limit?: number; deadlineMs?: number; maxLookups?: number; tried?: Set<string> } = {},
): Promise<{
  scanned: number;
  written: number;
  skipped: number;
  lookups: number;
  googleUnavailable: boolean;
}> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const { data: items, error } = await supabase
    .from('inventory_items')
    .select('id, barcode, last_priced_at')
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .eq('status', 'active')
    .eq('item_type', 'book')
    .not('barcode', 'is', null)
    .order('last_priced_at', { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new ServiceError('internal_error', error.message);

  let written = 0;
  let skipped = 0;
  let lookups = 0;
  let googleUnavailable = false;
  const list = (items ?? []) as BookItem[];
  for (const item of list) {
    // Graceful stop under the platform kill — better to return partial counts
    // than be hard-killed mid-loop with no result at all.
    if (opts.deadlineMs && Date.now() > opts.deadlineMs) break;
    if (opts.maxLookups !== undefined && lookups >= opts.maxLookups) break;
    if (opts.tried?.has(item.id)) continue;
    const priced = item.last_priced_at ? Date.now() - new Date(item.last_priced_at).getTime() : Infinity;
    if (priced < RECENT_MS || !isLikelyIsbn(item.barcode)) {
      skipped += 1;
      continue;
    }
    opts.tried?.add(item.id);
    lookups += 1;
    let ok: boolean;
    try {
      ok = await recordBookObservation(supabase, orgId, item, client);
    } catch (e) {
      if (!(e instanceof GoogleBooksUnavailableError)) throw e;
      // Not an answer: this book was not looked up after all.
      opts.tried?.delete(item.id);
      googleUnavailable = true;
      break;
    }
    if (ok) written += 1;
    else skipped += 1;
    await new Promise((r) => setTimeout(r, 120)); // gentle throttle for Google's quota
  }
  return { scanned: list.length, written, skipped, lookups, googleUnavailable };
}

/**
 * PriceTrackingService — user-scoped (RLS) on-demand price pulls. Gated on the
 * price_tracking module + items:update. Delegates fetch/persist to the shared
 * helpers so the cron and the UI share one source of truth.
 */
export class PriceTrackingService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly client: GoogleBooksClient = googleBooksClient,
  ) {}

  static async forCurrentUser() {
    return new PriceTrackingService(await withContext());
  }

  async fetchItemPrice(itemId: string): Promise<PriceObservationRow | null> {
    assertModuleEnabled(this.ctx, 'price_tracking');
    assertPermission(this.ctx, 'items:update');
    const { data: item, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, barcode')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', itemId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!item) throw new ServiceError('not_found', 'Item not found.');
    try {
      await recordBookObservation(this.ctx.supabase, this.ctx.organizationId, item as BookItem, this.client);
    } catch (e) {
      // Google did not answer: nothing new, the latest observation stands.
      if (!(e instanceof GoogleBooksUnavailableError)) throw e;
    }
    return this.getLatestObservation(itemId);
  }

  async refreshOrgBookPrices(opts: { limit?: number; deadlineMs?: number } = {}) {
    assertModuleEnabled(this.ctx, 'price_tracking');
    assertPermission(this.ctx, 'items:update');
    // Default deadline so the on-demand bulk action stops gracefully well under
    // any request timeout rather than being hard-killed mid-loop.
    return refreshBookPricesForOrg(this.ctx.supabase, this.ctx.organizationId, this.client, {
      ...opts,
      deadlineMs: opts.deadlineMs ?? Date.now() + 25_000,
    });
  }

  async getLatestObservation(itemId: string): Promise<PriceObservationRow | null> {
    assertModuleEnabled(this.ctx, 'price_tracking');
    const { data, error } = await this.ctx.supabase
      .from('item_price_observations')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', itemId)
      .order('observed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    return (data as PriceObservationRow | null) ?? null;
  }
}
