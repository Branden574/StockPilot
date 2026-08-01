// Pure catalog/cart logic for the storefront order page. No React —
// everything in here is unit-testable with plain data. The UI layers
// (cards / toolbar / cart) call these so filtering, sorting, status
// derivation, and totals behave identically everywhere.

import { formatOrderNumber } from '@stockpilot/core';

import type { CartLineState, CatalogItem, CharterAddress } from '../v2/types';

/** Derived stock status per item (README state model). */
export type ItemStatus = 'ok' | 'low' | 'out';

/** Availability filter = a set of statuses to keep (empty = all). */
export type AvailabilityFilter = ReadonlySet<ItemStatus>;

export type SortKey =
  | 'featured'
  | 'freq'
  | 'name-asc'
  | 'name-desc'
  | 'stock-desc'
  | 'stock-asc';

export type ViewMode = 'grid' | 'compact';

/** 'all' | 'uncategorized' | categoryId. Mirrors the v2 aisle filter. */
export type CategoryFilter = 'all' | 'uncategorized' | string;

export const SORT_OPTIONS: ReadonlyArray<{ id: SortKey; label: string }> = [
  { id: 'featured', label: 'Featured' },
  { id: 'freq', label: 'Most ordered by you' },
  { id: 'name-asc', label: 'Name · A–Z' },
  { id: 'name-desc', label: 'Name · Z–A' },
  { id: 'stock-desc', label: 'Most available' },
  { id: 'stock-asc', label: 'Least available' },
];

export const AVAILABILITY_LABELS: Record<ItemStatus, string> = {
  ok: 'In stock',
  low: 'Low stock',
  out: 'Out of stock',
};

type StockFields = Pick<CatalogItem, 'quantityOnHand' | 'reservedQuantity'>;
type StatusFields = StockFields & Pick<CatalogItem, 'reorderPoint'>;

/** Available-to-promise = on hand minus open reservations, floored at 0. */
export function availableOf(item: StockFields): number {
  return Math.max(0, item.quantityOnHand - item.reservedQuantity);
}

/**
 * Status derivation: out = nothing available, low = available at or
 * below the reorder point (when one is set), ok otherwise.
 */
export function statusOf(item: StatusFields): ItemStatus {
  const avail = availableOf(item);
  if (avail <= 0) return 'out';
  if (item.reorderPoint > 0 && avail <= item.reorderPoint) return 'low';
  return 'ok';
}

/** Availability pill copy: "107 avail" / "Low · 8 left" / "Out of stock". */
export function availabilityLabel(status: ItemStatus, available: number): string {
  if (status === 'out') return 'Out of stock';
  if (status === 'low') return `Low · ${available} left`;
  return `${available} avail`;
}

/** Two-letter serif glyph for photo-less items ("L4L Water Bottle" → "WB"). */
export function glyphFor(name: string): string {
  return name
    .replace(/^L4L\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!)
    .join('')
    .toUpperCase();
}

export interface CatalogFilterInput {
  category: CategoryFilter;
  search: string;
  availability: AvailabilityFilter;
}

/**
 * Composable filter pipeline: category → search → availability.
 * Search matches every whitespace-separated token against the
 * combined name + SKU + category haystack, so "polo w" finds
 * "L4L Polo (Women's)" while single-token queries behave exactly like
 * a substring match on any one field.
 */
export function filterCatalog(
  items: readonly CatalogItem[],
  { category, search, availability }: CatalogFilterInput,
): CatalogItem[] {
  let out = items.slice();

  if (category !== 'all') {
    out =
      category === 'uncategorized'
        ? out.filter((it) => it.categoryId === null)
        : out.filter((it) => it.categoryId === category);
  }

  const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    out = out.filter((it) => {
      const hay =
        `${it.name} ${it.sku} ${it.categoryName ?? ''}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }

  if (availability.size > 0) {
    out = out.filter((it) => availability.has(statusOf(it)));
  }

  return out;
}

/**
 * Sorts a filtered list. `featured` keeps catalog order; `freq` ranks
 * by the caller-supplied order-frequency map (items the viewer never
 * ordered sink to the bottom, catalog order preserved within ties).
 */
export function sortCatalog(
  items: readonly CatalogItem[],
  sort: SortKey,
  freqByItemId?: ReadonlyMap<string, number>,
): CatalogItem[] {
  const out = items.slice();
  switch (sort) {
    case 'name-asc':
      out.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case 'name-desc':
      out.sort((a, b) => b.name.localeCompare(a.name));
      break;
    case 'stock-desc':
      out.sort((a, b) => availableOf(b) - availableOf(a));
      break;
    case 'stock-asc':
      out.sort((a, b) => availableOf(a) - availableOf(b));
      break;
    case 'freq': {
      const freqOf = (it: CatalogItem) => freqByItemId?.get(it.id) ?? 0;
      // Array.prototype.sort is stable, so equal-frequency items keep
      // their catalog order.
      out.sort((a, b) => freqOf(b) - freqOf(a));
      break;
    }
    case 'featured':
    default:
      break; // catalog order
  }
  return out;
}

/**
 * "Add full kit" for the New Hire section: one of each item in the
 * category that has stock available. Out-of-stock items are skipped
 * entirely rather than queued at 0.
 */
export function fullKitLines(
  items: readonly CatalogItem[],
): Array<{ itemId: string; quantity: number }> {
  return items
    .filter((it) => statusOf(it) !== 'out')
    .map((it) => ({ itemId: it.id, quantity: 1 }));
}

/**
 * Clamp a typed quantity to what a stepper can legally hold:
 * integers between 0 and the item's available stock. Non-finite input
 * clamps to 0 (the cart reducer removes lines at ≤0).
 */
export function clampQty(value: number, available: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.max(0, available), Math.floor(value)));
}

export interface CartTotals {
  lineCount: number;
  unitCount: number;
}

export function cartTotals(lines: readonly CartLineState[]): CartTotals {
  return {
    lineCount: lines.length,
    unitCount: lines.reduce((sum, l) => sum + l.quantity, 0),
  };
}

/** itemId → qty map so memoized cards take qty as a scalar prop. */
export function buildQtyMap(
  lines: readonly CartLineState[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of lines) map.set(l.itemId, l.quantity);
  return map;
}

/**
 * Success-state reference line, e.g. "SO-000049 · DC4 · 7 units".
 *
 * This used to be `orderRef()`, which rendered `SO-` plus the first 8 hex
 * characters of the order UUID. That string is visually indistinguishable from
 * the canonical `formatOrderNumber()` output but exists NOWHERE else in the
 * product — not in the orders list, not on the detail page, not in any email,
 * not on a pick or packing slip. An employee who quoted it (and, once the
 * delivery-request assistant ships, an employee who mails it to DC4) quoted a
 * number nobody can look up.
 *
 * The canonical number now reaches the client (createOrderRequestAction returns
 * it), so this renders the real handle. When it is genuinely absent — an old
 * client bundle, or a row the BEFORE-INSERT trigger somehow missed — the
 * fallback is deliberately NOT SO-shaped: a bare uuid prefix reads as an
 * internal id, which is honest, where a fake SO number reads as a searchable
 * order number, which is not.
 */
export function successRefLine(
  orderNumber: number | null,
  orderId: string,
  warehouseName: string,
  unitCount: number,
): string {
  const handle = formatOrderNumber(orderNumber) ?? `Order ${orderId.replace(/-/g, '').slice(0, 8)}`;
  const units = `${unitCount} ${unitCount === 1 ? 'unit' : 'units'}`;
  return `${handle} · ${warehouseName} · ${units}`;
}

/** True when the catalog is in the unfiltered "browse All" state. */
export function isBrowsingAll(input: CatalogFilterInput): boolean {
  return (
    input.category === 'all' &&
    input.search.trim() === '' &&
    input.availability.size === 0
  );
}

/**
 * Collapse anything destined for a plain-text email line: CR, LF, tabs and any
 * other control character become a single space, and the result is trimmed.
 *
 * Two reasons, both real. (1) A newline inside a value would break the body's
 * block structure and could forge a header-looking line ("Bcc: ...") in a mail
 * client that parses the pasted text. (2) The repo already has this helper —
 * `sanitizePlainText` in lib/email/order-requests.ts:1247 — but it is
 * module-private and lives in a `server-only` module, so a client builder
 * cannot import it. This is the client-side twin, deliberately named
 * differently so nobody assumes the two are kept in sync.
 */
export function toPlainTextLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Render `charters.address` as zero or more plain-text lines.
 *
 * Returns an EMPTY array whenever there is nothing real to print. The caller
 * must then omit the whole block: 4 of 16 prod charters have `address = null`,
 * and printing "Address:" with nothing under it implies the system captured
 * something it did not.
 *
 * Values are reproduced verbatim, typos included (KVA Tulare's address really
 * says "Calfornia"). Silently correcting a site address inside a delivery
 * instruction would be a worse failure than reproducing the owner's data.
 */
export function formatSiteAddressLines(address: CharterAddress | null): string[] {
  if (!address) return [];
  const clean = (v: string | null | undefined): string =>
    typeof v === 'string' ? toPlainTextLine(v) : '';

  const lines: string[] = [];
  const line1 = clean(address.line1);
  const line2 = clean(address.line2);
  if (line1) lines.push(line1);
  if (line2) lines.push(line2);

  const city = clean(address.city);
  const region = clean(address.region);
  const postal = clean(address.postalCode);
  const cityRegion = [city, region].filter(Boolean).join(', ');
  const cityLine = [cityRegion, postal].filter(Boolean).join(' ');
  if (cityLine) lines.push(cityLine);

  const country = clean(address.country);
  if (country) lines.push(country);

  return lines;
}
