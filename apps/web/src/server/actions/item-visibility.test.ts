import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bulk public visibility on up to 500 items.
 *
 * The read (the tenancy check and the audit's before-distribution) and the
 * write each sent every id in one `.in()`: past ~215 uuids the local gateway
 * answers 414, past ~395 production fails after ~7 s of retries. Both now go
 * 100 at a time; the write stops at the first failed batch, and what DID
 * commit is invalidated, audited and revalidated before the partial failure is
 * reported.
 */

const { adminRef, audit, invalidate, reportError, revalidateTag } = vi.hoisted(() => ({
  adminRef: { current: null as unknown },
  audit: vi.fn(async () => undefined),
  invalidate: vi.fn(),
  reportError: vi.fn(async () => {}),
  revalidateTag: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/server/services/audit', () => ({ audit }));
vi.mock('@/server/services/lib/inventory-list-cache', () => ({
  invalidateInventoryListAfterWrite: invalidate,
}));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...actual,
    withContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'user-1', role: 'admin' })),
    assertPermission: vi.fn(),
  };
});

import { inFilters, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { bulkSetItemPublicVisibilityAction } from './item-visibility';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = Array.from({ length: 250 }, (_, i) => uuid(i));
const inList = (call: MockCall) => (inFilters(call).find(([c]) => c === 'id')?.[1] ?? []) as string[];

function stubWith(opts: { failRead?: number; failWrite?: number }) {
  const readLists: string[][] = [];
  const writeLists: string[][] = [];
  const stub = makeSupabaseStub({
    'inventory_items.select': (call) => {
      const list = inList(call);
      readLists.push(list);
      if (readLists.length === opts.failRead) return { data: null, error: { message: 'fetch failed' } };
      return { data: list.map((id) => ({ id, public_visibility: 'internal_only' })), error: null };
    },
    'inventory_items.update': (call) => {
      const list = inList(call);
      writeLists.push(list);
      if (writeLists.length === opts.failWrite) {
        return { data: null, error: { message: 'fetch failed' } };
      }
      return { data: list.map((id) => ({ id })), error: null };
    },
    'public_request_links.select': { data: [{ id: 'link-1' }], error: null },
  });
  adminRef.current = stub.client;
  return { readLists, writeLists };
}

beforeEach(() => vi.clearAllMocks());

describe('bulkSetItemPublicVisibilityAction with 250 items', () => {
  it('reads and writes in batches of at most 100 and audits all 250', async () => {
    const { readLists, writeLists } = stubWith({});
    const r = await bulkSetItemPublicVisibilityAction({ itemIds: ids, visibility: 'public' });
    expect(r).toEqual({ ok: true, data: { updated: 250, visibility: 'public' } });
    expect(readLists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(writeLists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({ count: 250, item_ids: ids }),
        before: { public_visibility_counts: { internal_only: 250 } },
      }),
      expect.anything(),
    );
  });

  it('a failed second write batch: says how many changed, and still invalidates, audits and revalidates the 100 that did', async () => {
    const { writeLists } = stubWith({ failWrite: 2 });
    const r = await bulkSetItemPublicVisibilityAction({ itemIds: ids, visibility: 'hidden' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('internal_error');
    expect(r.error.message).toBe(
      'Changed 100 of 250 items before an error stopped the rest. Run it again to finish.',
    );
    // Stopped at the failure: no third batch.
    expect(writeLists).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({ count: 100, item_ids: ids.slice(0, 100) }),
      }),
      expect.anything(),
    );
    expect(revalidateTag).toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'item_visibility.bulk.partial',
        extra: expect.objectContaining({ written: 100, notWritten: 150 }),
      }),
    );
  });

  it('a failed read batch writes nothing', async () => {
    const { writeLists } = stubWith({ failRead: 2 });
    const r = await bulkSetItemPublicVisibilityAction({ itemIds: ids, visibility: 'public' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal_error');
    expect(writeLists).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a failed first write batch changes nothing and is a plain internal error', async () => {
    stubWith({ failWrite: 1 });
    const r = await bulkSetItemPublicVisibilityAction({ itemIds: ids, visibility: 'public' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal_error');
    expect(invalidate).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
});
