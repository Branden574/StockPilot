// apps/web/src/app/api/items/search/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { withApiContextMock, inventoryListMock, primaryImagesMock } = vi.hoisted(
  () => ({
    withApiContextMock: vi.fn(),
    inventoryListMock: vi.fn(),
    primaryImagesMock: vi.fn(),
  }),
);

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: withApiContextMock,
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    constructor() {}
    list = inventoryListMock;
  },
}));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: class {
    constructor() {}
    primaryImagesForItems = primaryImagesMock;
  },
}));

import { GET } from './route';

function makeReq(qs: string): Request {
  return new Request(`https://example.com/api/items/search?${qs}`);
}

describe('GET /api/items/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    withApiContextMock.mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: {} as any,
      organizationId: 'org-1',
      userId: 'u-1',
      email: 'a@b.c',
      role: 'admin',
    });
    primaryImagesMock.mockResolvedValue(new Map());
  });

  it('returns 401 when unauthenticated', async () => {
    withApiContextMock.mockResolvedValueOnce(null);
    const res = await GET(makeReq('q=shir'));
    expect(res.status).toBe(401);
  });

  it('returns empty when q < 2 chars', async () => {
    const res = await GET(makeReq('q=a'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ items: [], total: 0 });
    expect(inventoryListMock).not.toHaveBeenCalled();
  });

  it('forwards filters to InventoryService.list', async () => {
    inventoryListMock.mockResolvedValueOnce({
      items: [
        {
          id: 'i1',
          sku: 'SP-1',
          barcode: null,
          name: 'Black T-Shirt',
          quantity_on_hand: 5,
          reorder_point: 0,
          unit_cost: 4,
          retail_price: 12,
          status: 'active',
          category_id: 'c1',
          primary_location_id: null,
          warehouse_id: 'w1',
          item_type: 'product',
          custom_fields: null,
          updated_at: '2026-05-14T00:00:00Z',
        },
      ],
      total: 1,
    });

    const res = await GET(
      makeReq(
        'q=shir&type=product&status=active&stock=low&sort=name_asc' +
          '&cat=c1&cat=c2&loc=l1&rack=20-A&limit=10&offset=20',
      ),
    );
    expect(res.status).toBe(200);
    expect(inventoryListMock).toHaveBeenCalledWith({
      q: 'shir',
      itemType: 'product',
      status: 'active',
      lowStock: true,
      outOfStock: false,
      sort: 'name_asc',
      categoryIds: ['c1', 'c2'],
      locationIds: ['l1'],
      rack: '20-A',
      limit: 10,
      offset: 20,
    });
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('i1');
    expect(body.total).toBe(1);
  });

  it('attaches signed image URLs', async () => {
    inventoryListMock.mockResolvedValueOnce({
      items: [
        {
          id: 'i1',
          sku: 'SP-1',
          barcode: null,
          name: 'X',
          quantity_on_hand: 0,
          reorder_point: 0,
          unit_cost: 0,
          retail_price: 0,
          status: 'active',
          category_id: null,
          primary_location_id: null,
          warehouse_id: null,
          item_type: 'product',
          custom_fields: null,
          updated_at: '2026-05-14T00:00:00Z',
        },
      ],
      total: 1,
    });
    primaryImagesMock.mockResolvedValueOnce(
      new Map([['i1', 'https://signed.example/i1.jpg']]),
    );

    const res = await GET(makeReq('q=shir'));
    const body = await res.json();
    expect(body.items[0].image_url).toBe('https://signed.example/i1.jpg');
  });

  it('falls back to custom_fields.thumbnail_url when no item_images row', async () => {
    inventoryListMock.mockResolvedValueOnce({
      items: [
        {
          id: 'i1',
          sku: 'SP-1',
          barcode: null,
          name: 'X',
          quantity_on_hand: 0,
          reorder_point: 0,
          unit_cost: 0,
          retail_price: 0,
          status: 'active',
          category_id: null,
          primary_location_id: null,
          warehouse_id: null,
          item_type: 'product',
          custom_fields: { thumbnail_url: 'https://cf.example/i1.jpg' },
          updated_at: '2026-05-14T00:00:00Z',
        },
      ],
      total: 1,
    });
    primaryImagesMock.mockResolvedValueOnce(new Map());

    const res = await GET(makeReq('q=shir'));
    const body = await res.json();
    expect(body.items[0].image_url).toBe('https://cf.example/i1.jpg');
  });

  it('caps limit at 200 and offset at 10000', async () => {
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });
    await GET(makeReq('q=shir&limit=9999&offset=99999'));
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200, offset: 10000 }),
    );
  });

  it('defaults itemType when not supplied', async () => {
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });
    await GET(makeReq('q=shir'));
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({ itemType: undefined }),
    );
  });
});
