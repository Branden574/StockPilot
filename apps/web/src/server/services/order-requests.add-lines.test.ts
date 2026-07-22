import { describe, expect, it, vi } from 'vitest';

import type { ModuleId, Role } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { OrderRequestsService } from './order-requests';

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

// Line UPDATE/DELETE are RLS-forbidden for end users by design (mig 0049), so
// the service performs them through the service role. The stub is a fake DB —
// routing both handles to the same one keeps every chain assertion below
// meaningful while exercising the real code path.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminHandle.client,
}));
const adminHandle: { client: unknown } = { client: null };

// Adding items to an EXISTING order (owner request 2026-07-22). The rules that
// matter: allowed any time BEFORE the order ships, only for the requester or an
// approver, never for an unreceived (expected) item, and topping up an item
// already on the order must increment it rather than duplicate the line.

const ITEM = {
  id: 'item-1',
  name: 'Widget',
  warehouse_id: 'wh-1',
  unit_cost: 5,
  awaiting_first_receipt: false,
};

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  opts: { role?: Role; userId?: string } = {},
) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    (adminHandle.client = stub.client,
    makeServiceContext(stub.client, {
      role: opts.role ?? 'admin',
      userId: opts.userId ?? 'approver-1',
      enabledModules: new Set<ModuleId>(['orders']),
    })),
  );
}

/** Header + item lookup + existing-lines lookup, in the order addLines reads them. */
function stubFor(
  header: Record<string, unknown>,
  existingLines: Array<Record<string, unknown>> = [],
) {
  return makeSupabaseStub({
    'order_requests.select': { data: header, error: null },
    'inventory_items.select': { data: [ITEM], error: null },
    'order_request_lines.select': { data: existingLines, error: null },
    'order_request_lines.insert': { data: null, error: null },
    'order_request_lines.update': { data: { id: 'line-1' }, error: null },
  });
}

const OPEN_HEADER = {
  id: 'order-1',
  status: 'approved',
  warehouse_id: 'wh-1',
  requester_user_id: 'requester-1',
  pick_slip_generated_at: null,
  order_number: 12,
};

describe('OrderRequestsService.addLines', () => {
  it('adds a new line to an open order', async () => {
    const stub = stubFor(OPEN_HEADER);
    const res = await svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 3 }]);
    expect(res.added).toBe(1);
    expect(res.merged).toBe(0);
    expect(res.pickSlipStale).toBe(false);
  });

  it('TOPS UP an item already on the order instead of duplicating the line', async () => {
    const stub = stubFor(OPEN_HEADER, [
      { id: 'line-1', item_id: 'item-1', quantity_requested: 4 },
    ]);
    const res = await svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 6 }]);
    expect(res.merged).toBe(1);
    expect(res.added).toBe(0);
  });

  it('flags the printed pick slip as stale when one already exists', async () => {
    const stub = stubFor({ ...OPEN_HEADER, pick_slip_generated_at: '2026-07-22T10:00:00Z' });
    const res = await svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]);
    expect(res.pickSlipStale).toBe(true);
  });

  it('still allows additions DURING picking / staging (owner: any time before it ships)', async () => {
    for (const status of ['pick_slip_generated', 'picking_in_progress', 'staged_for_delivery']) {
      const stub = stubFor({ ...OPEN_HEADER, status });
      const res = await svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]);
      expect(res.added + res.merged).toBe(1);
    }
  });

  it('REFUSES once the order has shipped or closed', async () => {
    for (const status of ['in_transit', 'completed', 'cancelled', 'denied']) {
      const stub = stubFor({ ...OPEN_HEADER, status });
      await expect(
        svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]),
      ).rejects.toMatchObject({ code: 'conflict' });
    }
  });

  it('lets the REQUESTER add to their own order without approve permission', async () => {
    const stub = stubFor(OPEN_HEADER);
    const res = await svc(stub, { role: 'staff', userId: 'requester-1' }).addLines('order-1', [
      { itemId: 'item-1', quantity: 2 },
    ]);
    expect(res.added).toBe(1);
  });

  it("REFUSES a non-requester who cannot approve orders", async () => {
    const stub = stubFor(OPEN_HEADER);
    await expect(
      svc(stub, { role: 'staff', userId: 'someone-else' }).addLines('order-1', [
        { itemId: 'item-1', quantity: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('REFUSES an item that has never been received (expected phantom)', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': { data: OPEN_HEADER, error: null },
      'inventory_items.select': {
        data: [{ ...ITEM, awaiting_first_receipt: true }],
        error: null,
      },
      'order_request_lines.select': { data: [], error: null },
    });
    await expect(
      svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 1 }]),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('rejects a zero/negative quantity and an empty payload', async () => {
    const stub = stubFor(OPEN_HEADER);
    await expect(
      svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 0 }]),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(svc(stub).addLines('order-1', [])).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});

// ---------------------------------------------------------------------------
// REGRESSION (shipped and caught the same day, 2026-07-22).
//
// Topping up an item already on the order UPDATEs its quantity_requested. RLS
// policy order_request_lines_no_update (mig 0049, USING false) forbids that
// through the end-user client, and PostgREST reports zero affected rows with
// NO error — so the service counted the line as `merged` and told the user the
// add succeeded while the order was unchanged. The write now goes through the
// service role and is verified.
// ---------------------------------------------------------------------------
describe('addLines top-up fails CLOSED when the write affects no row', () => {
  it('never reports a merge that did not happen', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': {
        data: {
          id: 'order-1',
          status: 'approved',
          warehouse_id: 'wh-1',
          requester_user_id: 'requester-1',
          pick_slip_generated_at: null,
          order_number: 12,
        },
        error: null,
      },
      'inventory_items.select': {
        data: [
          {
            id: 'item-1',
            name: 'Widget',
            warehouse_id: 'wh-1',
            unit_cost: 2,
            awaiting_first_receipt: false,
          },
        ],
        error: null,
      },
      // The item is ALREADY on the order, so this takes the merge branch.
      'order_request_lines.select': {
        data: [{ id: 'line-1', item_id: 'item-1', quantity_requested: 4 }],
        error: null,
      },
      // Zero rows affected, no error — exactly what RLS produced in production.
      'order_request_lines.update': { data: null, error: null },
    });

    await expect(
      svc(stub).addLines('order-1', [{ itemId: 'item-1', quantity: 3 }]),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
