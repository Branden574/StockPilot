import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { SF_ORG, sfContext } from '@/test/order-storefront-route-fixture';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: 0 })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/loaders/orders-new-catalog', () => ({
  CATALOG_ROW_CEILING: 10_000,
  resolveCatalogScopeKey: vi.fn(),
  loadCatalogItemsCached: vi.fn(),
  loadChartersForWarehouse: vi.fn(),
}));
vi.mock('@/server/loaders/orders-kits', () => ({ loadOrderKits: vi.fn() }));
vi.mock('@/server/loaders/orders-frequently-ordered', () => ({ readFrequentlyOrdered: vi.fn() }));
vi.mock('@/server/loaders/orders-phone-catalog', () => ({ loadPhoneThumbMapCached: vi.fn() }));

import { withApiContext } from '@/lib/auth/api-context';
import { OrderRequestsService } from '@/server/services/order-requests';

import { POST as CREATE } from '../route';
import { GET as STATUS } from '../submissions/[key]/route';
import { POST as WITHDRAW } from '../submissions/[key]/withdraw/route';
import { GET as STOREFRONT } from './route';

/**
 * The kill switch (ORDERS_PHONE_STOREFRONT=off, plan 3.1 and decision 15)
 * covers the phone's storefront reads ONLY. Placing an order and settling a
 * key stay up on purpose: a phone holding a pending send must always be able
 * to find out what happened, and to finish or withdraw it.
 */

const KEY = '00000000-0000-4000-8000-00000000f001';
const ORDER = {
  id: '00000000-0000-4000-8000-00000000f0aa',
  orderNumber: 7,
  orderLabel: 'SO-000007',
  status: 'pending_approval',
  warehouseId: '00000000-0000-4000-8000-0000000000b1',
  fulfillmentType: 'pickup',
  deliveryCharterId: null,
  neededBy: null,
  lineCount: 1,
  unitCount: 1,
  createdAt: '2026-10-04T00:00:00Z',
  requestedFor: { self: true },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ORDERS_PHONE_STOREFRONT', 'off');
  vi.mocked(withApiContext).mockResolvedValue(sfContext().ctx as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the kill switch turns off the storefront reads, never placing or settling', () => {
  it('the storefront read answers enabled false', async () => {
    const res = await STOREFRONT(new NextRequest('http://localhost/api/v1/orders/storefront'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ organizationId: SF_ORG, enabled: false });
  });

  it('POST /api/v1/orders still places', async () => {
    const create = vi
      .spyOn(OrderRequestsService.prototype, 'create')
      .mockResolvedValue({ organizationId: SF_ORG, replay: false, order: ORDER } as never);
    const body = {
      idempotencyKey: KEY,
      placerUserId: sfContext().ctx.userId,
      warehouseId: ORDER.warehouseId,
      fulfillmentType: 'pickup',
      deliveryCharterId: null,
      onBehalfOf: null,
      notes: null,
      neededByLocal: null,
      lines: [{ itemId: '00000000-0000-4000-8000-00000000a001', quantity: 1 }],
    };
    const res = await CREATE(
      new NextRequest('http://localhost/api/v1/orders', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('the status read and the withdraw still settle a key', async () => {
    vi.spyOn(OrderRequestsService.prototype, 'submissionStatus').mockResolvedValue({
      organizationId: SF_ORG,
      outcome: 'none',
    } as never);
    vi.spyOn(OrderRequestsService.prototype, 'withdrawSubmission').mockResolvedValue({
      organizationId: SF_ORG,
      outcome: 'withdrawn',
    } as never);
    const params = { params: Promise.resolve({ key: KEY }) };
    const status = await STATUS(
      new NextRequest(`http://localhost/api/v1/orders/submissions/${KEY}`),
      params,
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ outcome: 'none' });
    const withdraw = await WITHDRAW(
      new NextRequest(`http://localhost/api/v1/orders/submissions/${KEY}/withdraw`, {
        method: 'POST',
        body: '{}',
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ key: KEY }) },
    );
    expect(withdraw.status).toBe(200);
    await expect(withdraw.json()).resolves.toMatchObject({ outcome: 'withdrawn' });
  });

  it('nothing on the create or settle path reads the switch', () => {
    const SRC = path.resolve(__dirname, '../../../../..');
    for (const file of [
      'app/api/v1/orders/route.ts',
      'app/api/v1/orders/submissions/[key]/route.ts',
      'app/api/v1/orders/submissions/[key]/withdraw/route.ts',
      'server/services/order-requests.ts',
      'server/actions/order-requests.ts',
    ]) {
      const text = readFileSync(path.join(SRC, file), 'utf8');
      expect(text).not.toContain('ORDERS_PHONE_STOREFRONT');
      expect(text).not.toContain('phoneStorefrontEnabled');
    }
  });
});
