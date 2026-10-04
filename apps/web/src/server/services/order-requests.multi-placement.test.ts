import { describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// Fulfillment RPCs are the only source of truth for the stock decrement;
// the service layer never re-resolves the placement. Warehouse access is
// enforced elsewhere (lib/auth/warehouse) and is out of scope here — stub
// it to a no-op so these tests isolate the placement-binding logic.
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));

import { OrderRequestsService } from './order-requests';

/**
 * Model B — task 7 (verify-and-pin): order fulfillment must draw from the
 * SPECIFIC placement (a charter/rack-scoped `inventory_items` row) the
 * order line points at, never an arbitrary same-SKU sibling.
 *
 * Investigation finding: under the current (non-destructive, "grouped")
 * Model B design, a placement IS its own `inventory_items` row — same SKU,
 * different charter/rack, each with its own `quantity_on_hand`. Every step
 * of the fulfillment path is keyed by that row's `id`, never by `sku`:
 *   - create()            sends `lines[].item_id = line.itemId` verbatim to
 *                          place_order_request (0391), which hands them to
 *                          create_order_request (0365), whose line trigger
 *                          stamps unit_cost_at_request from THAT item row.
 *   - recordPickedLine()   forwards {p_line_id, p_qty} to partial_pick_line;
 *                          no item/sku argument at all.
 *   - completePicking()    forwards {p_order_id} to complete_picking, which
 *                          (0121) loops order_request_lines by item_id and
 *                          calls adjust_stock(item_id, ...) — a `WHERE id =
 *                          p_item_id` update, structurally incapable of
 *                          touching a sibling row.
 * So there is no SKU-based resolution anywhere in this path today. These
 * tests pin that: two same-SKU placements never get their identities or
 * quantities swapped/collapsed when an order references one of them.
 */

const NORTH_ITEM = {
  id: 'bbbbbbbb-0000-4000-8000-00000000000a',
  warehouse_id: 'wh-1',
  unit_cost: 100,
  // Not selected by create()'s query, but documents the fixture: both rows
  // below are the SAME product (SKU), placed at different charters/racks.
  sku: 'SP-CHROME-05H',
};
const SOUTH_ITEM = {
  id: 'bbbbbbbb-0000-4000-8000-00000000000b',
  warehouse_id: 'wh-1',
  unit_cost: 120,
  sku: 'SP-CHROME-05H',
};

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (
    ctx: unknown,
  ) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'admin',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

describe('OrderRequestsService — multi-placement SKU fulfillment (Model B, verify-and-pin)', () => {
  it('create() binds EACH line to its own placement (item_id), never a same-SKU sibling', async () => {
    // Two placements of the same SKU are two inventory_items rows; the body
    // names each by its id, and the service passes the ids through verbatim
    // (place_order_request sums lines of one item id, never of one SKU).
    const stub = makeSupabaseStub({
      'rpc:place_order_request': { data: { outcome: 'withdrawn' }, error: null },
    });

    await svc(stub)
      .create({
        body: {
          idempotencyKey: 'eeeeeeee-0000-4000-8000-000000000001',
          placerUserId: 'dddddddd-0000-4000-8000-000000000001',
          warehouseId: 'aaaaaaaa-0000-4000-8000-000000000001',
          fulfillmentType: 'pickup',
          deliveryCharterId: null,
          onBehalfOf: null,
          notes: null,
          neededByLocal: null,
          lines: [
            { itemId: SOUTH_ITEM.id, quantity: 10 },
            { itemId: NORTH_ITEM.id, quantity: 3 },
          ],
        },
        surface: 'web',
      })
      .catch(() => undefined);

    type LinePayload = Record<string, unknown> & { item_id: string; quantity: number };
    const call = stub.rpcCalls.find((c) => c.name === 'place_order_request');
    const payload = (call?.args as { p_request?: { lines?: LinePayload[] } } | undefined)?.p_request?.lines;
    expect(payload).toEqual([
      { item_id: SOUTH_ITEM.id, quantity: 10 },
      { item_id: NORTH_ITEM.id, quantity: 3 },
    ]);
    // The cost is the line trigger's to stamp from each line's own item row;
    // the client sends none, so it cannot hand one placement the other's cost.
    for (const line of payload ?? []) expect(line).not.toHaveProperty('unit_cost_at_request');
  });

  it('recordPickedLine() forwards {p_line_id, p_qty} only — no item/SKU resolution in JS', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      // The line-belongs-to-order verification finds the line on this order.
      'order_request_lines.select.maybeSingle': { data: { id: 'line-1' }, error: null },
      'rpc:partial_pick_line': {
        data: { id: 'line-1', quantity_picked: 5 },
        error: null,
      },
    });

    await svc(stub).recordPickedLine('order-1', 'line-1', 5);

    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.rpcCalls[0]).toEqual({
      name: 'partial_pick_line',
      args: { p_line_id: 'line-1', p_qty: 5 },
    });
  });

  it('SECURITY: recordPickedLine() rejects a lineId that is not on the gated order (no RPC call)', async () => {
    // The caller passes an orderId they CAN write to, but a lineId that belongs
    // to a DIFFERENT order (e.g. another warehouse's order in the same org).
    // The line-belongs-to-order lookup returns nothing → not_found, and the
    // partial_pick_line RPC (which only checks org role, not that the line is on
    // this order) is NEVER reached.
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'order_request_lines.select.maybeSingle': { data: null, error: null },
      'rpc:partial_pick_line': { data: { id: 'foreign-line' }, error: null },
    });

    const err = await svc(stub)
      .recordPickedLine('order-1', 'foreign-line-from-another-order', 3)
      .catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('not_found');
    expect(stub.rpcCalls).toHaveLength(0); // the RPC must not run on a foreign line
  });

  it('completePicking() forwards {p_order_id} only — the SQL RPC owns the per-line decrement, not JS', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'rpc:complete_picking': {
        data: { id: 'order-1', status: 'picking_complete' },
        error: null,
      },
    });

    await svc(stub).completePicking('order-1');

    // The service must delegate ENTIRELY to the RPC by order id. It must
    // NOT pass (or independently resolve) any item_id/sku of its own —
    // that would reopen the "arbitrary same-SKU row" ambiguity the RPC's
    // per-line item_id FK is designed to prevent (0111/0118/0121:
    // complete_picking loops order_request_lines by item_id and calls
    // adjust_stock(item_id, ...), a primary-key-scoped update).
    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.rpcCalls[0]).toEqual({
      name: 'complete_picking',
      args: { p_order_id: 'order-1' },
    });
  });
});
