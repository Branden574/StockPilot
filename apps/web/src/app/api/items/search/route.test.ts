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
      // Expected-items visibility (mig 0277): absent ?expected=1 the
      // endpoint mirrors the list pages and excludes flagged rows.
      expected: false,
      sort: 'name_asc',
      categoryIds: ['c1', 'c2'],
      locationIds: ['l1'],
      rack: '20-A',
      limit: 10,
      offset: 20,
      // Bundles stay visible unless a caller opts out (?bundles=exclude).
      excludeBundles: false,
    });
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe('i1');
    expect(body.total).toBe(1);
  });

  it('?expected=1 forwards expected:true (in-view search inside the Expected chip view, mig 0277)', async () => {
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });

    const res = await GET(makeReq('q=lanyard&expected=1'));

    expect(res.status).toBe(200);
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'lanyard', expected: true }),
    );
  });

  it('turns a REPEATED type into an itemTypes set, not a single-type filter', async () => {
    // The order add-items picker's Inventory tab has to span every non-book
    // type the order-creation catalog allows. Narrowing server-side (rather
    // than splitting client-side) is what keeps `total` — and therefore the
    // picker's Load more — describing the rows actually rendered.
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });

    await GET(makeReq('browse=1&type=product&type=asset&type=consumable'));

    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({
        itemType: undefined,
        itemTypes: ['product', 'asset', 'consumable'],
      }),
    );
  });

  it('keeps the single-value type contract, including type=all', async () => {
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });
    await GET(makeReq('q=shir&type=all'));
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({ itemType: 'all', itemTypes: undefined }),
    );
  });

  it('?bundles=exclude forwards excludeBundles so a kit SKU cannot reach an order', async () => {
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });
    await GET(makeReq('browse=1&type=product&bundles=exclude'));
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({ excludeBundles: true }),
    );
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

  // browse=1 backs the cycle-count embedded picker: it needs a default
  // (empty-query) listing to render a checkable list on open. Only that
  // flag relaxes the 2-char floor.
  it('?browse=1 allows an empty q and forwards type (cycle-count picker browse mode)', async () => {
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });
    const res = await GET(makeReq('browse=1&type=book&sort=name_asc&limit=50'));
    expect(res.status).toBe(200);
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({
        q: '',
        itemType: 'book',
        sort: 'name_asc',
        limit: 50,
        // Default visibility still applies in browse mode: no status
        // param → InventoryService.list serves active-only, and
        // expected:false keeps awaiting-first-receipt phantoms out.
        status: undefined,
        expected: false,
      }),
    );
  });

  it('without browse=1 an empty q still short-circuits (instant-search guard intact)', async () => {
    const res = await GET(makeReq('type=book'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], total: 0 });
    expect(inventoryListMock).not.toHaveBeenCalled();
  });

  it('?wh forwards warehouseId to InventoryService.list', async () => {
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });
    await GET(makeReq('q=shir&wh=w-42'));
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'shir', warehouseId: 'w-42' }),
    );
  });

  it('omits warehouseId when ?wh is absent', async () => {
    inventoryListMock.mockResolvedValueOnce({ items: [], total: 0 });
    await GET(makeReq('q=shir'));
    expect(inventoryListMock).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseId: undefined }),
    );
  });
});
