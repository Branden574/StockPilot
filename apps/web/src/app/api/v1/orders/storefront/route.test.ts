import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  ORDER_MODULE_DISABLED_COPY,
  ORDER_PERMISSION_COPY,
  ORDER_PHONE_AAL2_COPY,
  ORDER_PHONE_TURNED_OFF_COPY,
  ORDER_STOREFRONT_LOAD_FAILED_COPY,
  ORDER_STOREFRONT_RATE_LIMITED_COPY,
  ORDER_STOREFRONT_SIGN_IN_COPY,
} from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { SF_ORG, SF_WH, sfContext } from '@/test/order-storefront-route-fixture';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
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

import { GET } from './route';

/**
 * GET /api/v1/orders/storefront (phone ordering PO-3): the HTTP answers over
 * the real OrderStorefrontService and a stubbed caller client. Every answer is
 * private, no-store and names the organization; refusals carry core's words
 * and the reason a screen switches on.
 */

const req = () => new NextRequest('http://localhost/api/v1/orders/storefront');

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true, resetAt: 0 } as never);
});
afterEach(() => vi.unstubAllEnvs());

async function call(ctx: unknown) {
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  const res = await GET(req());
  return { res, body: (await res.json()) as Record<string, any> };
}

describe('GET /api/v1/orders/storefront', () => {
  it('401 with core words when there is no session', async () => {
    const { res, body } = await call(null);
    expect(res.status).toBe(401);
    expect(body).toEqual({
      error: 'unauthenticated',
      message: ORDER_STOREFRONT_SIGN_IN_COPY,
      details: { reason: 'unauthenticated' },
    });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('429 with retry-after past order-storefront:<user>, 120 a minute; nothing read', async () => {
    const { ctx, stub } = sfContext();
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, resetAt: Date.now() + 30_500 } as never);
    const { res, body } = await call(ctx);
    expect(checkRateLimit).toHaveBeenCalledWith(`order-storefront:${ctx.userId}`, 120, 60_000);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(30);
    expect(body).toEqual({
      organizationId: SF_ORG,
      error: 'rate_limited',
      message: ORDER_STOREFRONT_RATE_LIMITED_COPY,
      details: { reason: 'rate_limited', organizationId: SF_ORG },
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it.each([
    ['the Orders module off', { modules: ['inventory'] as never }, 403, 'module_disabled', 'module_disabled', ORDER_MODULE_DISABLED_COPY],
    ['orders:request revoked', { permissions: [] }, 403, 'forbidden', 'permission', ORDER_PERMISSION_COPY],
    ['the MFA step-up', { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true }, 403, 'forbidden', 'aal2_required', ORDER_PHONE_AAL2_COPY],
  ])('%s: %i %s', async (_label, over, status, error, reason, message) => {
    const { ctx } = sfContext(over);
    const { res, body } = await call(ctx);
    expect(res.status).toBe(status);
    expect(body).toEqual({
      organizationId: SF_ORG,
      error,
      message,
      details: { reason, organizationId: SF_ORG },
    });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('200: the setup answer, no-store, naming the organization', async () => {
    const { ctx } = sfContext({ role: 'staff' });
    const { res, body } = await call(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(body).toMatchObject({
      organizationId: SF_ORG,
      enabled: true,
      warehouses: [{ id: SF_WH, name: 'DC4' }],
      viewer: { role: 'staff', canOrderOnBehalf: false, canApproveOrders: false },
      orgTimezone: 'UTC',
      deliveryRecipients: null,
      recentRequesters: null,
    });
  });

  it('the kill switch: 200 enabled false with core words', async () => {
    vi.stubEnv('ORDERS_PHONE_STOREFRONT', 'off');
    const { ctx, stub } = sfContext();
    const { res, body } = await call(ctx);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      organizationId: SF_ORG,
      enabled: false,
      message: ORDER_PHONE_TURNED_OFF_COPY,
      serverNow: expect.any(String),
    });
    expect(stub.fromCalls).toEqual([]);
  });

  it('a fault: 500 with the read-failed sentence and reason failed, reported under the route tag', async () => {
    const { ctx } = sfContext({
      results: { 'warehouses.select': { data: null, error: { message: 'boom', code: '57014' } } },
    });
    const { res, body } = await call(ctx);
    expect(res.status).toBe(500);
    expect(body).toEqual({
      organizationId: SF_ORG,
      error: 'internal_error',
      message: ORDER_STOREFRONT_LOAD_FAILED_COPY,
      details: { reason: 'failed', organizationId: SF_ORG },
    });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tag: 'api.v1.orders.storefront',
      organizationId: SF_ORG,
    });
    // The report is the database's words, never a person's name or email.
    const reported = vi.mocked(reportError).mock.calls[0]![0] as Error;
    expect(reported.message).toMatch(/warehouses read failed/);
    expect(reported.message).not.toMatch(/@|Pat/);
  });
});
