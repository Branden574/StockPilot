import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ModuleId } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';

import { POST } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/maintenance-attachments', () => ({ MaintenanceAttachmentsService: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const BAD_ID = 'not-a-uuid';
const PATH = 'org-1/req-1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg';

const finalize = vi.fn();

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
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${id}/attachments/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return Promise.resolve({ id });
}

function validBody(extra: Record<string, unknown> = {}) {
  return { path: PATH, originalFilename: 'a.jpg', declaredMime: 'image/jpeg', ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  finalize.mockReset();
  vi.mocked(MaintenanceAttachmentsService).mockImplementation(
    () => ({ finalize }) as unknown as InstanceType<typeof MaintenanceAttachmentsService>,
  );
});

describe('POST /api/v1/maintenance-requests/[id]/attachments/finalize', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq(REQUEST_ID, validBody()), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(BAD_ID, validBody()), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('rejects an unsupported declaredMime with 400 validation_error', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(REQUEST_ID, validBody({ declaredMime: 'image/gif' })), {
      params: params(REQUEST_ID),
    });
    expect(res.status).toBe(400);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('kind omitted: forwards kind: undefined to the service — the service is the one place a default ("requester") gets applied', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    finalize.mockResolvedValueOnce({ id: 'att-1', width: 10, height: 10 });
    const res = await POST(postReq(REQUEST_ID, validBody()), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    expect(finalize).toHaveBeenCalledWith(REQUEST_ID, {
      path: PATH,
      originalFilename: 'a.jpg',
      declaredMime: 'image/jpeg',
      kind: undefined,
    });
  });

  it('LITERAL PIN — body { kind: "resolution" } reaches the service argument verbatim', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    finalize.mockResolvedValueOnce({ id: 'att-1', width: 10, height: 10 });
    const res = await POST(postReq(REQUEST_ID, validBody({ kind: 'resolution' })), {
      params: params(REQUEST_ID),
    });
    expect(res.status).toBe(200);
    expect(finalize).toHaveBeenCalledWith(REQUEST_ID, {
      path: PATH,
      originalFilename: 'a.jpg',
      declaredMime: 'image/jpeg',
      kind: 'resolution',
    });
  });

  it('an unknown kind literal is rejected with 400 BEFORE the service is ever called', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(REQUEST_ID, validBody({ kind: 'proof' })), { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
    expect(finalize).not.toHaveBeenCalled();
  });

  it('maps a forbidden ServiceError (e.g. kind=resolution without manage) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    finalize.mockRejectedValueOnce(
      new ServiceError('forbidden', 'Only a manage-holder may attach resolution proof photos.'),
    );
    const res = await POST(postReq(REQUEST_ID, validBody({ kind: 'resolution' })), {
      params: params(REQUEST_ID),
    });
    expect(res.status).toBe(403);
  });

  it('maps a validation_error ServiceError (invalid image) to 400', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    finalize.mockRejectedValueOnce(new ServiceError('validation_error', 'invalid_image'));
    const res = await POST(postReq(REQUEST_ID, validBody()), { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
  });

  it('returns the finalize response body on success', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    finalize.mockResolvedValueOnce({ id: 'att-1', width: 10, height: 10 });
    const res = await POST(postReq(REQUEST_ID, validBody()), { params: params(REQUEST_ID) });
    expect(await res.json()).toEqual({ id: 'att-1', width: 10, height: 10 });
  });
});
