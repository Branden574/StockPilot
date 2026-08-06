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

const createUploadUrl = vi.fn();

const MINT_RESULT = {
  path: 'org-1/req-1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jpg',
  signedUrl: 'https://mock/upload-signed',
  token: 'tok-abc',
  thumbPath: 'org-1/req-1/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee-thumb.webp',
  thumbSignedUrl: 'https://mock/upload-signed',
  thumbToken: 'tok-abc',
};

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
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${id}/attachments`, {
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
  createUploadUrl.mockReset();
  vi.mocked(MaintenanceAttachmentsService).mockImplementation(
    () => ({ createUploadUrl }) as unknown as InstanceType<typeof MaintenanceAttachmentsService>,
  );
});

describe('POST /api/v1/maintenance-requests/[id]/attachments (mint)', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq(REQUEST_ID, { fileExt: 'jpg', originalFilename: 'a.jpg' }), {
      params: params(REQUEST_ID),
    });
    expect(res.status).toBe(401);
    expect(createUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(BAD_ID, { fileExt: 'jpg', originalFilename: 'a.jpg' }), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(createUploadUrl).not.toHaveBeenCalled();
  });

  it('rejects a missing required field with 400 validation_error', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(REQUEST_ID, { fileExt: 'jpg' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
    expect(createUploadUrl).not.toHaveBeenCalled();
  });

  it('kind omitted: forwards the body verbatim with no `kind` key at all — the service is the one place a default gets applied', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    createUploadUrl.mockResolvedValueOnce(MINT_RESULT);
    const res = await POST(postReq(REQUEST_ID, { fileExt: 'jpg', originalFilename: 'a.jpg' }), {
      params: params(REQUEST_ID),
    });
    expect(res.status).toBe(200);
    expect(createUploadUrl).toHaveBeenCalledWith(REQUEST_ID, { fileExt: 'jpg', originalFilename: 'a.jpg' });
    const forwarded = createUploadUrl.mock.calls[0]![1] as Record<string, unknown>;
    expect('kind' in forwarded).toBe(false);
  });

  it('LITERAL PIN — body { kind: "resolution" } reaches the service argument verbatim', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    createUploadUrl.mockResolvedValueOnce(MINT_RESULT);
    const res = await POST(
      postReq(REQUEST_ID, { fileExt: 'jpg', originalFilename: 'a.jpg', kind: 'resolution' }),
      { params: params(REQUEST_ID) },
    );
    expect(res.status).toBe(200);
    expect(createUploadUrl).toHaveBeenCalledWith(REQUEST_ID, {
      fileExt: 'jpg',
      originalFilename: 'a.jpg',
      kind: 'resolution',
    });
  });

  it('kind: "requester" is forwarded verbatim too (not stripped just because it equals the service default)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    createUploadUrl.mockResolvedValueOnce(MINT_RESULT);
    await POST(postReq(REQUEST_ID, { fileExt: 'jpg', originalFilename: 'a.jpg', kind: 'requester' }), {
      params: params(REQUEST_ID),
    });
    expect(createUploadUrl).toHaveBeenCalledWith(REQUEST_ID, {
      fileExt: 'jpg',
      originalFilename: 'a.jpg',
      kind: 'requester',
    });
  });

  it('an unknown kind literal is rejected with 400 BEFORE the service is ever called', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(
      postReq(REQUEST_ID, { fileExt: 'jpg', originalFilename: 'a.jpg', kind: 'proof' }),
      { params: params(REQUEST_ID) },
    );
    expect(res.status).toBe(400);
    expect(createUploadUrl).not.toHaveBeenCalled();
  });

  it('maps a forbidden ServiceError (e.g. kind=resolution without manage) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    createUploadUrl.mockRejectedValueOnce(
      new ServiceError('forbidden', 'Only a manage-holder may attach resolution proof photos.'),
    );
    const res = await POST(
      postReq(REQUEST_ID, { fileExt: 'jpg', originalFilename: 'a.jpg', kind: 'resolution' }),
      { params: params(REQUEST_ID) },
    );
    expect(res.status).toBe(403);
  });

  it('maps a conflict ServiceError (rate-limit / cap) to 409', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    createUploadUrl.mockRejectedValueOnce(new ServiceError('conflict', 'A request can carry at most 8 photos.'));
    const res = await POST(postReq(REQUEST_ID, { fileExt: 'jpg', originalFilename: 'a.jpg' }), {
      params: params(REQUEST_ID),
    });
    expect(res.status).toBe(409);
  });

  it('returns the mint response body on success', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    createUploadUrl.mockResolvedValueOnce(MINT_RESULT);
    const res = await POST(postReq(REQUEST_ID, { fileExt: 'jpg', originalFilename: 'a.jpg' }), {
      params: params(REQUEST_ID),
    });
    expect(await res.json()).toEqual(MINT_RESULT);
  });
});
