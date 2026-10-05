import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { hashReceiptRequest, ReceivingService } from './receiving';

import type { PostReceiptInput } from '@stockpilot/core';

/**
 * L27: post_receipt_v2 takes each line's item lock in the order the lines
 * arrive, so two receipts naming the same items in opposite orders could wait
 * on each other. postReceipt now hands the RPC its lines sorted by item, then
 * by PO line, so every receipt takes its locks in one order. The idempotency
 * hash already sorted its own copy, so it is unchanged.
 */

const input: PostReceiptInput = {
  purchaseOrderId: 'po-1',
  warehouseId: 'wh-1',
  idempotencyKey: 'idem-1',
  lines: [
    { poLineId: 'pol-1', qtyReceived: 1, qtyAccepted: 1, qtyRejected: 0, unitCost: 1 },
    { poLineId: 'pol-2', qtyReceived: 2, qtyAccepted: 2, qtyRejected: 0, unitCost: 1 },
    { poLineId: 'pol-3', qtyReceived: 3, qtyAccepted: 3, qtyRejected: 0, unitCost: 1 },
    { poLineId: 'pol-4', qtyReceived: 4, qtyAccepted: 4, qtyRejected: 0, unitCost: 1 },
  ],
};

const PO_LINES = [
  { id: 'pol-1', purchase_order_id: 'po-1', item_id: 'item-c' },
  { id: 'pol-2', purchase_order_id: 'po-1', item_id: 'item-a' },
  { id: 'pol-3', purchase_order_id: 'po-1', item_id: 'item-b' },
  { id: 'pol-4', purchase_order_id: 'po-1', item_id: 'item-a' },
];

function stubWith(poLines: unknown) {
  return makeSupabaseStub({
    'purchase_order_items.select': poLines as never,
    'rpc:post_receipt_v2': {
      data: { id: 'r-1', warehouse_id: 'wh-1', purchase_order_id: 'po-1' },
      error: null,
    },
    'inventory_items.select': { data: [], error: null },
  });
}

describe('ReceivingService.postReceipt — lines in item order (L27)', () => {
  it('sends the lines sorted by item id, then PO line id', async () => {
    const stub = stubWith(servedLikePostgrest(PO_LINES));
    await new ReceivingService(makeServiceContext(stub.client)).postReceipt(input);

    const call = stub.rpcCalls.find((c) => c.name === 'post_receipt_v2');
    const sent = (call?.args as { p_lines: Array<{ po_line_id: string }> }).p_lines;
    expect(sent.map((l) => l.po_line_id)).toEqual(['pol-2', 'pol-4', 'pol-3', 'pol-1']);
  });

  it('keeps the request hash the caller would compute from the original order', async () => {
    const stub = stubWith(servedLikePostgrest(PO_LINES));
    await new ReceivingService(makeServiceContext(stub.client)).postReceipt(input);

    const call = stub.rpcCalls.find((c) => c.name === 'post_receipt_v2');
    expect((call?.args as { p_request_hash: string }).p_request_hash).toBe(
      hashReceiptRequest(input),
    );
  });

  it('still posts, in PO line order, when the item lookup fails', async () => {
    const stub = stubWith({ data: null, error: { message: 'boom' } });
    await new ReceivingService(makeServiceContext(stub.client)).postReceipt({
      ...input,
      lines: [...input.lines].reverse(),
    });

    const call = stub.rpcCalls.find((c) => c.name === 'post_receipt_v2');
    const sent = (call?.args as { p_lines: Array<{ po_line_id: string }> }).p_lines;
    expect(sent.map((l) => l.po_line_id)).toEqual(['pol-1', 'pol-2', 'pol-3', 'pol-4']);
  });
});
