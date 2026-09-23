import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public catalog and the link editor batch their id lists.
 *
 * A link's catalog serves up to 500 items and the editor changes up to 1000
 * at once. One `.in()` past ~215 uuids answers 414 locally and fails as
 * "fetch failed" in production after ~7 s of retries. The catalog's item and
 * reservation reads ignored their errors: items silently dropped out and
 * reserved stock read as available, cached for 60 s. Both now throw (a throw
 * is never cached); categories and blur placeholders degrade, reported.
 */

const { reportError, adminRef, revalidateTag } = vi.hoisted(() => ({
  reportError: vi.fn(async () => {}),
  adminRef: { current: null as unknown },
  revalidateTag: vi.fn(),
}));
vi.mock('next/cache', () => ({ unstable_cache: vi.fn((fn: unknown) => fn), revalidateTag }));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

import {
  inFilters,
  makeServiceContext,
  makeSupabaseStub,
  type MockCall,
} from '@/test/supabase-mock';

import { audit } from './audit';
import { getPublicCatalogForLink } from './public-catalog';
import { PublicLinksService } from './public-links';

const uuid = (i: number, p = '0') => `${p.repeat(8)}-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ITEMS = Array.from({ length: 250 }, (_, i) => uuid(i, 'a'));
const LINK = { id: 'link-1', organizationId: 'org-1', availabilityDisplay: 'exact' as const };

function inList(call: MockCall, column: string): string[] {
  return (inFilters(call).find(([c]) => c === column)?.[1] ?? []) as string[];
}
const tags = () =>
  reportError.mock.calls.map((c) => (c as unknown as [Error, { tag: string }])[1].tag);

function catalogAdmin(
  opts: {
    failItemsBatch?: number;
    failReservationBatch?: number;
    failCategories?: boolean;
    failLqip?: boolean;
  } = {},
) {
  let itemCalls = 0;
  let resvCalls = 0;
  const lists = { items: [] as string[][], resv: [] as string[][], lqip: [] as string[][] };
  const stub = makeSupabaseStub({
    'rpc:public_link_eligible_items': {
      data: ITEMS.map((item_id) => ({ item_id, max_qty: null })),
      error: null,
    },
    'inventory_items.select': (call) => {
      itemCalls += 1;
      const list = inList(call, 'id');
      lists.items.push(list);
      if (itemCalls === opts.failItemsBatch) return { data: null, error: { message: 'boom' } };
      return {
        data: list.map((id) => ({
          id,
          name: `Item ${id.slice(-3)}`,
          public_display_name: null,
          public_description: null,
          quantity_on_hand: 5,
          item_type: 'book',
          category_id: 'cat-1',
          custom_fields: null,
        })),
        error: null,
      };
    },
    'stock_reservations.select': (call) => {
      resvCalls += 1;
      const list = inList(call, 'item_id');
      lists.resv.push(list);
      if (resvCalls === opts.failReservationBatch) {
        return { data: null, error: { message: 'fetch failed' } };
      }
      // uuid(249) has 4 of its 5 units reserved; it sits in the last batch.
      return {
        data: list
          .filter((id) => id === uuid(249, 'a'))
          .map((item_id) => ({ item_id, quantity: 4 })),
        error: null,
      };
    },
    'categories.select': opts.failCategories
      ? { data: null, error: { message: 'boom' } }
      : { data: [{ id: 'cat-1', name: 'Novels' }], error: null },
    'item_images.select': (call) => {
      const list = inList(call, 'item_id');
      lists.lqip.push(list);
      if (opts.failLqip) return { data: null, error: { message: 'boom' } };
      return { data: list.map((item_id) => ({ item_id, lqip: `data:${item_id}` })), error: null };
    },
  });
  adminRef.current = stub.client;
  return lists;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getPublicCatalogForLink with 250 eligible items', () => {
  it('reads items, reservations and blurs in batches and nets a reservation from the last batch', async () => {
    const lists = catalogAdmin();
    const out = await getPublicCatalogForLink(LINK, 'wh-1');
    expect(lists.items.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(lists.resv.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(lists.lqip.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(out).toHaveLength(250);
    const last = out.find((i) => i.id === uuid(249, 'a'));
    expect(last?.availability).toEqual({ kind: 'exact', count: 1 });
    expect(last?.lqip).toBe(`data:${uuid(249, 'a')}`);
    expect(last?.categoryLabel).toBe('Novels');
  });

  it('throws when an item batch fails, instead of dropping its items', async () => {
    catalogAdmin({ failItemsBatch: 2 });
    await expect(getPublicCatalogForLink(LINK, 'wh-1')).rejects.toBeTruthy();
  });

  it('throws when a reservation batch fails, instead of showing reserved stock as available', async () => {
    catalogAdmin({ failReservationBatch: 3 });
    await expect(getPublicCatalogForLink(LINK, 'wh-1')).rejects.toBeTruthy();
  });

  it('still renders, reported, when category labels or blur placeholders fail', async () => {
    catalogAdmin({ failCategories: true, failLqip: true });
    const out = await getPublicCatalogForLink(LINK, 'wh-1');
    expect(out).toHaveLength(250);
    expect(out[0]?.categoryLabel).toBeNull();
    expect(out[0]?.lqip).toBeNull();
    expect(tags().sort()).toEqual(['public_catalog.categories', 'public_catalog.lqip']);
  });
});

describe('PublicLinksService entries with 250 items', () => {
  const svcFor = (client: unknown) =>
    new PublicLinksService(
      makeServiceContext(client, {
        enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'public_requests' as ModuleId]),
      }) as never,
    );

  it('addEntries checks the items in batches of at most 100', async () => {
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'public_request_links.select': { data: { id: 'link-1' }, error: null },
      'inventory_items.select': (call) => {
        const list = inList(call, 'id');
        lists.push(list);
        return { data: list.map((id) => ({ id })), error: null };
      },
      'public_link_catalog_entries.insert': { data: null, error: null },
    });
    const out = await svcFor(stub.client).addEntries('link-1', ITEMS);
    expect(lists.map((l) => l.length)).toEqual([100, 100, 50]);
    expect(out.added).toBe(250);
  });

  it('removeEntries deletes in batches and, on a partial failure, audits and revalidates what was removed', async () => {
    let n = 0;
    const lists: string[][] = [];
    const stub = makeSupabaseStub({
      'public_request_links.select': { data: { id: 'link-1' }, error: null },
      'public_link_catalog_entries.delete': (call) => {
        n += 1;
        lists.push(inList(call, 'item_id'));
        return n === 2 ? { data: null, error: { message: 'boom' } } : { data: null, error: null };
      },
    });
    const out = await svcFor(stub.client).removeEntries('link-1', ITEMS);
    expect(lists.map((l) => l.length)).toEqual([100, 100]);
    expect(out).toEqual({ removed: 100, failed: 150 });
    const auditArg = vi.mocked(audit).mock.calls[0]?.[0] as unknown as {
      extra: { item_ids: string[] };
    };
    expect(auditArg.extra.item_ids).toHaveLength(100);
    expect(revalidateTag).toHaveBeenCalled();
    expect(tags()).toEqual(['public_links.remove_entries.partial']);
  });

  it('removeEntries throws when the first batch fails and nothing was removed', async () => {
    const stub = makeSupabaseStub({
      'public_request_links.select': { data: { id: 'link-1' }, error: null },
      'public_link_catalog_entries.delete': { data: null, error: { message: 'boom' } },
    });
    await expect(svcFor(stub.client).removeEntries('link-1', ITEMS)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(vi.mocked(audit)).not.toHaveBeenCalled();
  });
});
