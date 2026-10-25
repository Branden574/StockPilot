import 'server-only';

import { reportError } from '@/lib/error-reporter';

import {
  partitionPlacementHoldings,
  type PlacedHoldingLike,
  type RackHoldingLike,
} from '@stockpilot/core';

import type { ServiceContext } from './context';
import { mapIdBatches, rawErrorText } from './lib/fetch-by-ids';
import { fetchAllRows } from './lib/paginate';

export type { PlacedHoldingLike, RackHoldingLike };

/**
 * Every PLACED holding of each item, split the way `resolvePlacement` reads
 * them (`partitionPlacementHoldings`).
 */
export interface PlacementHoldingsByItem {
  /** Rack and crate rows: exactly what `fetchRackHoldingsByItem` returns. */
  rack: Map<string, RackHoldingLike[]>;
  /**
   * Every other placed row (Sites, areas, NULL-kind shelves and bins), with
   * `kind` and `type`: `PlacementInput.otherHoldings`, so an item whose stock
   * sits only on a Site is named by its Site, not the rack its label still
   * names (B37).
   */
  other: Map<string, PlacedHoldingLike[]>;
}

/**
 * Batched fetch of each item's PLACED holdings (item_stock_levels rows with
 * quantity > 0, on any location but the Staging and Unplaced buckets) — one
 * paged read per 100-item batch (mapIdBatches: at most 6 in flight),
 * org-scoped, using the caller's user-authed `ctx.supabase` (RLS applies,
 * same as every other read in these services — never the admin client).
 *
 * ONE read for both lists, on purpose: rule 0c names the Site only when an
 * item has NO rack or crate holding, so the rack rows and the Site rows must
 * succeed or fail together. A failed batch answers nothing for its items (both
 * lists empty), which every consumer reads as "no holdings known" and renders
 * from the label, as before; it never answers "on the Site" for stock whose
 * rack read was lost.
 *
 * Every location kind is read and the buckets are dropped here rather than in
 * the query: a Site's `locations.kind` IS NULL, and in SQL a NOT IN filter
 * drops NULL rows (the 0292 trap), so "everything but staging and unplaced"
 * is not a filter PostgREST can be trusted to spell. The extra rows are at
 * most two per item per warehouse.
 *
 * Batched because a single `.in('item_id', ids)` for a big order or count
 * fails on URL length (414 locally past ~215 uuids, "fetch failed" in
 * production past ~395). Each batch is PAGED as well: an item can hold
 * several rows, and an unpaged read was cut at 1000 rows with no error,
 * hiding split stock from the picker.
 *
 * `warehouseId`, when passed, scopes holdings to that warehouse's
 * locations only — mirrors how `stock_reservations` and the digital pick
 * flow already scope to a single order's warehouse_id, so a pick slip for
 * warehouse X lists holdings in X only. Omit it (org-wide cycle counts,
 * the scanner lookup, which carry no single-warehouse context) to return
 * every holding across every warehouse.
 */
export async function fetchPlacementHoldingsByItem(
  ctx: Pick<ServiceContext, 'supabase' | 'organizationId'>,
  itemIds: string[],
  warehouseId?: string | null,
): Promise<PlacementHoldingsByItem> {
  const rack = new Map<string, RackHoldingLike[]>();
  const other = new Map<string, PlacedHoldingLike[]>();
  const uniqueIds = [...new Set(itemIds)];
  if (uniqueIds.length === 0) return { rack, other };

  type HoldingRow = {
    item_id: string;
    quantity: number;
    locations: {
      name: string;
      kind: string | null;
      type: string | null;
      warehouse_id: string | null;
    } | null;
  };

  const chunkResults = await mapIdBatches(uniqueIds, async (batch) => {
    try {
      // `locations` is a to-one embed → a single object at runtime; the
      // generated PostgREST types model it as an array (same convention
      // as the other holdings reads in InventoryService).
      return (await fetchAllRows<unknown>((from, to) => {
        let q = ctx.supabase
          .from('item_stock_levels')
          .select('item_id, quantity, locations!inner(name, kind, type, warehouse_id)')
          .eq('organization_id', ctx.organizationId)
          .in('item_id', batch)
          .gt('quantity', 0);
        if (warehouseId) q = q.eq('locations.warehouse_id', warehouseId);
        return q.order('id').range(from, to);
      })) as HoldingRow[];
    } catch (err) {
      // Graceful degradation is deliberate (consumers fall back to the
      // stale label), and per batch, so one failed batch costs only its own
      // items — but never silently: a persistent failure here would
      // otherwise hide split stock from pickers with zero telemetry.
      void reportError(new Error(`rack-holdings fetch: ${rawErrorText(err)}`), {
        tag: 'rack-holdings.fetch',
        level: 'warning',
      });
      return [] as HoldingRow[];
    }
  });

  // Rows grouped per item in read order, then split by the one core rule.
  const rowsByItem = new Map<string, PlacedHoldingLike[]>();
  for (const row of chunkResults.flat()) {
    const name = row.locations?.name;
    if (!name) continue;
    const arr = rowsByItem.get(row.item_id) ?? [];
    // `kind` and `type` are carried, not discarded: `kind` tells a crate from
    // a rack (a put-away into a position-less crate leaves the item's rack
    // keys naming the rack it left), and only the PAIR tells a Site from a
    // legacy shelf, since both are stored with a NULL kind.
    arr.push({
      name,
      quantity: Number(row.quantity) || 0,
      kind: row.locations?.kind ?? null,
      type: row.locations?.type ?? null,
    });
    rowsByItem.set(row.item_id, arr);
  }
  for (const [itemId, rows] of rowsByItem) {
    const { holdings, otherHoldings } = partitionPlacementHoldings(rows);
    if (holdings.length > 0) rack.set(itemId, holdings);
    if (otherHoldings.length > 0) other.set(itemId, otherHoldings);
  }
  return { rack, other };
}

/**
 * The rack/crate HOLDINGS alone, for a set of item ids — the `rack` half of
 * `fetchPlacementHoldingsByItem`, with the same batching, scoping and per-batch
 * degradation.
 *
 * Shared by every "label consumer" that wants to show a picker/counter
 * the FULL breakdown when an item's stock is split across more than one
 * rack/crate, instead of trusting a single (possibly stale) bin_location
 * label. The walk-to surfaces that also need the Site rule (the order slips,
 * the cycle-count sheet, the rentals catalog, the grouping review) read
 * `fetchPlacementHoldingsByItem` instead; this keeps the scanner lookup's
 * `rackHoldings` and the returns workbench on the rows they always had.
 */
export async function fetchRackHoldingsByItem(
  ctx: Pick<ServiceContext, 'supabase' | 'organizationId'>,
  itemIds: string[],
  warehouseId?: string | null,
): Promise<Map<string, RackHoldingLike[]>> {
  return (await fetchPlacementHoldingsByItem(ctx, itemIds, warehouseId)).rack;
}
