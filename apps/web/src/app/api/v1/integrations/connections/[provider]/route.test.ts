import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError, mfaGateError } from '@/server/services/context';
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
    vi.mocked(ConnectionsService).mockImplementationOnce(function () {
      return { disconnect } as unknown as InstanceType<typeof ConnectionsService>;
    });

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
    vi.mocked(ConnectionsService).mockImplementationOnce(function () {
      return { disconnect } as unknown as InstanceType<typeof ConnectionsService>;
    });

    const { req, ctx } = deleteRequest('quickbooks');
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });

  // docket B10: the phone tells the MFA gate's refusal (step up, or enroll)
  // from a missing permission by details.reason, as every other v1 route
  // already lets it. Without it, Settings > Integrations showed an owner who
  // only had to sign in again with their code "Access denied ... ask an admin".
  it.each([
    ['an enrolled account at AAL1', true, 'aal2_required'],
    ['an account the policy requires to enroll', false, 'mfa_required'],
  ])("forwards the MFA gate's reason for %s", async (_who, mfaEnrolled, reason) => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const disconnect = vi.fn(async () => {
      throw mfaGateError({ mfaEnrolled });
    });
    vi.mocked(ConnectionsService).mockImplementationOnce(function () {
      return { disconnect } as unknown as InstanceType<typeof ConnectionsService>;
    });

    const { req, ctx } = deleteRequest('quickbooks');
    const res = await DELETE(req, ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden', details: { reason } });
  });

  it('a refusal without details sends none, and an internal error never sends its details', async () => {
    for (const [error, status] of [
      [new ServiceError('forbidden', 'Missing permission: integrations:manage'), 403],
      [
        new ServiceError('internal_error', 'relation secret_store does not exist', { table: 'x' }),
        500,
      ],
    ] as const) {
      vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
      const disconnect = vi.fn(async () => {
        throw error;
      });
      vi.mocked(ConnectionsService).mockImplementationOnce(function () {
        return { disconnect } as unknown as InstanceType<typeof ConnectionsService>;
      });
      const { req, ctx } = deleteRequest('quickbooks');
      const res = await DELETE(req, ctx);
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body).not.toHaveProperty('details');
      expect(JSON.stringify(body)).not.toMatch(/secret_store|table/);
    }
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
    vi.mocked(ConnectionsService).mockImplementationOnce(function () {
      return { saveAccountMapping } as unknown as InstanceType<typeof ConnectionsService>;
    });

    const { req, ctx } = mappingRequest('quickbooks', validMapping);
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // returnCredit (Phase B) is optional on this surface — when the body omits
    // it the route forwards '' so the return JournalEntry export stays unconfigured.
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
    vi.mocked(ConnectionsService).mockImplementationOnce(function () {
      return { saveAccountMapping } as unknown as InstanceType<typeof ConnectionsService>;
    });

    const { req, ctx } = mappingRequest('quickbooks', validMapping);
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });

  it.each([
    ['an enrolled account at AAL1', true, 'aal2_required'],
    ['an account the policy requires to enroll', false, 'mfa_required'],
  ])("forwards the MFA gate's reason for %s", async (_who, mfaEnrolled, reason) => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const saveAccountMapping = vi.fn(async () => {
      throw mfaGateError({ mfaEnrolled });
    });
    vi.mocked(ConnectionsService).mockImplementationOnce(function () {
      return { saveAccountMapping } as unknown as InstanceType<typeof ConnectionsService>;
    });

    const { req, ctx } = mappingRequest('quickbooks', validMapping);
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden', details: { reason } });
  });

  it('a refusal without details sends none, and an internal error never sends its details', async () => {
    for (const [error, status] of [
      [new ServiceError('forbidden', 'Missing permission: integrations:manage'), 403],
      [new ServiceError('internal_error', 'column settings does not exist', { column: 'x' }), 500],
    ] as const) {
      vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
      const saveAccountMapping = vi.fn(async () => {
        throw error;
      });
      vi.mocked(ConnectionsService).mockImplementationOnce(function () {
        return { saveAccountMapping } as unknown as InstanceType<typeof ConnectionsService>;
      });
      const { req, ctx } = mappingRequest('quickbooks', validMapping);
      const res = await POST(req, ctx);
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body).not.toHaveProperty('details');
      expect(JSON.stringify(body)).not.toMatch(/settings|column/);
    }
  });
});
