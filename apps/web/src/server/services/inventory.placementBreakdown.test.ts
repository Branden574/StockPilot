import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { InventoryService } from './inventory';

// placementBreakdown backs the inventory list's "one line per rack" expansion:
// per item, every non-empty holding with a display label + kind, sorted
// racks/crates (A→Z) → Staging → Unplaced.
const ITEM = '11111111-1111-1111-1111-111111111111';

describe('InventoryService.placementBreakdown', () => {
  it('groups holdings per item, labels buckets, sorts racks→staging→unplaced', async () => {
    const stub = makeSupabaseStub({
      'item_stock_levels.select': {
        data: [
          { item_id: ITEM, location_id: 'unp', quantity: 100, locations: { name: 'Holding Bin', kind: 'unplaced' } },
          { item_id: ITEM, location_id: 'r2', quantity: 250, locations: { name: '2-C', kind: 'rack' } },
          { item_id: ITEM, location_id: 'stg', quantity: 50, locations: { name: 'PO Buffer', kind: 'staging' } },
          { item_id: ITEM, location_id: 'r1', quantity: 250, locations: { name: '1-A', kind: 'rack' } },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));
    const rows = (await svc.placementBreakdown([ITEM])).get(ITEM)!;

    // Order: real racks alphabetical, then Staging, then Unplaced.
    expect(rows.map((r) => r.label)).toEqual(['1-A', '2-C', 'Staging', 'Unplaced']);
    expect(rows.map((r) => r.quantity)).toEqual([250, 250, 50, 100]);
    // System buckets show the WORD, not the underlying location name.
    expect(rows.find((r) => r.kind === 'staging')!.label).toBe('Staging');
    expect(rows.find((r) => r.kind === 'unplaced')!.label).toBe('Unplaced');
    // Rack rows keep the rack's real name + carry the location id.
    expect(rows.find((r) => r.label === '1-A')).toMatchObject({ locationId: 'r1', kind: 'rack' });
  });

  // ── NULL locations.kind IS the Site encoding ────────────────────────────
  // 0292/0331 + reference_locations_kind_null_is_a_site: a Site row is stored
  // with kind NULL and is never backfilled (L4L's DC4 holds 405 units that
  // way; 5 of Demo Co's 8 active locations are NULL-kind). The row SUMMARY
  // already counts those units as PLACED (derivePlacement subtracts only
  // staged + unplaced), but this breakdown coalesced NULL → 'unplaced' and
  // printed the word "Unplaced" — so one row said "placed 405" while its own
  // expansion said the stock was nowhere, and anything keyed on
  // kind === 'unplaced' (the amber "awaiting put-away" chip) fired on stock
  // that was correctly recorded. A manager "fixes" that by moving stock that
  // never needed moving.
  it('labels a NULL-kind SITE holding with the site NAME and a distinct "site" kind', async () => {
    const stub = makeSupabaseStub({
      'item_stock_levels.select': {
        data: [
          { item_id: ITEM, location_id: 'stg', quantity: 50, locations: { name: 'PO Buffer', kind: 'staging' } },
          { item_id: ITEM, location_id: 'site', quantity: 405, locations: { name: 'DC4', kind: null } },
          { item_id: ITEM, location_id: 'r1', quantity: 10, locations: { name: '1-A', kind: 'rack' } },
        ],
        error: null,
      },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));
    const rows = (await svc.placementBreakdown([ITEM])).get(ITEM)!;

    expect(rows.find((r) => r.locationId === 'site')).toMatchObject({
      label: 'DC4',
      kind: 'site',
      quantity: 405,
    });
    // Ranked with the real placements (before Staging), not with Unplaced.
    expect(rows.map((r) => r.label)).toEqual(['1-A', 'DC4', 'Staging']);
  });

  it('returns an empty map for an empty id list (no round-trip)', async () => {
    const stub = makeSupabaseStub({});
    const svc = new InventoryService(makeServiceContext(stub.client));
    expect((await svc.placementBreakdown([])).size).toBe(0);
  });
});
