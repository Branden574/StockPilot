import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ConnectionsService } from '@/server/services/connections';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';

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

function buildRequest() {
  return new Request('https://test.local/api/v1/integrations/connections', {
    method: 'GET',
  }) as unknown as Parameters<typeof GET>[0];
}

describe('GET /api/v1/integrations/connections', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
  });

  it('returns 200 with { connections, health } and invokes ConnectionsService.list', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const payload = {
      connections: [{ id: 'c-1', providerId: 'quickbooks' }],
      health: [{ topic: 'bill', status: 'success' }],
    };
    const list = vi.fn(async () => payload);
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () => ({ list }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const res = await GET(buildRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('maps a module_disabled ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const list = vi.fn(async () => {
      throw new ServiceError('module_disabled', 'Module not enabled');
    });
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () => ({ list }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const res = await GET(buildRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
  });
});
