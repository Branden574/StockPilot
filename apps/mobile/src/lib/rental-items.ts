import { stockAvailability } from '@stockpilot/core';

import { settleIdBatchRead, type IdReadClient } from './id-batches';
import { readOpenReservations, readPrimaryPhotos, type PhotoPaths } from './id-reads';

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

/** The Rentals screen's Items view, before its photos are signed. */
export interface RentalItemsView {
  /** The availability figures could not be computed: show the failed state. */
  failed: boolean;
  /** Why it failed, for the log. */
  message: string | null;
  rows: RentalItemRow[];
  /** Primary photo per item. Empty when the photo read failed (glyphs). */
  photoByItem: Map<string, PhotoPaths>;
}

/**
 * Open reservations and primary photos for the fetched rental items, both
 * batched (up to RENTAL_ITEMS_LIMIT = 200 ids: about 7.8 KB of uuids, right at
 * the local 8 KB URL limit for one `.in()`).
 *
 * - Reservations FEED A FIGURE the operator acts on (Available, OVER-LENT). A
 *   failure fails the view: it used to be ignored, so Available silently
 *   equalled On hand.
 * - Photos are cosmetic: a failure leaves glyphs. Nothing is cached, since the
 *   view is rebuilt on every load.
 */
export async function loadRentalItemsView(
  client: IdReadClient,
  orgId: string,
  sources: readonly RentalItemSource[],
): Promise<RentalItemsView> {
  const ids = sources.map((s) => s.id);
  const [reservations, photos] = await Promise.all([
    settleIdBatchRead(readOpenReservations(client, orgId, ids)),
    settleIdBatchRead(readPrimaryPhotos(client, orgId, ids)),
  ]);
  if (!reservations.ok) {
    return { failed: true, message: reservations.message, rows: [], photoByItem: new Map() };
  }
  return {
    failed: false,
    message: null,
    rows: buildRentalItemRows(sources, reservations.value),
    photoByItem: photos.ok ? new Map(photos.value) : new Map(),
  };
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

// ── New-rental picker ───────────────────────────────────────────────────────

/** What the new-rental picker can offer, given which of its reads failed. */
export interface RentalPickerStatus {
  /** True when the item list and its steppers must not be offered, and the
   *  checkout must not be submitted. */
  blocked: boolean;
  /** The sentence to show when blocked. */
  message: string | null;
  /** The read's own reason, shown under the sentence. */
  detail: string | null;
}

/**
 * The new-rental picker offers units by AVAILABILITY (on hand minus open
 * reservations, what the server enforces, SP-052). If the reservations read
 * fails, every "N AVAILABLE" figure would silently equal on hand and the +
 * button would offer units the server then refuses, with a cause the operator
 * cannot see. So each failed read BLOCKS the picker with its own sentence,
 * instead of showing a picker built on a guess:
 *
 * - warehouses failed: there is no warehouse to pick items from;
 * - items failed: "No rental items in this warehouse" would be false;
 * - reservations failed: availability is unknown.
 */
export function rentalPickerStatus(reads: {
  warehousesError: string | null;
  itemsError: string | null;
  stockError: string | null;
}): RentalPickerStatus {
  if (reads.warehousesError !== null) {
    return { blocked: true, message: 'Could not load warehouses.', detail: reads.warehousesError };
  }
  if (reads.itemsError !== null) {
    return { blocked: true, message: 'Could not load rental items.', detail: reads.itemsError };
  }
  if (reads.stockError !== null) {
    return {
      blocked: true,
      message: 'Could not check which units are already out on rental.',
      detail: reads.stockError,
    };
  }
  return { blocked: false, message: null, detail: null };
}
