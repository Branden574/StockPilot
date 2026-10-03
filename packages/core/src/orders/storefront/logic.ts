// Pure catalog logic for the storefront order page, shared by the web New
// order page and the phone. No React — everything in here is unit-testable
// with plain data. The UI layers (cards / toolbar / cart) call these so
// filtering, sorting, status derivation, and totals behave identically
// everywhere.
//
// Moved from apps/web/src/components/orders/storefront/storefront-logic.ts
// (phone ordering PO-1). The web module re-exports every name it exported
// before, so its call sites and its tests are unchanged. The functions take
// `StorefrontItem` (no `price`) and are generic where they hand rows back, so
// the web's richer `CatalogItem` comes back as itself.

import type { CartLineState } from './cart';
import type { StorefrontItem } from './item';
import { formatOrderNumber } from '../order-number';

/**
 * Derived stock status per item (README state model). Named
 * `StorefrontItemStatus` in core because `ItemStatus` is already core's
 * inventory status (schemas/inventory.ts); the web re-exports it as `ItemStatus`.
 */
export type StorefrontItemStatus = 'ok' | 'low' | 'out';

/** Availability filter = a set of statuses to keep (empty = all). */
export type AvailabilityFilter = ReadonlySet<StorefrontItemStatus>;

export type SortKey = 'featured' | 'freq' | 'name-asc' | 'name-desc' | 'stock-desc' | 'stock-asc';

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

export const AVAILABILITY_LABELS: Record<StorefrontItemStatus, string> = {
  ok: 'In stock',
  low: 'Low stock',
  out: 'Out of stock',
};

type StockFields = Pick<StorefrontItem, 'quantityOnHand' | 'reservedQuantity'>;
type StatusFields = StockFields & Pick<StorefrontItem, 'reorderPoint'>;

/** Available-to-promise = on hand minus open reservations, floored at 0. */
export function availableOf(item: StockFields): number {
  return Math.max(0, item.quantityOnHand - item.reservedQuantity);
}

/**
 * Status derivation: out = nothing available, low = available at or
 * below the reorder point (when one is set), ok otherwise.
 */
export function statusOf(item: StatusFields): StorefrontItemStatus {
  const avail = availableOf(item);
  if (avail <= 0) return 'out';
  if (item.reorderPoint > 0 && avail <= item.reorderPoint) return 'low';
  return 'ok';
}

/**
 * Availability pill copy: "107 avail" / "Low · 8 left" / "Out of stock".
 *
 * `form` (added for the phone, PO-1): 'long' says "107 available" where a row
 * has room for the whole word. The default stays 'short', so the web card's
 * words are unchanged.
 */
export function availabilityLabel(
  status: StorefrontItemStatus,
  available: number,
  form: 'short' | 'long' = 'short',
): string {
  if (status === 'out') return 'Out of stock';
  if (status === 'low') return `Low · ${available} left`;
  return form === 'long' ? `${available} available` : `${available} avail`;
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
export function filterCatalog<T extends StorefrontItem>(
  items: readonly T[],
  { category, search, availability }: CatalogFilterInput,
): T[] {
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
      const hay = `${it.name} ${it.sku} ${it.categoryName ?? ''}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }

  if (availability.size > 0) {
    out = out.filter((it) => availability.has(statusOf(it)));
  }

  return out;
}

/**
 * A catalog with each row's search text and status worked out once (added for
 * the phone, PO-1). A phone re-filters on every keystroke over every orderable
 * row (571 at DC4); building the lowercase haystack and the status per row per
 * keystroke is the work this saves. Build it once per catalog answer.
 */
export interface PreparedCatalog<T extends StorefrontItem> {
  readonly items: readonly T[];
  /** `${name} ${sku} ${categoryName}` lowercased, in `items` order. */
  readonly haystacks: readonly string[];
  /** statusOf each row, in `items` order. */
  readonly statuses: readonly StorefrontItemStatus[];
}

export function prepareCatalog<T extends StorefrontItem>(items: readonly T[]): PreparedCatalog<T> {
  return {
    items,
    haystacks: items.map((it) => `${it.name} ${it.sku} ${it.categoryName ?? ''}`.toLowerCase()),
    statuses: items.map((it) => statusOf(it)),
  };
}

/**
 * filterCatalog over a prepared catalog: the same rows, in the same order, for
 * every input (pinned against filterCatalog in logic.test.ts).
 */
export function filterPreparedCatalog<T extends StorefrontItem>(
  prepared: PreparedCatalog<T>,
  { category, search, availability }: CatalogFilterInput,
): T[] {
  const tokens = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: T[] = [];
  prepared.items.forEach((it, i) => {
    if (category !== 'all') {
      if (category === 'uncategorized' ? it.categoryId !== null : it.categoryId !== category) return;
    }
    if (tokens.length > 0) {
      const hay = prepared.haystacks[i] ?? '';
      if (!tokens.every((t) => hay.includes(t))) return;
    }
    if (availability.size > 0 && !availability.has(prepared.statuses[i] ?? statusOf(it))) return;
    out.push(it);
  });
  return out;
}

/**
 * Sorts a filtered list. `featured` keeps catalog order; `freq` ranks
 * by the caller-supplied order-frequency map (items the viewer never
 * ordered sink to the bottom, catalog order preserved within ties).
 */
export function sortCatalog<T extends StorefrontItem>(
  items: readonly T[],
  sort: SortKey,
  freqByItemId?: ReadonlyMap<string, number>,
): T[] {
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
      const freqOf = (it: T) => freqByItemId?.get(it.id) ?? 0;
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
 * Clamp a typed quantity to what a stepper can legally hold:
 * integers between 0 and the item's available stock. Non-finite input
 * clamps to 0 (the cart reducer removes lines at ≤0).
 */
export function clampQty(value: number, available: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.max(0, available), Math.floor(value)));
}


/** itemId → qty map so memoized cards take qty as a scalar prop. */
export function buildQtyMap(lines: readonly CartLineState[]): Map<string, number> {
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
  return input.category === 'all' && input.search.trim() === '' && input.availability.size === 0;
}
