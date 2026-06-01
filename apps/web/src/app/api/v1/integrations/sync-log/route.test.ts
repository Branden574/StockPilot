import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { ConnectionsService } from '@/server/services/connections';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET } from './route';
import { POST } from './[id]/replay/route';

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

function listRequest() {
  return new Request('https://test.local/api/v1/integrations/sync-log', {
    method: 'GET',
  }) as unknown as Parameters<typeof GET>[0];
}

const VALID_ID = '11111111-1111-1111-1111-111111111111';

function replayRequest(id: string) {
  return {
    req: new Request(`https://test.local/api/v1/integrations/sync-log/${id}/replay`, {
      method: 'POST',
    }) as unknown as Parameters<typeof POST>[0],
    ctx: { params: Promise.resolve({ id }) },
  };
}

describe('GET /api/v1/integrations/sync-log', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(listRequest());
    expect(res.status).toBe(401);
  });

  it('returns 200 with { rows } and invokes listFailedSyncs', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const payload = { rows: [{ id: VALID_ID, topic: 'bill', status: 'dead' }] };
    const listFailedSyncs = vi.fn(async () => payload);
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () => ({ listFailedSyncs }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const res = await GET(listRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
    expect(listFailedSyncs).toHaveBeenCalledTimes(1);
  });

  it('maps a forbidden ServiceError to 403 (manage permission required)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const listFailedSyncs = vi.fn(async () => {
      throw new ServiceError('forbidden', 'Missing permission: integrations:manage');
    });
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () => ({ listFailedSyncs }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const res = await GET(listRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });

  it('maps a module_disabled ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const listFailedSyncs = vi.fn(async () => {
      throw new ServiceError('module_disabled', 'Module not enabled');
    });
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () => ({ listFailedSyncs }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const res = await GET(listRequest());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('module_disabled');
  });
});

describe('POST /api/v1/integrations/sync-log/[id]/replay', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an auth context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const { req, ctx } = replayRequest(VALID_ID);
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for a non-uuid id', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const { req, ctx } = replayRequest('not-a-uuid');
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('validation_error');
  });

  it('replays a failed row and returns 200 { ok: true }', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const replaySync = vi.fn(async () => undefined);
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () => ({ replaySync }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const { req, ctx } = replayRequest(VALID_ID);
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(replaySync).toHaveBeenCalledWith(VALID_ID);
  });

  it('maps a forbidden ServiceError to 403 (manage permission required)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const replaySync = vi.fn(async () => {
      throw new ServiceError('forbidden', 'Missing permission: integrations:manage');
    });
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () => ({ replaySync }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const { req, ctx } = replayRequest(VALID_ID);
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
  });

  it('maps a not_found ServiceError to 404 (non-replayable / other-org id)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx());
    const replaySync = vi.fn(async () => {
      throw new ServiceError('not_found', 'No replayable failed sync was found for that id.');
    });
    vi.mocked(ConnectionsService).mockImplementationOnce(
      () => ({ replaySync }) as unknown as InstanceType<typeof ConnectionsService>,
    );

    const { req, ctx } = replayRequest(VALID_ID);
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
  });
});
