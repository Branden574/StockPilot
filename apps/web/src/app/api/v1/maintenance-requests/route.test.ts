import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';

import { GET, POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/maintenance-requests', () => ({ MaintenanceRequestsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const list = vi.fn();
const create = vi.fn();

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

function getReq(qs = '') {
  return new NextRequest(`http://localhost/api/v1/maintenance-requests${qs}`);
}

function postReq(body: unknown) {
  return new NextRequest('http://localhost/api/v1/maintenance-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockReset();
  create.mockReset();
  vi.mocked(MaintenanceRequestsService).mockImplementation(
    () => ({ list, create }) as unknown as InstanceType<typeof MaintenanceRequestsService>,
  );
});

describe('GET /api/v1/maintenance-requests', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it('defaults scope to mine', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    list.mockResolvedValueOnce([]);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'mine' }),
    );
  });

  it('forwards scope=all, q, and status to the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    list.mockResolvedValueOnce([]);
    const res = await GET(getReq('?scope=all&q=broken+light&status=saved'));
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'all', q: 'broken light', status: 'saved' }),
    );
  });

  it('never touches Zendesk (no outbound fetch)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    list.mockResolvedValueOnce([]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await GET(getReq());
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('maps a forbidden ServiceError (scope=all without read_all) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    list.mockRejectedValueOnce(new ServiceError('forbidden', 'Missing permission: maintenance_requests:read_all'));
    const res = await GET(getReq('?scope=all'));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/maintenance-requests', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq({ subject: 'Leaky faucet needs repair', description: 'Water on the floor near the sink.' }));
    expect(res.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });

  it('parses the body through the service and returns id/requestNumber/createdAt', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    create.mockResolvedValueOnce({ id: 'mr-1', requestNumber: 42, createdAt: '2026-08-05T00:00:00.000Z' });
    const body = { subject: 'Leaky faucet needs repair', description: 'Water on the floor near the sink.' };
    const res = await POST(postReq(body));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'mr-1', requestNumber: 42, createdAt: '2026-08-05T00:00:00.000Z' });
    expect(create).toHaveBeenCalledWith(body);
  });

  it('maps ServiceError("module_disabled") to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    create.mockRejectedValueOnce(new ServiceError('module_disabled', 'Module not enabled for this organization: maintenance_requests'));
    const res = await POST(postReq({ subject: 'Leaky faucet needs repair', description: 'Water on the floor near the sink.' }));
    expect(res.status).toBe(403);
  });

  it('maps a rate-limit rejection to 409, never 429 (route contract)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    create.mockRejectedValueOnce(
      new ServiceError('conflict', 'Too many maintenance requests in the last hour. Please try again later.'),
    );
    const res = await POST(postReq({ subject: 'Leaky faucet needs repair', description: 'Water on the floor near the sink.' }));
    expect(res.status).toBe(409);
  });

  it('returns 400 on invalid JSON', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const req = new NextRequest('http://localhost/api/v1/maintenance-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('maps an unmapped thrown error to 500 and reports it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    create.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(postReq({ subject: 'Leaky faucet needs repair', description: 'Water on the floor near the sink.' }));
    expect(res.status).toBe(500);
    const { reportError } = await import('@/lib/error-reporter');
    expect(reportError).toHaveBeenCalled();
  });
});
