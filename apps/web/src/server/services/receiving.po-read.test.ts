import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { ReceivingService } from './receiving';

import type { PostReceiptInput } from '@stockpilot/core';

/**
 * Receiving a purchase order, and reversing a receipt, needs View purchase
 * orders (migration 0423, docket S46: the read revoke binds managers and
 * admins). The database refuses both with po_not_found for someone without
 * it; before the review round the reversal half-applied instead (the stock
 * came back out, the PO line and status stayed). The service now refuses
 * first, in the permission's words, before any database call, and maps the
 * database's own refusal to not_found instead of an internal error.
 */

const post: PostReceiptInput = {
  purchaseOrderId: 'po-1',
  warehouseId: 'wh-1',
  idempotencyKey: 'idem-1',
  lines: [{ poLineId: 'pol-1', qtyReceived: 1, qtyAccepted: 1, qtyRejected: 0, unitCost: 1 }],
};

const MANAGER_WITHOUT_READ = new Set(['stock:adjust', 'purchase_orders:manage']);
const MANAGER_WITH_READ = new Set([
  'stock:adjust',
  'purchase_orders:manage',
  'purchase_orders:read',
]);

function svcWith(stub: ReturnType<typeof makeSupabaseStub>, permissions: ReadonlySet<string>) {
  return new ReceivingService(
    makeServiceContext(stub.client, { role: 'manager', permissions }) as never,
  );
}

describe('ReceivingService: receiving and reversing need purchase_orders:read', () => {
  it('reverseReceipt refuses a manager without it before calling reverse_receipt', async () => {
    const stub = makeSupabaseStub({
      'rpc:reverse_receipt': { data: { id: 'rev-1' }, error: null },
    });

    const err = await svcWith(stub, MANAGER_WITHOUT_READ)
      .reverseReceipt({ receiptId: 'r-1', reason: 'wrong count' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
    expect((err as ServiceError).message).toBe('Missing permission: purchase_orders:read');
    expect(stub.rpcCalls).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('postReceipt refuses a manager without it before any read or call', async () => {
    const stub = makeSupabaseStub({ 'rpc:post_receipt_v2': { data: { id: 'r-1' }, error: null } });

    const err = await svcWith(stub, MANAGER_WITHOUT_READ)
      .postReceipt(post)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
    expect((err as ServiceError).message).toBe('Missing permission: purchase_orders:read');
    expect(stub.rpcCalls).toEqual([]);
    expect(stub.fromCalls).toEqual([]);
  });

  it.each(['po_not_found', 'po_line_not_found'])(
    "reverseReceipt reports the database's %s as not found, not an internal error",
    async (message) => {
      const stub = makeSupabaseStub({
        'rpc:reverse_receipt': { data: null, error: { message, code: 'P0002' } },
      });

      const err = await svcWith(stub, MANAGER_WITH_READ)
        .reverseReceipt({ receiptId: 'r-1', reason: 'wrong count' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('not_found');
      expect((err as ServiceError).message).toBe('PO or line not found.');
    },
  );

  it('a manager with it still reverses through reverse_receipt', async () => {
    const stub = makeSupabaseStub({
      'rpc:reverse_receipt': { data: { id: 'rev-1', warehouse_id: 'wh-1' }, error: null },
    });

    const res = await svcWith(stub, MANAGER_WITH_READ).reverseReceipt({
      receiptId: 'r-1',
      reason: 'wrong count',
    });

    expect(res).toMatchObject({ id: 'rev-1' });
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['reverse_receipt']);
  });
});
