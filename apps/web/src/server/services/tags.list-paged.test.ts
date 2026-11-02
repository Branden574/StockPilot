import { describe, expect, it } from 'vitest';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { TagsService } from './tags';

/**
 * TagsService.list was ONE read ordered by name, with no range, so PostgREST's
 * 1000-row max_rows cut it off with no error: past 1000 tags, every tag whose
 * name sorts after the first 1000 was missing from the Tags picker on the add
 * and edit forms and from the Tags page (B47). The list is now read page by
 * page, ordered by name and then id. listWithCounts() builds on it, so the
 * Tags page counts every tag too.
 */

const ORG = 'org-test';

function tags(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    organization_id: ORG,
    name: `tag ${String(i).padStart(4, '0')}`,
    color: null,
    created_at: '2026-01-01T00:00:00Z',
  }));
}

const OTHER_ORG_TAG = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  organization_id: 'org-other',
  name: 'tag other',
  color: null,
  created_at: '2026-01-01T00:00:00Z',
};

function pageArgs(stub: SupabaseStub, key: string, page: number, method: string): unknown[][] {
  const methods = stub.chainsAll.get(key)?.[page] ?? [];
  const args = stub.chainArgsAll.get(key)?.[page] ?? [];
  return methods.flatMap((m, i) => (m === method ? [args[i]!] : []));
}

describe('TagsService.list reads every page', () => {
  it('returns all 1200 tags, ordered by name then id, in two pages', async () => {
    const rows = tags(1200);
    const stub = makeSupabaseStub({ 'tags.select': servedLikePostgrest([...rows, OTHER_ORG_TAG]) });

    const list = await new TagsService(makeServiceContext(stub.client) as never).list();

    expect(list.map((t) => t.id)).toEqual(rows.map((t) => t.id));
    expect(stub.chainsAll.get('tags.select')).toHaveLength(2);
    expect(pageArgs(stub, 'tags.select', 0, 'order').map((a) => a[0])).toEqual(['name', 'id']);
    expect(pageArgs(stub, 'tags.select', 0, 'range')).toEqual([[0, 999]]);
    expect(pageArgs(stub, 'tags.select', 1, 'range')).toEqual([[1000, 1999]]);
    for (const page of [0, 1]) {
      expect(pageArgs(stub, 'tags.select', page, 'eq')).toContainEqual(['organization_id', ORG]);
    }
  });

  it('listWithCounts includes the 1200th tag with its usage count', async () => {
    const rows = tags(1200);
    const last = rows[1199]!;
    const itemTags = [
      { item_id: 'item-1', tag_id: last.id },
      { item_id: 'item-2', tag_id: last.id },
      { item_id: 'item-3', tag_id: last.id },
      { item_id: 'item-1', tag_id: rows[0]!.id },
    ];
    const stub = makeSupabaseStub({
      'tags.select': servedLikePostgrest(rows),
      'item_tags.select': servedLikePostgrest(itemTags),
    });

    const list = await new TagsService(makeServiceContext(stub.client) as never).listWithCounts();

    expect(list).toHaveLength(1200);
    expect(list.find((t) => t.id === last.id)?.usage_count).toBe(3);
    expect(list.find((t) => t.id === rows[0]!.id)?.usage_count).toBe(1);
  });
});
