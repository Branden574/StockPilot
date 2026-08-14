// Pure catalog/cart logic for the storefront order page. No React —
// everything in here is unit-testable with plain data. The UI layers
// (cards / toolbar / cart) call these so filtering, sorting, status
// derivation, and totals behave identically everywhere.

import { formatOrderNumber } from '@stockpilot/core';

import { DELIVERY_REQUEST_EMAIL, DELIVERY_REQUEST_EMAIL_NAMES } from '@/lib/site';

import type { CartLineState, CatalogItem } from '../v2/types';

/** Derived stock status per item (README state model). */
export type ItemStatus = 'ok' | 'low' | 'out';

/** Availability filter = a set of statuses to keep (empty = all). */
export type AvailabilityFilter = ReadonlySet<ItemStatus>;

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
  return items.filter((it) => statusOf(it) !== 'out').map((it) => ({ itemId: it.id, quantity: 1 }));
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

/**
 * Cart totals — moved to `@stockpilot/core` (orders/cart-totals.ts) 2026-08-13
 * and re-exported here so the six web call sites keep importing it from this
 * module unchanged.
 *
 * It moved rather than being duplicated because the delivery-request builder,
 * now in core, prints `lineCount`/`unitCount` in the email body's ITEMS
 * heading while these same numbers render on the cart badge the requester
 * checks before submitting. If the two ever disagreed, the recipient and the
 * requester would be reading different orders. One function makes that
 * impossible rather than merely unlikely (recurring pattern #26).
 */
export { cartTotals, type CartTotals } from '@stockpilot/core';

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

/* ---- delivery-request assistant ------------------------------------------ */

/**
 * THE BUILDER MOVED TO CORE (2026-08-13). Everything below this line is a
 * re-export shim over `packages/core/src/orders/delivery-request.ts` — the same
 * shape this file already used for `OUTLOOK_COMPOSE_BASE` and
 * `DRAFT_URL_LIMIT` after the 2026-08-05 transport extraction.
 *
 * WHY IT MOVED. Both surfaces have to send the SAME email. Web has composed
 * delivery requests since 2026-08-01; the mobile order screen is about to. Two
 * copies of a message builder drift — recurring pattern #26, and the exact
 * failure class this codebase has been fighting all week. Drift here is
 * especially expensive because it is SILENT: a request that reaches DC4 with a
 * stale row format, a shortened body that no longer discloses what it dropped,
 * or without the mandatory CC still looks sent to the employee who sent it.
 * Mobile cannot import from `apps/web`; its only workspace dependency is
 * `@stockpilot/core`. So the message is defined there, once.
 *
 * WHAT MOVED: `toPlainTextLine`, `formatSiteAddressLines`, the draft/input/
 * prepared types, the shortened-disclosure copy, `condensedNoticeText`, the
 * three URL builders, `buildDeliveryRequestDraft` and `prepareDeliveryRequest`
 * — verbatim, plus `cartTotals` (six web UI call sites keep importing it from
 * here) and the four `@/lib/timezone` formatters. The tenant-verified
 * transport history — `mailtouri` and not `cc=`, outlook.cloud.microsoft and
 * not outlook.office.com, why the name-addr chip is OWA-only — moved with the
 * code it documents and is now in that module.
 *
 * WHAT STAYED: everything above this line. The catalog filter/sort pipeline,
 * the status derivation and `successRefLine` are storefront concerns with no
 * delivery involvement, and `CatalogItem` stays in `../v2/types` — the whole
 * point of the builder's narrowed item type is that it cannot reach `price` or
 * any other staff-only field, and widening core's view of an item would undo
 * that.
 *
 * NOTHING IN WEB CHANGED SHAPE. Every symbol this file exported before the
 * move it still exports, under the same name and the same signature, so every
 * import site and every test compiles and passes unedited. Byte-identical
 * output was verified by driving both builders over an 11-line order with a
 * recorded requester and notes, dumping every rung of the ladder, both URLs,
 * the clipboard text and their lengths, and diffing before against after.
 */

import {
  buildDeliveryRequestDraft as coreBuildDeliveryRequestDraft,
  prepareDeliveryRequest as corePrepareDeliveryRequest,
  type DeliveryRequestInput as CoreDeliveryRequestInput,
  type DeliveryRequestRecipients,
  type PreparedDeliveryRequest,
} from '@stockpilot/core';

export {
  condensedNoticeText,
  formatSiteAddressLines,
  toPlainTextLine,
  type DeliveryRequestDraft,
  type PreparedDeliveryRequest,
} from '@stockpilot/core';

/**
 * Conservative ceiling for a compose link, in characters, and the OWA compose
 * host. Outlook Web and mailto: both carry the body in the query string;
 * practical limits land around 2,000 and Outlook desktop truncates SILENTLY,
 * which is the dangerous part. 1,800 leaves headroom for the tenant's own
 * redirect wrapper. Both live in core with the transports they constrain.
 */
export { DRAFT_URL_LIMIT, OUTLOOK_COMPOSE_BASE } from '@stockpilot/core';

/**
 * The three transports, under the names this file has always exported them by.
 *
 * They now read the recipients OFF THE DRAFT rather than closing over
 * `DELIVERY_REQUEST_EMAIL_NAMES`, which is why the draft carries `toName` and
 * `ccName`: a draft is self-contained, so a URL can never be built against
 * different recipients than the ones the preview showed the employee.
 */
export {
  buildDeliveryRequestOutlookUrl as buildOutlookComposeUrl,
  buildDeliveryRequestMailtoUrl as buildMailtoUrl,
  buildDeliveryRequestClipboardText as buildClipboardText,
} from '@stockpilot/core';

/**
 * WEB'S RECIPIENTS, SUPPLIED EXPLICITLY AT ONE BOUNDARY.
 *
 * The core builder is tenant-neutral: it takes recipients as input and reads no
 * constant. This is web's single supply point, and mobile has its own. Both
 * read the SAME frozen literals — there is still exactly one definition of the
 * addresses in the codebase (`@stockpilot/core`, re-exported by `@/lib/site`),
 * so the two surfaces cannot mail different mailboxes.
 *
 * THE CC IS THE ACCEPTANCE GATE and this is where web guarantees it. It is
 * deliberately a module constant rather than a parameter of the exported
 * wrappers: nothing a caller passes — a URL parameter, a stored value, an order
 * note, a site name — can reach the recipient fields, which preserves the
 * property the old builder had when it read the constant directly. Core
 * additionally validates both addresses at draft time and throws on anything
 * that is not exactly one plain mailbox, which is a runtime check the old
 * design did not have at all.
 */
const WEB_DELIVERY_RECIPIENTS: DeliveryRequestRecipients = {
  to: DELIVERY_REQUEST_EMAIL.to,
  cc: DELIVERY_REQUEST_EMAIL.cc,
  toName: DELIVERY_REQUEST_EMAIL_NAMES.to,
  ccName: DELIVERY_REQUEST_EMAIL_NAMES.cc,
};

/**
 * Everything the draft builder is allowed to see, MINUS the recipients — those
 * are web's to supply, not its callers'. Keeping them off this type is what
 * lets `storefront-overlays.tsx`, `send-delivery-request-button.tsx` and both
 * test suites construct an input exactly as they did before the move.
 */
export type DeliveryRequestInput = Omit<CoreDeliveryRequestInput, 'recipients'>;

/** Build the delivery-request draft. The full contract is on the core module. */
export function buildDeliveryRequestDraft(
  input: DeliveryRequestInput,
  opts: { condensed?: boolean; maxRows?: number } = {},
) {
  return coreBuildDeliveryRequestDraft({ ...input, recipients: WEB_DELIVERY_RECIPIENTS }, opts);
}

/**
 * Build every transport, choosing how much of the item list fits. See core.
 *
 * NO `transport` OPTION, deliberately. Web opens the https OWA url
 * (`window.open` on `prepared.outlookUrl`), so it must keep fitting rows
 * against that url — which is core's default, `outlook-web`. Mobile passes
 * `outlook-native` when it has PROVED the native app will take the link; a
 * browser can never prove that, and asking for the shorter budget here would
 * fit rows against a url this surface does not open and truncate the body
 * silently in the one it does. Byte-identical output to before the option
 * existed, pinned by `prepareDeliveryRequest — the ladder, measured end to end`
 * in storefront-logic.test.ts.
 */
export function prepareDeliveryRequest(input: DeliveryRequestInput): PreparedDeliveryRequest {
  return corePrepareDeliveryRequest({ ...input, recipients: WEB_DELIVERY_RECIPIENTS });
}
