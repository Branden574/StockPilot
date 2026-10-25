import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A request link's catalog shows EVERY eligible item (B32).
 *
 * Two silent cuts used to apply. The loader kept the first 500 items by name
 * (CATALOG_LIMIT), so item 501 was neither shown nor searchable on the public
 * page. And the eligibility function was read in one unpaged request, which
 * PostgREST answers with at most 1000 rows (max_rows) in no stated order, so
 * past 1000 eligible items an arbitrary set dropped out. The read is now paged
 * in item_id order to the internal storefront's ceiling (10,000), and reaching
 * that ceiling is logged, never silent.
 *
 * The stub answers like PostgREST (servedLikePostgrest): an unpaged read gets
 * 1000 rows, exactly as production would.
 */

const { adminRef } = vi.hoisted(() => ({ adminRef: { current: null as unknown } }));
vi.mock('next/cache', () => ({
  unstable_cache: vi.fn((fn: unknown) => fn),
  revalidateTag: vi.fn(),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));

import { CATALOG_ROW_CEILING } from '@/server/loaders/orders-new-catalog';
import {
  callArgs,
  makeSupabaseStub,
  servedLikePostgrest,
  type MockCall,
} from '@/test/supabase-mock';

import {
  getPublicCatalogForLink,
  PUBLIC_CATALOG_ROW_CEILING,
  readEligibleItems,
} from './public-catalog';

const ORG = 'org-1';
const LINK = { id: 'link-1', organizationId: ORG, availabilityDisplay: 'exact' as const };
const uuid = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;

/** n eligible items named "Item 00000" .. so the name order is the id order. */
function wire(n: number) {
  const ids = Array.from({ length: n }, (_, i) => uuid(i));
  const rpcCalls: MockCall[] = [];
  const eligible = servedLikePostgrest(ids.map((item_id) => ({ item_id, max_qty: null })));
  const stub = makeSupabaseStub({
    'rpc:public_link_eligible_items': (call) => {
      // The stub also answers a chained rpc once at call time, before its
      // chain exists (supabase-mock.ts makeRpcChain): record only the read
      // the code awaited, which carries its order and range.
      if (call.methods.length > 1) rpcCalls.push(call);
      return eligible(call);
    },
    'inventory_items.select': servedLikePostgrest(
      ids.map((id, i) => ({
        id,
        organization_id: ORG,
        name: `Item ${String(i).padStart(5, '0')}`,
        public_display_name: null,
        public_description: null,
        quantity_on_hand: 3,
        item_type: 'book',
        category_id: null,
        custom_fields: null,
      })),
    ),
    'stock_reservations.select': servedLikePostgrest([]),
    'categories.select': servedLikePostgrest([]),
    'item_images.select': { data: [], error: null },
  });
  adminRef.current = stub.client;
  return { ids, rpcCalls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('getPublicCatalogForLink: no silent cut at 500 or 1000 items', () => {
  it('500 eligible items: all 500', async () => {
    wire(500);
    expect(await getPublicCatalogForLink(LINK, 'wh-1')).toHaveLength(500);
  });

  // Mutation caught: the old `items.slice(0, 500)`.
  it('501 eligible items: all 501, the last one by name included', async () => {
    const { ids } = wire(501);
    const out = await getPublicCatalogForLink(LINK, 'wh-1');
    expect(out).toHaveLength(501);
    expect(out.at(-1)?.id).toBe(ids[500]);
  });

  it('1000 eligible items: all 1000, in one eligibility page', async () => {
    const { rpcCalls } = wire(1000);
    expect(await getPublicCatalogForLink(LINK, 'wh-1')).toHaveLength(1000);
    // A full first page asks for the next one, which comes back empty.
    expect(rpcCalls.map((c) => callArgs(c, 'range'))).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  // Mutation caught: the unpaged rpc read, which PostgREST cuts at 1000 rows.
  it('1001 eligible items: all 1001, read in item_id order across two pages', async () => {
    const { ids, rpcCalls } = wire(1001);
    const out = await getPublicCatalogForLink(LINK, 'wh-1');
    expect(out).toHaveLength(1001);
    expect(new Set(out.map((i) => i.id))).toEqual(new Set(ids));
    expect(rpcCalls).toHaveLength(2);
    for (const call of rpcCalls) {
      expect(callArgs(call, 'order')).toEqual(['item_id', { ascending: true }]);
    }
  });
});

describe('readEligibleItems: the ceiling', () => {
  it('is the internal storefront ceiling', () => {
    expect(PUBLIC_CATALOG_ROW_CEILING).toBe(CATALOG_ROW_CEILING);
  });

  it('stops at the ceiling and says so in the log', async () => {
    wire(7);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = await readEligibleItems(adminRef.current as never, 'link-1', 'wh-1', {
      ceiling: 5,
    });
    expect(rows.map((r) => r.item_id)).toEqual([0, 1, 2, 3, 4].map(uuid));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/5-item ceiling/);
  });

  it('under the ceiling: every row and no log', async () => {
    wire(4);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rows = await readEligibleItems(adminRef.current as never, 'link-1', 'wh-1', {
      ceiling: 5,
    });
    expect(rows).toHaveLength(4);
    expect(log).not.toHaveBeenCalled();
  });

  it('a failed page fails the read (never the rows before it as the whole catalog)', async () => {
    const stub = makeSupabaseStub({
      'rpc:public_link_eligible_items': (call) =>
        (callArgs(call, 'range')?.[0] as number) === 0
          ? {
              data: Array.from({ length: 1000 }, (_, i) => ({ item_id: uuid(i), max_qty: null })),
              error: null,
            }
          : { data: null, error: { message: 'fetch failed' } },
    });
    await expect(readEligibleItems(stub.client, 'link-1', 'wh-1')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});
