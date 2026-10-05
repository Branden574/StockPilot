import {
  CHECKOUT_NEEDED_BY_ZONE_UNREADABLE_COPY,
  CHECKOUT_NOT_SET_COPY,
  NEEDED_BY_IN_PAST_COPY,
  ORDER_NEEDS_CONNECTION_COPY,
  ORDER_ON_BEHALF_INVALID_COPY,
  ORDER_ON_BEHALF_NOT_PERMITTED_COPY,
  ORDER_NOTES_MAX,
  SUBMIT_NO_LINES_COPY,
  SUBMIT_NO_SITE_COPY,
  SUBMIT_ON_BEHALF_INCOMPLETE_COPY,
  SUBMIT_ON_BEHALF_NOT_PERMITTED_COPY,
  SUBMIT_REMOVE_UNORDERABLE_COPY,
  STOREFRONT_FOR_SET_MYSELF_HINT_COPY,
  STOREFRONT_LINE_DETAILS_PENDING_COPY,
  STOREFRONT_LINE_NOT_LISTED_COPY,
  STOREFRONT_REMOVE_COPY,
  STOREFRONT_REMOVE_THIS_ITEM_COPY,
  availableOf,
  cartLineAtMaxCopy,
  cartLineOverCopy,
  cartTotals,
  checkoutNeededByZoneUnknownCopy,
  checkoutStockChangedCopy,
  fitKitShares,
  isOrderOnBehalfValid,
  kitsForAudit,
  neededByLabel,
  orderItemRefusalCopy,
  resolveOrgTimezone,
  restoredCartChangedCopy,
  wallClockToInstant,
  type CartAction,
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

/**
 * Which body checkout draws (PO-4 review). The storefront answer is read
 * again when checkout opens and after a refusal for permission or the module
 * (R1), and it can come back turned off, refused or with no answer while the
 * cart is shown. Then checkout says why in place, with how the send ended and
 * the unconfirmed panel (a locked cart must still settle), as the catalog
 * does; a spinner only while there is nothing to show yet.
 */
export type CheckoutStage = 'loading' | 'unavailable' | 'checkout';
export function checkoutStage(
  snap: { setup: { status: 'loading' | 'ready' | 'off' | 'refused' | 'failed' }; cart: CartState | null } | null,
): CheckoutStage {
  if (!snap || snap.setup.status === 'loading') return 'loading';
  if (snap.setup.status !== 'ready') return 'unavailable';
  return snap.cart ? 'checkout' : 'loading';
}

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
  /** The organization's zone and the SERVER's now (ms), to refuse a needed-by
   *  that is not still to come (the server records `needed_by_past` for
   *  needed <= now(), final, spending the key). Absent when the zone cannot
   *  be used on this phone: then the server decides. */
  neededBy?: { zone: string; now: number };
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
  // What the route would refuse (desk check F11): refused here first.
  if (cart.onBehalfOf && !isOrderOnBehalfValid(cart.onBehalfOf)) return ORDER_ON_BEHALF_INVALID_COPY;
  if (input.neededBy && cart.neededBy) {
    const at = wallClockToInstant(cart.neededBy, input.neededBy.zone);
    if (at !== null && at <= input.neededBy.now) return NEEDED_BY_IN_PAST_COPY;
  }
  if (cart.lines.some((l) => input.unorderable.has(l.itemId))) return SUBMIT_REMOVE_UNORDERABLE_COPY;
  return null;
}

/** The someone-new form's action: only for a name and email the route
 *  accepts (core isOrderOnBehalfValid, desk check F11). While it is dimmed
 *  its hint always says why, and so does a line on screen once either field
 *  has been typed in (PO-4 review): both are needed, or what is typed is not
 *  what the server takes. */
export function someoneNewCheck(
  name: string,
  email: string,
): { canUse: boolean; message: string | null; hint: string | undefined } {
  const named = name.trim() !== '';
  const mailed = email.trim() !== '';
  if (!named && !mailed) return { canUse: false, message: null, hint: SUBMIT_ON_BEHALF_INCOMPLETE_COPY };
  if (!named || !mailed) {
    return { canUse: false, message: SUBMIT_ON_BEHALF_INCOMPLETE_COPY, hint: SUBMIT_ON_BEHALF_INCOMPLETE_COPY };
  }
  return isOrderOnBehalfValid({ name, email })
    ? { canUse: true, message: null, hint: undefined }
    : { canUse: false, message: ORDER_ON_BEHALF_INVALID_COPY, hint: ORDER_ON_BEHALF_INVALID_COPY };
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
  // The lock dims the row: say the rule, never "Tap For" (it cannot be
  // tapped until the send is settled), and the lock's hint says why.
  if (input.lockHint !== undefined) {
    return { shown: true, detail: ORDER_ON_BEHALF_NOT_PERMITTED_COPY, hint: input.lockHint, tap: 'set-myself' };
  }
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

/** Each refused line's reason (a rental, not received yet, a pre-assembled
 *  kit, archived...), from a final refusal's details: the line says why in
 *  core's words, as the web does (PO-4 review). */
export function refusedItemReasons(details: OrderRefusalDetails | null): Map<string, string> {
  return new Map(Object.entries(details?.items ?? {}));
}

/**
 * A change that would put more of a line marked as not orderable (refused by
 * the server's item check, or gone from the catalog) into the cart: +, Add, a
 * higher quantity, or a kit that adds to it (simulator walk D9). Such a line
 * can be lowered or removed, never raised. Pure.
 */
export function raisesNotOrderable(action: CartAction, cart: CartState, notOrderable: ReadonlySet<string>): boolean {
  if (notOrderable.size === 0) return false;
  switch (action.type) {
    case 'add':
    case 'inc':
      return notOrderable.has(action.itemId);
    case 'set-qty': {
      if (!notOrderable.has(action.itemId)) return false;
      const now = cart.lines.find((l) => l.itemId === action.itemId)?.quantity ?? 0;
      return action.quantity > now;
    }
    case 'apply-kit':
      return action.changes.some((c) => c.delta > 0 && notOrderable.has(c.itemId));
    default:
      return false;
  }
}

/** Lines no longer in the catalog this account can order from here. */
export function linesNotInCatalog(cart: CartState, catalog: ReadonlyMap<string, StorefrontItem>): Set<string> {
  return new Set(cart.lines.filter((l) => !catalog.has(l.itemId)).map((l) => l.itemId));
}

export type CartLineNote =
  | { kind: 'not_orderable' }
  /** Refused by the server's item check: core's sentence for its reason. */
  | { kind: 'refused'; message: string }
  | { kind: 'over'; message: string }
  | { kind: 'at_max'; message: string }
  | null;

/** What one cart line says under it: can't be ordered, more than available
 *  (kept, the web's warning), or everything available is in the cart.
 *  `unorderable` is the snapshot's notOrderable, which only a catalog answer
 *  (or the server's refusal) fills: a line whose item is simply not known
 *  yet (the catalog loading, or its read failed) is not marked (desk check
 *  F6.2). */
export function cartLineNote(
  quantity: number,
  item: StorefrontItem | undefined,
  unorderable: boolean,
): CartLineNote {
  if (unorderable) return { kind: 'not_orderable' };
  if (!item) return null;
  const available = availableOf(item);
  if (quantity > available) return { kind: 'over', message: cartLineOverCopy(available) };
  if (quantity === available && available > 0) return { kind: 'at_max', message: cartLineAtMaxCopy(available) };
  return null;
}

/** One cart line as the cart panel draws it: its title (the item's name; a
 *  neutral sentence while its item is not known yet; never a uuid, and
 *  never the mark again as the title), what it says under it, and whether
 *  it has a stepper (a known item that is not marked). */
export interface CartLineView {
  title: string;
  note: CartLineNote;
  stepper: boolean;
  /** Remove's spoken label: "Remove Planner", or "Remove this item" for an
   *  item the catalog shown does not name, never its id (desk check F7.3). */
  removeLabel: string;
}
export function cartLineView(
  line: { itemId: string; quantity: number },
  item: StorefrontItem | undefined,
  unorderable: boolean,
  /** The server's reason when it refused this line (PO-4 review): named from
   *  the cart's item, never from the server; without a name, the generic mark. */
  refusedReason?: string,
): CartLineView {
  const refused = unorderable && refusedReason !== undefined && item !== undefined;
  return {
    title: item ? item.name : unorderable ? STOREFRONT_LINE_NOT_LISTED_COPY : STOREFRONT_LINE_DETAILS_PENDING_COPY,
    note: refused ? { kind: 'refused', message: orderItemRefusalCopy(refusedReason, item.name) } : cartLineNote(line.quantity, item, unorderable),
    stepper: item !== undefined && !unorderable,
    removeLabel: item ? `${STOREFRONT_REMOVE_COPY} ${item.name}` : STOREFRONT_REMOVE_THIS_ITEM_COPY,
  };
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
