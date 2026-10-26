import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * GET /api/v1/public/catalog-thumbnails and ordering visibility (0413, design
 * 5.1). A link's covers are signed only for its eligible items
 * (public_link_eligible_items, which leaves out an item hidden from ordering).
 * The legacy organization token (no links row) used to sign the cover of every
 * active book of the warehouse with no visibility rule at all, while its page
 * renders an empty catalog; it now answers the empty map its page shows, so no
 * cover URL leaks through it.
 */

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => adminHolder.client) }));
const signMock = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, `https://signed/${id}`])));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    primaryMasterUrlsForItems = signMock;
  },
}));

import { GET } from './route';

const WH = '11111111-1111-4111-8111-111111111111';

function request() {
  return new Request(
    `https://test.local/api/v1/public/catalog-thumbnails?token=pub_token_example&warehouseId=${WH}`,
  ) as unknown as Parameters<typeof GET>[0];
}

function wire(viaLink: boolean, eligible: string[] = []) {
  const stub = makeSupabaseStub({
    'public_request_links.select.maybeSingle': viaLink
      ? {
          data: {
            id: 'link-1',
            organization_id: 'org-1',
            active: true,
            expires_at: null,
            available_from: null,
            available_until: null,
          },
          error: null,
        }
      : { data: null, error: null },
    'organizations.select.maybeSingle': { data: { id: 'org-1' }, error: null },
    'organization_modules.select.maybeSingle': { data: { module_id: 'public_requests' }, error: null },
    'warehouses.select.maybeSingle': { data: { id: WH }, error: null },
    'rpc:public_link_eligible_items': {
      data: eligible.map((item_id) => ({ item_id, max_qty: null })),
      error: null,
    },
    'inventory_items.select': {
      data: [{ id: 'book-shown' }, { id: 'book-hidden' }],
      error: null,
    },
  });
  adminHolder.client = stub.client;
  return stub;
}

describe('GET /api/v1/public/catalog-thumbnails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the legacy organization token answers an empty map: no item read, nothing signed', async () => {
    const stub = wire(false);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ urls: {} });
    expect(res.headers.get('cache-control')).toBe('public, s-maxage=60, stale-while-revalidate=300');
    expect(stub.fromCalls).not.toContain('inventory_items');
    expect(signMock).not.toHaveBeenCalled();
  });

  it("a link signs only its eligible items' covers", async () => {
    wire(true, ['book-shown']);
    const res = await GET(request());
    expect(await res.json()).toEqual({ urls: { 'book-shown': 'https://signed/book-shown' } });
    expect(signMock).toHaveBeenCalledWith(['book-shown']);
  });
});
