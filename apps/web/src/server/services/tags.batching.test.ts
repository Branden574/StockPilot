import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tags and team membership batch their id lists.
 *
 * An org's tags and members have no cap and a bulk selection carries up to
 * 500 items. One `.in()` past ~215 uuids answers 414 locally and fails as
 * "fetch failed" in production after ~7 s of retries.
 *
 * The bulk tag removal is a cross product: the tag list rides in EVERY
 * request beside a batch of item ids, so tags are capped at MAX_BULK_TAGS and
 * each item batch gets the budget the tags leave. A removal that stops
 * partway audits and returns what it did.
 */

const { audit, auditMany } = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({
    written: payloads.length,
    lost: 0,
  })),
}));
vi.mock('./audit', () => ({ audit, auditMany }));

/** Rows handed to the ONE batched audit write (never one audit() per row). */
function auditedRowCount(): number {
  expect(audit).not.toHaveBeenCalled();
  expect(auditMany).toHaveBeenCalledTimes(1);
  return (auditMany.mock.calls[0]![0] as unknown[]).length;
}
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn() }));

import { encodedInValueLength, IN_FILTER_MAX_ENCODED_CHARS } from '@/lib/supabase/in-filter';
import {
  callArgs,
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { MAX_BULK_TAGS, TagsService } from './tags';
import { TeamService } from './team';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}
const ITEMS = Array.from({ length: 250 }, (_, i) => uuid(i, 'a'));
const TAGS = Array.from({ length: 20 }, (_, i) => uuid(i, 't'));

beforeEach(() => vi.clearAllMocks());

describe('TagsService.listWithCounts with 250 tags', () => {
  it('counts in batches of at most 100 tags, paging each batch', async () => {
    const tags = Array.from({ length: 250 }, (_, i) => ({
      id: uuid(i, 't'),
      name: `T${i}`,
      color: null,
      created_at: '2026-01-01',
    }));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'tags.select': { data: tags, error: null },
      'item_tags.select': (call) => {
        const list = inList(call, 'tag_id');
        lists.push(list);
        // The last tag is on 1200 items: past one 1000-row page.
        const rows = list.flatMap((tag_id) =>
          tag_id === uuid(249, 't')
            ? Array.from({ length: 1200 }, () => ({ tag_id }))
            : [{ tag_id }],
        );
        const [from, to] = (callArgs(call, 'range') ?? [0, 999]) as [number, number];
        return { data: rows.slice(from, to + 1), error: null };
      },
    });
    const out = await new TagsService(makeServiceContext(stub.client) as never).listWithCounts();
    expect(lists.filter((_, i) => i < 3).map((l) => l.length)).toEqual([100, 100, 50]);
    expect(out.find((t) => t.id === uuid(249, 't'))?.usage_count).toBe(1200);
  });
});

describe('TagsService.bulkRemoveFromItems with 250 items', () => {
  function stubWith(opts: { failDeleteBatch?: number } = {}) {
    let n = 0;
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'tags.select': (call) => ({ data: inList(call, 'id').map((id) => ({ id })), error: null }),
      'inventory_items.select': (call) => ({
        data: inList(call, 'id').map((id) => ({ id })),
        error: null,
      }),
      'item_tags.delete': (call) => {
        n += 1;
        lists.push(inList(call, 'item_id'));
        return n === opts.failDeleteBatch
          ? { data: null, error: { message: 'boom' } }
          : { data: null, error: null };
      },
    });
    return { stub, lists };
  }

  it('deletes in item batches that leave room for the tag list in each URL', async () => {
    const { stub, lists } = stubWith();
    const res = await new TagsService(makeServiceContext(stub.client) as never).bulkRemoveFromItems(
      ITEMS,
      TAGS,
    );
    expect(res.written).toHaveLength(250);
    expect(lists.flat()).toHaveLength(250);
    const tagChars = TAGS.reduce((n, id) => n + encodedInValueLength(id) + 3, 0);
    for (const l of lists) {
      const itemChars = l.reduce((n, id) => n + encodedInValueLength(id) + 3, 0);
      expect(itemChars + tagChars).toBeLessThanOrEqual(IN_FILTER_MAX_ENCODED_CHARS);
    }
    expect(auditedRowCount()).toBe(250);
  });

  it('returns and audits only what was removed when a later batch fails', async () => {
    const { stub, lists } = stubWith({ failDeleteBatch: 2 });
    const res = await new TagsService(makeServiceContext(stub.client) as never).bulkRemoveFromItems(
      ITEMS,
      TAGS,
    );
    const first = lists[0] ?? [];
    expect(res.written).toEqual(first);
    expect(res.notWritten).toHaveLength(250 - first.length);
    expect(auditedRowCount()).toBe(first.length);
  });

  it('throws when the first batch fails', async () => {
    const { stub } = stubWith({ failDeleteBatch: 1 });
    await expect(
      new TagsService(makeServiceContext(stub.client) as never).bulkRemoveFromItems(ITEMS, TAGS),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(audit).not.toHaveBeenCalled();
    expect(auditMany).not.toHaveBeenCalled();
  });

  it(`refuses more than ${MAX_BULK_TAGS} tags before any read`, async () => {
    const { stub } = stubWith();
    const many = Array.from({ length: MAX_BULK_TAGS + 1 }, (_, i) => uuid(i, 't'));
    await expect(
      new TagsService(makeServiceContext(stub.client) as never).bulkRemoveFromItems(ITEMS, many),
    ).rejects.toMatchObject({ code: 'validation_error' });
    await expect(
      new TagsService(makeServiceContext(stub.client) as never).bulkAddToItems(ITEMS, many),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.fromCalls).toEqual([]);
  });
});

describe('TagsService.setForItem removing 150 tags', () => {
  it('deletes the removed tags in batches and audits each', async () => {
    const existing = Array.from({ length: 150 }, (_, i) => ({ tag_id: uuid(i, 't') }));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1' }], error: null },
      'item_tags.select': { data: existing, error: null },
      'item_tags.delete': (call) => {
        lists.push(inList(call, 'tag_id'));
        return { data: null, error: null };
      },
    });
    await new TagsService(makeServiceContext(stub.client) as never).setForItem('item-1', []);
    expect(lists.map((l) => l.length)).toEqual([100, 50]);
    expect(auditedRowCount()).toBe(150);
  });

  it('audits the tags it adds in one batched write', async () => {
    const tags = Array.from({ length: 60 }, (_, i) => uuid(i, 't'));
    const stub = makeSupabaseStub({
      'tags.select': { data: tags.map((id) => ({ id })), error: null },
      'inventory_items.select': { data: [{ id: 'item-1' }], error: null },
      'item_tags.select': { data: [], error: null },
      'item_tags.insert': { data: null, error: null },
    });
    await new TagsService(makeServiceContext(stub.client) as never).setForItem('item-1', tags);
    expect(auditedRowCount()).toBe(60);
    expect(auditMany.mock.calls[0]![0]).toContainEqual({
      event: 'tag.applied',
      entityType: 'inventory_item',
      entityId: 'item-1',
      extra: { tag_id: tags[0] },
    });
  });

  it('audits the tags a committed batch removed even when a later batch fails', async () => {
    const existing = Array.from({ length: 150 }, (_, i) => ({ tag_id: uuid(i, 't') }));
    let n = 0;
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: [{ id: 'item-1' }], error: null },
      'item_tags.select': { data: existing, error: null },
      'item_tags.delete': () => {
        n += 1;
        return n === 2 ? { data: null, error: { message: 'boom' } } : { data: null, error: null };
      },
    });
    await expect(
      new TagsService(makeServiceContext(stub.client) as never).setForItem('item-1', []),
    ).rejects.toMatchObject({ code: 'internal_error' });
    expect(auditedRowCount()).toBe(100);
  });
});

describe('TeamService.listMembers with 250 members', () => {
  it('reads warehouse assignments in batches of at most 100', async () => {
    const members = Array.from({ length: 250 }, (_, i) => ({
      id: `m-${i}`,
      role: 'staff',
      user_id: uuid(i, 'u'),
      created_at: '2026-01-01',
      user: { id: uuid(i, 'u'), email: `u${i}@x.test`, full_name: null },
    }));
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'organization_members.select': { data: members, error: null },
      'user_warehouse_assignments.select': (call) => {
        const list = inList(call, 'user_id');
        lists.push(list);
        return {
          data: list.map((user_id) => ({
            user_id,
            warehouse_id: 'wh-1',
            charter_id: null,
            is_primary: true,
          })),
          error: null,
        };
      },
    });
    const out = await new TeamService(makeServiceContext(stub.client) as never).listMembers();
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(out.at(-1)?.warehouse_id).toBe('wh-1');
  });

  it('throws when an assignment batch fails', async () => {
    let n = 0;
    const stub = makeSupabaseStub({
      'organization_members.select': {
        data: Array.from({ length: 250 }, (_, i) => ({
          id: `m-${i}`,
          role: 'staff',
          user_id: uuid(i, 'u'),
        })),
        error: null,
      },
      'user_warehouse_assignments.select': () => {
        n += 1;
        return n === 2 ? { data: null, error: { message: 'boom' } } : { data: [], error: null };
      },
    });
    await expect(
      new TeamService(makeServiceContext(stub.client) as never).listMembers(),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});
