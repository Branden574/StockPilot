import {
  CHECKOUT_NEEDED_BY_ZONE_UNREADABLE_COPY,
  CHECKOUT_NOT_SET_COPY,
  ORDER_NEEDS_CONNECTION_COPY,
  ORDER_NOTES_MAX,
  SUBMIT_NO_LINES_COPY,
  SUBMIT_NO_SITE_COPY,
  SUBMIT_ON_BEHALF_INCOMPLETE_COPY,
  SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY,
  SUBMIT_REMOVE_UNORDERABLE_COPY,
  STOREFRONT_FOR_SET_MYSELF_HINT_COPY,
  availableOf,
  cartLineAtMaxCopy,
  cartLineOverCopy,
  cartTotals,
  checkoutNeededByZoneUnknownCopy,
  checkoutStockChangedCopy,
  fitKitShares,
  kitsForAudit,
  neededByLabel,
  resolveOrgTimezone,
  restoredCartChangedCopy,
  wallClockToInstant,
  type CartState,
  type KitOffer,
  type OrderCreateRequestInput,
  type OrderRefusalDetails,
  type StorefrontItem,
} from '@stockpilot/core';

/**
 * CHECKOUT ON THE PHONE (phone ordering PO-4): what Submit sends, why it
 * cannot be pressed yet, and what each cart line says. Checkout is also the
 * review on the phone (plan decision 6). Pure.
 *
 * The body is core's create body (orderCreateRequestSchema), built exactly as
 * the web storefront builds it (orders-storefront.tsx handleConfirmSubmit):
 * the needed-by is the organization's wall clock ("YYYY-MM-DDTHH:mm"), which
 * the server reads in the organization's zone; the kits are for the audit
 * note only.
 *
 * Quantities above what is available keep the web's warning and do NOT block
 * Submit (storefront-cart.tsx): approval is the stock check. A line that can
 * no longer be ordered from here (gone from the fresh catalog, or refused by
 * the server's item check) must be removed first.
 */

/** The parts of the checkout the body is built from. */
export interface CheckoutInput {
  cart: CartState;
  userId: string;
  /** The idempotency key minted for this press of Submit. */
  key: string;
  /** The kits offered at this warehouse (the audit note), [] when none. */
  kits: readonly KitOffer[];
}

export function buildOrderCreateBody(input: CheckoutInput): OrderCreateRequestInput {
  const { cart } = input;
  const lines = cart.lines.filter((l) => l.quantity > 0);
  const kits = kitsForAudit(input.kits, fitKitShares(cart.kits, lines), lines);
  return {
    idempotencyKey: input.key,
    placerUserId: input.userId,
    warehouseId: cart.warehouseId,
    fulfillmentType: cart.fulfillmentType,
    deliveryCharterId: cart.fulfillmentType === 'delivery' ? cart.charterId : null,
    onBehalfOf: cart.onBehalfOf
      ? { name: cart.onBehalfOf.name.trim(), email: cart.onBehalfOf.email.trim() }
      : null,
    notes: cart.notes.trim() || null,
    neededByLocal: cart.neededBy || null,
    lines: lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
    ...(kits.length > 0 ? { kits } : {}),
  };
}

/** Why Submit cannot be pressed, in core's words (the button's hint and the
 *  line under it), or null when it can. Checked in this order. */
export function submitBlockedBy(input: {
  cart: CartState;
  offline: boolean;
  /** Lines that cannot be ordered from here (not in the catalog, or refused). */
  unorderable: ReadonlySet<string>;
  /** The delivery site still exists in the sites answer (or sites failed). */
  siteKnown: boolean;
  /** The storefront answer shown says this person may order for someone
   *  else (the effective orders:approve, slice D). A cart saved for someone
   *  else is checked against it before every Submit: the server would
   *  refuse it, and that refusal is final and spends the key. */
  canOrderOnBehalf: boolean;
}): string | null {
  const { cart } = input;
  if (input.offline) return ORDER_NEEDS_CONNECTION_COPY;
  if (cart.lines.length === 0) return SUBMIT_NO_LINES_COPY;
  if (cart.fulfillmentType === 'delivery' && (cart.charterId === null || !input.siteKnown)) {
    return SUBMIT_NO_SITE_COPY;
  }
  if (cart.onBehalfOf && !input.canOrderOnBehalf) return SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY;
  if (cart.onBehalfOf && (!cart.onBehalfOf.name.trim() || !cart.onBehalfOf.email.trim())) {
    return SUBMIT_ON_BEHALF_INCOMPLETE_COPY;
  }
  if (cart.lines.some((l) => input.unorderable.has(l.itemId))) return SUBMIT_REMOVE_UNORDERABLE_COPY;
  return null;
}

/** Checkout's For row. Offered to someone who may order on behalf (the
 *  storefront answer's canOrderOnBehalf, the effective orders:approve). For
 *  a cart kept for someone else by a person who no longer may, it is still
 *  shown, saying so in a visible line (Submit's reason), and a tap sets it
 *  to Myself instead of opening the people sheet. */
export interface ForRowView {
  shown: boolean;
  /** The visible line under the row, or null. */
  detail: string | null;
  hint: string | undefined;
  /** What a tap does. */
  tap: 'choose' | 'set-myself';
}
export function forRowView(input: {
  canOrderOnBehalf: boolean;
  onBehalfOf: CartState['onBehalfOf'];
  /** The lock's hint while the cart is locked. */
  lockHint?: string;
}): ForRowView {
  if (input.canOrderOnBehalf) {
    return { shown: true, detail: null, hint: input.lockHint, tap: 'choose' };
  }
  if (input.onBehalfOf === null) return { shown: false, detail: null, hint: undefined, tap: 'choose' };
  return {
    shown: true,
    detail: SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY,
    hint: input.lockHint ?? STOREFRONT_FOR_SET_MYSELF_HINT_COPY,
    tap: 'set-myself',
  };
}

/** The lines the server refused as not orderable (item_not_orderable), from
 *  a final refusal's details. */
export function refusedItemIds(details: OrderRefusalDetails | null): Set<string> {
  return new Set(Object.keys(details?.items ?? {}));
}

/** Lines no longer in the catalog this account can order from here. */
export function linesNotInCatalog(cart: CartState, catalog: ReadonlyMap<string, StorefrontItem>): Set<string> {
  return new Set(cart.lines.filter((l) => !catalog.has(l.itemId)).map((l) => l.itemId));
}

export type CartLineNote =
  | { kind: 'not_orderable' }
  | { kind: 'over'; message: string }
  | { kind: 'at_max'; message: string }
  | null;

/** What one cart line says under it: can't be ordered, more than available
 *  (kept, the web's warning), or everything available is in the cart. */
export function cartLineNote(
  quantity: number,
  item: StorefrontItem | undefined,
  unorderable: boolean,
): CartLineNote {
  if (unorderable || !item) return { kind: 'not_orderable' };
  const available = availableOf(item);
  if (quantity > available) return { kind: 'over', message: cartLineOverCopy(available) };
  if (quantity === available && available > 0) return { kind: 'at_max', message: cartLineAtMaxCopy(available) };
  return null;
}

/** "3 items · 12 units" counts (core cartTotals). */
export function checkoutTotals(cart: CartState): { lines: number; units: number } {
  const t = cartTotals(cart.lines);
  return { lines: t.lineCount, units: t.unitCount };
}

/** The needed-by row's value: core's label for the wall clock in the
 *  organization's zone (the instant the server will store), or "Not set". */
export function neededByRowValue(wall: string, zone: string, now?: number): string {
  if (!wall) return CHECKOUT_NOT_SET_COPY;
  const at = wallClockToInstant(wall, zone);
  return at === null ? CHECKOUT_NOT_SET_COPY : neededByLabel(at, zone, now);
}

/** A wall clock's instant in the zone, as ISO (the picker's opening value),
 *  or null when it is empty or names no instant there. */
export function wallClockIso(wall: string, zone: string): string | null {
  if (!wall) return null;
  const at = wallClockToInstant(wall, zone);
  return at === null ? null : new Date(at).toISOString();
}

export type NeededByZone = { ok: true; zone: string } | { ok: false; message: string };

/**
 * The zone the needed-by picker works in: the organization's, as the server
 * reads it. When it could not be read, or this phone's engine does not know
 * it (Hermes ships a reduced ICU), the picker is not offered (its days, slots
 * and preview would be in another zone than the server converts in); the
 * order can still be placed without a needed-by. The F2-4 sheet's rule
 * (order-needed-by.ts neededBySheetOpening), minus the warehouse write check,
 * which placing an order does not need.
 */
export function storefrontNeededByZone(rawZone: string | null | undefined): NeededByZone {
  const zone = typeof rawZone === 'string' ? rawZone.trim() : '';
  if (zone === '') return { ok: false, message: CHECKOUT_NEEDED_BY_ZONE_UNREADABLE_COPY };
  if (resolveOrgTimezone(zone) !== zone) return { ok: false, message: checkoutNeededByZoneUnknownCopy(zone) };
  return { ok: true, zone };
}

/** Manager notes' counter shows from 1,800 characters. */
export const NOTES_COUNTER_FROM = 1800;
export function showNotesCounter(notes: string): boolean {
  return Array.from(notes).length >= NOTES_COUNTER_FROM;
}
export { ORDER_NOTES_MAX };

/**
 * A cart restored on this phone, checked against the catalog as it is now.
 * Nothing is dropped: lines that can no longer be ordered are marked, lines
 * above what is available keep their quantity and the warning, and the kits'
 * records are refitted. One sentence says what changed (null when nothing).
 * A LOCKED cart is never passed here: it is settled first.
 */
export function recheckRestoredCart(
  cart: CartState,
  catalog: ReadonlyMap<string, StorefrontItem>,
): { cart: CartState; notOrderable: Set<string>; notice: string | null } {
  const notOrderable = linesNotInCatalog(cart, catalog);
  let over = 0;
  for (const l of cart.lines) {
    const item = catalog.get(l.itemId);
    if (item && l.quantity > availableOf(item)) over += 1;
  }
  return {
    cart: { ...cart, kits: fitKitShares(cart.kits, cart.lines) },
    notOrderable,
    notice: restoredCartChangedCopy({ notOrderable: notOrderable.size, overAvailable: over }),
  };
}

/**
 * The one notice checkout shows when stock moved under the cart since its
 * lines were added: each line now above what is available, whose available
 * went down between the two catalog reads. Null when nothing moved that way.
 */
export function stockChangedNotice(
  cart: CartState,
  before: ReadonlyMap<string, StorefrontItem>,
  after: ReadonlyMap<string, StorefrontItem>,
): string | null {
  const changes: { name: string; available: number; quantity: number }[] = [];
  for (const l of cart.lines) {
    const was = before.get(l.itemId);
    const now = after.get(l.itemId);
    if (!was || !now) continue;
    const a = availableOf(now);
    if (a < availableOf(was) && l.quantity > a) changes.push({ name: now.name, available: a, quantity: l.quantity });
  }
  return changes.length > 0 ? checkoutStockChangedCopy(changes) : null;
}

/** The item's name as the cart knows it (core's refusal words name refused
 *  items from the cart, never from the server). */
export function itemNameFrom(catalog: ReadonlyMap<string, StorefrontItem>) {
  return (itemId: string): string | null => catalog.get(itemId)?.name ?? null;
}
