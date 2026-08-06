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

const recordDraftOpened = vi.fn();

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
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${id}/draft-opened`, { method: 'POST' });
}

function params(id: string) {
  return Promise.resolve({ id });
}

beforeEach(() => {
  vi.clearAllMocks();
  recordDraftOpened.mockReset();
  vi.mocked(MaintenanceRequestsService).mockImplementation(
    () => ({ recordDraftOpened }) as unknown as InstanceType<typeof MaintenanceRequestsService>,
  );
});

describe('POST /api/v1/maintenance-requests/[id]/draft-opened', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(recordDraftOpened).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(BAD_ID), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(recordDraftOpened).not.toHaveBeenCalled();
  });

  it('calls recordDraftOpened once and returns { openCount }', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    recordDraftOpened.mockResolvedValueOnce({ openCount: 3 });
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ openCount: 3 });
    expect(recordDraftOpened).toHaveBeenCalledTimes(1);
    expect(recordDraftOpened).toHaveBeenCalledWith(REQUEST_ID);
  });

  it('never claims the email was sent or a ticket was created (StockPilot cannot observe either)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    recordDraftOpened.mockResolvedValueOnce({ openCount: 1 });
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    const raw = JSON.stringify(await res.json()).toLowerCase();
    expect(raw).not.toMatch(/\bsent\b/);
    expect(raw).not.toMatch(/\bticket\b/);
  });

  it('maps a conflict ServiceError (closed request) to 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    recordDraftOpened.mockRejectedValueOnce(
      new ServiceError('conflict', 'This request changed state and can no longer be edited this way.'),
    );
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(409);
  });

  it('maps a forbidden ServiceError to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    recordDraftOpened.mockRejectedValueOnce(new ServiceError('forbidden', 'Not your request.'));
    const res = await POST(postReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(403);
  });
});
