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

const resolve = vi.fn();

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
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${id}/resolve`, {
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
  resolve.mockReset();
  vi.mocked(MaintenanceRequestsService).mockImplementation(
    () => ({ resolve }) as unknown as InstanceType<typeof MaintenanceRequestsService>,
  );
});

describe('POST /api/v1/maintenance-requests/[id]/resolve', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq(REQUEST_ID, { note: 'Fixed it, all good now.' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(BAD_ID, { note: 'Fixed it, all good now.' }), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const req = new NextRequest(`http://localhost/api/v1/maintenance-requests/${REQUEST_ID}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(req, { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('forwards the RAW body to service.resolve(id, body) — the service owns maintenanceResolveSchema, the route never re-parses', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    resolve.mockResolvedValueOnce(undefined);
    // Deliberately carries a key `maintenanceResolveSchema` (.strict()) does
    // not define — the ONLY way this exact body reaches the service
    // untouched is if the route forwards it raw, matching the PATCH
    // precedent ([id]/route.ts). A route that re-parsed with a local
    // z.object({ note: z.string() }) mirror would either strip this key (a
    // non-strict mirror) or reject the request outright (a strict one) —
    // both fail this assertion (T8-M2).
    const body = { note: 'Replaced the shutoff valve.', extraneous: 'must pass through untouched' };
    const res = await POST(postReq(REQUEST_ID, body), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resolve).toHaveBeenCalledWith(REQUEST_ID, body);
  });

  it('maps a validation_error ServiceError (schema failure, e.g. a too-short note) to 400', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    resolve.mockRejectedValueOnce(
      new ServiceError('validation_error', 'Describe how this was resolved (at least 5 characters).'),
    );
    const res = await POST(postReq(REQUEST_ID, { note: 'Hi' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
  });

  it('maps a forbidden ServiceError (submit-only caller) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    resolve.mockRejectedValueOnce(new ServiceError('forbidden', 'Missing permission: maintenance_requests:manage'));
    const res = await POST(postReq(REQUEST_ID, { note: 'Fixed it, all good now.' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(403);
  });

  it('maps a conflict ServiceError (already resolved/archived/cancelled) to 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    resolve.mockRejectedValueOnce(new ServiceError('conflict', 'This request is already resolved.'));
    const res = await POST(postReq(REQUEST_ID, { note: 'Fixed it, all good now.' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(409);
  });

  it('maps a not_found ServiceError to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    resolve.mockRejectedValueOnce(new ServiceError('not_found', 'Maintenance request not found.'));
    const res = await POST(postReq(REQUEST_ID, { note: 'Fixed it, all good now.' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(404);
  });

  it('maps an unmapped thrown error to 500 and reports it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    resolve.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(postReq(REQUEST_ID, { note: 'Fixed it, all good now.' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(500);
    const { reportError } = await import('@/lib/error-reporter');
    expect(reportError).toHaveBeenCalled();
  });
});
