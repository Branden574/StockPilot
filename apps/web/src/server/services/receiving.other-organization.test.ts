// Security invariant (S39, listed in scripts/security-test.sh): a write named by
// a row id never runs on a row of another organization.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));

import type { PostReceiptInput } from '@stockpilot/core';

import { audit } from './audit';
import { dispatchEvent } from './integration-events';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';
import { ReceivingService } from './receiving';

/**
 * S39: a purchase order or receipt of organization B, received or reversed
 * from a page left open after the person switched to organization A.
 * post_receipt_v2 and reverse_receipt decide on the PO's and the receipt's own
 * organization, so the stock moved in B while this service wrote the audit
 * row, the receipt.posted outbox row, the po.received webhook and the cache
 * invalidation into A (and A's QuickBooks acknowledged an event it could not
 * find, so B's never made the Bill). The PO or receipt is now read in A
 * first; a miss refuses before the function.
 */

const PO_ID = 'po-b-1';
const RECEIPT_ID = 'rcpt-b-1';

const input: PostReceiptInput = {
  purchaseOrderId: PO_ID,
  warehouseId: 'wh-b',
  idempotencyKey: 'idem-1',
  lines: [{ poLineId: 'pol-1', qtyReceived: 2, qtyAccepted: 2, qtyRejected: 0, unitCost: 1 }],
};

function stubFor() {
  return makeSupabaseStub({
    'purchase_orders.select': servedLikePostgrest([{ id: PO_ID, organization_id: 'org-B' }]),
    'receipts.select': servedLikePostgrest([{ id: RECEIPT_ID, organization_id: 'org-B' }]),
    'purchase_order_items.select': { data: [], error: null },
    'inventory_items.select': { data: [], error: null },
    'rpc:post_receipt_v2': {
      data: {
        id: 'rcpt-new',
        warehouse_id: 'wh-b',
        purchase_order_id: PO_ID,
        receipt_number: 'RCV-000001',
      },
      error: null,
    },
    'rpc:reverse_receipt': {
      data: {
        id: 'rcpt-reversal',
        warehouse_id: 'wh-b',
        purchase_order_id: PO_ID,
        receipt_number: 'RCV-000002',
      },
      error: null,
    },
    'rpc:publish_outbox': { data: null, error: null },
  });
}

function svc(stub: ReturnType<typeof makeSupabaseStub>, org: string) {
  return new ReceivingService(
    makeServiceContext(stub.client, { organizationId: org, role: 'manager' }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('postReceipt: a purchase order of another organization is not found', () => {
  it('receiving on a PO that is not in A runs nothing and records nothing', async () => {
    const stub = stubFor();

    await expect(svc(stub, 'org-A').postReceipt(input)).rejects.toMatchObject({
      code: 'not_found',
      message: 'PO or line not found.',
    });

    expect(stub.chainArgsAll.get('purchase_orders.select')?.[0]).toEqual(
      expect.arrayContaining([
        ['organization_id', 'org-A'],
        ['id', PO_ID],
      ]),
    );
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
    expect(invalidateInventoryListAfterWrite).not.toHaveBeenCalled();
  });

  it('working in B, the receipt posts once and every record lands in B', async () => {
    const stub = stubFor();

    await svc(stub, 'org-B').postReceipt(input);

    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['post_receipt_v2', 'publish_outbox']);
    expect(stub.rpcCalls[1]?.args).toMatchObject({ p_org_id: 'org-B', p_topic: 'receipt.posted' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'stock.receipt.posted' }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
    expect(dispatchEvent).toHaveBeenCalledWith(
      'org-B',
      'po.received',
      expect.objectContaining({ id: PO_ID }),
    );
  });
});

describe('reverseReceipt: a receipt of another organization is not found', () => {
  it('reversing a receipt that is not in A runs nothing and records nothing', async () => {
    const stub = stubFor();

    await expect(
      svc(stub, 'org-A').reverseReceipt({ receiptId: RECEIPT_ID, reason: 'entered twice' }),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Receipt not found.' });

    expect(stub.chainArgsAll.get('receipts.select')?.[0]).toEqual(
      expect.arrayContaining([
        ['organization_id', 'org-A'],
        ['id', RECEIPT_ID],
      ]),
    );
    expect(stub.rpcCalls).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(invalidateInventoryListAfterWrite).not.toHaveBeenCalled();
  });

  it('working in B, the reversal runs once and is recorded in B', async () => {
    const stub = stubFor();

    await svc(stub, 'org-B').reverseReceipt({ receiptId: RECEIPT_ID, reason: 'entered twice' });

    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['reverse_receipt']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'stock.receipt.reversed', entityId: RECEIPT_ID }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
  });
});
