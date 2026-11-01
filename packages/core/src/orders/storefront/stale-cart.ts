// STALE CARTS (ordering visibility, design 6.5): what a cart line says when its
// item is no longer in the catalog this account can order from (hidden from
// Orders, archived, out of scope) or the server refused it, and which changes
// such a line still allows. Pure.
//
// Moved unchanged from apps/mobile/src/lib/order-storefront/checkout.ts (phone
// ordering PO-4), which re-exports every name, so the web storefront applies
// the same rule: a marked line is kept, can be lowered or removed, never
// raised, and blocks Submit until it is edited. Nothing is dropped silently
// and no partial order is sent.
//
// ═══ IMPORTING THIS MODULE RUNS NOTHING ═══ (core's index re-exports it and
// Metro does not tree-shake): declarations only.

import type { OrderRefusalDetails } from '../place-order';
import { orderItemRefusalCopy } from '../place-order';

import { fitKitShares, type CartAction, type CartState } from './cart';
import { cartLineAtMaxCopy, cartLineOverCopy } from './copy';
import type { StorefrontItem } from './item';
import { availableOf } from './logic';
import {
  restoredCartChangedCopy,
  STOREFRONT_LINE_DETAILS_PENDING_COPY,
  STOREFRONT_LINE_NOT_LISTED_COPY,
  STOREFRONT_REMOVE_COPY,
  STOREFRONT_REMOVE_THIS_ITEM_COPY,
} from './phone-copy';

/** The lines the server refused as not orderable (item_not_orderable), from
 *  a final refusal's details. */
export function refusedItemIds(details: OrderRefusalDetails | null): Set<string> {
  return new Set(Object.keys(details?.items ?? {}));
}

/** Each refused line's reason (a rental, not received yet, a pre-assembled
 *  kit, archived, hidden from Orders...), from a final refusal's details: the
 *  line says why in core's words (PO-4 review). */
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

/**
 * The cart's marks, the rule the phone's storefront session applies (session
 * build()): lines gone from a catalog ANSWER (null while it loads or failed:
 * nothing is claimed then), plus every refused line still in the cart with
 * its reason. A refusal for a line the person already removed is dropped.
 */
export function cartNotOrderableMarks(
  cart: CartState | null,
  catalog: ReadonlyMap<string, StorefrontItem> | null,
  refused: ReadonlyMap<string, string>,
): { notOrderable: Set<string>; refusals: Map<string, string> } {
  const notOrderable = new Set<string>();
  const refusals = new Map<string, string>();
  if (!cart) return { notOrderable, refusals };
  if (catalog) for (const id of linesNotInCatalog(cart, catalog)) notOrderable.add(id);
  for (const [id, reason] of refused) {
    if (!cart.lines.some((l) => l.itemId === id)) continue;
    notOrderable.add(id);
    refusals.set(id, reason);
  }
  return { notOrderable, refusals };
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

/**
 * A cart restored on this device, checked against the catalog as it is now.
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
