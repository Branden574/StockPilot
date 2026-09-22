import { stockAvailability } from '@stockpilot/core';

/**
 * The Rentals screen's Items view: the rental inventory itself, twin of web's
 * Rentals -> Items (`/dashboard/rentals/items`).
 *
 * WHY IT EXISTS. Mobile's Rentals screen listed only checkouts (the `rentals`
 * table). Rental ITEMS had no list of their own on mobile, and the Items tab,
 * which forgot to exclude rentals, was by accident the only place a phone
 * could browse them. The Items tab now uses the shared rule (#224), which
 * excludes rentals like web does, so this list has to exist or rental items
 * would vanish from mobile.
 *
 * WHAT IT SHOWS matches web: every rental item the member can read, of any
 * type, active, not awaiting its first receipt, most recently updated first,
 * in every warehouse (web's rentals list takes no warehouse filter either).
 * Row level security decides what "can read" means; nothing here widens it.
 */

/** Rows fetched in one go. Rental fleets are small; the count says if not. */
export const RENTAL_ITEMS_LIMIT = 200;

export interface RentalItemSource {
  id: string;
  name: string;
  sku: string | null;
  quantity_on_hand: number | string | null;
}

export interface RentalItemRow {
  id: string;
  name: string;
  sku: string | null;
  onHand: number;
  /** Units out on rental (open reservations). */
  reserved: number;
  /** What can still be lent. Never negative. */
  available: number;
  /** More reserved than owned: a promise that cannot be kept. */
  overReserved: boolean;
}

/**
 * Fold open reservations into each item's numbers, the way web's rentals list
 * and the new-rental picker do: available = on hand - open reservations.
 * Items keep the order they were fetched in.
 */
export function buildRentalItemRows(
  items: readonly RentalItemSource[],
  reservations: readonly { item_id: string; quantity: number | string | null }[],
): RentalItemRow[] {
  const reservedById = new Map<string, number>();
  for (const r of reservations) {
    const qty = Number(r.quantity);
    if (!Number.isFinite(qty)) continue;
    reservedById.set(r.item_id, (reservedById.get(r.item_id) ?? 0) + qty);
  }
  return items.map((item) => {
    const stock = stockAvailability({
      onHand: Number(item.quantity_on_hand ?? 0),
      reserved: reservedById.get(item.id) ?? 0,
    });
    return {
      id: item.id,
      name: item.name,
      sku: item.sku,
      onHand: stock.onHand,
      reserved: stock.reserved,
      available: stock.available,
      overReserved: stock.overReserved,
    };
  });
}

/**
 * The eyebrow over the Items view. Says so when the list is a prefix, so a
 * fleet bigger than one fetch never reads as "that's all of them".
 */
export function rentalItemsEyebrow(shown: number, total: number | null): string {
  const count = total ?? shown;
  const noun = count === 1 ? 'ITEM' : 'ITEMS';
  if (total !== null && total > shown) return `RENTALS · SHOWING ${shown} OF ${total} ${noun}`;
  return `RENTALS · ${count} ${noun}`;
}
