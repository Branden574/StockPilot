import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ConnectionsService } from '@/server/services/connections';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { DELETE } from './route';
import { POST } from './account-mapping/route';

vi.mock('@/lib/auth/api-context', () => ({
  withApiContext: vi.fn(),
}));

vi.mock('@/server/services/connections', () => ({
  ConnectionsService: vi.fn(),
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
    enabledModules: new Set<ModuleId>(['integrations']),
  };
}

function deleteRequest(provider: string) {
  return {
    req: new Request(
      `https://test.local/api/v1/integrations/connections/${provider}`,
      { method: 'DELETE' },
    ) as unknown as Parameters<typeof DELETE>[0],
    ctx: { params: Promise.resolve({ provider }) },
  };
}

function mappingRequest(provider: string, body: unknown) {
  return {
    req: new Request(
      `https://test.local/api/v1/integrations/connections/${provider}/account-mapping`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ) as unknown as Parameters<typeof POST>[0],
    ctx: { params: Promise.resolve({ provider }) },
  };
}

const validMapping = {
  billExpense: '60',
  inventoryAsset: '12',
  valuationOffset: '13',
};

describe('DELETE /api/v1/integrations/connections/[provider]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const { req, ctx } = deleteRequest('quickbooks');
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for an unknown provider', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const { req, ctx } = deleteRequest('foo');
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
  });

  it('disconnects quickbooks and returns 200 { ok: true }', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const disconnect = vi.fn(async () => undefined);
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () => ({ disconnect }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const { req, ctx } = deleteRequest('quickbooks');
    const res = await DELETE(req, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(disconnect).toHaveBeenCalledWith('quickbooks');
  });

  it('maps a forbidden ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const disconnect = vi.fn(async () => {
      throw new ServiceError('forbidden', 'Missing permission: integrations:manage');
    });
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () => ({ disconnect }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const { req, ctx } = deleteRequest('quickbooks');
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });
});

describe('POST /api/v1/integrations/connections/[provider]/account-mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const { req, ctx } = mappingRequest('quickbooks', validMapping);
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for an unknown provider', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const { req, ctx } = mappingRequest('foo', validMapping);
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
  });

  it('returns 400 when a mapping field is missing', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const { req, ctx } = mappingRequest('quickbooks', {
      billExpense: '60',
      inventoryAsset: '12',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
  });

  it('returns 400 when a mapping field is blank', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const { req, ctx } = mappingRequest('quickbooks', {
      billExpense: '60',
      inventoryAsset: '   ',
      valuationOffset: '13',
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('saves the mapping and returns 200 { ok: true }', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const saveAccountMapping = vi.fn(async () => undefined);
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () =>
        ({ saveAccountMapping }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const { req, ctx } = mappingRequest('quickbooks', validMapping);
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // returnCredit (Phase B) is optional on this surface — when the body omits
    // it the route forwards '' so the CreditMemo export stays unconfigured.
    expect(saveAccountMapping).toHaveBeenCalledWith('quickbooks', {
      ...validMapping,
      returnCredit: '',
    });
  });

  it('maps a forbidden ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const saveAccountMapping = vi.fn(async () => {
      throw new ServiceError('forbidden', 'Missing permission: integrations:manage');
    });
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () =>
        ({ saveAccountMapping }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const { req, ctx } = mappingRequest('quickbooks', validMapping);
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });
});
