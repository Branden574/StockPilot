import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public request page's deferred photos (B32).
 *
 * The route signed only the first 500 eligible items, in the eligibility
 * function's own order, from one unpaged read that PostgREST cuts at 1000
 * rows: past 500 items the photos it signed were a different set from the
 * items the page showed. It now reads the same pages, in the same order and
 * to the same ceiling as the page (readEligibleItems), and signs them all
 * (the signer calls storage in 1000-path chunks, SIGN_PATHS_PER_CALL).
 *
 * A failed eligibility read used to answer an empty map with the public
 * CDN cache header: a minute (and five more stale) of a catalog with no
 * photos, for everyone. It now answers 500, uncached, and the page's
 * thumbnail hook retries.
 *
 * A legacy organization token (no links row) shows an EMPTY catalog on the
 * page (r/[token]/page.tsx), so there is nothing to sign: it used to sign up
 * to 500 book photos no page displayed.
 */

const { adminRef, signed } = vi.hoisted(() => ({
  adminRef: { current: null as unknown },
  signed: { ids: [] as string[][] },
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminRef.current }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    async primaryMasterUrlsForItems(ids: string[]) {
      signed.ids.push(ids);
      return new Map(ids.map((id) => [id, `https://signed.test/${id}`]));
    }
  },
}));

import { makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { GET } from './route';

const WAREHOUSE = '11111111-1111-4111-8111-111111111111';
const uuid = (i: number) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;

function get(token = 'tok_test_value') {
  return GET(
    new NextRequest(
      `https://test.local/api/v1/public/catalog-thumbnails?token=${token}&warehouseId=${WAREHOUSE}`,
    ),
  );
}

function wire(opts: { eligible?: number; link?: 'open' | 'closed' | 'none'; failRpc?: boolean }) {
  const ids = Array.from({ length: opts.eligible ?? 0 }, (_, i) => uuid(i));
  const link = opts.link ?? 'open';
  const stub = makeSupabaseStub({
    'public_request_links.select.maybeSingle': {
      data:
        link === 'none'
          ? null
          : {
              id: 'link-1',
              organization_id: 'org-1',
              active: link === 'open',
              expires_at: null,
              available_from: null,
              available_until: null,
            },
      error: null,
    },
    'organizations.select.maybeSingle': { data: { id: 'org-1' }, error: null },
    'organization_modules.select.maybeSingle': {
      data: { module_id: 'public_requests' },
      error: null,
    },
    'warehouses.select.maybeSingle': { data: { id: WAREHOUSE }, error: null },
    'rpc:public_link_eligible_items': opts.failRpc
      ? { data: null, error: { message: 'fetch failed' } }
      : servedLikePostgrest(ids.map((item_id) => ({ item_id, max_qty: null }))),
    'inventory_items.select': { data: [], error: null },
  });
  adminRef.current = stub.client;
  return { ids, stub };
}

beforeEach(() => {
  signed.ids = [];
});

describe('GET /api/v1/public/catalog-thumbnails: every eligible item', () => {
  it('500 eligible: signs all 500', async () => {
    const { ids } = wire({ eligible: 500 });
    const res = await get();
    expect(res.status).toBe(200);
    expect(signed.ids).toEqual([ids]);
  });

  // Mutation caught: the old `.slice(0, 500)`.
  it('501 eligible: signs all 501 and returns a URL for the 501st', async () => {
    const { ids } = wire({ eligible: 501 });
    const res = await get();
    const body = (await res.json()) as { urls: Record<string, string> };
    expect(signed.ids[0]).toHaveLength(501);
    expect(body.urls[ids[500]!]).toBe(`https://signed.test/${ids[500]}`);
  });

  // Mutation caught: the unpaged rpc read, cut by PostgREST at 1000 rows.
  it('1001 eligible: signs all 1001, the same set the page shows', async () => {
    const { ids } = wire({ eligible: 1001 });
    await get();
    expect(signed.ids[0]).toEqual(ids);
  });

  it('a closed link still answers an empty map (unchanged)', async () => {
    wire({ eligible: 3, link: 'closed' });
    const res = await get();
    expect(await res.json()).toEqual({ urls: {} });
    expect(signed.ids).toEqual([]);
  });
});

describe('GET /api/v1/public/catalog-thumbnails: failures and the legacy token', () => {
  // Mutation caught: ignoring the rpc error (an empty map, CDN-cached).
  it('a failed eligibility read is a 500 that no cache keeps, not an empty map', async () => {
    wire({ failRpc: true });
    const res = await get();
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(signed.ids).toEqual([]);
  });

  it('a legacy organization token signs nothing: its page shows an empty catalog', async () => {
    const { stub } = wire({ eligible: 3, link: 'none' });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ urls: {} });
    expect(stub.fromCalls).not.toContain('inventory_items');
    expect(signed.ids).toEqual([]);
  });
});
