import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/maintenance-requests', () => ({ MaintenanceRequestsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const BAD_ID = 'not-a-uuid';

const archive = vi.fn();

function buildCtx() {
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff' as const,
    permissions: undefined,
    supabase: {} as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['maintenance_requests']),
  };
}

function postReq(id: string) {
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${id}/archive`, { method: 'POST' });
}

function params(id: string) {
  return Promise.resolve({ id });
}

beforeEach(() => {
  vi.clearAllMocks();
  archive.mockReset();
  vi.mocked(MaintenanceRequestsService).mockImplementation(
    () => ({ archive }) as unknown as InstanceType<typeof MaintenanceRequestsService>,
  );
});

describe('POST /api/v1/maintenance-requests/[id]/archive', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(archive).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(BAD_ID), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(archive).not.toHaveBeenCalled();
  });

  it('calls archive(id) with no body and returns { ok: true }', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    archive.mockResolvedValueOnce(undefined);
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(archive).toHaveBeenCalledWith(REQUEST_ID);
    expect(archive).toHaveBeenCalledTimes(1);
  });

  it('maps a forbidden ServiceError (submit-only caller) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    archive.mockRejectedValueOnce(new ServiceError('forbidden', 'Missing permission: maintenance_requests:manage'));
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(403);
  });

  it('maps a conflict ServiceError (already archived) to 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    archive.mockRejectedValueOnce(new ServiceError('conflict', 'This request is already archived.'));
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(409);
  });

  it('maps a not_found ServiceError to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    archive.mockRejectedValueOnce(new ServiceError('not_found', 'Maintenance request not found.'));
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(404);
  });

  it('maps an unmapped thrown error to 500 and reports it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    archive.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(500);
    const { reportError } = await import('@/lib/error-reporter');
    expect(reportError).toHaveBeenCalled();
  });
});
