// Pure availability/cap logic for the public request page. No React —
// unit-testable with plain data, mirroring storefront-logic.ts for the
// internal storefront. Works on the narrow PublicCatalogItem schema, so
// nothing in here can even reference cost/sku/reserved/charter data.

import type { PublicAvailability, PublicCatalogItem } from './types';

/** Derived display status. `null` = the link ships no stock signal. */
export type PublicItemStatus = 'ok' | 'low' | 'out';

/**
 * Fixed public low-stock boundary for 'exact' links. Mirrors
 * PUBLIC_BUCKET_LOW_THRESHOLD in server/services/public-catalog.ts — the
 * org's real reorder_point is confidential and never ships to anonymous
 * visitors, so "low" is classified against this fixed public number.
 */
export const PUBLIC_LOW_STOCK_THRESHOLD = 5;

/** Status per the link's availability mode; null when mode = 'none'. */
export function publicStatusOf(a: PublicAvailability): PublicItemStatus | null {
  if (a.kind === 'exact') {
    if (a.count <= 0) return 'out';
    return a.count <= PUBLIC_LOW_STOCK_THRESHOLD ? 'low' : 'ok';
  }
  if (a.kind === 'bucket') {
    if (a.level === 'out_of_stock') return 'out';
    return a.level === 'low_stock' ? 'low' : 'ok';
  }
  return null;
}

/**
 * Availability pill copy. 'exact' keeps real counts (current behavior);
 * 'bucket' says In stock / Limited / Unavailable with no numbers; 'none'
 * renders nothing (null).
 */
export function publicAvailabilityLabel(a: PublicAvailability): string | null {
  if (a.kind === 'exact') {
    if (a.count <= 0) return 'Out of stock';
    if (a.count <= PUBLIC_LOW_STOCK_THRESHOLD) return `Low · ${a.count} left`;
    return `${a.count} avail`;
  }
  if (a.kind === 'bucket') {
    if (a.level === 'out_of_stock') return 'Unavailable';
    return a.level === 'low_stock' ? 'Limited' : 'In stock';
  }
  return null;
}

/** Filter-popover labels per display mode (statuses only exist for exact/bucket). */
export const PUBLIC_STATUS_LABELS: Record<
  'exact' | 'bucket',
  Record<PublicItemStatus, string>
> = {
  exact: { ok: 'In stock', low: 'Low stock', out: 'Out of stock' },
  bucket: { ok: 'In stock', low: 'Limited', out: 'Unavailable' },
};

/** True when the item is visibly unavailable (exact 0 / bucket out). */
export function isUnavailable(item: Pick<PublicCatalogItem, 'availability'>): boolean {
  return publicStatusOf(item.availability) === 'out';
}

/**
 * Effective stepper cap = known stock (exact links only) ∩ per-request
 * limit (entry cap ?? link default). Infinity = uncapped client-side —
 * bucket/none links don't reveal a count, so the backend's re-validation
 * is the only stock gate there.
 */
export function publicCapOf(
  item: Pick<PublicCatalogItem, 'availability' | 'maxQty'>,
): number {
  const stock =
    item.availability.kind === 'exact'
      ? Math.max(0, item.availability.count)
      : Infinity;
  const limit = item.maxQty ?? Infinity;
  return Math.min(stock, limit);
}

/**
 * Finite version of publicCapOf for components that need a real number
 * (typed-quantity clamping). 9 999 comfortably exceeds any legitimate
 * public request; the backend enforces the true limits regardless.
 */
export function publicCapFinite(
  item: Pick<PublicCatalogItem, 'availability' | 'maxQty'>,
): number {
  const cap = publicCapOf(item);
  return Number.isFinite(cap) ? cap : 9999;
}
