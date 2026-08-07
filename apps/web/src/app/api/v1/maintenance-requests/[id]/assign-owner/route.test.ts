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

const assignLocalOwner = vi.fn();

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

function postReq(id: string, body: unknown) {
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${id}/assign-owner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return Promise.resolve({ id });
}

beforeEach(() => {
  vi.clearAllMocks();
  assignLocalOwner.mockReset();
  vi.mocked(MaintenanceRequestsService).mockImplementation(
    () => ({ assignLocalOwner }) as unknown as InstanceType<typeof MaintenanceRequestsService>,
  );
});

describe('POST /api/v1/maintenance-requests/[id]/assign-owner', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq(REQUEST_ID, { userId: 'u-2' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(assignLocalOwner).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(BAD_ID, { userId: 'u-2' }), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(assignLocalOwner).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const req = new NextRequest(`http://localhost/api/v1/maintenance-requests/${REQUEST_ID}/assign-owner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(req, { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
    expect(assignLocalOwner).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when userId is missing from the body', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(REQUEST_ID, {}), { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('validation_error');
    expect(assignLocalOwner).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when userId is neither a string nor null (e.g. a number)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(REQUEST_ID, { userId: 123 }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
    expect(assignLocalOwner).not.toHaveBeenCalled();
  });

  it('forwards a string userId straight through to assignLocalOwner(id, userId) — uuid-format and membership checks stay in the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    assignLocalOwner.mockResolvedValueOnce(undefined);
    const res = await POST(postReq(REQUEST_ID, { userId: 'u-2' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(assignLocalOwner).toHaveBeenCalledWith(REQUEST_ID, 'u-2');
  });

  it('forwards userId: null straight through (clear assignment)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    assignLocalOwner.mockResolvedValueOnce(undefined);
    const res = await POST(postReq(REQUEST_ID, { userId: null }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    expect(assignLocalOwner).toHaveBeenCalledWith(REQUEST_ID, null);
  });

  it('maps a validation_error ServiceError (e.g. a foreign-org userId) to 400', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    assignLocalOwner.mockRejectedValueOnce(
      new ServiceError('validation_error', 'That user is not an active member of this organization.'),
    );
    const res = await POST(postReq(REQUEST_ID, { userId: 'u-2' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
  });

  it('maps a forbidden ServiceError (submit-only caller) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    assignLocalOwner.mockRejectedValueOnce(new ServiceError('forbidden', 'Missing permission: maintenance_requests:manage'));
    const res = await POST(postReq(REQUEST_ID, { userId: 'u-2' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(403);
  });

  it('maps a not_found ServiceError to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    assignLocalOwner.mockRejectedValueOnce(new ServiceError('not_found', 'Maintenance request not found.'));
    const res = await POST(postReq(REQUEST_ID, { userId: 'u-2' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(404);
  });

  it('maps an unmapped thrown error to 500 and reports it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    assignLocalOwner.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(postReq(REQUEST_ID, { userId: 'u-2' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(500);
    const { reportError } = await import('@/lib/error-reporter');
    expect(reportError).toHaveBeenCalled();
  });
});
