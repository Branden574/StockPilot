import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A retry key is honoured only for the request it was stored for.
 *
 * post_receipt_v2 answers a key it has seen with the receipt its stored row
 * names (0013 contract: same key and same lines return the earlier receipt).
 * postReceipt uses that answer only when it is a receipt of this purchase
 * order and this warehouse, in this organization, recorded with this key by
 * this person: what a genuine retry of the same request gets back. Any other
 * answer is the existing conflict (409, reason idempotency_conflict, on
 * /api/v1/po/[id]/receipts), with no audit row, outbox event, webhook or cache
 * invalidation for a receipt this request did not post.
 */

const { invalidate, audit, auditMany, publishOutboxEvent, dispatchEvent } = vi.hoisted(() => ({
  invalidate: vi.fn(),
  audit: vi.fn(async () => {}),
  auditMany: vi.fn(async (rows: readonly unknown[]) => ({ written: rows.length, lost: 0 })),
  publishOutboxEvent: vi.fn(async () => {}),
  dispatchEvent: vi.fn(async () => undefined),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: invalidate }));
vi.mock('./audit', () => ({ audit, auditMany }));
vi.mock('./integration-events', () => ({ dispatchEvent }));
vi.mock('@/server/lib/outbox-events', () => ({ publishOutboxEvent }));

import type { PostReceiptInput } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ReceivingService } from './receiving';

const KEY = 'receipt-key-0000-4000-8000-000000000001';

const input: PostReceiptInput = {
  purchaseOrderId: 'po-1',
  warehouseId: 'wh-1',
  idempotencyKey: KEY,
  lines: [{ poLineId: 'pol-1', qtyReceived: 2, qtyAccepted: 2, qtyRejected: 0, unitCost: 1 }],
};

/** The receipt a first post of `input` records (made-up values). */
const ownReceipt = {
  id: 'rcpt-1',
  organization_id: 'org-test',
  purchase_order_id: 'po-1',
  warehouse_id: 'wh-1',
  receipt_number: 'R-001',
  status: 'posted',
  received_by: 'user-test',
  received_at: '2026-11-01T00:00:00Z',
  idempotency_key: KEY,
};

/** The existing conflict sentence; the receipts route tags it idempotency_conflict. */
const CONFLICT =
  'A different receipt was already submitted with this idempotency key. Refresh and try again.';

function serviceAnswering(answer: unknown) {
  const stub = makeSupabaseStub({
    'purchase_orders.select.maybeSingle': { data: { id: 'po-1' }, error: null },
    'purchase_order_items.select': { data: [{ id: 'pol-1', item_id: 'item-1' }], error: null },
    'inventory_items.select': { data: [], error: null },
    'rpc:post_receipt_v2': { data: answer, error: null },
  });
  return new ReceivingService(makeServiceContext(stub.client));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReceivingService.postReceipt: the answer to a retry key', () => {
  it('returns the receipt this key recorded for this purchase order (a genuine retry)', async () => {
    const receipt = await serviceAnswering(ownReceipt).postReceipt(input);
    expect(receipt).toMatchObject({ id: 'rcpt-1', receipt_number: 'R-001' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'stock.receipt.posted', entityId: 'rcpt-1' }),
      expect.anything(),
    );
  });

  const others: Array<[string, unknown]> = [
    ['a receipt of another purchase order', { ...ownReceipt, id: 'rcpt-9', purchase_order_id: 'po-9' }],
    ['a receipt into another warehouse', { ...ownReceipt, id: 'rcpt-9', warehouse_id: 'wh-9' }],
    ['a receipt recorded with another key', { ...ownReceipt, id: 'rcpt-9', idempotency_key: 'other-key-1' }],
    ['a receipt recorded with no key', { ...ownReceipt, id: 'rcpt-9', idempotency_key: null }],
    ['a receipt another person posted', { ...ownReceipt, id: 'rcpt-9', received_by: 'user-other' }],
    ['a receipt of another organization', { ...ownReceipt, id: 'rcpt-9', organization_id: 'org-other' }],
    [
      'no receipt (a row of nulls)',
      {
        id: null,
        organization_id: null,
        purchase_order_id: null,
        warehouse_id: null,
        receipt_number: null,
        received_by: null,
        idempotency_key: null,
      },
    ],
    ['nothing', null],
  ];

  it.each(others)('answers the existing conflict when the answer is %s', async (_label, answer) => {
    await expect(serviceAnswering(answer).postReceipt(input)).rejects.toMatchObject({
      code: 'conflict',
      message: CONFLICT,
    });
    // Nothing is said about a receipt this request did not post.
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'stock.receipt.posted' }),
      expect.anything(),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'idempotency.conflict', entityType: 'receipt' }),
      expect.anything(),
    );
    expect(publishOutboxEvent).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
