import 'server-only';

import { reportError } from '@/lib/error-reporter';

import type { RackHoldingLike } from '@stockpilot/core';

import type { ServiceContext } from './context';

export type { RackHoldingLike };

const ID_CHUNK_SIZE = 100;

/**
 * Batched fetch of rack/crate HOLDINGS (item_stock_levels rows with
 * quantity > 0 sitting on a rack/crate location) for a set of item ids —
 * ONE round trip per ID_CHUNK_SIZE-item chunk (chunks run in parallel),
 * org-scoped, using the caller's user-authed `ctx.supabase` (RLS applies,
 * same as every other read in these services — never the admin client).
 *
 * Shared by every "label consumer" that wants to show a picker/counter
 * the FULL breakdown when an item's stock is split across more than one
 * rack/crate, instead of trusting a single (possibly stale) bin_location
 * label: the pick-slip PDF, the cycle-count sheet PDF, and the
 * scanner/lookup API. Chunked the same way the cycle-count PDF route
 * already chunks its own bin-location lookup (100 uuids ≈ 3.7KB — well
 * under the edge/gateway URL-length rejection threshold a single
 * `.in('item_id', ids)` could hit for a big order/count).
 *
 * `warehouseId`, when passed, scopes holdings to that warehouse's
 * locations only — mirrors how `stock_reservations` and the digital pick
 * flow already scope to a single order's warehouse_id, so a pick slip for
 * warehouse X lists holdings in X only. Omit it (org-wide cycle counts,
 * the scanner lookup, which carry no single-warehouse context) to return
 * every holding across every warehouse.
 */
export async function fetchRackHoldingsByItem(
  ctx: Pick<ServiceContext, 'supabase' | 'organizationId'>,
  itemIds: string[],
  warehouseId?: string | null,
): Promise<Map<string, RackHoldingLike[]>> {
  const byItem = new Map<string, RackHoldingLike[]>();
  const uniqueIds = [...new Set(itemIds)];
  if (uniqueIds.length === 0) return byItem;

  type HoldingRow = {
    item_id: string;
    quantity: number;
    locations: { name: string; kind: string; warehouse_id: string | null } | null;
  };

  const chunks: string[][] = [];
  for (let i = 0; i < uniqueIds.length; i += ID_CHUNK_SIZE) {
    chunks.push(uniqueIds.slice(i, i + ID_CHUNK_SIZE));
  }

  const chunkResults = await Promise.all(
    chunks.map(async (chunk) => {
      let q = ctx.supabase
        .from('item_stock_levels')
        .select('item_id, quantity, locations!inner(name, kind, warehouse_id)')
        .eq('organization_id', ctx.organizationId)
        .in('item_id', chunk)
        .in('locations.kind', ['rack', 'crate'])
        .gt('quantity', 0);
      if (warehouseId) q = q.eq('locations.warehouse_id', warehouseId);
      const { data, error } = await q;
      // Graceful degradation is deliberate (consumers fall back to the
      // stale label) — but never silently: a persistent failure here would
      // otherwise hide split stock from pickers with zero telemetry.
      if (error) {
        void reportError(new Error(`rack-holdings fetch: ${error.message}`), {
          tag: 'rack-holdings.fetch',
          level: 'warning',
        });
      }
      // `locations` is a to-one embed → a single object at runtime; the
      // generated PostgREST types model it as an array (same convention
      // as the other holdings reads in InventoryService).
      return (data ?? []) as unknown as HoldingRow[];
    }),
  );

  for (const row of chunkResults.flat()) {
    const name = row.locations?.name;
    if (!name) continue;
    const arr = byItem.get(row.item_id) ?? [];
    // `kind` was already being SELECTed and thrown away here. Carrying it is
    // what lets a single-label consumer tell "the stock is in a crate" from
    // "the stock is on a rack" — see countSheetLocationLabel, where an item
    // whose stock has moved into a position-less crate would otherwise keep
    // printing the rack its custom_fields still (deliberately) name.
    arr.push({ name, quantity: Number(row.quantity) || 0, kind: row.locations?.kind ?? null });
    byItem.set(row.item_id, arr);
  }
  return byItem;
}
