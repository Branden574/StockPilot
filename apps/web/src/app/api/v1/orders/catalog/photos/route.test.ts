import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  ORDER_PHONE_TURNED_OFF_COPY,
  ORDER_STOREFRONT_LOAD_FAILED_COPY,
  ORDER_STOREFRONT_RATE_LIMITED_COPY,
  ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { loadCatalogItems } from '@/server/loaders/orders-new-catalog';
import { loadPhoneThumbMapCached } from '@/server/loaders/orders-phone-catalog';
import { SF_ORG, SF_WH, SF_WH_FOREIGN, sfContext, sfItem } from '@/test/order-storefront-route-fixture';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/loaders/orders-new-catalog', () => ({
  CATALOG_ROW_CEILING: 10_000,
  loadCatalogItems: vi.fn(),
  loadChartersForWarehouse: vi.fn(),
}));
vi.mock('@/server/loaders/orders-kits', () => ({ loadOrderKits: vi.fn() }));
vi.mock('@/server/loaders/orders-frequently-ordered', () => ({ readFrequentlyOrdered: vi.fn() }));
vi.mock('@/server/loaders/orders-phone-catalog', () => ({ loadPhoneThumbMapCached: vi.fn() }));

import { GET } from './route';

/** GET /api/v1/orders/catalog/photos?warehouseId= (phone ordering PO-3). */

const req = (warehouseId = SF_WH) =>
  new NextRequest(`http://localhost/api/v1/orders/catalog/photos?warehouseId=${warehouseId}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
  vi.mocked(loadCatalogItems).mockResolvedValue([sfItem('mine')]);
  vi.mocked(loadPhoneThumbMapCached).mockResolvedValue({
    signedAt: '2026-10-04T00:00:00.000Z',
    photos: { mine: 'https://signed/mine', hidden: 'https://signed/hidden' },
  });
});
afterEach(() => vi.unstubAllEnvs());

async function call(ctx: unknown, warehouseId?: string) {
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  const res = await GET(req(warehouseId));
  return { res, body: (await res.json()) as Record<string, any> };
}

describe('GET /api/v1/orders/catalog/photos', () => {
  it("200: only the caller's items, valid 30 days, no-store, naming the organization", async () => {
    const { ctx } = sfContext({ role: 'viewer' });
    const { res, body } = await call(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(body).toEqual({
      organizationId: SF_ORG,
      warehouseId: SF_WH,
      photos: { mine: 'https://signed/mine' },
      signedAt: '2026-10-04T00:00:00.000Z',
      expiresAt: '2026-11-03T00:00:00.000Z',
    });
  });

  it('its own limit: order-photos:<user>, 30 a minute, 429 with retry-after', async () => {
    const { ctx } = sfContext();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, resetAt: Date.now() + 1_000 } as never);
    const { res, body } = await call(ctx);
    expect(checkRateLimit).toHaveBeenCalledWith(`order-photos:${ctx.userId}`, 30, 60_000);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(body.message).toBe(ORDER_STOREFRONT_RATE_LIMITED_COPY);
    expect(loadPhoneThumbMapCached).not.toHaveBeenCalled();
  });

  it('the perimeter: a foreign warehouse is 404 and the map is never built for it', async () => {
    const { ctx } = sfContext({ role: 'owner' });
    const { res, body } = await call(ctx, SF_WH_FOREIGN);
    expect(res.status).toBe(404);
    expect(body.message).toBe(ORDER_WAREHOUSE_NOT_AVAILABLE_COPY);
    expect(loadPhoneThumbMapCached).not.toHaveBeenCalled();
  });

  it('the kill switch: 503 turned_off', async () => {
    vi.stubEnv('ORDERS_PHONE_STOREFRONT', 'off');
    const { ctx } = sfContext();
    const { res, body } = await call(ctx);
    expect(res.status).toBe(503);
    expect(body).toMatchObject({ message: ORDER_PHONE_TURNED_OFF_COPY, details: { reason: 'turned_off' } });
  });

  it('a map that could not be built: 500 in core words, reported', async () => {
    vi.mocked(loadPhoneThumbMapCached).mockRejectedValue(new Error('[orders-phone] photo sign failed'));
    const { ctx } = sfContext();
    const { res, body } = await call(ctx);
    expect(res.status).toBe(500);
    expect(body).toEqual({
      organizationId: SF_ORG,
      error: 'internal_error',
      message: ORDER_STOREFRONT_LOAD_FAILED_COPY,
      details: { reason: 'failed', organizationId: SF_ORG },
    });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'api.v1.orders.catalog_photos',
      organizationId: SF_ORG,
    });
  });
});
