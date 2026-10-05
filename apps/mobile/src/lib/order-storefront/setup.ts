import {
  ORDER_CATALOG_STALE_AFTER_SECONDS,
  STOREFRONT_MYSELF_COPY,
  clampQty,
  type CharterAddress,
  type OrderCatalogAnswer,
  type OrderCatalogSite,
  type OrderRecentRequester,
  type OrderStorefrontWarehouse,
  type StorefrontItem,
} from '@stockpilot/core';

/**
 * THE STOREFRONT'S SETUP AND FRESHNESS RULES (phone ordering PO-4): Ship from,
 * the catalog rows as the shared logic reads them, the delivery site's
 * address lines, the recent-requester search, and when the catalog and the
 * photos are read again. Pure.
 */

/**
 * Ship from when the storefront opens (plan decision 3), in order:
 *   1. a warehouse whose cart holds an order request that is not confirmed
 *      (that cart is locked and its warehouse cannot be left until it is
 *      settled), a listed one first, else one no longer listed (its send
 *      must still be settled: status and withdraw need only membership);
 *   2. the warehouse last used for ordering on this phone;
 *   3. the workspace's active warehouse, when the person may order from it;
 *   4. the first by name (the web's rule; the list comes sorted by name).
 * Otherwise only warehouses the storefront answer lists (readable, not
 * archived).
 */
export function initialShipFrom(input: {
  warehouses: readonly OrderStorefrontWarehouse[];
  lockedWarehouseIds: readonly string[];
  lastUsedId: string | null;
  activeWarehouseId: string | null;
}): string | null {
  const ids = new Set(input.warehouses.map((w) => w.id));
  const locked = input.warehouses.find((w) => input.lockedWarehouseIds.includes(w.id));
  if (locked) return locked.id;
  if (input.lockedWarehouseIds.length > 0) return input.lockedWarehouseIds[0]!;
  if (input.lastUsedId && ids.has(input.lastUsedId)) return input.lastUsedId;
  if (input.activeWarehouseId && ids.has(input.activeWarehouseId)) return input.activeWarehouseId;
  return input.warehouses[0]?.id ?? null;
}

/**
 * The catalog answer's rows as core's storefront logic reads them: the
 * category's name from the aisles, the earmark's name and code from the
 * charters. Built field by field: nothing else (no price) can ride along.
 */
export function catalogItems(answer: OrderCatalogAnswer): StorefrontItem[] {
  const categoryNames = new Map<string, string>();
  for (const a of answer.aisles) if (a.id !== null) categoryNames.set(a.id, a.name);
  return answer.items.map((row) => {
    const charter = row.charterId ? answer.charters[row.charterId] : undefined;
    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      quantityOnHand: row.quantityOnHand,
      reservedQuantity: row.reservedQuantity,
      categoryId: row.categoryId,
      categoryName: row.categoryId ? (categoryNames.get(row.categoryId) ?? null) : null,
      charterId: row.charterId,
      charterName: charter?.name ?? null,
      charterCode: charter?.code ?? null,
      rackLabel: row.rackLabel,
      reorderPoint: row.reorderPoint,
    };
  });
}

/** The earmark chip's text: the charter's code, else its name. */
export function earmarkLabel(item: Pick<StorefrontItem, 'charterCode' | 'charterName'>): string | null {
  return item.charterCode || item.charterName || null;
}

/** A site's address as lines, printing nothing for a missing address (never
 *  an empty labelled block). */
export function siteAddressLines(address: CharterAddress | null): string[] {
  if (!address) return [];
  const clean = (v: string | null | undefined) => (typeof v === 'string' ? v.trim() : '');
  const lines = [clean(address.line1), clean(address.line2)].filter((l) => l !== '');
  const city = clean(address.city);
  const regionPostal = [clean(address.region), clean(address.postalCode)].filter((p) => p !== '').join(' ');
  const last = [city, regionPostal].filter((p) => p !== '').join(', ');
  if (last !== '') lines.push(last);
  return lines;
}

/** "North Campus (NC)". */
export function siteLabel(site: Pick<OrderCatalogSite, 'name' | 'code'>): string {
  return site.code ? `${site.name} (${site.code})` : site.name;
}

/** Recent requesters matching what is typed: every word in the name or email. */
export function matchRequesters(
  people: readonly OrderRecentRequester[],
  query: string,
): OrderRecentRequester[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...people];
  return people.filter((p) => {
    const hay = `${p.name ?? ''} ${p.email}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

/** The quantity sheet's field as a quantity to set: blank sets nothing (the
 *  quantity is kept, as the web's field does; PO-4 review), 0 removes the
 *  line, anything else is clamped to what is available. */
export function quantityFromField(text: string, available: number): number | null {
  const digits = text.replace(/[^0-9]/g, '');
  if (digits === '') return null;
  return clampQty(Number.parseInt(digits, 10), available);
}

/** Who the order is for, as the For row shows it. */
export function requesterRowValue(onBehalfOf: { name: string; email: string } | null): string {
  if (!onBehalfOf) return STOREFRONT_MYSELF_COPY;
  const name = onBehalfOf.name.trim();
  const email = onBehalfOf.email.trim();
  return name && email ? `${name} · ${email}` : name || email || STOREFRONT_MYSELF_COPY;
}

// ── Freshness ───────────────────────────────────────────────────────────────

/** The catalog is read again on focus once it is older than this (the
 *  server's own catalog cache is 60 s, so a fresher read would not be
 *  fresher), on a pull, and when checkout opens. Never on a timer. */
export function catalogIsStale(readAt: number | null, now: number, staleAfterSeconds?: number): boolean {
  if (readAt === null || !Number.isFinite(readAt)) return true;
  const ttl = (staleAfterSeconds ?? ORDER_CATALOG_STALE_AFTER_SECONDS) * 1000;
  return now - readAt >= ttl;
}

/** Photos are read again after 4 hours (the server re-signs its map every 4
 *  hours) or after an image failed to load; never on a timer. */
export const PHOTO_REFRESH_MS = 4 * 60 * 60 * 1000;
/** A signed URL this close to its expiry is not used. */
export const PHOTO_EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;

export function photosNeedRefresh(
  photos: { signedAt: string; expiresAt: string } | null,
  now: number,
  anImageFailed: boolean,
): boolean {
  if (!photos || anImageFailed) return true;
  const signed = Date.parse(photos.signedAt);
  const expires = Date.parse(photos.expiresAt);
  if (!Number.isFinite(signed) || !Number.isFinite(expires)) return true;
  return now - signed >= PHOTO_REFRESH_MS || now >= expires - PHOTO_EXPIRY_MARGIN_MS;
}

/** "9:41 AM" on this phone's clock (when the catalog shown was read). Built
 *  by hand, the same on every engine. */
export function clockLabel(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
