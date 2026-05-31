import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ShippingService } from '@/server/services/shipping';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

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
    role: 'staff' as const,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['shipping']),
  };
}

function buildRequest(id = 'order-1') {
  return {
    req: new Request(`https://test.local/api/v1/orders/${id}/shipping`, {
      method: 'GET',
    }) as unknown as Parameters<typeof GET>[0],
    ctx: { params: Promise.resolve({ id }) },
  };
}

function mockService(getShipment: () => unknown) {
  vi.mocked(ShippingService.forApiContext).mockReturnValueOnce({
    getShipment,
  } as unknown as ReturnType<typeof ShippingService.forApiContext>);
}

describe('GET /api/v1/orders/[id]/shipping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const { req, ctx } = buildRequest();
    const res = await GET(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 200 with the shipment and invokes getShipment', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const shipment = { id: 'cs-1', status: 'purchased' };
    const getShipment = vi.fn(async () => shipment);
    mockService(getShipment);

    const { req, ctx } = buildRequest();
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shipment });
    expect(getShipment).toHaveBeenCalledWith('order-1');
  });

  it('returns 200 with { shipment: null } when none exists', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const getShipment = vi.fn(async () => null);
    mockService(getShipment);

    const { req, ctx } = buildRequest();
    const res = await GET(req, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shipment: null });
  });

  it('maps a module_disabled ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const getShipment = vi.fn(async () => {
      throw new ServiceError('module_disabled', 'Module not enabled for this organization: shipping');
    });
    mockService(getShipment);

    const { req, ctx } = buildRequest();
    const res = await GET(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
  });
});
