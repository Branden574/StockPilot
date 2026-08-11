import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { MaintenanceShareLinksService } from '@/server/services/maintenance-share-links';

import { POST, DELETE } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/maintenance-share-links', () => ({ MaintenanceShareLinksService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const BAD_ID = 'not-a-uuid';

const issueLink = vi.fn();
const revoke = vi.fn();

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
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${id}/share-link`, { method: 'POST' });
}

function deleteReq(id: string) {
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${id}/share-link`, { method: 'DELETE' });
}

function params(id: string) {
  return Promise.resolve({ id });
}

beforeEach(() => {
  vi.clearAllMocks();
  issueLink.mockReset();
  revoke.mockReset();
  vi.mocked(MaintenanceShareLinksService).mockImplementation(
    () => ({ issueLink, revoke }) as unknown as InstanceType<typeof MaintenanceShareLinksService>,
  );
});

describe('POST /api/v1/maintenance-requests/[id]/share-link', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(issueLink).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(BAD_ID), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(issueLink).not.toHaveBeenCalled();
  });

  it('returns { url, expiresAt } with url starting APP_URL + /m/', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    issueLink.mockResolvedValueOnce({
      token: 'abc123',
      url: 'https://stockpilotusa.com/m/abc123',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toMatch(/^https:\/\/stockpilotusa\.com\/m\//);
    expect(body.expiresAt).toBe('2027-01-01T00:00:00.000Z');
    expect(body).not.toHaveProperty('token');
    expect(issueLink).toHaveBeenCalledWith(REQUEST_ID);
  });

  it('maps a forbidden ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    issueLink.mockRejectedValueOnce(new ServiceError('forbidden', 'Missing permission: maintenance_requests:manage'));
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(403);
  });

  it('maps a not_found ServiceError to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    issueLink.mockRejectedValueOnce(new ServiceError('not_found', 'Maintenance request not found'));
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/maintenance-requests/[id]/share-link', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await DELETE(deleteReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await DELETE(deleteReq(BAD_ID), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('calls revoke and returns { ok: true }', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    revoke.mockResolvedValueOnce(undefined);
    const res = await DELETE(deleteReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(revoke).toHaveBeenCalledWith(REQUEST_ID);
  });

  it('passes a forbidden ServiceError through as 403 without manage (permission passthrough, no route-level widening)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    revoke.mockRejectedValueOnce(new ServiceError('forbidden', 'Missing permission: maintenance_requests:manage'));
    const res = await DELETE(deleteReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(403);
  });

  it('maps a not_found ServiceError (no active link) to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    revoke.mockRejectedValueOnce(new ServiceError('not_found', 'No active share link found for this request.'));
    const res = await DELETE(deleteReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(404);
  });
});
