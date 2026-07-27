import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { ReceivingService } from './receiving';

import type { PostReceiptInput } from '@stockpilot/core';

/**
 * Error mapping for the post_receipt_v2 sixth rewrite (migrations 0295/0296).
 *
 * Anything the RPC raises that postReceipt does not explicitly match falls
 * through to `new ServiceError('internal_error', ...)`, which the API layer
 * masks as "An internal error occurred." That is the exact failure mode
 * migration 0285's header calls out — warehouse staff saw a generic error and
 * had no idea what to fix. These tests pin the two codes the new
 * 'serial_optional' branch makes reachable, and re-pin the pre-existing serial
 * mapping so widening the enum cannot quietly change it.
 */

const receiptRow = {
  id: 'rcpt-1',
  organization_id: 'org-test',
  purchase_order_id: 'po-1',
  warehouse_id: 'wh-1',
  receipt_number: 'R-001',
  status: 'posted',
  reversed_receipt_id: null,
  reversal_reason: null,
  notes: null,
  received_by: 'user-test',
  received_at: '2026-06-01T00:00:00Z',
  idempotency_key: 'idem-1',
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
};

const baseInput: PostReceiptInput = {
  purchaseOrderId: 'po-1',
  warehouseId: 'wh-1',
  idempotencyKey: 'idem-1',
  lines: [
    {
      poLineId: 'pol-1',
      qtyReceived: 4,
      qtyAccepted: 4,
      qtyRejected: 0,
      unitCost: 2,
      serials: ['OPT-1', 'OPT-2'],
    },
  ],
};

function serviceWithRpcError(error: { message: string; code?: string }) {
  const stub = makeSupabaseStub({
    'rpc:post_receipt_v2': { data: null, error },
    'purchase_order_items.select': { data: [], error: null },
    'inventory_items.select': { data: [], error: null },
  });
  return new ReceivingService(makeServiceContext(stub.client));
}

describe('ReceivingService.postReceipt — serial_optional error mapping', () => {
  it('maps serial_count_exceeds_quantity to an actionable validation_error', async () => {
    const svc = serviceWithRpcError({
      message: 'serial_count_exceeds_quantity',
      code: '23514',
    });

    const err = await svc.postReceipt(baseInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    const se = err as ServiceError;
    expect(se.code).toBe('validation_error');
    expect(se.message).toContain('More serial numbers were entered than units accepted');
    // It must NOT be swallowed by the exact-count arm, whose copy would tell
    // the user to enter one serial per unit — the opposite of the fix.
    expect(se.message).not.toContain('exactly one serial number per accepted unit');
  });

  it('maps a serial_registry unique violation (23505) to a conflict', async () => {
    const svc = serviceWithRpcError({
      message:
        'duplicate key value violates unique constraint "serial_registry_organization_id_item_id_serial_number_key"',
      code: '23505',
    });

    const err = await svc.postReceipt(baseInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    const se = err as ServiceError;
    expect(se.code).toBe('conflict');
    expect(se.message).toContain('already registered for this item');
  });

  it('leaves an unrelated 23505 as internal_error (the guard is scoped)', async () => {
    // Anti-vacuity for the test above: the mapping keys on BOTH the errcode and
    // the constraint text, so a different unique violation must not be
    // mislabelled "That serial number is already registered".
    const svc = serviceWithRpcError({
      message: 'duplicate key value violates unique constraint "receipts_idempotency_key_key"',
      code: '23505',
    });

    const err = await svc.postReceipt(baseInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('internal_error');
  });

  it('REGRESSION: serials_required still maps to the exact-count message', async () => {
    const svc = serviceWithRpcError({ message: 'serials_required', code: '23514' });

    const err = await svc.postReceipt(baseInput).catch((e: unknown) => e);
    const se = err as ServiceError;
    expect(se.code).toBe('validation_error');
    expect(se.message).toContain('exactly one serial number per accepted unit');
  });

  it('REGRESSION: serial_count_mismatch still maps to the exact-count message', async () => {
    const svc = serviceWithRpcError({ message: 'serial_count_mismatch', code: '23514' });

    const err = await svc.postReceipt(baseInput).catch((e: unknown) => e);
    const se = err as ServiceError;
    expect(se.code).toBe('validation_error');
    expect(se.message).toContain('exactly one serial number per accepted unit');
  });

  it('forwards a partial serials array to the RPC unchanged', async () => {
    // The whole point of the 0296 branch: 2 serials against 4 accepted units is
    // a legitimate payload and must reach the RPC verbatim, not be padded.
    const stub = makeSupabaseStub({
      'rpc:post_receipt_v2': { data: receiptRow, error: null },
      'purchase_order_items.select': { data: [], error: null },
      'inventory_items.select': { data: [], error: null },
    });
    const svc = new ReceivingService(makeServiceContext(stub.client));

    await svc.postReceipt(baseInput);

    const call = stub.rpcCalls.find((c) => c.name === 'post_receipt_v2');
    const args = call!.args as { p_lines: { qty_accepted: number; serials: unknown }[] };
    expect(args.p_lines[0]?.serials).toEqual(['OPT-1', 'OPT-2']);
    expect(args.p_lines[0]?.qty_accepted).toBe(4);
  });
});
