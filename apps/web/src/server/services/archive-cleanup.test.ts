import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

vi.mock('./audit', () => ({
  audit: vi.fn(async () => {}),
  auditMany: vi.fn(async (rows: readonly unknown[]) => ({ written: rows.length, lost: 0 })),
}));

import { audit, auditMany } from './audit';
import { parseAutoDeleteArchivedSettings, purgeExpiredArchivedItems } from './archive-cleanup';

beforeEach(() => {
  vi.clearAllMocks();
});

/** Rows the list audit wrote. They go through the batched writer (auditMany);
 *  audit() is never called once per row. */
function auditedRows(): unknown[] {
  expect(vi.mocked(audit)).not.toHaveBeenCalled();
  return vi.mocked(auditMany).mock.calls.flatMap(([rows]) => rows);
}

describe('parseAutoDeleteArchivedSettings', () => {
  it('accepts valid settings unchanged', () => {
    expect(parseAutoDeleteArchivedSettings({ enabled: true, days: 90 })).toEqual({
      enabled: true,
      days: 90,
    });
  });

  it('falls back to OFF defaults for missing/garbage input', () => {
    expect(parseAutoDeleteArchivedSettings(undefined)).toEqual({ enabled: false, days: 90 });
    expect(parseAutoDeleteArchivedSettings(null)).toEqual({ enabled: false, days: 90 });
    expect(parseAutoDeleteArchivedSettings({ enabled: 'yes' })).toEqual({ enabled: false, days: 90 });
  });

  it('rejects out-of-range days (below the 7-day floor) by falling back to OFF', () => {
    expect(parseAutoDeleteArchivedSettings({ enabled: true, days: 1 })).toEqual({
      enabled: false,
      days: 90,
    });
    expect(parseAutoDeleteArchivedSettings({ enabled: true, days: 99999 })).toEqual({
      enabled: false,
      days: 90,
    });
  });
});

describe('purgeExpiredArchivedItems', () => {
  it('soft-deletes the expired archived candidates and audits each', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': {
        data: [
          { id: 'i1', name: 'Old Tote' },
          { id: 'i2', name: 'Old Flag' },
        ],
        error: null,
      },
      'inventory_items.update': {
        data: [
          { id: 'i1', name: 'Old Tote' },
          { id: 'i2', name: 'Old Flag' },
        ],
        error: null,
      },
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.deleted).toBe(2);
    expect(res.ids).toEqual(['i1', 'i2']);
    // The UPDATE sets deleted_at (soft delete), never a hard delete.
    const updArgs = stub.chainArgs.get('inventory_items.update');
    const payload = updArgs?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(payload?.deleted_at).toBeTruthy();
    expect(payload?.deleted_by).toBeDefined();
    // One audit row per deleted item.
    expect(auditedRows()).toHaveLength(2);
  });

  it('no-ops (no UPDATE, no audit) when nothing is past the retention window', async () => {
    const stub = makeSupabaseStub({ 'inventory_items.select': { data: [], error: null } });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.deleted).toBe(0);
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    expect(auditedRows()).toHaveLength(0);
  });
});

// L15: the daily auto-delete used to soft-delete an archived item past its
// retention whatever stock it still held ("Archive anyway" keeps stock), so
// the stock on record vanished with the item. It now deletes only items that
// hold nothing: no stock on record, no holding on any location, no open hold.
describe('purgeExpiredArchivedItems keeps archived items that still hold stock', () => {
  const OLD = new Date(Date.now() - 400 * 86_400_000).toISOString();

  type ItemRow = {
    id: string;
    name: string;
    organization_id: string;
    status: string;
    deleted_at: string | null;
    archived_at: string;
    quantity_on_hand: number;
  };

  function item(id: string, qoh: number): ItemRow {
    return {
      id,
      name: `Item ${id}`,
      organization_id: 'org-test',
      status: 'archived',
      deleted_at: null,
      archived_at: OLD,
      quantity_on_hand: qoh,
    };
  }

  /** servedLikePostgrest, plus the `.not(column, 'in', '(a,b)')` filter the
   *  order-line read uses. Embedded columns are flat keys on the row
   *  ('order_requests.status'), as `!inner` filters the parent rows by them. */
  function servedWithNotIn(rows: ReadonlyArray<Record<string, unknown>>) {
    return (call: MockCall) => {
      const nots = call.methods
        .map((m, i) => [m, call.args[i] ?? []] as const)
        .filter(([m]) => m === 'not');
      const rest: MockCall = {
        ...call,
        methods: call.methods.filter((m) => m !== 'not'),
        args: call.args.filter((_, i) => call.methods[i] !== 'not'),
      };
      let out = servedLikePostgrest(rows)(rest).data as Array<Record<string, unknown>>;
      for (const [, [col, op, list]] of nots) {
        if (op !== 'in') throw new Error(`cannot evaluate .not(${String(col)}, ${String(op)})`);
        const values = String(list).replace(/[()]/g, '').split(',');
        out = out.filter((r) => !values.includes(String(r[col as string])));
      }
      return { data: out, error: null };
    };
  }

  /** inventory_items answered like PostgREST: the candidate read applies its
   *  own filters, the head count answers a count, and the update applies its
   *  race guards against `afterRead` (the rows as they are when it lands). */
  function stubFor(opts: {
    items: ItemRow[];
    afterRead?: ItemRow[];
    holdings?: Array<{ id: string; organization_id: string; item_id: string; quantity: number }>;
    holds?: Array<{
      id: string;
      organization_id: string;
      item_id: string;
      released_at: string | null;
    }>;
    poLines?: Array<{ id: string; organization_id: string; item_id: string; 'purchase_orders.status': string }>;
    orderLines?: Array<{
      id: string;
      item_id: string;
      quantity_picked: number | null;
      'order_requests.organization_id': string;
      'order_requests.status': string;
    }>;
    returnLines?: Array<{
      id: string;
      organization_id: string;
      item_id: string;
      applied: boolean;
      'returns.status': string;
    }>;
  }) {
    const served = servedLikePostgrest(opts.items);
    return makeSupabaseStub({
      'inventory_items.select': (call) => {
        const selectArgs = call.args[call.methods.indexOf('select')] ?? [];
        const head = (selectArgs[1] as { head?: boolean } | undefined)?.head === true;
        if (head) {
          const rest: MockCall = {
            ...call,
            methods: call.methods.filter((m) => m !== 'not'),
            args: call.args.filter((_, i) => call.methods[i] !== 'not'),
          };
          const rows = servedLikePostgrest(opts.items)(rest).data as unknown[];
          return { data: null, error: null, count: rows.length };
        }
        const rest: MockCall = {
          ...call,
          methods: call.methods.filter((m) => m !== 'not'),
          args: call.args.filter((_, i) => call.methods[i] !== 'not'),
        };
        return served(rest);
      },
      'inventory_items.update': (call) => {
        const rest: MockCall = {
          ...call,
          methods: call.methods.filter((m) => m !== 'update'),
          args: call.args.filter((_, i) => call.methods[i] !== 'update'),
        };
        return servedLikePostgrest(opts.afterRead ?? opts.items)(rest);
      },
      'item_stock_levels.select': servedLikePostgrest(opts.holdings ?? []),
      'stock_reservations.select': servedLikePostgrest(opts.holds ?? []),
      'purchase_order_items.select': servedWithNotIn(opts.poLines ?? []),
      'order_request_lines.select': servedWithNotIn(opts.orderLines ?? []),
      'return_lines.select': servedWithNotIn(opts.returnLines ?? []),
    });
  }

  it('reads candidates with no stock on record only, and repeats that as the update guard', async () => {
    const stub = stubFor({ items: [item('zero', 0), item('stocked', 5), item('negative', -2)] });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.ids).toEqual(['zero']);
    const updChain = stub.chainsAll.get('inventory_items.update')?.[0] ?? [];
    const updArgs = stub.chainArgsAll.get('inventory_items.update')?.[0] ?? [];
    const guards = updChain
      .map((m, i) => [m, updArgs[i]?.[0], updArgs[i]?.[1]] as const)
      .filter(([m]) => m === 'eq');
    expect(guards).toContainEqual(['eq', 'quantity_on_hand', 0]);
  });

  it('keeps an item with no stock on record that still has a holding on a location', async () => {
    const stub = stubFor({
      items: [item('zero', 0), item('held-on-rack', 0)],
      holdings: [
        { id: 'h1', organization_id: 'org-test', item_id: 'held-on-rack', quantity: 3 },
        { id: 'h2', organization_id: 'org-test', item_id: 'zero', quantity: 0 },
      ],
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.ids).toEqual(['zero']);
    expect(res.skipped).toBe(1);
  });

  it('keeps an item with an open hold (an order or rental still holding it)', async () => {
    const stub = stubFor({
      items: [item('zero', 0), item('reserved', 0)],
      holds: [
        { id: 'r1', organization_id: 'org-test', item_id: 'reserved', released_at: null },
        { id: 'r2', organization_id: 'org-test', item_id: 'zero', released_at: OLD },
      ],
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.ids).toEqual(['zero']);
    expect(res.skipped).toBe(1);
  });

  it('keeps an item whose stock arrived between the read and the update', async () => {
    const stub = stubFor({
      items: [item('zero', 0), item('race', 0)],
      afterRead: [item('zero', 0), item('race', 4)],
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.ids).toEqual(['zero']);
    expect(res.deleted).toBe(1);
    expect(res.skipped).toBe(1);
    expect(auditedRows()).toHaveLength(1);
  });

  it('counts the items kept for their stock on record', async () => {
    const stub = stubFor({ items: [item('zero', 0), item('stocked', 5), item('negative', -2)] });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.deleted).toBe(1);
    expect(res.skipped).toBe(2);
  });

  // Review (2026-10-05): stock can still come BACK to an item that holds
  // nothing today, and nothing restores a deleted item: a receipt posts
  // against a deleted item's PO line (post_receipt_v2), and a cancel, a
  // reopen or a return restocks through adjust_stock or the return
  // disposition, none of which check deleted_at. A rolled-back probe put 4
  // units on a deleted item. So an item is also kept while it is on an open
  // PO, picked for an open order, or named by a return not yet applied.
  it('keeps an item still on an open PO (draft, expected, ordered or partly received); a received or cancelled PO does not keep it', async () => {
    const line = (id: string, itemId: string, status: string) => ({
      id,
      organization_id: 'org-test',
      item_id: itemId,
      'purchase_orders.status': status,
    });
    const stub = stubFor({
      items: [
        item('on-draft', 0),
        item('on-expected', 0),
        item('on-ordered', 0),
        item('on-partial', 0),
        item('on-received', 0),
        item('on-cancelled', 0),
      ],
      poLines: [
        line('l1', 'on-draft', 'draft'),
        line('l2', 'on-expected', 'expected_inbound'),
        line('l3', 'on-ordered', 'ordered'),
        line('l4', 'on-partial', 'partially_received'),
        line('l5', 'on-received', 'received'),
        line('l6', 'on-cancelled', 'cancelled'),
      ],
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.ids.sort()).toEqual(['on-cancelled', 'on-received']);
    expect(res.skipped).toBe(4);
  });

  it('keeps an item picked for an open order (a cancel or reopen restocks it); a closed order does not keep it', async () => {
    const line = (id: string, itemId: string, status: string, picked: number | null) => ({
      id,
      item_id: itemId,
      quantity_picked: picked,
      'order_requests.organization_id': 'org-test',
      'order_requests.status': status,
    });
    const stub = stubFor({
      items: [item('staged', 0), item('backordered', 0), item('completed', 0), item('cancelled', 0), item('not-picked', 0)],
      orderLines: [
        line('o1', 'staged', 'staged_for_pickup', 2),
        line('o2', 'backordered', 'backordered', 1),
        line('o3', 'completed', 'completed', 2),
        line('o4', 'cancelled', 'cancelled', 2),
        line('o5', 'not-picked', 'approved', null),
      ],
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.ids.sort()).toEqual(['cancelled', 'completed', 'not-picked']);
    expect(res.skipped).toBe(2);
    // Scoped to this org through the order (the line has no organization_id).
    const read = stub.chainArgsAll.get('order_request_lines.select')?.[0] ?? [];
    expect(read).toContainEqual(['order_requests.organization_id', 'org-test']);
  });

  it('keeps an item named by a return line not yet applied, while the return is open', async () => {
    const line = (id: string, itemId: string, status: string, applied: boolean) => ({
      id,
      organization_id: 'org-test',
      item_id: itemId,
      applied,
      'returns.status': status,
    });
    const stub = stubFor({
      items: [item('requested', 0), item('approved', 0), item('received', 0), item('closed', 0), item('denied', 0)],
      returnLines: [
        line('r1', 'requested', 'requested', false),
        line('r2', 'approved', 'approved', false),
        line('r3', 'received', 'received', false),
        line('r4', 'closed', 'closed', true),
        line('r5', 'denied', 'denied', false),
      ],
    });
    const ctx = makeServiceContext(stub.client) as never;

    const res = await purgeExpiredArchivedItems(ctx, 90);

    expect(res.ids.sort()).toEqual(['closed', 'denied']);
    expect(res.skipped).toBe(3);
  });

  it.each(['purchase_order_items', 'order_request_lines', 'return_lines'])(
    'deletes nothing when the %s read fails',
    async (table) => {
      const stub = makeSupabaseStub({
        'inventory_items.select': { data: [{ id: 'zero', name: 'Zero' }], error: null },
        'item_stock_levels.select': { data: [], error: null },
        'stock_reservations.select': { data: [], error: null },
        'purchase_order_items.select': { data: [], error: null },
        'order_request_lines.select': { data: [], error: null },
        'return_lines.select': { data: [], error: null },
        [`${table}.select`]: { data: null, error: { message: 'boom' } },
      });
      const ctx = makeServiceContext(stub.client) as never;

      await expect(purgeExpiredArchivedItems(ctx, 90)).rejects.toThrow();
      expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    },
  );

  it('deletes nothing when the holdings read fails', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'zero', name: 'Zero' }], error: null },
      'item_stock_levels.select': { data: null, error: { message: 'boom' } },
      'stock_reservations.select': { data: [], error: null },
    });
    const ctx = makeServiceContext(stub.client) as never;

    await expect(purgeExpiredArchivedItems(ctx, 90)).rejects.toThrow();
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
  });
});
