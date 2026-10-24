import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The public catalog's photo map (/api/v1/public/catalog-thumbnails), the
 * anonymous twin of the staff route: a `?token=` link token instead of a
 * session.
 *
 * WHAT WAS MISSING. It had no rate limit. Every request looked the token up
 * and, for an open link, signed a photo for each eligible item, and nothing
 * bounded how often one address could do that or how fast it could guess
 * tokens: each guess is a new URL, so the CDN cache in front of the route
 * never absorbs it. Now 120 requests an hour per IP, checked before the token
 * is looked up, closed on a limiter outage, and the 429 is never cached.
 */

const { checkRateLimit, admin, signed } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(
    async (_key: string, _limit: number, _windowMs: number, _mode?: 'open' | 'closed') => ({
      allowed: true,
      count: 1,
      resetAt: Date.now() + 3_600_000,
    }),
  ),
  admin: { current: null as unknown },
  signed: { ids: [] as string[][] },
}));

vi.mock('@/lib/rate-limit', () => ({ checkRateLimit }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin.current }));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    async primaryMasterUrlsForItems(ids: string[]) {
      signed.ids.push(ids);
      return new Map(ids.map((id) => [id, `https://signed.example/${id}`]));
    }
  },
}));

const ORG = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const WH = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const LINK = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const LINK_REF = 'link-ref-for-tests';
const ITEMS = ['item-1', 'item-2'];

/** An open link to an org with the public_requests module on and a public warehouse. */
function openLink() {
  const stub = makeSupabaseStub({
    'public_request_links.select': {
      data: {
        id: LINK,
        organization_id: ORG,
        active: true,
        expires_at: null,
        available_from: null,
        available_until: null,
      },
      error: null,
    },
    'organization_modules.select': { data: { module_id: 'public_requests' }, error: null },
    'warehouses.select': { data: { id: WH }, error: null },
    'rpc:public_link_eligible_items': { data: ITEMS.map((item_id) => ({ item_id })), error: null },
  });
  admin.current = stub.client;
  return stub;
}

async function get(
  query: string,
  headers: Record<string, string> = { 'x-real-ip': '203.0.113.7' },
) {
  const { GET } = await import('./route');
  return GET(
    new NextRequest(`http://localhost/api/v1/public/catalog-thumbnails?${query}`, { headers }),
  );
}

const QUERY = `token=${LINK_REF}&warehouseId=${WH}`;

beforeEach(() => {
  vi.resetModules();
  checkRateLimit.mockClear();
  signed.ids = [];
  vi.stubEnv('VERCEL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/v1/public/catalog-thumbnails', () => {
  it('an open link still gets its signed photos, cached at the CDN as before', async () => {
    openLink();
    const res = await get(QUERY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      urls: {
        'item-1': 'https://signed.example/item-1',
        'item-2': 'https://signed.example/item-2',
      },
    });
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=60, stale-while-revalidate=300',
    );
  });

  it("counts the caller's address, 120 an hour, closed on a limiter outage, before the token is looked up", async () => {
    const stub = openLink();
    const order: string[] = [];
    checkRateLimit.mockImplementationOnce(async () => {
      order.push(`limit (tables read so far: ${stub.fromCalls.length})`);
      return { allowed: true, count: 1, resetAt: Date.now() + 3_600_000 };
    });
    await get(QUERY);
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(checkRateLimit.mock.calls[0]).toEqual([
      'public-catalog-thumbnails:ip:203.0.113.7',
      120,
      3_600_000,
      'closed',
    ]);
    expect(order).toEqual(['limit (tables read so far: 0)']);
  });

  it('on Vercel the bucket is the first x-forwarded-for address', async () => {
    vi.stubEnv('VERCEL', '1');
    openLink();
    await get(QUERY, { 'x-forwarded-for': '198.51.100.4, 10.0.0.1', 'x-real-ip': '10.0.0.1' });
    expect(checkRateLimit.mock.calls[0]?.[0]).toBe('public-catalog-thumbnails:ip:198.51.100.4');
  });

  // Mutation caught: no limit at all, a limit checked after the token
  // lookup and the signing, or a 429 the CDN may cache and serve to every
  // other visitor of the same URL.
  it('over the limit: 429, no-store, retry-after, and no token lookup, read or signing', async () => {
    const stub = openLink();
    checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      count: 120,
      resetAt: Date.now() + 90_000,
    });
    const res = await get(QUERY);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(89);
    expect(retryAfter).toBeLessThanOrEqual(90);
    expect(stub.fromCalls).toEqual([]);
    expect(stub.rpcCalls).toEqual([]);
    expect(signed.ids).toEqual([]);
  });

  it('a request without a token or a warehouse is refused before it spends the bucket', async () => {
    openLink();
    expect((await get(`warehouseId=${WH}`)).status).toBe(400);
    expect((await get(`token=${LINK_REF}`)).status).toBe(400);
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
