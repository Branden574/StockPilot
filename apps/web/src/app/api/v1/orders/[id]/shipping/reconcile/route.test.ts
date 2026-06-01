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

function buildRequest(id = 'order-1') {
  return {
    req: new Request(`https://test.local/api/v1/orders/${id}/shipping/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Parameters<typeof POST>[0],
    ctx: { params: Promise.resolve({ id }) },
  };
}

function mockService(reconcilePurchasing: () => unknown) {
  vi.mocked(ShippingService.forApiContext).mockReturnValueOnce({
    reconcilePurchasing,
  } as unknown as ReturnType<typeof ShippingService.forApiContext>);
}

describe('POST /api/v1/orders/[id]/shipping/reconcile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const { req, ctx } = buildRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 200 with { shipment } and invokes reconcilePurchasing', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const shipment = { id: 'cs-1', status: 'purchased', label_url: 'https://label' };
    const reconcilePurchasing = vi.fn(async () => shipment);
    mockService(reconcilePurchasing);

    const { req, ctx } = buildRequest();
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shipment });
    expect(reconcilePurchasing).toHaveBeenCalledWith('order-1');
  });

  it('returns 200 with { shipment: null } when the stranded row was reset to draft', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const reconcilePurchasing = vi.fn(async () => null);
    mockService(reconcilePurchasing);

    const { req, ctx } = buildRequest();
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shipment: null });
  });

  it('maps a module_disabled ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const reconcilePurchasing = vi.fn(async () => {
      throw new ServiceError('module_disabled', 'Module not enabled for this organization: shipping');
    });
    mockService(reconcilePurchasing);

    const { req, ctx } = buildRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
  });

  it('maps a forbidden ServiceError to 403 (manager without shipping:manage)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const reconcilePurchasing = vi.fn(async () => {
      throw new ServiceError('forbidden', 'Missing permission: shipping:manage');
    });
    mockService(reconcilePurchasing);

    const { req, ctx } = buildRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });
});
