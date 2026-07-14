import { describe, expect, it } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import { ReceivingService } from './receiving';

import type { PostReceiptInput } from '@stockpilot/core';

// Task 9: maybeAutoUnarchive (private, exercised via postReceipt) used to
// revive ANY archived item a receipt's lines targeted, regardless of WHY it
// was archived. That let a receipt against a deliberately/manually archived
// SKU (e.g. a discontinued line that still gets a correction receipt) silently
// un-retire it. The fix scopes the revive to auto_archived=true rows only —
// items the zero-stock cron archived — mirroring the DB's own restock
// trigger (_auto_restock_restore, migration 0266), which carries the same
// guard.

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
  received_at: '2026-07-14T00:00:00Z',
  idempotency_key: 'idem-1',
  created_at: '2026-07-14T00:00:00Z',
  updated_at: '2026-07-14T00:00:00Z',
};

const baseInput: PostReceiptInput = {
  purchaseOrderId: 'po-1',
  warehouseId: 'wh-1',
  idempotencyKey: 'idem-1',
  lines: [
    {
      poLineId: '11111111-1111-1111-1111-111111111111',
      qtyReceived: 5,
      qtyAccepted: 5,
      qtyRejected: 0,
      unitCost: 2,
    },
    {
      poLineId: '22222222-2222-2222-2222-222222222222',
      qtyReceived: 3,
      qtyAccepted: 3,
      qtyRejected: 0,
      unitCost: 4,
    },
  ],
};

describe('ReceivingService.postReceipt — auto-unarchive scoping (Task 9)', () => {
  it('scopes the "which items are archived" check to auto_archived=true rows only', async () => {
    const stub = makeSupabaseStub({
      'rpc:post_receipt_v2': { data: receiptRow, error: null },
      'purchase_order_items.select': {
        data: [
          { id: '11111111-1111-1111-1111-111111111111', item_id: 'item-auto' },
          { id: '22222222-2222-2222-2222-222222222222', item_id: 'item-manual' },
        ],
        error: null,
      },
      // Stands in for what Postgres would actually return once the new
      // `.eq('auto_archived', true)` filter is applied: only the
      // system-archived item survives, even though BOTH items are
      // status='archived' and both were targeted by this receipt.
      'inventory_items.select': {
        data: [{ id: 'item-auto', name: 'System Archived Widget' }],
        error: null,
      },
      'inventory_items.update': {
        data: [{ id: 'item-auto', name: 'System Archived Widget' }],
        error: null,
      },
    });
    const svc = new ReceivingService(makeServiceContext(stub.client));

    await svc.postReceipt(baseInput);

    // The direct RED→GREEN assertion: the archived-rows check query must
    // filter on auto_archived=true, not just status='archived'. Before the
    // fix this eq() call doesn't exist and the assertion fails.
    const selectChain = stub.chains.get('inventory_items.select') ?? [];
    const selectArgs = stub.chainArgs.get('inventory_items.select') ?? [];
    const eqCalls = selectChain
      .map((m, i) => ({ m, args: selectArgs[i] }))
      .filter((c) => c.m === 'eq');
    const eqMap = new Map(eqCalls.map((c) => [c.args![0] as string, c.args![1]]));
    expect(eqMap.get('status')).toBe('archived');
    expect(eqMap.get('auto_archived')).toBe(true);

    // Behavioral corollary: the revive UPDATE only ever targets ids that
    // came back from that (now correctly scoped) select — so the
    // manually-archived item is never touched, even though it was in the
    // same receipt's item set.
    const updateArgs = stub.chainArgs.get('inventory_items.update') ?? [];
    const inCall = (stub.chains.get('inventory_items.update') ?? [])
      .map((m, i) => ({ m, args: updateArgs[i] }))
      .find((c) => c.m === 'in');
    expect(inCall?.args?.[1]).toEqual(['item-auto']);
    // The update payload also clears auto_archived, mirroring the DB's own
    // restock trigger, so a later zero-stock crossing is eligible for the
    // cron again instead of being permanently skipped.
    const updatePayload = updateArgs[0]?.[0] as Record<string, unknown>;
    expect(updatePayload).toMatchObject({ status: 'active', auto_archived: false });
  });

  it('is a no-op when none of the targeted items are auto_archived (all manually archived)', async () => {
    const stub = makeSupabaseStub({
      'rpc:post_receipt_v2': { data: receiptRow, error: null },
      'purchase_order_items.select': {
        data: [{ id: '22222222-2222-2222-2222-222222222222', item_id: 'item-manual' }],
        error: null,
      },
      // Postgres returns nothing: item-manual is status='archived' but
      // auto_archived=false, so the scoped select filters it out entirely.
      'inventory_items.select': { data: [], error: null },
    });
    const svc = new ReceivingService(makeServiceContext(stub.client));

    await svc.postReceipt({
      ...baseInput,
      lines: [baseInput.lines[1]!],
    });

    // No update should have been issued at all — the manually-archived
    // item must stay exactly as a human left it.
    expect(stub.chains.has('inventory_items.update')).toBe(false);
  });
});
