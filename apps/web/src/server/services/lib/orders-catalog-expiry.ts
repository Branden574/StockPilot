import 'server-only';

import { revalidateTag } from 'next/cache';

import { ordersCatalogTag, ordersCatalogWarehouseTag } from './order-catalog-hidden';

/**
 * WHICH ORDERING CATALOG ENTRIES A WRITE EXPIRES.
 *
 * Every Place an Order catalog entry carries three tags
 * (loaders/orders-new-catalog.ts, loadCatalogItemsCached): the global
 * 'orders-new-v2-catalog', its organization's (ordersCatalogTag) and its
 * organization's for its warehouse (ordersCatalogWarehouseTag). An order write
 * used to expire the GLOBAL tag, so one order moving anywhere marked every
 * organization's catalog stale. And with the 'max' profile that mark is
 * stale-while-revalidate (next 16.4.3 unstable-cache.js): the next read still
 * served the entry from before the write, the opposite of what those callers
 * wanted (fresh availability right after an order changes).
 *
 * Now a write expires only what it changed:
 *   - an order write: its organization's catalog for the order's warehouse,
 *     with `{ expire: 0 }`, so the next read recomputes. The warehouse comes
 *     from the order row the server read (never from the client). When the
 *     caller holds no such row, the organization's tag instead.
 *   - a write that changes one organization's catalog as a whole (a grouping
 *     write): the organization's tag, also with `{ expire: 0 }`.
 *   - a member's category grants (actions/user-categories.ts and its phone
 *     route) mark the organization's tag with 'max' themselves: the entries
 *     stay right, because the access key is resolved live per request.
 * The global tag stays on the entries; nothing here expires it.
 *
 * Never throws. The write has committed by the time this runs; outside a
 * request scope (a script, a test) there is nothing to record the tag in, and
 * the catalog's 60 s TTL bounds the staleness. A committed write must never
 * turn into an error the person retries.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The warehouse of an order row the server read, when the row is one of this
 * organization's and names a warehouse; otherwise null. Lowercased: the
 * catalog entries are tagged with warehouse ids as the database returns them.
 */
export function orderCatalogWarehouseOf(organizationId: string, order: unknown): string | null {
  if (!order || typeof order !== 'object') return null;
  const row = order as { organization_id?: unknown; warehouse_id?: unknown };
  if (row.organization_id !== organizationId) return null;
  if (typeof row.warehouse_id !== 'string' || !UUID.test(row.warehouse_id)) return null;
  return row.warehouse_id.toLowerCase();
}

/**
 * The tag an order write expires: the order's warehouse tag when the row names
 * one (orderCatalogWarehouseOf), else the organization's tag.
 */
export function ordersCatalogTagForOrder(organizationId: string, order?: unknown): string {
  const warehouseId = orderCatalogWarehouseOf(organizationId, order);
  return warehouseId
    ? ordersCatalogWarehouseTag(organizationId, warehouseId)
    : ordersCatalogTag(organizationId);
}

/**
 * After an order write that moves availability (a hold, a release, a
 * hand-over): expire, now, the catalog of the order's warehouse in its
 * organization. `order` is the row the service answered (or read); pass
 * nothing when the caller has none, and the organization's catalog is expired.
 *
 * `{ expire: 0 }`: the next read recomputes instead of serving the entry from
 * before the write once more. Inside a Server Action that also marks the page
 * for re-rendering into the action's response; every order action already
 * calls revalidatePath, which does the same, so it adds no render there.
 */
export function expireOrdersCatalogAfterOrderWrite(organizationId: string, order?: unknown): void {
  expire(ordersCatalogTagForOrder(organizationId, order), 'order write');
}

/**
 * After a write that changed the rows of one organization's catalog as a whole
 * (a grouping write changes SKUs in any of its warehouses): expire its every
 * warehouse's entry, now, and no other organization's.
 */
export function expireOrganizationOrdersCatalog(organizationId: string, label: string): void {
  expire(ordersCatalogTag(organizationId), label);
}

function expire(tag: string, label: string): void {
  try {
    revalidateTag(tag, { expire: 0 });
  } catch (err) {
    console.warn(
      `[orders-catalog] refresh skipped after ${label}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
