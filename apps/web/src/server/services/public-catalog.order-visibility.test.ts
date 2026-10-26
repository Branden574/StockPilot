import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ordering visibility (0413, design 7.2 item 5) on a public request link's
 * page. public_link_eligible_items leaves out an item hidden from ordering, so
 * a fresh entry never holds one. The entry is cached for 60 s per (link,
 * warehouse), and an entry read before a hide can be served (or stored as
 * fresh) after it, so the page removes, uncached, every item of the warehouse
 * hidden since 30 s before the entry's read began. The page has no request
 * context and so no hide mark: the check always runs when the entry has rows.
 *
 * A Show or Hide expires every link's entry of the organization with
 * { expire: 0 } through expireOrgPublicCatalogs, never 'max'.
 */

const { adminRef, revalidateTag, unstableCache } = vi.hoisted(() => ({
  adminRef: { current: null as unknown },
  revalidateTag: vi.fn(),
  unstableCache: vi.fn((fn: unknown) => fn),
}));
vi.mock('next/cache', () => ({ unstable_cache: unstableCache, revalidateTag }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { expireOrgPublicCatalogs, getPublicCatalogForLink } from './public-catalog';

const ORG = 'org-1';
const WH = 'wh-1';
const LINK = { id: 'link-1', organizationId: ORG, availabilityDisplay: 'exact' as const };
const T0 = Date.parse('2026-10-26T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const entryItem = (id: string) => ({
  id,
  displayName: id,
  publicDescription: null,
  itemType: 'book',
  categoryLabel: null,
  availability: { kind: 'none' },
  maxQty: null,
  lqip: null,
});

/** The next cached entry answers `ids`, read at `readStartedAt`. */
function cachedEntry(ids: string[], readStartedAt: number) {
  unstableCache.mockImplementationOnce((() => async () => ({
    items: ids.map(entryItem),
    readStartedAt,
  })) as never);
}

/** The overlay's admin read, evaluated against `rows` with its filters. */
function overlayAdmin(rows: Array<Record<string, unknown>>) {
  const stub = makeSupabaseStub({ 'inventory_items.select': servedLikePostgrest(rows) });
  adminRef.current = stub.client;
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getPublicCatalogForLink and items hidden from ordering', () => {
  it('removes an item hidden after the cached entry was read', async () => {
    const stub = overlayAdmin([
      {
        id: 'book-b',
        organization_id: ORG,
        warehouse_id: WH,
        order_catalog_visible: false,
        order_catalog_visibility_changed_at: iso(T0 + 2_000),
      },
    ]);
    cachedEntry(['book-a', 'book-b'], T0);

    const out = await getPublicCatalogForLink(LINK, WH);

    expect(out.map((i) => i.id)).toEqual(['book-a']);
    const chain = stub.chainsAll.get('inventory_items.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('inventory_items.select')?.[0] ?? [];
    const calls = chain.map((m, i) => [m, args[i]]);
    expect(calls).toContainEqual(['eq', ['organization_id', ORG]]);
    expect(calls).toContainEqual(['eq', ['warehouse_id', WH]]);
    expect(calls).toContainEqual(['eq', ['order_catalog_visible', false]]);
    expect(calls).toContainEqual(['gte', ['order_catalog_visibility_changed_at', iso(T0 - 30_000)]]);
  });

  it('keeps every item when nothing was hidden since the read', async () => {
    overlayAdmin([
      {
        id: 'book-b',
        organization_id: ORG,
        warehouse_id: WH,
        order_catalog_visible: false,
        // Hidden long before the entry was read: the entry never held it.
        order_catalog_visibility_changed_at: iso(T0 - 3_600_000),
      },
    ]);
    cachedEntry(['book-a', 'book-c'], T0);

    const out = await getPublicCatalogForLink(LINK, WH);

    expect(out.map((i) => i.id)).toEqual(['book-a', 'book-c']);
  });

  it('a failed check fails the page closed', async () => {
    adminRef.current = makeSupabaseStub({
      'inventory_items.select': { data: null, error: { message: 'canceling statement' } },
    }).client;
    cachedEntry(['book-a'], T0);

    await expect(getPublicCatalogForLink(LINK, WH)).rejects.toThrow(/recently hidden read failed/);
  });

  it('an empty entry makes no check', async () => {
    const stub = overlayAdmin([]);
    cachedEntry([], T0);

    expect(await getPublicCatalogForLink(LINK, WH)).toEqual([]);
    expect(stub.fromCalls).not.toContain('inventory_items');
  });

  it('the entry is keyed v2, tagged per link, and carries its read time', async () => {
    adminRef.current = makeSupabaseStub({
      'rpc:public_link_eligible_items': { data: [], error: null },
    }).client;
    const before = Date.now();

    await getPublicCatalogForLink(LINK, WH);

    const call = unstableCache.mock.calls.at(-1) as unknown as [
      (...a: unknown[]) => Promise<{ items: unknown[]; readStartedAt: number }>,
      string[],
      { revalidate: number; tags: string[] },
    ];
    expect(call[1]).toEqual(['public-link-catalog-v2']);
    expect(call[2]).toEqual({ revalidate: 60, tags: ['public-catalog-link-1'] });
    const value = await call[0]('link-1', ORG, WH, 'exact');
    expect(value.items).toEqual([]);
    expect(value.readStartedAt).toBeGreaterThanOrEqual(before);
  });
});

describe('expireOrgPublicCatalogs', () => {
  it("expires every link's catalog of the organization with expire: 0, never 'max'", async () => {
    const stub = makeSupabaseStub({
      'public_request_links.select': servedLikePostgrest([
        { id: 'link-1', organization_id: ORG },
        { id: 'link-2', organization_id: ORG },
        { id: 'link-x', organization_id: 'org-other' },
      ]),
    });
    adminRef.current = stub.client;

    const n = await expireOrgPublicCatalogs(ORG);

    expect(n).toBe(2);
    expect(revalidateTag.mock.calls).toEqual([
      ['public-catalog-link-1', { expire: 0 }],
      ['public-catalog-link-2', { expire: 0 }],
    ]);
  });

  it('throws on a failed read, expiring nothing (the caller logs it)', async () => {
    adminRef.current = makeSupabaseStub({
      'public_request_links.select': { data: null, error: { message: 'boom' } },
    }).client;

    await expect(expireOrgPublicCatalogs(ORG)).rejects.toThrow();
    expect(revalidateTag).not.toHaveBeenCalled();
  });
});
