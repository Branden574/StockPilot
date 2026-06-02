import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { hashReceiptRequest, ReceivingService } from './receiving';

import type { PostReceiptInput } from '@stockpilot/core';

// A minimal posted-receipt row the RPC returns.
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
      qtyReceived: 5,
      qtyAccepted: 5,
      qtyRejected: 0,
      unitCost: 2,
      lots: [{ lotNumber: 'L1', expirationDate: '2026-07-01', qtyBase: 5 }],
    },
  ],
};

describe('ReceivingService.postReceipt — lots/serials forwarding', () => {
  it('maps per-line lots to snake_case in the post_receipt_v2 RPC', async () => {
    const stub = makeSupabaseStub({
      'rpc:post_receipt_v2': { data: receiptRow, error: null },
      // follow-on selects inside maybeAutoUnarchive — return empty so it's a no-op
      'purchase_order_items.select': { data: [], error: null },
      'inventory_items.select': { data: [], error: null },
    });
    const svc = new ReceivingService(makeServiceContext(stub.client));

    const receipt = await svc.postReceipt(baseInput);
    expect(receipt.id).toBe('rcpt-1');

    const call = stub.rpcCalls.find((c) => c.name === 'post_receipt_v2');
    expect(call).toBeDefined();
    const args = call!.args as { p_lines: Array<{ lots: unknown; serials: unknown }> };
    expect(args.p_lines[0]?.lots).toEqual([
      { lot_number: 'L1', expiration_date: '2026-07-01', qty_base: 5 },
    ]);
  });
});

describe('hashReceiptRequest', () => {
  it('reflects lots/serials in the idempotency payload hash', () => {
    const withoutLots: PostReceiptInput = {
      ...baseInput,
      lines: [{ ...baseInput.lines[0]!, lots: [], serials: [] }],
    };
    expect(hashReceiptRequest(baseInput)).not.toBe(hashReceiptRequest(withoutLots));
  });
});
