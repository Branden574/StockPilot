import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The stock moves of a placement pass audit in ONE batched write.
 *
 * Bulk "Set rack" places every selected item's stock with one transferStock
 * per holding (409 on the lab org), and transferStock audits each move. Those
 * were one `void audit()` INSERT per transfer: up to 20 more requests in flight
 * next to the transfers themselves, and, during a gateway incident, one lost-row
 * report per transfer. The placement pass now collects the rows and writes them
 * through auditMany once, with exactly the rows transferStock writes alone.
 */

const { audit, auditMany } = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({
    written: payloads.length,
    lost: 0,
  })),
}));
vi.mock('./audit', () => ({ audit, auditMany }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: vi.fn() }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-1'],
    writableIds: ['wh-1'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-1',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => 'wh-1'),
  ForbiddenError: class ForbiddenError extends Error {},
}));
vi.spyOn(console, 'error').mockImplementation(() => {});

import { callArgs, inFilters, makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { AuditPayload } from './audit';
import { InventoryService } from './inventory';

const uuid = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));

function inList(call: Parameters<typeof inFilters>[0], column: string): string[] {
  const hit = inFilters(call).find(([c]) => c === column);
  return hit ? (hit[1] as string[]) : [];
}

/** 250 products, each with one Unplaced holding of 2 units in wh-1, and an
 *  existing rack 12-B. */
function stub() {
  return makeSupabaseStub({
    'inventory_items.select': (call) => ({
      data: inList(call, 'id').map((id) => ({
        id,
        warehouse_id: 'wh-1',
        status: 'active',
        item_type: 'product',
        bin_location: null,
      })),
      error: null,
    }),
    'item_stock_levels.select': (call) => {
      // Paged by fetchAllRows: one page of rows, then an empty one.
      const range = callArgs(call, 'range') as [number, number] | undefined;
      if (range && range[0] > 0) return { data: [], error: null };
      return {
        data: inList(call, 'item_id').map((id) => ({
          item_id: id,
          location_id: 'unplaced-1',
          quantity: 2,
          locations: { kind: 'unplaced', type: null, warehouse_id: 'wh-1' },
        })),
        error: null,
      };
    },
    'locations.select': { data: [{ id: 'rack-1', name: '12-B' }], error: null },
    'rpc:inventory_set_rack': { data: 250, error: null },
    'rpc:transfer_stock': { data: null, error: null },
  });
}

function transferRows(): AuditPayload[] {
  return auditMany.mock.calls
    .flatMap(([payloads]) => payloads as AuditPayload[])
    .filter((p) => p.event === 'stock.transferred');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bulk Set rack placement audits', () => {
  it('writes one stock.transferred row per transfer, in one batched call, never one audit() per move', async () => {
    const s = stub();
    const svc = new InventoryService(makeServiceContext(s.client, { role: 'admin' }) as never);

    const res = await svc.bulkUpdate({
      ids: ids(250),
      op: { kind: 'set_rack', rackNumber: '12', rackRow: 'B' },
    } as never);

    expect(res).toMatchObject({ ok: 250, placed: 250 });
    expect(s.rpcCalls.filter((c) => c.name === 'transfer_stock')).toHaveLength(250);
    // No per-transfer INSERT.
    expect(audit).not.toHaveBeenCalled();
    // The label rows, then the placement's transfer rows: two batched calls.
    expect(auditMany).toHaveBeenCalledTimes(2);
    const rows = transferRows();
    expect(rows).toHaveLength(250);
    expect(rows.map((r) => r.entityId).sort()).toEqual(ids(250));
    // Exactly the row transferStock writes on its own.
    expect(rows[0]).toEqual({
      event: 'stock.transferred',
      entityType: 'inventory_item',
      entityId: expect.any(String),
      before: { location_id: 'unplaced-1' },
      after: { location_id: 'rack-1' },
      extra: { quantity: 2, from_location_id: 'unplaced-1', to_location_id: 'rack-1' },
    });
  });

  it('audits only the transfers that happened when some are refused', async () => {
    const s = stub();
    let n = 0;
    const base = s.client.rpc;
    s.client.rpc = (name: string, args: unknown) => {
      if (name === 'transfer_stock') {
        n += 1;
        if (n % 5 === 0)
          return Promise.resolve({ data: null, error: { message: 'insufficient_stock' } });
      }
      return base(name, args);
    };
    const svc = new InventoryService(makeServiceContext(s.client, { role: 'admin' }) as never);

    const res = await svc.bulkUpdate({
      ids: ids(250),
      op: { kind: 'set_rack', rackNumber: '12', rackRow: 'B' },
    } as never);

    expect(res).toMatchObject({ placed: 200, placeFailed: 50 });
    expect(audit).not.toHaveBeenCalled();
    expect(transferRows()).toHaveLength(200);
  });
});

describe('transferStock on its own', () => {
  it('still writes its row through audit() when no batch collects it', async () => {
    const s = stub();
    const svc = new InventoryService(makeServiceContext(s.client, { role: 'admin' }) as never);
    await svc.transferStock({
      itemId: uuid(1),
      fromLocationId: 'loc-a',
      toLocationId: 'loc-b',
      quantity: 3,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(auditMany).not.toHaveBeenCalled();
  });
});
