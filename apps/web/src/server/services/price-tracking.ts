import 'server-only';

import { isLikelyIsbn, parseGoogleBooksVolume } from '@stockpilot/core';

import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { googleBooksClient, type GoogleBooksClient } from '@/server/pricing/google-books-client';

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
  if (!parsed) return false;
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

  // Stamp the rotation cursor so the cron can fairly cycle catalogs >limit.
  // Non-fatal: the price observation is already durably written, so a stamp
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
  }
  return true;
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
 */
export async function refreshBookPricesForOrg(
  supabase: { from: (t: string) => any },
  orgId: string,
  client: GoogleBooksClient,
  opts: { limit?: number; deadlineMs?: number } = {},
): Promise<{ scanned: number; written: number; skipped: number }> {
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
  const list = (items ?? []) as BookItem[];
  for (const item of list) {
    // Graceful stop under the platform kill — better to return partial counts
    // than be hard-killed mid-loop with no result at all.
    if (opts.deadlineMs && Date.now() > opts.deadlineMs) break;
    const priced = item.last_priced_at ? Date.now() - new Date(item.last_priced_at).getTime() : Infinity;
    if (priced < RECENT_MS || !isLikelyIsbn(item.barcode)) {
      skipped += 1;
      continue;
    }
    const ok = await recordBookObservation(supabase, orgId, item, client);
    if (ok) written += 1;
    else skipped += 1;
    await new Promise((r) => setTimeout(r, 120)); // gentle throttle for Google's quota
  }
  return { scanned: list.length, written, skipped };
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
    await recordBookObservation(this.ctx.supabase, this.ctx.organizationId, item as BookItem, this.client);
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
