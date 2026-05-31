import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ShippingService } from '@/server/services/shipping';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/server/services/shipping', () => ({
  ShippingService: { forApiContext: vi.fn() },
}));

function buildCtx() {
  const stub = makeSupabaseStub({});
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['shipping']),
  };
}

const validParcel = { weight_oz: 16, length_in: 10, width_in: 8, height_in: 4 };

function buildRequest(body: unknown, id = 'order-1') {
  return {
    req: new Request(`https://test.local/api/v1/orders/${id}/shipping/rates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
    ctx: { params: Promise.resolve({ id }) },
  };
}

function mockService(getRates: () => unknown) {
  vi.mocked(ShippingService.forApiContext).mockReturnValueOnce({
    getRates,
  } as unknown as ReturnType<typeof ShippingService.forApiContext>);
}

describe('POST /api/v1/orders/[id]/shipping/rates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const { req, ctx } = buildRequest({ parcel: validParcel });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 when the parcel is missing', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const { req, ctx } = buildRequest({});
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
  });

  it('returns 400 when a parcel dimension is not positive', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const { req, ctx } = buildRequest({ parcel: { ...validParcel, weight_oz: 0 } });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
  });

  it('returns 200 with rates and invokes getRates', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const payload = {
      shipmentId: 'cs-1',
      easypostShipmentId: 'shp_1',
      rates: [{ id: 'rate_1', carrier: 'USPS', service: 'Priority', rate: '7.50', currency: 'USD', delivery_days: 2 }],
    };
    const getRates = vi.fn(async () => payload);
    mockService(getRates);

    const { req, ctx } = buildRequest({ parcel: validParcel });
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(getRates).toHaveBeenCalledWith('order-1', validParcel);
  });

  it('maps a module_disabled ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const getRates = vi.fn(async () => {
      throw new ServiceError('module_disabled', 'Module not enabled for this organization: shipping');
    });
    mockService(getRates);

    const { req, ctx } = buildRequest({ parcel: validParcel });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
  });

  it('maps a forbidden ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const getRates = vi.fn(async () => {
      throw new ServiceError('forbidden', 'Missing permission: shipping:manage');
    });
    mockService(getRates);

    const { req, ctx } = buildRequest({ parcel: validParcel });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });
});
