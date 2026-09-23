/**
 * The id-list reads the mobile screens make, one definition per table.
 *
 * Each reader takes a structural client (IdReadClient: the screens pass
 * `supabase`, the tests pass a fake that records every call), batches its id
 * list through fetchAllRowsByIds, pages each batch with a stable
 * `.order(..., 'id')`, and THROWS IdBatchReadError when any batch fails. None
 * of them ever answers a failure with an empty map: the screen decides what a
 * failure means (fail closed for a decision, degrade visibly for a photo).
 *
 * Every `.in(` below passes the parameter named `batch`; the static guard in
 * in-filter-sites.guard.test.ts relies on that name.
 *
 * Pure: no React Native import, no Supabase client. Do not import ./supabase
 * or ./image-cache here (supabase.ts pulls in expo-secure-store).
 */

import type { CountingUnit, RackHoldingLike, SizeScaleValueOrder } from '@stockpilot/core';

import {
  fetchAllRowsByIds,
  idReadTable,
  type IdReadClient,
  type PageResult,
} from './id-batches';
import type { PoRunGroup } from './po-size-run';

/** The page promise typed as the rows the caller expects. */
function typed<Row>(p: PromiseLike<PageResult<unknown>>): PromiseLike<PageResult<Row>> {
  return p as PromiseLike<PageResult<Row>>;
}

// ── Open reservations ───────────────────────────────────────────────────────

export interface ReservationRow {
  item_id: string;
  quantity: number | string | null;
}

/**
 * Open (unreleased) stock reservations for `itemIds`. Availability is on hand
 * minus these, which is what the server enforces (SP-052), so this read feeds
 * a decision: a failure must never read as "nothing reserved".
 */
export async function readOpenReservations(
  client: IdReadClient,
  orgId: string,
  itemIds: readonly (string | null | undefined)[],
): Promise<ReservationRow[]> {
  const rows = await fetchAllRowsByIds<ReservationRow & { id?: string }>(
    itemIds,
    (batch) => (from, to) =>
      typed(
        idReadTable(client, 'stock_reservations')
          .select('id, item_id, quantity')
          .eq('organization_id', orgId)
          .in('item_id', batch)
          .is('released_at', null)
          .order('id', { ascending: true })
          .range(from, to),
      ),
  );
  return rows.map((r) => ({ item_id: r.item_id, quantity: r.quantity }));
}

/**
 * Units reserved per item. A quantity that is not a finite number is skipped
 * (null reads as 0), the same rule buildRentalItemRows applies.
 */
export function sumReservedByItem(rows: readonly ReservationRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const qty = Number(r.quantity);
    if (!Number.isFinite(qty)) continue;
    out.set(r.item_id, (out.get(r.item_id) ?? 0) + qty);
  }
  return out;
}

// ── On hand ─────────────────────────────────────────────────────────────────

/** quantity_on_hand per item id. An item the viewer cannot read has no entry. */
export async function readOnHand(
  client: IdReadClient,
  orgId: string,
  itemIds: readonly (string | null | undefined)[],
): Promise<Map<string, number>> {
  const rows = await fetchAllRowsByIds<{ id: string; quantity_on_hand: number | string | null }>(
    itemIds,
    (batch) => (from, to) =>
      typed(
        idReadTable(client, 'inventory_items')
          .select('id, quantity_on_hand')
          .eq('organization_id', orgId)
          .in('id', batch)
          .order('id', { ascending: true })
          .range(from, to),
      ),
  );
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.id, Number(r.quantity_on_hand) || 0);
  return out;
}

// ── Primary photos ──────────────────────────────────────────────────────────

export interface PhotoPaths {
  storage_path: string;
  thumb_path: string | null;
}

/**
 * The primary photo of each item (the first by is_primary desc, sort_order,
 * id). An item with no photo has no entry. Every row for one item sits in one
 * batch, so "first row wins" is the same pick the unbatched read made.
 */
export async function readPrimaryPhotos(
  client: IdReadClient,
  orgId: string,
  itemIds: readonly (string | null | undefined)[],
): Promise<Map<string, PhotoPaths>> {
  const rows = await fetchAllRowsByIds<{
    item_id: string;
    storage_path: string;
    thumb_path: string | null;
  }>(
    itemIds,
    (batch) => (from, to) =>
      typed(
        idReadTable(client, 'item_images')
          .select('item_id, storage_path, thumb_path, is_primary, sort_order')
          .eq('organization_id', orgId)
          .in('item_id', batch)
          .order('is_primary', { ascending: false })
          .order('sort_order', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
  );
  const out = new Map<string, PhotoPaths>();
  for (const r of rows) {
    if (!out.has(r.item_id)) {
      out.set(r.item_id, { storage_path: r.storage_path, thumb_path: r.thumb_path ?? null });
    }
  }
  return out;
}

// ── Rack / crate holdings ───────────────────────────────────────────────────

type LocationEmbed = { name: string | null; kind: string | null };

/**
 * Where each item's stock physically is: its item_stock_levels rows with
 * quantity > 0 at a rack or crate. Moved verbatim from the Books list.
 */
export async function readRackHoldings(
  client: IdReadClient,
  orgId: string,
  itemIds: readonly (string | null | undefined)[],
): Promise<Map<string, RackHoldingLike[]>> {
  const rows = await fetchAllRowsByIds<{
    item_id: string;
    quantity: number | string | null;
    locations: LocationEmbed | LocationEmbed[] | null;
  }>(
    itemIds,
    (batch) => (from, to) =>
      typed(
        idReadTable(client, 'item_stock_levels')
          .select('item_id, quantity, locations!inner(name, kind)')
          .eq('organization_id', orgId)
          .in('item_id', batch)
          .in('locations.kind', ['rack', 'crate'])
          .gt('quantity', 0)
          .order('id', { ascending: true })
          .range(from, to),
      ),
  );
  const byItem = new Map<string, RackHoldingLike[]>();
  for (const lvl of rows) {
    const l = Array.isArray(lvl.locations) ? lvl.locations[0] : lvl.locations;
    if (!l?.name) continue;
    const arr = byItem.get(lvl.item_id) ?? [];
    arr.push({ name: l.name, quantity: Number(lvl.quantity) || 0, kind: l.kind ?? null });
    byItem.set(lvl.item_id, arr);
  }
  return byItem;
}

// ── Profiles ────────────────────────────────────────────────────────────────

/** user_profiles rows by id, selecting `columns` (which must include `id`). */
export async function readProfilesByIds<P extends { id: string }>(
  client: IdReadClient,
  userIds: readonly (string | null | undefined)[],
  columns: string,
): Promise<Map<string, P>> {
  const rows = await fetchAllRowsByIds<P>(
    userIds,
    (batch) => (from, to) =>
      typed(
        idReadTable(client, 'user_profiles')
          .select(columns)
          .in('id', batch)
          .order('id', { ascending: true })
          .range(from, to),
      ),
  );
  const out = new Map<string, P>();
  for (const p of rows) out.set(p.id, p);
  return out;
}

// ── Item names ──────────────────────────────────────────────────────────────

export interface ItemRef {
  id: string;
  name: string;
  sku: string;
}

/** Name and SKU per item id, org-scoped. */
export async function readItemRefs(
  client: IdReadClient,
  orgId: string,
  ids: readonly (string | null | undefined)[],
): Promise<Record<string, ItemRef>> {
  const rows = await fetchAllRowsByIds<ItemRef>(
    ids,
    (batch) => (from, to) =>
      typed(
        idReadTable(client, 'inventory_items')
          .select('id, name, sku')
          .eq('organization_id', orgId)
          .in('id', batch)
          .order('id', { ascending: true })
          .range(from, to),
      ),
  );
  const out: Record<string, ItemRef> = {};
  for (const it of rows) out[it.id] = it;
  return out;
}

// ── PO size runs ────────────────────────────────────────────────────────────

/**
 * Display metadata for the product groups a PO's lines point at, with each
 * group's size-scale values in sort order. Read BY ID at any status (only
 * `deleted_at` excludes a row), the stance web's displayByIds takes: a receipt
 * in flight keeps rendering its size runs even if the group was archived.
 * Either read failing throws; sizes are never returned unordered.
 */
export async function readPoRunGroups(
  client: IdReadClient,
  orgId: string,
  groupIds: readonly (string | null | undefined)[],
): Promise<Record<string, PoRunGroup>> {
  const groups = await fetchAllRowsByIds<{
    id: string;
    name: string;
    default_counting_unit: string;
    size_scale_id: string | null;
  }>(
    groupIds,
    (batch) => (from, to) =>
      typed(
        idReadTable(client, 'product_groups')
          .select('id, name, default_counting_unit, size_scale_id')
          .eq('organization_id', orgId)
          .in('id', batch)
          .is('deleted_at', null)
          .order('id', { ascending: true })
          .range(from, to),
      ),
  );
  const scaleIds = groups.map((g) => g.size_scale_id);
  const values = await fetchAllRowsByIds<{
    size_scale_id: string;
    value: string;
    normalized: string | null;
    sort_order: number | string;
  }>(
    scaleIds,
    (batch) => (from, to) =>
      typed(
        idReadTable(client, 'size_scale_values')
          .select('id, size_scale_id, value, normalized, sort_order')
          .in('size_scale_id', batch)
          .order('sort_order', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      ),
  );
  const valuesByScale = new Map<string, SizeScaleValueOrder[]>();
  for (const v of values) {
    const entry: SizeScaleValueOrder = {
      value: v.value,
      normalized: v.normalized ?? null,
      sortOrder: Number(v.sort_order),
    };
    const arr = valuesByScale.get(v.size_scale_id);
    if (arr) arr.push(entry);
    else valuesByScale.set(v.size_scale_id, [entry]);
  }
  const out: Record<string, PoRunGroup> = {};
  for (const g of groups) {
    out[g.id] = {
      name: g.name,
      countingUnit: g.default_counting_unit as CountingUnit,
      sizeValues: g.size_scale_id ? (valuesByScale.get(g.size_scale_id) ?? []) : [],
    };
  }
  return out;
}

// ── Receipt totals ──────────────────────────────────────────────────────────

/**
 * Accepted and rejected units per receipt, summed over EVERY receipt line.
 * Paged, so a PO with more than 1000 receipt lines is not silently short (the
 * `.limit(5000)` this replaces was clamped to 1000 by max_rows).
 */
export async function readReceiptTotals(
  client: IdReadClient,
  receiptIds: readonly (string | null | undefined)[],
): Promise<Map<string, { accepted: number; rejected: number }>> {
  const rows = await fetchAllRowsByIds<{
    receipt_id: string;
    qty_accepted_base: number | string | null;
    qty_rejected_base: number | string | null;
  }>(
    receiptIds,
    (batch) => (from, to) =>
      typed(
        idReadTable(client, 'receipt_lines')
          .select('id, receipt_id, qty_accepted_base, qty_rejected_base')
          .in('receipt_id', batch)
          .order('id', { ascending: true })
          .range(from, to),
      ),
  );
  const out = new Map<string, { accepted: number; rejected: number }>();
  for (const r of rows) {
    const t = out.get(r.receipt_id) ?? { accepted: 0, rejected: 0 };
    t.accepted += Number(r.qty_accepted_base) || 0;
    t.rejected += Number(r.qty_rejected_base) || 0;
    out.set(r.receipt_id, t);
  }
  return out;
}
