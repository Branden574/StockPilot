import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';
import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import { LotsService } from './lots';

const withLotSerial = () => new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'lot_serial']);

describe('LotsService module gate', () => {
  it('throws module_disabled when lot_serial is not enabled', async () => {
    const stub = makeSupabaseStub({});
    const svc = new LotsService(makeServiceContext(stub.client)); // default: no lot_serial
    await expect(svc.getAgingInventory()).rejects.toMatchObject({ code: 'module_disabled' });
    await expect(svc.traceLot('LOT-1')).rejects.toMatchObject({ code: 'module_disabled' });
    await expect(svc.getFefoSuggestion('item-1')).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('LotsService.getAgingInventory', () => {
  it('nets recorded picks out of received qty and buckets by expiry', async () => {
    const stub = makeSupabaseStub({
      'receipt_line_lots.select': {
        data: [
          {
            lot_number: 'A', expiration_date: '2000-01-01', qty_base: 10, created_at: '2026-05-01T00:00:00Z',
            receipt_lines: { item_id: 'item-1', receipts: { organization_id: 'org-test' },
              inventory_items: { name: 'Milk', sku: 'MILK', shelf_life_days: null } },
          },
          {
            lot_number: 'B', expiration_date: '2099-01-01', qty_base: 5, created_at: '2026-05-01T00:00:00Z',
            receipt_lines: { item_id: 'item-1', receipts: { organization_id: 'org-test' },
              inventory_items: { name: 'Milk', sku: 'MILK', shelf_life_days: null } },
          },
        ],
        error: null,
      },
      'lot_pick_events.select': {
        data: [{ item_id: 'item-1', lot_number: 'A', qty: 4 }],
        error: null,
      },
    });
    const svc = new LotsService(makeServiceContext(stub.client, { enabledModules: withLotSerial() }));
    const rows = await svc.getAgingInventory();
    const a = rows.find((r) => r.lotNumber === 'A');
    const b = rows.find((r) => r.lotNumber === 'B');
    expect(a?.remaining).toBe(6); // 10 received - 4 picked
    expect(a?.bucket).toBe('expired');
    expect(b?.remaining).toBe(5);
    expect(b?.bucket).toBe('ok');
    // FEFO order: expired 'A' before ok 'B'
    expect(rows.map((r) => r.lotNumber)).toEqual(['A', 'B']);
  });

  it('drops fully-consumed lots (remaining <= 0)', async () => {
    const stub = makeSupabaseStub({
      'receipt_line_lots.select': {
        data: [{
          lot_number: 'A', expiration_date: '2099-01-01', qty_base: 4, created_at: '2026-05-01T00:00:00Z',
          receipt_lines: { item_id: 'item-1', receipts: { organization_id: 'org-test' },
            inventory_items: { name: 'X', sku: 'X', shelf_life_days: null } },
        }],
        error: null,
      },
      'lot_pick_events.select': { data: [{ item_id: 'item-1', lot_number: 'A', qty: 4 }], error: null },
    });
    const svc = new LotsService(makeServiceContext(stub.client, { enabledModules: withLotSerial() }));
    expect(await svc.getAgingInventory()).toEqual([]);
  });
});

describe('LotsService.recordLotPicks', () => {
  it('blocks an expired-lot pick when the item expiry_policy is "block"', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { expiry_policy: 'block', shelf_life_days: null }, error: null },
    });
    const svc = new LotsService(makeServiceContext(stub.client, { enabledModules: withLotSerial() }));
    await expect(
      svc.recordLotPicks({
        orderRequestId: 'o1', orderRequestLineId: 'l1', itemId: 'item-1',
        picks: [{ lotNumber: 'A', qty: 1, expirationDate: '2000-01-01' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('inserts pick events when policy allows (warn)', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: { expiry_policy: 'warn', shelf_life_days: null }, error: null },
      'lot_pick_events.insert': { data: null, error: null },
    });
    const svc = new LotsService(makeServiceContext(stub.client, { enabledModules: withLotSerial() }));
    await svc.recordLotPicks({
      orderRequestId: 'o1', orderRequestLineId: 'l1', itemId: 'item-1',
      picks: [{ lotNumber: 'A', qty: 2, expirationDate: '2000-01-01' }],
    });
    expect(stub.fromCalls).toContain('lot_pick_events');
  });
});
