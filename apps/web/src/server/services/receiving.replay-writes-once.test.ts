// Security invariant (listed in scripts/security-test.sh): a receipt's audit
// row, its export event and its webhook / Slack / Teams message are written
// once per receipt. A retry with the same key and the same lines gets the
// same receipt back and writes none of them again; the same key with other
// lines is refused as a conflict.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

const { dispatchEvent } = vi.hoisted(() => ({ dispatchEvent: vi.fn(async () => undefined) }));
vi.mock('./integration-events', () => ({ dispatchEvent }));
const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import type { PostReceiptInput } from '@stockpilot/core';

import { audit } from './audit';
import { ReceivingService } from './receiving';

const ORG = 'org-test';
const PO_ID = '7ece1700-0000-4000-8000-0000000000e1';
const KEY = 'receipt-once-0000-4000-8000-000000000001';
const RECEIPT_ID = '7ece1700-0000-4000-8000-0000000000f1';

const input: PostReceiptInput = {
  purchaseOrderId: PO_ID,
  warehouseId: 'wh-1',
  idempotencyKey: KEY,
  lines: [{ poLineId: 'pol-1', qtyReceived: 2, qtyAccepted: 2, qtyRejected: 0, unitCost: 1 }],
};

/** The receipt post_receipt_v2 records for the first request under KEY, and
 *  answers again to a request with the same hash. */
const RECEIPT = {
  id: RECEIPT_ID,
  organization_id: ORG,
  warehouse_id: 'wh-1',
  purchase_order_id: PO_ID,
  receipt_number: 'RCV-000001',
  idempotency_key: KEY,
  received_by: 'user-test',
};

/**
 * The member's client: post_receipt_v2 as the database answers it (0013,
 * 0466): the first hash under a key records the receipt, the same hash again
 * answers the same receipt, another hash is idempotency_conflict.
 */
function memberStub() {
  let storedHash: string | null = null;
  return makeSupabaseStub({
    'purchase_orders.select': servedLikePostgrest([{ id: PO_ID, organization_id: ORG }]),
    'purchase_order_items.select': servedLikePostgrest([{ id: 'pol-1', item_id: 'item-1' }]),
    'inventory_items.select': servedLikePostgrest([]),
    'rpc:post_receipt_v2': (call) => {
      const args = call.args[0]![0] as { p_request_hash: string };
      if (storedHash === null) storedHash = args.p_request_hash;
      if (storedHash !== args.p_request_hash) {
        return { data: null, error: { message: 'idempotency_conflict', code: '55000' } };
      }
      return { data: RECEIPT, error: null };
    },
  });
}

/**
 * The service client: publish_outbox as the database answers it (0341): the
 * new event's id for a key not yet held, null for a key already held
 * (outbox_dedupe_uniq, on conflict do nothing).
 */
function adminStub(answer?: () => { data: unknown; error: unknown }) {
  const held = new Set<string>();
  let n = 0;
  return makeSupabaseStub({
    'rpc:publish_outbox': (call) => {
      if (answer) return answer() as never;
      const args = call.args[0]![0] as { p_org_id: string; p_dedupe_key: string };
      const key = `${args.p_org_id}|${args.p_dedupe_key}`;
      if (held.has(key)) return { data: null, error: null };
      held.add(key);
      n += 1;
      return { data: `evt-${n}`, error: null };
    },
  });
}

let admin: ReturnType<typeof adminStub>;

function svc(member: ReturnType<typeof memberStub>) {
  return new ReceivingService(makeServiceContext(member.client, { role: 'manager' }));
}

function receiptAuditRows(): number {
  return vi.mocked(audit).mock.calls.filter(([payload]) => payload.event === 'stock.receipt.posted')
    .length;
}

function exportEvents(): number {
  return admin.rpcCalls.filter((c) => c.name === 'publish_outbox').length;
}

function autoUnarchiveReads(member: ReturnType<typeof memberStub>): number {
  return member.fromCalls.filter((t) => t === 'inventory_items').length;
}

beforeEach(() => {
  vi.clearAllMocks();
  admin = adminStub();
  adminHolder.client = admin.client;
});

describe('a receipt writes its audit row and sends its messages once', () => {
  it('a new receipt: one audit row, one export event, one po.received message', async () => {
    const member = memberStub();
    const receipt = await svc(member).postReceipt(input);

    expect(receipt.id).toBe(RECEIPT_ID);
    expect(receiptAuditRows()).toBe(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'stock.receipt.posted', entityId: RECEIPT_ID }),
      expect.objectContaining({ organizationId: ORG }),
    );
    expect(exportEvents()).toBe(1);
    expect(admin.rpcCalls[0]!.args).toMatchObject({
      p_topic: 'receipt.posted',
      p_dedupe_key: `receipt.posted:${RECEIPT_ID}`,
    });
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalledWith(ORG, 'po.received', {
      id: PO_ID,
      receiptNumber: 'RCV-000001',
      totalAccepted: 2,
    });
    expect(autoUnarchiveReads(member)).toBe(1);
  });

  it('a retry with the same key and lines gets the same receipt and writes nothing again', async () => {
    const member = memberStub();
    const first = await svc(member).postReceipt(input);
    const retry = await svc(member).postReceipt(input);

    expect(retry).toEqual(first);
    expect(member.rpcCalls.map((c) => c.name)).toEqual(['post_receipt_v2', 'post_receipt_v2']);
    expect(receiptAuditRows()).toBe(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    // The retry asks for the export event and is told it is already there.
    expect(exportEvents()).toBe(2);
    expect(autoUnarchiveReads(member)).toBe(1);
  });

  it('two sends of the same request at once write one audit row and one message', async () => {
    const member = memberStub();
    const [a, b] = await Promise.all([
      svc(member).postReceipt(input),
      svc(member).postReceipt(input),
    ]);

    expect(a.id).toBe(RECEIPT_ID);
    expect(b.id).toBe(RECEIPT_ID);
    expect(receiptAuditRows()).toBe(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(autoUnarchiveReads(member)).toBe(1);
  });

  it('the same key with other lines is the conflict, with no second receipt row or message', async () => {
    const member = memberStub();
    await svc(member).postReceipt(input);
    const other: PostReceiptInput = {
      ...input,
      lines: [{ ...input.lines[0]!, qtyReceived: 3, qtyAccepted: 3 }],
    };

    await expect(svc(member).postReceipt(other)).rejects.toMatchObject({
      code: 'conflict',
      message:
        'A different receipt was already submitted with this idempotency key. Refresh and try again.',
    });
    expect(receiptAuditRows()).toBe(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'idempotency.conflict', entityType: 'receipt' }),
      expect.anything(),
    );
    expect(exportEvents()).toBe(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it('when the export event cannot be written, the audit row and the message are still written', async () => {
    admin = adminStub(() => ({ data: null, error: { message: 'publish failed' } }));
    adminHolder.client = admin.client;
    const member = memberStub();
    await svc(member).postReceipt(input);

    expect(receiptAuditRows()).toBe(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(autoUnarchiveReads(member)).toBe(1);
  });

  it('when the service client cannot be made, the audit row and the message are still written', async () => {
    adminHolder.client = undefined;
    const member = memberStub();
    await svc(member).postReceipt(input);

    expect(receiptAuditRows()).toBe(1);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
