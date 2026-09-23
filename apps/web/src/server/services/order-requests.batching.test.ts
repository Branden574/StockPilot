import { describe, expect, it, vi } from 'vitest';

/**
 * Order line validation and the order list's name lookup batch their ids.
 *
 * An order's lines have no cap and a list with no `limit` carries every
 * order. One `.in()` past ~215 uuids answers 414 locally and fails as "fetch
 * failed" in production after ~7 s of retries. The item read validates the
 * lines, so a failed batch throws and nothing is written.
 */

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
const adminHandle = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHandle.client }));

import type { ModuleId } from '@stockpilot/core';

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  adminHandle.client = stub.client;
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'admin',
      userId: 'approver-1',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

function idsIn(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}

const OPEN_HEADER = {
  id: 'order-1',
  status: 'approved',
  warehouse_id: 'wh-1',
  requester_user_id: 'requester-1',
  pick_slip_generated_at: null,
  order_number: 12,
};

describe('OrderRequestsService.addLines with 250 new lines', () => {
  const lines = Array.from({ length: 250 }, (_, i) => ({ itemId: uuid(i), quantity: 1 }));

  it('validates the items in batches of at most 100 and adds every line', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'order_requests.select': { data: OPEN_HEADER, error: null },
      'inventory_items.select': (call) => {
        const list = idsIn(call, 'id');
        lists.push(list);
        return {
          data: list.map((id) => ({
            id,
            name: id,
            warehouse_id: 'wh-1',
            unit_cost: 1,
            awaiting_first_receipt: false,
          })),
          error: null,
        };
      },
      'order_request_lines.select': { data: [], error: null },
      'order_request_lines.insert': { data: null, error: null },
    });
    const res = await svc(stub).addLines('order-1', lines);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(res.added).toBe(250);
  });

  it('throws internal_error and writes nothing when an item batch fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'order_requests.select': { data: OPEN_HEADER, error: null },
      'inventory_items.select': () => {
        n += 1;
        return n === 2
          ? { data: null, error: { message: 'fetch failed' } }
          : { data: [], error: null };
      },
      'order_request_lines.select': { data: [], error: null },
    });
    await expect(svc(stub).addLines('order-1', lines)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(stub.chainsAll.get('order_request_lines.insert')).toBeUndefined();
  });
});

describe('OrderRequestsService.list picker and driver names', () => {
  it('resolves 300 distinct pickers and drivers in batches of at most 100', async () => {
    const orders = Array.from({ length: 150 }, (_, i) => ({
      id: `o-${i}`,
      order_number: i,
      status: 'approved',
      assigned_picker_id: uuid(i, 'a'),
      assigned_delivery_user_id: uuid(i, 'b'),
      lines: [],
    }));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'order_requests.select': { data: orders, error: null },
      'user_profiles.select': (call) => {
        const list = idsIn(call, 'id');
        lists.push(list);
        return {
          data: list.map((id) => ({ id, full_name: `Name ${id.slice(0, 1)}`, email: null })),
          error: null,
        };
      },
    });
    const rows = await svc(stub).list();
    expect(lists.map((l) => l.length)).toEqual([100, 100, 100]);
    expect(rows).toHaveLength(150);
    const last = rows.at(-1) as unknown as Record<string, unknown>;
    expect(JSON.stringify(last)).toContain('Name b');
  });
});
