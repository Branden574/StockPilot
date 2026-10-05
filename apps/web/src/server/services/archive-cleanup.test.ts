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
