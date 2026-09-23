import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Receiving batches its id lists.
 *
 * A receipt's lines and a PO's receipts have no cap. One `.in()` past ~215
 * uuids answers 414 locally and fails as "fetch failed" in production after
 * ~7 s of retries. The auto-unarchive reads ignored their errors; they are
 * bound and reported now, and a revive that stops partway still invalidates
 * and audits what it restored.
 */

const { reportError, invalidate, audit } = vi.hoisted(() => ({
  reportError: vi.fn(async () => {}),
  invalidate: vi.fn(),
  audit: vi.fn(async () => {}),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: invalidate }));
vi.mock('./audit', () => ({ audit }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => undefined) }));

import type { PostReceiptInput } from '@stockpilot/core';

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { ReceivingService } from './receiving';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}
const restoredAudits = () =>
  audit.mock.calls
    .map((c) => (c as unknown as [{ event?: string }])[0])
    .filter((a) => a.event === 'inventory.item.restored');
const tags = () =>
  reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);

const receiptRow = {
  id: 'rcpt-1',
  organization_id: 'org-test',
  purchase_order_id: 'po-1',
  warehouse_id: 'wh-1',
  receipt_number: 'R-001',
  status: 'posted',
  received_by: 'user-test',
  received_at: '2026-07-14T00:00:00Z',
  idempotency_key: 'idem-1',
};

const input: PostReceiptInput = {
  purchaseOrderId: 'po-1',
  warehouseId: 'wh-1',
  idempotencyKey: 'idem-1',
  lines: Array.from({ length: 250 }, (_, i) => ({
    poLineId: uuid(i, 'l'),
    qtyReceived: 1,
    qtyAccepted: 1,
    qtyRejected: 0,
    unitCost: 1,
  })),
};

function receiptStub(opts: { failLinesBatch?: number; failUpdateBatch?: number } = {}) {
  let lineCalls = 0;
  let updates = 0;
  const lists = { lines: [] as string[][], items: [] as string[][], update: [] as string[][] };
  const stub = makeSupabaseStub({
    'rpc:post_receipt_v2': { data: receiptRow, error: null },
    'purchase_order_items.select': (call) => {
      lineCalls += 1;
      const list = inList(call, 'id');
      lists.lines.push(list);
      if (lineCalls === opts.failLinesBatch) return { data: null, error: { message: 'boom' } };
      return {
        data: list.map((id) => ({ id, item_id: uuid(Number(id.slice(-12)), 'i') })),
        error: null,
      };
    },
    'inventory_items.select': (call) => {
      const list = inList(call, 'id');
      lists.items.push(list);
      return { data: list.map((id) => ({ id, name: 'x' })), error: null };
    },
    'inventory_items.update': (call) => {
      updates += 1;
      const list = inList(call, 'id');
      lists.update.push(list);
      if (updates === opts.failUpdateBatch) return { data: null, error: { message: 'boom' } };
      return { data: list.map((id) => ({ id, name: 'x' })), error: null };
    },
  });
  return { stub, lists };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('postReceipt auto-unarchive with 250 lines', () => {
  it('reads lines and archived items and restores them in batches of at most 100', async () => {
    const { stub, lists } = receiptStub();
    await new ReceivingService(makeServiceContext(stub.client)).postReceipt(input);
    expect(lists.lines.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(lists.items.flat()).toHaveLength(250);
    expect(lists.items.every((l) => l.length <= 100)).toBe(true);
    expect(lists.update.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(restoredAudits()).toHaveLength(250);
  });

  it('skips the revive, reported, when a line batch fails', async () => {
    const { stub } = receiptStub({ failLinesBatch: 2 });
    const receipt = await new ReceivingService(makeServiceContext(stub.client)).postReceipt(input);
    expect(receipt.id).toBe('rcpt-1');
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    expect(tags()).toContain('receiving.auto_unarchive.lines');
  });

  it('invalidates and audits the restored part when a later update batch fails', async () => {
    const { stub } = receiptStub({ failUpdateBatch: 2 });
    await new ReceivingService(makeServiceContext(stub.client)).postReceipt(input);
    expect(restoredAudits()).toHaveLength(100);
    expect(invalidate).toHaveBeenCalledWith('org-test', 'receipt.auto_unarchive');
    expect(tags()).toContain('receiving.auto_unarchive.update');
  });
});

describe('listForPurchaseOrder with 250 receipts', () => {
  it('reads receipt lines and receiver names in batches of at most 100', async () => {
    const receipts = Array.from({ length: 250 }, (_, i) => ({
      id: uuid(i, 'r'),
      received_by: uuid(i, 'u'),
    }));
    const lineLists: string[][] = [];
    const nameLists: string[][] = [];
    const stub = makeSupabaseStub({
      'receipts.select': { data: receipts, error: null },
      'receipt_lines.select': (call) => {
        const list = inList(call, 'receipt_id');
        lineLists.push(list);
        return {
          data: list.map((receipt_id) => ({ id: `l-${receipt_id}`, receipt_id })),
          error: null,
        };
      },
      'user_profiles.select': (call) => {
        const list = inList(call, 'id');
        nameLists.push(list);
        return {
          data: list.map((id) => ({ id, full_name: 'Receiver', email: null })),
          error: null,
        };
      },
    });
    const out = await new ReceivingService(makeServiceContext(stub.client)).listForPurchaseOrder(
      'po-1',
    );
    expect(lineLists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(nameLists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(out.lines).toHaveLength(250);
    expect((out.receipts.at(-1) as unknown as { received_by_name: string }).received_by_name).toBe(
      'Receiver',
    );
  });

  it('shows "Unknown" and reports when the name lookup fails', async () => {
    const stub = makeSupabaseStub({
      'receipts.select': { data: [{ id: uuid(1, 'r'), received_by: uuid(1, 'u') }], error: null },
      'receipt_lines.select': { data: [], error: null },
      'user_profiles.select': { data: null, error: { message: 'boom' } },
    });
    const out = await new ReceivingService(makeServiceContext(stub.client)).listForPurchaseOrder(
      'po-1',
    );
    expect((out.receipts[0] as unknown as { received_by_name: string }).received_by_name).toBe(
      'Unknown',
    );
    expect(tags()).toEqual(['receiving.receiver_names']);
  });
});
