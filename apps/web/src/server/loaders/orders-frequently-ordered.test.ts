import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createClientMock, rpcMock, forCurrentUserMock, thumbsMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  rpcMock: vi.fn(),
  forCurrentUserMock: vi.fn(),
  thumbsMock: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({ createClient: createClientMock }));
vi.mock('@/server/services/item-images', () => ({
  ItemImagesService: { forCurrentUser: forCurrentUserMock },
}));

import { loadFrequentlyOrdered } from './orders-frequently-ordered';

const WAREHOUSE = 'wh-1';
const catalog = (items: Array<{ id: string; imageUrl: string | null }>) =>
  Promise.resolve({ items });
const top = (...rows: Array<[string, number]>) => ({
  data: rows.map(([item_id, request_count]) => ({ item_id, request_count })),
  error: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  createClientMock.mockResolvedValue({ rpc: rpcMock });
  forCurrentUserMock.mockResolvedValue({ primaryImagesForBrowserDisplay: thumbsMock });
  thumbsMock.mockResolvedValue(new Map());
});

describe('loadFrequentlyOrdered', () => {
  it("asks the database the one question the route asked, with the visitor's own client", async () => {
    rpcMock.mockResolvedValue(top(['a', 4]));
    await loadFrequentlyOrdered(WAREHOUSE, catalog([{ id: 'a', imageUrl: 'u' }]));
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('order_request_top_skus_for_warehouse', {
      p_warehouse_id: 'wh-1',
      p_days: 30,
      p_limit: 10,
    });
  });

  it('keeps the ranking order and hands the browser only ids its own catalog holds', async () => {
    rpcMock.mockResolvedValue(top(['c', 9], ['not-in-my-catalog', 7], ['a', 3]));
    const out = await loadFrequentlyOrdered(
      WAREHOUSE,
      catalog([
        { id: 'a', imageUrl: 'ua' },
        { id: 'b', imageUrl: 'ub' },
        { id: 'c', imageUrl: 'uc' },
      ]),
    );
    expect(out).toEqual([
      { itemId: 'c', count: 9, fallbackImageUrl: null },
      { itemId: 'a', count: 3, fallbackImageUrl: null },
    ]);
  });

  it('signs nothing when every catalog row already has its photo', async () => {
    rpcMock.mockResolvedValue(top(['a', 2], ['b', 1]));
    await loadFrequentlyOrdered(
      WAREHOUSE,
      catalog([
        { id: 'a', imageUrl: 'ua' },
        { id: 'b', imageUrl: 'ub' },
      ]),
    );
    expect(forCurrentUserMock).not.toHaveBeenCalled();
    expect(thumbsMock).not.toHaveBeenCalled();
  });

  it('signs a 200 px thumbnail for exactly the rows the catalog left without a photo', async () => {
    rpcMock.mockResolvedValue(top(['a', 5], ['b', 4], ['c', 3]));
    thumbsMock.mockResolvedValue(new Map([['b', 'signed-b']]));
    const out = await loadFrequentlyOrdered(
      WAREHOUSE,
      catalog([
        { id: 'a', imageUrl: 'ua' },
        { id: 'b', imageUrl: null },
        { id: 'c', imageUrl: null },
      ]),
    );
    expect(thumbsMock).toHaveBeenCalledTimes(1);
    expect(thumbsMock).toHaveBeenCalledWith(['b', 'c'], 200);
    expect(out).toEqual([
      { itemId: 'a', count: 5, fallbackImageUrl: null },
      { itemId: 'b', count: 4, fallbackImageUrl: 'signed-b' },
      { itemId: 'c', count: 3, fallbackImageUrl: null },
    ]);
  });

  it('does not wait for the catalog before asking: the two run side by side', async () => {
    rpcMock.mockResolvedValue(top(['a', 1]));
    let release!: (value: { items: Array<{ id: string; imageUrl: string | null }> }) => void;
    const slowCatalog = new Promise<{ items: Array<{ id: string; imageUrl: string | null }> }>(
      (resolve) => (release = resolve),
    );
    const pending = loadFrequentlyOrdered(WAREHOUSE, slowCatalog);
    await vi.waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    release({ items: [{ id: 'a', imageUrl: 'ua' }] });
    expect(await pending).toEqual([{ itemId: 'a', count: 1, fallbackImageUrl: null }]);
  });

  describe('never rejects: a fault hides the strip, it does not take the storefront down', () => {
    const CATALOG = () => catalog([{ id: 'a', imageUrl: null }]);

    it('the database refuses', async () => {
      rpcMock.mockResolvedValue({ data: null, error: { code: '42501', message: 'secret detail' } });
      await expect(loadFrequentlyOrdered(WAREHOUSE, CATALOG())).resolves.toEqual([]);
      // The code is logged, never the message.
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret detail');
    });

    it('names a transport fault "network" rather than logging a blank', async () => {
      // What postgrest-js really resolves when the fetch fails: it does NOT
      // throw, and `code` is the empty string.
      rpcMock.mockResolvedValue({
        data: null,
        error: { message: 'TypeError: fetch failed', details: '', hint: '', code: '' },
        status: 0,
      });
      await expect(loadFrequentlyOrdered(WAREHOUSE, CATALOG())).resolves.toEqual([]);
      const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
      expect(logged).toContain('network');
      expect(logged).not.toContain('fetch failed');
    });

    it('names a gateway error by its status, not "network"', async () => {
      rpcMock.mockResolvedValue({
        data: null,
        error: { message: '<html>502</html>' },
        status: 502,
      });
      await expect(loadFrequentlyOrdered(WAREHOUSE, CATALOG())).resolves.toEqual([]);
      const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
      expect(logged).toContain('http-502');
      expect(logged).not.toContain('html');
    });

    it('no session client', async () => {
      createClientMock.mockRejectedValue(new Error('cookies unavailable'));
      await expect(loadFrequentlyOrdered(WAREHOUSE, CATALOG())).resolves.toEqual([]);
    });

    it('the call itself throws', async () => {
      rpcMock.mockRejectedValue(new Error('network'));
      await expect(loadFrequentlyOrdered(WAREHOUSE, CATALOG())).resolves.toEqual([]);
    });

    it('the catalog failed', async () => {
      rpcMock.mockResolvedValue(top(['a', 1]));
      await expect(
        loadFrequentlyOrdered(WAREHOUSE, Promise.reject(new Error('catalog down'))),
      ).resolves.toEqual([]);
    });

    it('the fallback photo cannot be signed: the strip still shows, without that photo', async () => {
      rpcMock.mockResolvedValue(top(['a', 1]));
      forCurrentUserMock.mockRejectedValue(new Error('no context'));
      await expect(loadFrequentlyOrdered(WAREHOUSE, CATALOG())).resolves.toEqual([
        { itemId: 'a', count: 1, fallbackImageUrl: null },
      ]);
    });

    it('nothing ordered lately', async () => {
      rpcMock.mockResolvedValue({ data: [], error: null });
      await expect(loadFrequentlyOrdered(WAREHOUSE, CATALOG())).resolves.toEqual([]);
      rpcMock.mockResolvedValue({ data: null, error: null });
      await expect(loadFrequentlyOrdered(WAREHOUSE, CATALOG())).resolves.toEqual([]);
    });
  });
});
