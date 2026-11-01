import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

import { ServiceError } from '../context';

import { fetchAllRows } from './paginate';

/**
 * ORDERING VISIBILITY FRESHNESS (design 7.2, migration 0413).
 *
 * The requester catalogs (Place an Order on the web and the phone, a public
 * request link's page) are served from unstable_cache entries. Expiring a tag
 * is not enough to promise "a fresh request after Hide commits never offers
 * the hidden item": unstable_cache serves a stale entry once while it
 * recomputes, and a recompute that READ before the hide but STORED after the
 * expiry counts as fresh (next 16.4.3 incremental-cache: an entry is expired
 * only by a tag expired after the entry's lastModified, which is its store
 * time). So each cached catalog carries `readStartedAt` (taken before its first
 * items read), and this module removes, uncached, every item hidden since then:
 *
 *   select id from inventory_items
 *    where organization_id = $org and warehouse_id = $wh
 *      and order_catalog_visible = false
 *      and order_catalog_visibility_changed_at >= readStartedAt - 30 s
 *
 * served by the partial index inventory_items_order_hidden_idx, and almost
 * always answering zero rows.
 *
 * SKIPPED IN THE COMMON CASE. The organization's hide mark
 * (organizations.order_catalog_last_hide_at, carried by get_request_context)
 * is stamped by a hide in its own transaction after every item stamp of that
 * hide, so it is never earlier than any of them. When it is null the
 * organization never hid anything; when it is older than readStartedAt - 30 s,
 * no item can have been hidden since the entry was read. Only otherwise (or
 * when the mark is unknown) is the query made. A request whose context was
 * read before the hide committed began before the hide; its checkout is still
 * refused by the database gate.
 *
 * Why 30 s: the item stamp is clock_timestamp() at the UPDATE, the hide waits
 * at most 3 s for its row locks, and the web server's clock and the
 * database's may disagree by a few seconds.
 *
 * Removing an item hidden EARLIER than the window is never wrong (it is
 * hidden); the window only bounds the read.
 */

/** The overlay reaches back this far before a cached read began. */
export const ORDER_CATALOG_HIDE_MARGIN_MS = 30_000;

/** The ordering catalog's per-organization cache tag. Every entry of the
 *  organization carries it; a Show or Hide expires it (with `{ expire: 0 }`,
 *  never 'max') only when its answer did not name the warehouses it touched.
 *  The global tag 'orders-new-v2-catalog' stays on every entry for the
 *  existing callers. */
export function ordersCatalogTag(organizationId: string): string {
  return `orders-new-v2-catalog:${organizationId}`;
}

/** The ordering catalog's per-(organization, warehouse) cache tag (0413
 *  review fix round, F1). A Show or Hide expires it with `{ expire: 0 }` for
 *  each warehouse its records sit in, so the organization's other warehouses
 *  stay warm and their open tabs do not rebuild. */
export function ordersCatalogWarehouseTag(organizationId: string, warehouseId: string): string {
  return `orders-new-v2-catalog:${organizationId}:${warehouseId}`;
}

/**
 * Whether a catalog read that began at `readStartedAt` (epoch ms) could hold
 * an item hidden since: false only when the mark says no hide is that recent.
 *
 *   undefined  unknown (no request-context bundle, a database before 0413):
 *              look.
 *   null       the organization never hid anything: skip.
 *   ISO time   look when it is at or after readStartedAt - 30 s.
 *
 * A mark that does not parse is unknown (look); a readStartedAt that is not a
 * finite number (an entry without one) is "read long ago" (look whenever the
 * organization ever hid something).
 */
export function recentHideCheckNeeded(
  lastHideAt: string | null | undefined,
  readStartedAt: number,
): boolean {
  if (lastHideAt === null) return false;
  if (lastHideAt === undefined) return true;
  const mark = Date.parse(lastHideAt);
  if (!Number.isFinite(mark)) return true;
  if (!Number.isFinite(readStartedAt)) return true;
  return mark >= readStartedAt - ORDER_CATALOG_HIDE_MARGIN_MS;
}

/** Hidden rows a single overlay read may return before it is cut (a bound,
 *  not an expectation: a hide changes at most 500 rows per call). */
const OVERLAY_ROW_CAP = 10_000;

/**
 * The ids of `warehouseId`'s items in `organizationId` that are hidden from
 * new ordering and whose visibility changed at or after `sinceMs` (epoch ms).
 * Admin client (the catalogs it filters are read with it too); THROWS on a
 * failed read, so the catalog fails closed and shows its error and retry
 * instead of a list that might still offer a hidden item.
 */
export async function loadRecentlyHiddenItemIds(
  organizationId: string,
  warehouseId: string,
  sinceMs: number,
): Promise<Set<string>> {
  const admin = createAdminClient();
  const since = new Date(Number.isFinite(sinceMs) ? sinceMs : 0).toISOString();
  let rows: Array<{ id: string }>;
  try {
    rows = await fetchAllRows<{ id: string }>(
      (from, to) =>
        admin
          .from('inventory_items')
          .select('id')
          .eq('organization_id', organizationId)
          .eq('warehouse_id', warehouseId)
          .eq('order_catalog_visible', false)
          .gte('order_catalog_visibility_changed_at', since)
          .order('id', { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: Array<{ id: string }> | null;
          error: { message: string } | null;
        }>,
      { cap: OVERLAY_ROW_CAP },
    );
  } catch (err) {
    // fetchAllRows throws a ServiceError whose public message is generic; the
    // PostgREST cause is internalDetail. This message stays server side.
    const cause =
      err instanceof ServiceError
        ? (err.internalDetail ?? err.message)
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`[order-catalog-hidden] recently hidden read failed: ${cause}`);
  }
  return new Set(rows.map((r) => r.id));
}

/**
 * The early overlay read (0413 review fix round, F3; design 7.2 item 3 "in
 * parallel with the cached read"). The overlay is needed only when the
 * organization hid something shortly before or after the entry was read, and
 * an entry is normally at most a minute old (a 60 s revalidate). So when the
 * last hide is within this window of now, the overlay is started from
 * `now - window` together with the cached read, instead of after it.
 */
export const ORDER_CATALOG_EARLY_OVERLAY_MS = 120_000;

/** An overlay read started before the entry answered: the ids hidden since
 *  `sinceMs`. */
export interface EarlyHiddenRead {
  sinceMs: number;
  ids: Promise<Set<string>>;
}

/**
 * Starts the early overlay read when the hide mark is within
 * ORDER_CATALOG_EARLY_OVERLAY_MS of `now`; null otherwise (no hide that
 * recent, never hid, or the mark is unknown, which the serial check after the
 * entry covers). The promise's rejection is observed here so a cached read
 * that fails first leaves no unhandled rejection; the awaiting side still
 * sees it.
 */
export function startEarlyHiddenRead(
  organizationId: string,
  warehouseId: string,
  lastHideAt: string | null | undefined,
  now: number,
): EarlyHiddenRead | null {
  if (typeof lastHideAt !== 'string') return null;
  const mark = Date.parse(lastHideAt);
  if (!Number.isFinite(mark) || mark < now - ORDER_CATALOG_EARLY_OVERLAY_MS) return null;
  const sinceMs = now - ORDER_CATALOG_EARLY_OVERLAY_MS;
  const ids = loadRecentlyHiddenItemIds(organizationId, warehouseId, sinceMs);
  ids.catch(() => undefined);
  return { sinceMs, ids };
}

/**
 * `rows` without the items hidden since `readStartedAt`, reading only when
 * the hide mark says one may be that recent (see recentHideCheckNeeded). An
 * `early` read is used when it reaches back far enough (its bound is at or
 * before readStartedAt - 30 s; a currently hidden id is always safe to drop),
 * otherwise the serial read from the entry's own bound is made.
 */
export async function withoutRecentlyHidden<T extends { id: string }>(
  rows: T[],
  opts: {
    organizationId: string;
    warehouseId: string;
    readStartedAt: number;
    lastHideAt: string | null | undefined;
    early?: EarlyHiddenRead | null;
  },
): Promise<T[]> {
  if (rows.length === 0) return rows;
  if (!recentHideCheckNeeded(opts.lastHideAt, opts.readStartedAt)) return rows;
  const since = Number.isFinite(opts.readStartedAt)
    ? opts.readStartedAt - ORDER_CATALOG_HIDE_MARGIN_MS
    : 0;
  const hidden =
    opts.early && opts.early.sinceMs <= since
      ? await opts.early.ids
      : await loadRecentlyHiddenItemIds(opts.organizationId, opts.warehouseId, since);
  return hidden.size === 0 ? rows : rows.filter((r) => !hidden.has(r.id));
}
