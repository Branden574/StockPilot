import { describe, expect, it, vi } from 'vitest';

const fetchItemPrice = vi.fn();
const refreshOrgBookPrices = vi.fn();
vi.mock('@/server/services/price-tracking', () => ({
  PriceTrackingService: { forCurrentUser: vi.fn(async () => ({ fetchItemPrice, refreshOrgBookPrices })) },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { fetchItemPriceAction, refreshBookPricesAction } from './price-tracking';

describe('price-tracking actions', () => {
  it('fetchItemPriceAction rejects a missing id', async () => {
    const res = await fetchItemPriceAction('');
    expect(res.ok).toBe(false);
  });
  it('fetchItemPriceAction returns ok on success', async () => {
    fetchItemPrice.mockResolvedValueOnce({ item_id: 'i1', retail_price: 7.99 });
    const res = await fetchItemPriceAction('i1');
    expect(res.ok).toBe(true);
  });
  it('refreshBookPricesAction returns the summary', async () => {
    refreshOrgBookPrices.mockResolvedValueOnce({ scanned: 5, written: 3, skipped: 2 });
    const res = await refreshBookPricesAction();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.written).toBe(3);
  });
});
