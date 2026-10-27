import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// ═══════════════════════════════════════════════════════════════════════════
// THE LIST ROW'S OTHER PLACED HOLDINGS (B37)
// ═══════════════════════════════════════════════════════════════════════════
//
// The Books Rack column, the cycle-count picker and the Books search results
// resolve where a book's stock is from its list row. The row carried only its
// rack and crate holdings, so a book whose stock all sits on the Site (a
// NULL-kind location with a site type) had nothing but its rack keys to go on
// and printed the rack the stock left. The row now carries every OTHER placed
// holding too, with kind AND type, from the same holdings read, so core
// resolvePlacement can apply its Site rule.

vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-1',
  })),
  assertWarehouseAccess: vi.fn(async () => undefined),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));

import { InventoryService } from './inventory';

beforeEach(() => vi.clearAllMocks());

const ON_SITE = '11111111-1111-1111-1111-111111111111';
const ON_RACK = '22222222-2222-2222-2222-222222222222';

function listWith(levels: unknown[]) {
  const stub = makeSupabaseStub({
    'inventory_items.select': {
      data: [
        { id: ON_SITE, warehouse_id: 'wh-1', quantity_on_hand: 12 },
        { id: ON_RACK, warehouse_id: 'wh-1', quantity_on_hand: 5 },
      ],
      error: null,
      count: 2,
    },
    'item_stock_levels.select': { data: levels, error: null },
  });
  const svc = new InventoryService(makeServiceContext(stub.client, { role: 'manager' }) as never);
  return { svc, stub };
}

describe('InventoryService.list: other_holdings (B37)', () => {
  it('carries a Site holding, and an area, with kind and type, sorted by name; never a bucket', async () => {
    const { svc } = listWith([
      {
        item_id: ON_SITE,
        location_id: 'loc-dc4',
        quantity: 7,
        locations: { name: 'DC4', kind: null, type: 'warehouse' },
      },
      {
        item_id: ON_SITE,
        location_id: 'loc-annex',
        quantity: 2,
        locations: { name: 'Annex', kind: 'area', type: null },
      },
      {
        item_id: ON_SITE,
        location_id: 'loc-stage',
        quantity: 3,
        locations: { name: 'Staging', kind: 'staging', type: null },
      },
      {
        item_id: ON_SITE,
        location_id: 'loc-unp',
        quantity: 0,
        locations: { name: 'Unplaced', kind: 'unplaced', type: null },
      },
      {
        item_id: ON_RACK,
        location_id: 'loc-2c',
        quantity: 5,
        locations: { name: '2-C', kind: 'rack', type: 'shelf' },
      },
    ]);
    const res = await svc.list({ limit: 50 });
    const site = res.items.find((i) => i.id === ON_SITE)!;
    expect(site.other_holdings).toEqual([
      { name: 'Annex', quantity: 2, kind: 'area', type: null },
      { name: 'DC4', quantity: 7, kind: null, type: 'warehouse' },
    ]);
    // The rack figures are what they were: a Site or an area is not a rack.
    expect(site.placed_holdings).toEqual([]);
    expect(site.placed_racks).toEqual([]);
    expect(site.rackHoldingsCount).toBe(0);
    expect(site.staged_quantity).toBe(3);
  });

  it('adds NO field to a row with none (most rows), so the rack rows are unchanged', async () => {
    const { svc } = listWith([
      {
        item_id: ON_RACK,
        location_id: 'loc-2c',
        quantity: 5,
        locations: { name: '2-C', kind: 'rack', type: 'shelf' },
      },
    ]);
    const res = await svc.list({ limit: 50 });
    const rack = res.items.find((i) => i.id === ON_RACK)!;
    expect(rack).not.toHaveProperty('other_holdings');
    expect(rack.placed_holdings).toEqual([{ name: '2-C', quantity: 5, kind: 'rack' }]);
    expect(res.items.find((i) => i.id === ON_SITE)).not.toHaveProperty('other_holdings');
  });

  it('two rows for one location add up to one holding', async () => {
    const { svc } = listWith([
      {
        item_id: ON_SITE,
        location_id: 'loc-dc4',
        quantity: 4,
        locations: { name: 'DC4', kind: null, type: 'warehouse' },
      },
      {
        item_id: ON_SITE,
        location_id: 'loc-dc4',
        quantity: 3,
        locations: { name: 'DC4', kind: null, type: 'warehouse' },
      },
    ]);
    const res = await svc.list({ limit: 50 });
    expect(res.items.find((i) => i.id === ON_SITE)!.other_holdings).toEqual([
      { name: 'DC4', quantity: 7, kind: null, type: 'warehouse' },
    ]);
  });

  it('reads the location TYPE with the kind in the one holdings read (a Site and a shelf share a NULL kind)', async () => {
    const { svc, stub } = listWith([]);
    await svc.list({ limit: 50 });
    const selects = (stub.chainArgsAll.get('item_stock_levels.select') ?? []).map(
      (chain) => chain[0]?.[0],
    );
    expect(selects).toContain('item_id, location_id, quantity, locations!inner(name, kind, type)');
  });
});
