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

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const BAD_ID = 'not-a-uuid';

const listNotes = vi.fn();
const addNote = vi.fn();

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

function getReq(id: string) {
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${id}/notes`);
}

function postReq(id: string, body: unknown) {
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${id}/notes`, {
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
  listNotes.mockReset();
  addNote.mockReset();
  vi.mocked(MaintenanceRequestsService).mockImplementation(
    () => ({ listNotes, addNote }) as unknown as InstanceType<typeof MaintenanceRequestsService>,
  );
});

describe('GET /api/v1/maintenance-requests/[id]/notes', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(getReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(listNotes).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await GET(getReq(BAD_ID), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(listNotes).not.toHaveBeenCalled();
  });

  it('returns { notes } from the service, id/authorUserId/body/createdAt shape', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    listNotes.mockResolvedValueOnce([
      { id: 'n-1', authorUserId: 'u-1', body: 'Checked the shutoff valve.', createdAt: '2026-08-05T00:00:00.000Z' },
    ]);
    const res = await GET(getReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      notes: [{ id: 'n-1', authorUserId: 'u-1', body: 'Checked the shutoff valve.', createdAt: '2026-08-05T00:00:00.000Z' }],
    });
    expect(listNotes).toHaveBeenCalledWith(REQUEST_ID);
  });

  it('maps the service\'s manage-only forbidden ServiceError to 403 (submit-only caller)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    listNotes.mockRejectedValueOnce(new ServiceError('forbidden', 'Missing permission: maintenance_requests:manage'));
    const res = await GET(getReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(403);
  });

  it('maps an unmapped thrown error to 500 and reports it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    listNotes.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(getReq(REQUEST_ID), { params: params(REQUEST_ID) });
    expect(res.status).toBe(500);
    const { reportError } = await import('@/lib/error-reporter');
    expect(reportError).toHaveBeenCalled();
  });
});

describe('POST /api/v1/maintenance-requests/[id]/notes', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await POST(postReq(REQUEST_ID, { body: 'Checked the shutoff valve.' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(addNote).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(BAD_ID, { body: 'Checked the shutoff valve.' }), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(addNote).not.toHaveBeenCalled();
  });

  it('returns 400 on invalid JSON and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const req = new NextRequest(`http://localhost/api/v1/maintenance-requests/${REQUEST_ID}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(req, { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
    expect(addNote).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when body.body is missing', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(REQUEST_ID, {}), { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
    expect(addNote).not.toHaveBeenCalled();
  });

  it('returns 400 validation_error when body.body is not a string (e.g. a number)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await POST(postReq(REQUEST_ID, { body: 42 }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
    expect(addNote).not.toHaveBeenCalled();
  });

  it('forwards body.body to addNote(id, body) and returns 201 { id } — T8-M3: a 200 here must fail this test', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    addNote.mockResolvedValueOnce({ id: 'n-1' });
    const res = await POST(postReq(REQUEST_ID, { body: 'Checked the shutoff valve.' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'n-1' });
    expect(addNote).toHaveBeenCalledWith(REQUEST_ID, 'Checked the shutoff valve.');
  });

  it('maps the service\'s manage-only forbidden ServiceError to 403 (submit-only caller)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    addNote.mockRejectedValueOnce(new ServiceError('forbidden', 'Missing permission: maintenance_requests:manage'));
    const res = await POST(postReq(REQUEST_ID, { body: 'Checked the shutoff valve.' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(403);
  });

  it('maps a validation_error ServiceError (note too long) to 400', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    addNote.mockRejectedValueOnce(new ServiceError('validation_error', 'Notes must be 1 to 4,000 characters.'));
    const res = await POST(postReq(REQUEST_ID, { body: 'x'.repeat(4001) }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
  });

  it('maps a not_found ServiceError to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    addNote.mockRejectedValueOnce(new ServiceError('not_found', 'Maintenance request not found.'));
    const res = await POST(postReq(REQUEST_ID, { body: 'Checked the shutoff valve.' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(404);
  });

  it('maps an unmapped thrown error to 500 and reports it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    addNote.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(postReq(REQUEST_ID, { body: 'Checked the shutoff valve.' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(500);
    const { reportError } = await import('@/lib/error-reporter');
    expect(reportError).toHaveBeenCalled();
  });

  // §16 posture: never log note text. This route never calls reportError
  // (or any logger) with the note body on the success path — pinned here
  // since it's cheap and the brief calls this out explicitly.
  it('never logs the note body on the success path', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    addNote.mockResolvedValueOnce({ id: 'n-1' });
    await POST(postReq(REQUEST_ID, { body: 'A secret-shaped note nobody should log.' }), { params: params(REQUEST_ID) });
    const { reportError } = await import('@/lib/error-reporter');
    expect(reportError).not.toHaveBeenCalled();
  });
});
