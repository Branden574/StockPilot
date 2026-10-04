import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  ORDER_MODULE_DISABLED_COPY,
  ORDER_PERMISSION_COPY,
  ORDER_PHONE_TURNED_OFF_COPY,
  ORDER_STOREFRONT_LOAD_FAILED_COPY,
  ORDER_STOREFRONT_RATE_LIMITED_COPY,
  ORDER_STOREFRONT_SIGN_IN_COPY,
  ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { loadCatalogItems, loadChartersForWarehouse } from '@/server/loaders/orders-new-catalog';
import { loadOrderKits } from '@/server/loaders/orders-kits';
import { readFrequentlyOrdered } from '@/server/loaders/orders-frequently-ordered';
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

/**
 * GET /api/v1/orders/catalog?warehouseId= (phone ordering PO-3) over the real
 * OrderStorefrontService: the answers, the perimeter before any shared read,
 * no price, the switch's 503, and faults in core's words.
 */

const req = (warehouseId: string | null = SF_WH) =>
  new NextRequest(
    `http://localhost/api/v1/orders/catalog${warehouseId === null ? '' : `?warehouseId=${warehouseId}`}`,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
  vi.mocked(loadCatalogItems).mockResolvedValue([sfItem('i1', { price: 77.5 })]);
  vi.mocked(loadChartersForWarehouse).mockResolvedValue([]);
  vi.mocked(loadOrderKits).mockResolvedValue({ status: 'ok', kits: [] });
  vi.mocked(readFrequentlyOrdered).mockResolvedValue({ status: 'ok', entries: [] });
});
afterEach(() => vi.unstubAllEnvs());

async function call(ctx: unknown, warehouseId?: string | null) {
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  const res = await GET(req(warehouseId));
  return { res, body: (await res.json()) as Record<string, any> };
}

describe('GET /api/v1/orders/catalog', () => {
  it('401 in core words', async () => {
    const { res, body } = await call(null);
    expect(res.status).toBe(401);
    expect(body.message).toBe(ORDER_STOREFRONT_SIGN_IN_COPY);
  });

  it('429 with retry-after on the shared order-storefront:<user> limit; nothing read', async () => {
    const { ctx, stub } = sfContext();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, resetAt: Date.now() + 5_000 } as never);
    const { res, body } = await call(ctx);
    expect(checkRateLimit).toHaveBeenCalledWith(`order-storefront:${ctx.userId}`, 120, 60_000);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(body).toMatchObject({ organizationId: SF_ORG, message: ORDER_STOREFRONT_RATE_LIMITED_COPY });
    expect(stub.fromCalls).toEqual([]);
    expect(loadCatalogItems).not.toHaveBeenCalled();
  });

  it('module and permission gates: 403 before any read', async () => {
    for (const [over, error, reason, message] of [
      [{ modules: ['inventory'] }, 'module_disabled', 'module_disabled', ORDER_MODULE_DISABLED_COPY],
      [{ permissions: [] }, 'forbidden', 'permission', ORDER_PERMISSION_COPY],
    ] as const) {
      const { ctx, stub } = sfContext(over as never);
      const { res, body } = await call(ctx);
      expect(res.status).toBe(403);
      expect(body).toEqual({
        organizationId: SF_ORG,
        error,
        message,
        details: { reason, organizationId: SF_ORG },
      });
      expect(stub.fromCalls).toEqual([]);
    }
    expect(loadCatalogItems).not.toHaveBeenCalled();
  });

  it('a foreign warehouse: 404 warehouse_not_available, and the sites loader never runs', async () => {
    const { ctx } = sfContext({ role: 'owner' });
    const { res, body } = await call(ctx, SF_WH_FOREIGN);
    expect(res.status).toBe(404);
    expect(body).toEqual({
      organizationId: SF_ORG,
      error: 'not_found',
      message: ORDER_WAREHOUSE_NOT_AVAILABLE_COPY,
      details: { reason: 'warehouse_not_available', organizationId: SF_ORG },
    });
    expect(loadChartersForWarehouse).not.toHaveBeenCalled();
    expect(loadCatalogItems).not.toHaveBeenCalled();
  });

  it('no warehouse id: 400 validation_error', async () => {
    const { ctx } = sfContext();
    const { res, body } = await call(ctx, null);
    expect(res.status).toBe(400);
    expect(body.details).toEqual({ reason: 'invalid', field: 'warehouseId', organizationId: SF_ORG });
  });

  it('200: the trimmed catalog, no price anywhere in the body, no-store', async () => {
    const { ctx } = sfContext();
    const { res, body } = await call(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(body.organizationId).toBe(SF_ORG);
    expect(body.items).toEqual([
      {
        id: 'i1',
        sku: 'SKU-i1',
        name: 'Item i1',
        categoryId: null,
        charterId: null,
        rackLabel: null,
        quantityOnHand: 10,
        reservedQuantity: 0,
        reorderPoint: 0,
      },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/price|cost/i);
    expect(text).not.toContain('77.5');
  });

  it('the kill switch: 503 unavailable with core words and the turned_off reason', async () => {
    vi.stubEnv('ORDERS_PHONE_STOREFRONT', 'off');
    const { ctx } = sfContext();
    const { res, body } = await call(ctx);
    expect(res.status).toBe(503);
    expect(body).toEqual({
      organizationId: SF_ORG,
      error: 'unavailable',
      message: ORDER_PHONE_TURNED_OFF_COPY,
      details: { reason: 'turned_off', organizationId: SF_ORG },
    });
    expect(loadCatalogItems).not.toHaveBeenCalled();
  });

  it('a failed catalog: 500 with the read-failed sentence, reported under api.v1.orders.catalog', async () => {
    vi.mocked(loadCatalogItems).mockRejectedValue(new Error('[orders-new] catalog items read failed: x'));
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
      tag: 'api.v1.orders.catalog',
      organizationId: SF_ORG,
    });
  });
});
