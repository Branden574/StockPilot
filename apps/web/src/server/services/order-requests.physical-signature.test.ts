import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * L91: the paper (physical) signature path sent the partly-fulfilled and the
 * backorder-shipped notices without the order number they accept, so they
 * named the order "#XXXXXXXX" while the app names it SO-000049. Both now get
 * it, as on the digital sign route.
 */

const notify = vi.hoisted(() => ({
  backordered: vi.fn(async (_a: Record<string, unknown>) => undefined),
  shipped: vi.fn(async (_a: Record<string, unknown>) => undefined),
}));
vi.mock('@/server/lib/order-handover-notify', () => ({
  notifyRequesterBackordered: (a: Record<string, unknown>) => notify.backordered(a),
  notifyRequesterBackorderShipped: (a: Record<string, unknown>) => notify.shipped(a),
  sendPartialReceiptEmail: vi.fn(async () => undefined),
  fetchOrderLineItems: vi.fn(async () => []),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/server/email/return-prompt', () => ({ maybeSendReturnPrompt: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeSupabaseStub().client }));
vi.mock('./lib/defer', () => ({ defer: vi.fn() }));

import { OrderRequestsService } from './order-requests';

function service(row: Record<string, unknown>, lines: { prior: number; requested: number; fulfilled: number }) {
  let lineReads = 0;
  const stub = makeSupabaseStub({
    'order_request_lines.select': () => {
      lineReads += 1;
      return lineReads === 1
        ? { data: [{ quantity_fulfilled: lines.prior }], error: null }
        : {
            data: [{ quantity_requested: lines.requested, quantity_fulfilled: lines.fulfilled }],
            error: null,
          };
    },
    'rpc:confirm_physical_signature': { data: row, error: null },
  });
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'manager',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

const ROW = {
  id: 'ord-1',
  requester_user_id: null,
  requester_email: null,
  requester_name: 'Pat',
};

beforeEach(() => vi.clearAllMocks());

describe('confirmPhysicalSignature: hand-over notices name the order by its number (L91)', () => {
  it('a partial hand-over tells the requester about SO-000049', async () => {
    await service({ ...ROW, status: 'backordered', order_number: 49 }, { prior: 0, requested: 5, fulfilled: 2 })
      .confirmPhysicalSignature('ord-1', 'Pat');

    expect(notify.backordered).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'SO-000049' }),
    );
  });

  it('a backorder remainder handed over tells the requester about SO-000049', async () => {
    await service({ ...ROW, status: 'completed', order_number: 49 }, { prior: 2, requested: 5, fulfilled: 5 })
      .confirmPhysicalSignature('ord-1', 'Pat');

    expect(notify.shipped).toHaveBeenCalledWith(expect.objectContaining({ orderNumber: 'SO-000049' }));
  });

  it('an order without a number passes none (the notice falls back to the short id)', async () => {
    await service({ ...ROW, status: 'backordered', order_number: null }, { prior: 0, requested: 5, fulfilled: 2 })
      .confirmPhysicalSignature('ord-1', 'Pat');

    expect(notify.backordered).toHaveBeenCalledWith(expect.objectContaining({ orderNumber: null }));
  });
});
