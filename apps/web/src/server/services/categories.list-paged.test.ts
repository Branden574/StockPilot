import { describe, expect, it } from 'vitest';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
  type QueryResult,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { CategoriesService } from './categories';

/**
 * CategoriesService.list was ONE read ordered by name, with no range, so
 * PostgREST's 1000-row max_rows cut it off with no error: an organization with
 * more than 1000 categories lost every category whose name sorts past the
 * first 1000 from the Category filter on Items and Books (staff and viewers),
 * the add and edit forms and the Categories page, where those rows could not
 * be edited, archived or restored (B47). The list is now read page by page,
 * ordered by name and then id, so a page boundary never repeats or skips a row.
 */

const ORG = 'org-test';

function categories(n: number, over: Record<string, unknown> = {}, prefix = 'A cat') {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    organization_id: ORG,
    name: `${prefix} ${String(i).padStart(4, '0')}`,
    deleted_at: null,
    ...over,
  }));
}

const ZEBRA = {
  id: 'ffffffff-0000-4000-8000-000000000001',
  organization_id: ORG,
  name: 'Zebra',
  deleted_at: null,
};

/** Soft-deleted rows and another organization's rows: never listed. */
const SOFT_DELETED = categories(5, { deleted_at: '2026-01-01T00:00:00Z' }, 'B gone').map(
  (c, i) => ({
    ...c,
    id: `eeeeeeee-0000-4000-8000-${String(i).padStart(12, '0')}`,
  }),
);
const OTHER_ORG = categories(3, { organization_id: 'org-other' }, 'A other').map((c, i) => ({
  ...c,
  id: `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`,
}));

/** The arguments of every call to `method` on page `page` of `key`. */
function pageArgs(stub: SupabaseStub, key: string, page: number, method: string): unknown[][] {
  const methods = stub.chainsAll.get(key)?.[page] ?? [];
  const args = stub.chainArgsAll.get(key)?.[page] ?? [];
  return methods.flatMap((m, i) => (m === method ? [args[i]!] : []));
}

function svc(rows: ReadonlyArray<Record<string, unknown>> | ((call: MockCall) => QueryResult)) {
  const stub = makeSupabaseStub({
    'categories.select': typeof rows === 'function' ? rows : servedLikePostgrest(rows),
  });
  return { stub, service: new CategoriesService(makeServiceContext(stub.client) as never) };
}

describe('CategoriesService.list reads every page', () => {
  it('returns a category past the first 1000 by name, in two pages ordered by name then id', async () => {
    const { stub, service } = svc([...categories(1200), ZEBRA, ...SOFT_DELETED, ...OTHER_ORG]);

    const list = await service.list();

    expect(list).toHaveLength(1201);
    expect(list.at(-1)?.id).toBe(ZEBRA.id);
    expect(stub.chainsAll.get('categories.select')).toHaveLength(2);
    expect(pageArgs(stub, 'categories.select', 0, 'order').map((a) => a[0])).toEqual([
      'name',
      'id',
    ]);
    expect(pageArgs(stub, 'categories.select', 0, 'range')).toEqual([[0, 999]]);
    expect(pageArgs(stub, 'categories.select', 1, 'range')).toEqual([[1000, 1999]]);
    // Every page keeps the organization and the not-deleted filters.
    for (const page of [0, 1]) {
      expect(pageArgs(stub, 'categories.select', page, 'eq')).toContainEqual([
        'organization_id',
        ORG,
      ]);
      expect(pageArgs(stub, 'categories.select', page, 'is')).toContainEqual(['deleted_at', null]);
    }
  });

  it('1001 categories sharing one name come back once each (the id breaks the tie)', async () => {
    const same = categories(1001).map((c) => ({ ...c, name: 'Same' }));
    const { service } = svc(same);

    const list = await service.list();

    expect(list).toHaveLength(1001);
    expect(new Set(list.map((c) => c.id)).size).toBe(1001);
  });

  it('includeArchived returns exactly the archived categories, every page of them', async () => {
    const archived = categories(1200, { deleted_at: '2026-02-01T00:00:00Z' });
    const live = categories(3, {}, 'B live').map((c, i) => ({
      ...c,
      id: `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    const { service } = svc([...archived, ...live, ...OTHER_ORG]);

    const list = await service.list({ includeArchived: true });

    expect(list).toHaveLength(1200);
    expect(list.every((c) => c.deleted_at !== null)).toBe(true);
  });

  it('a failed second page rejects with internal_error, keeping the PostgREST text for the log', async () => {
    const served = servedLikePostgrest([...categories(1200), ZEBRA]);
    let calls = 0;
    const { service } = svc((call) => {
      calls += 1;
      return calls === 1 ? served(call) : { data: null, error: { message: 'statement timeout' } };
    });

    await expect(service.list()).rejects.toMatchObject({
      code: 'internal_error',
      internalDetail: expect.stringContaining('statement timeout'),
    });
    expect(calls).toBe(2);
  });
});
