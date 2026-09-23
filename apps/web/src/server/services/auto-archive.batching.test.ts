import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daily archive and purge crons batch their id lists.
 *
 * auto-archive passes up to 500 candidate ids and the purge up to 1000. One
 * `.in()` of that many uuids fails in production (and answers 414 locally), so
 * an org with a full backlog failed every daily run, forever. The reservation
 * read decides what may be archived, so a failed batch must throw (never read
 * as "nothing reserved"); a write that stops partway must still audit and
 * invalidate what did commit, and report the rest.
 */

const reportError = vi.hoisted(() => vi.fn(async () => {}));
const invalidate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => {}),
  auditMany: vi.fn(async (rows: readonly unknown[]) => ({ written: rows.length, lost: 0 })),
}));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'n') }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: invalidate }));

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { purgeExpiredArchivedItems } from './archive-cleanup';
import { audit, auditMany } from './audit';
import {
  archiveExpiredZeroStockItems,
  countEligibleForAutoArchive,
  notifyAutoArchived,
} from './auto-archive';
import { createNotification } from './notifications';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const candidates = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: uuid(i), name: `Item ${i}` }));

function idsOf(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}

beforeEach(() => {
  reportError.mockClear();
  invalidate.mockClear();
  vi.mocked(audit).mockClear();
  vi.mocked(auditMany).mockClear();
});

/** Rows the list audit wrote. They go through the batched writer (auditMany);
 *  audit() is never called once per row. */
function auditedRows(): unknown[] {
  expect(vi.mocked(audit)).not.toHaveBeenCalled();
  return vi.mocked(auditMany).mock.calls.flatMap(([rows]) => rows);
}

describe('archiveExpiredZeroStockItems with 250 candidates', () => {
  it('reads reservations in org-scoped batches of at most 100 and skips one reserved in the last batch', async () => {
    const resvCalls: MockCall[] = [];
    const updateLists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: candidates(250), error: null },
      'stock_reservations.select': (call) => {
        resvCalls.push(call);
        const list = idsOf(call, 'item_id');
        // uuid(240) is reserved; it sits in the third batch.
        return {
          data: list.filter((id) => id === uuid(240)).map((item_id) => ({ item_id })),
          error: null,
        };
      },
      'inventory_items.update': (call) => {
        const list = idsOf(call, 'id');
        updateLists.push(list);
        return { data: list.map((id) => ({ id, name: 'x' })), error: null };
      },
    });
    const res = await archiveExpiredZeroStockItems(makeServiceContext(stub.client) as never, 7);

    expect(resvCalls.map((c) => idsOf(c, 'item_id').length)).toEqual([100, 100, 50]);
    for (const c of resvCalls) {
      const eqs = c.methods.map((m, i) => [m, c.args[i]] as const).filter(([m]) => m === 'eq');
      expect(eqs.map(([, a]) => a)).toContainEqual(['organization_id', 'org-test']);
    }
    expect(updateLists.map((l) => l.length)).toEqual([100, 100, 49]);
    expect(updateLists.flat()).not.toContain(uuid(240));
    expect(res.archived).toBe(249);
    expect(res.failed).toBe(0);
  });

  it('throws and archives nothing when a reservation batch fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: candidates(250), error: null },
      'stock_reservations.select': () => {
        n += 1;
        return n === 3
          ? { data: null, error: { message: 'fetch failed' } }
          : { data: [], error: null };
      },
    });
    await expect(
      archiveExpiredZeroStockItems(makeServiceContext(stub.client) as never, 7),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    expect(auditedRows()).toHaveLength(0);
  });

  it('audits, invalidates and returns the archived part when a later write batch fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: candidates(250), error: null },
      'stock_reservations.select': { data: [], error: null },
      'inventory_items.update': (call) => {
        n += 1;
        if (n === 2) return { data: null, error: { message: 'statement timeout' } };
        return { data: idsOf(call, 'id').map((id) => ({ id, name: 'x' })), error: null };
      },
    });
    const res = await archiveExpiredZeroStockItems(makeServiceContext(stub.client) as never, 7);

    expect(n).toBe(2); // stopped at the failure, the third batch never ran
    expect(res.archived).toBe(100);
    expect(res.items).toHaveLength(100);
    expect(res.failed).toBe(150);
    expect(auditedRows()).toHaveLength(100);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const tags = reportError.mock.calls.map(
      (c) => (c as unknown as [Error, { tag: string }])[1].tag,
    );
    expect(tags).toEqual(['auto_archive.archive.partial']);
  });

  it('throws when the first write batch fails and nothing was archived', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: candidates(250), error: null },
      'stock_reservations.select': { data: [], error: null },
      'inventory_items.update': { data: null, error: { message: 'boom' } },
    });
    await expect(
      archiveExpiredZeroStockItems(makeServiceContext(stub.client) as never, 7),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(auditedRows()).toHaveLength(0);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('the preview count reads reservations in the same batches', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: candidates(250), error: null },
      'stock_reservations.select': (call) => {
        const list = idsOf(call, 'item_id');
        lists.push(list);
        return {
          data: list.filter((id) => id === uuid(249)).map((item_id) => ({ item_id })),
          error: null,
        };
      },
    });
    const count = await countEligibleForAutoArchive(makeServiceContext(stub.client) as never, 7);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(count).toBe(249);
  });
});

describe('purgeExpiredArchivedItems with 250 candidates', () => {
  it('soft-deletes in batches of at most 100', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: candidates(250), error: null },
      'inventory_items.update': (call) => {
        const list = idsOf(call, 'id');
        lists.push(list);
        return { data: list.map((id) => ({ id, name: 'x' })), error: null };
      },
    });
    const res = await purgeExpiredArchivedItems(makeServiceContext(stub.client) as never, 90);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(res.deleted).toBe(250);
    expect(res.failed).toBe(0);
    expect(auditedRows()).toHaveLength(250);
  });

  it('audits, invalidates and returns the deleted part when a later batch fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: candidates(250), error: null },
      'inventory_items.update': (call) => {
        n += 1;
        if (n === 2) return { data: null, error: { message: 'statement timeout' } };
        return { data: idsOf(call, 'id').map((id) => ({ id, name: 'x' })), error: null };
      },
    });
    const res = await purgeExpiredArchivedItems(makeServiceContext(stub.client) as never, 90);
    expect(res.deleted).toBe(100);
    expect(res.failed).toBe(150);
    expect(auditedRows()).toHaveLength(100);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const tags = reportError.mock.calls.map(
      (c) => (c as unknown as [Error, { tag: string }])[1].tag,
    );
    expect(tags).toEqual(['archive_cleanup.purge.partial']);
  });

  it('throws when the first batch fails', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: candidates(250), error: null },
      'inventory_items.update': { data: null, error: { message: 'boom' } },
    });
    await expect(
      purgeExpiredArchivedItems(makeServiceContext(stub.client) as never, 90),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('notifyAutoArchived with 150 recipients', () => {
  const users = Array.from({ length: 150 }, (_, i) => ({ user_id: uuid(1000 + i) }));

  it('reads preferences in batches of at most 100 and honours an opt-out in the second batch', async () => {
    vi.mocked(createNotification).mockClear();
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'organization_members.select': { data: users, error: null },
      'notification_preferences.select': (call) => {
        const list = idsOf(call, 'user_id');
        lists.push(list);
        return {
          data: list
            .filter((id) => id === uuid(1149))
            .map((user_id) => ({ user_id, push_item_auto_archived: false })),
          error: null,
        };
      },
    });
    await notifyAutoArchived(stub.client, 'org-test', [{ id: 'item-1', name: 'Widget' }]);
    expect(lists.map((l) => l.length)).toEqual([100, 50]);
    expect(vi.mocked(createNotification)).toHaveBeenCalledTimes(149);
  });

  it('notifies everyone (the old default) and reports when the preference read fails', async () => {
    vi.mocked(createNotification).mockClear();
    const stub = makeSupabaseStub({
      'organization_members.select': { data: users, error: null },
      'notification_preferences.select': { data: null, error: { message: 'fetch failed' } },
    });
    await notifyAutoArchived(stub.client, 'org-test', [{ id: 'item-1', name: 'Widget' }]);
    expect(vi.mocked(createNotification)).toHaveBeenCalledTimes(150);
    const tags = reportError.mock.calls.map(
      (c) => (c as unknown as [Error, { tag: string }])[1].tag,
    );
    expect(tags).toEqual(['auto_archive.notify.preferences']);
  });
});
