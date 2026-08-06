import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { ModuleId, Permission } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { ServiceError } from '@/server/services/context';
import { MaintenanceRequestsService } from '@/server/services/maintenance-requests';
import { MaintenanceAttachmentsService } from '@/server/services/maintenance-attachments';
import { MaintenanceShareLinksService } from '@/server/services/maintenance-share-links';
import { makeSupabaseStub } from '@/test/supabase-mock';

import { GET, PATCH } from './route';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/server/services/maintenance-requests', () => ({ MaintenanceRequestsService: vi.fn() }));
vi.mock('@/server/services/maintenance-attachments', () => ({ MaintenanceAttachmentsService: vi.fn() }));
// Only the CLASS is mocked (ensureActiveLink is wired per-test below) —
// maintenanceShareLinksEnabled stays the REAL implementation, which reads
// `ctx.supabase`'s own 'organization_modules.select' canning (already
// configured per-test via buildCtx({ settings })), the exact org-setting
// read this route used to duplicate locally before Task 4 lifted it into
// this shared module.
vi.mock('@/server/services/maintenance-share-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/maintenance-share-links')>();
  return { ...actual, MaintenanceShareLinksService: vi.fn() };
});
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

const REQUEST_ID = '11111111-1111-1111-1111-111111111111';
const BAD_ID = 'not-a-uuid';

const get = vi.fn();
const update = vi.fn();
const emailInput = vi.fn();
const signedViewUrls = vi.fn();
const ensureActiveLink = vi.fn();

const DETAIL = {
  id: REQUEST_ID,
  requestNumber: 42,
  createdAt: '2026-08-01T00:00:00.000Z',
  subject: 'Leaky faucet',
  status: 'saved',
  priority: 'normal',
  category: null,
  siteName: 'DC4',
  requesterName: 'Raj',
  requesterUserId: 'u-1',
  photoCount: 2,
  draftOpened: false,
  localOwnerUserId: null,
  description: 'Water on the floor.',
  requesterEmail: 'raj@example.com',
  requesterPhone: null,
  charterId: null,
  warehouseId: null,
  building: null,
  roomOrArea: null,
  department: null,
  accessInstructions: null,
  relatedItemId: null,
  relatedOrderRequestId: null,
  relatedRentalId: null,
  relatedLocationId: null,
  outlookDraftOpenedAt: null,
  outlookDraftOpenCount: 0,
  archivedAt: null,
  cancelledAt: null,
  updatedAt: '2026-08-01T00:00:00.000Z',
};

function buildCtx(opts: { permissions?: Permission[]; settings?: Record<string, unknown> | null } = {}) {
  const stub = makeSupabaseStub({
    'organization_modules.select': { data: opts.settings === undefined ? { settings: {} } : opts.settings === null ? null : { settings: opts.settings }, error: null },
  });
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'staff' as const,
    permissions: opts.permissions ? new Set(opts.permissions) : undefined,
    supabase: stub.client as never,
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set<ModuleId>(['maintenance_requests']),
  };
}

function getReq() {
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${REQUEST_ID}`);
}

function patchReq(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/maintenance-requests/${REQUEST_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return Promise.resolve({ id });
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockReset();
  update.mockReset();
  emailInput.mockReset();
  signedViewUrls.mockReset();
  ensureActiveLink.mockReset();
  get.mockResolvedValue(DETAIL);
  // Mirrors the real emailInput() shape closely enough for these tests: the
  // one field the route/tests care about (shareUrl) passes through exactly
  // what the route computed and handed in.
  emailInput.mockImplementation(async (_id: string, opts: { shareUrl: string | null }) => ({
    requestNumber: 'MR-42',
    subject: DETAIL.subject,
    description: DETAIL.description,
    category: DETAIL.category,
    priority: DETAIL.priority,
    submittedAtDisplay: 'Aug 1, 2026',
    requesterName: DETAIL.requesterName,
    requesterEmail: DETAIL.requesterEmail,
    requesterPhone: DETAIL.requesterPhone,
    siteName: DETAIL.siteName,
    department: DETAIL.department,
    building: DETAIL.building,
    roomOrArea: DETAIL.roomOrArea,
    accessInstructions: DETAIL.accessInstructions,
    relatedItem: null,
    relatedOrder: null,
    relatedRental: null,
    photoCount: DETAIL.photoCount,
    shareUrl: opts.shareUrl,
  }));
  signedViewUrls.mockResolvedValue([
    { id: 'a-1', originalFilename: 'leak.jpg', url: 'https://signed/leak.jpg', thumbUrl: 'https://signed/leak-thumb.jpg', width: 800, height: 600 },
  ]);
  ensureActiveLink.mockResolvedValue({ token: 'tok', url: 'https://stockpilotusa.com/m/tok', expiresAt: '2027-01-01T00:00:00.000Z' });
  vi.mocked(MaintenanceRequestsService).mockImplementation(
    () => ({ get, update, emailInput }) as unknown as InstanceType<typeof MaintenanceRequestsService>,
  );
  vi.mocked(MaintenanceAttachmentsService).mockImplementation(
    () => ({ signedViewUrls }) as unknown as InstanceType<typeof MaintenanceAttachmentsService>,
  );
  vi.mocked(MaintenanceShareLinksService).mockImplementation(
    () => ({ ensureActiveLink }) as unknown as InstanceType<typeof MaintenanceShareLinksService>,
  );
});

describe('GET /api/v1/maintenance-requests/[id]', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await GET(getReq(), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await GET(getReq(), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it('returns request + photos + emailInput with the ensured share link when the org allows it', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ settings: { includeShareLinksInEmail: true } }) as never);
    const res = await GET(getReq(), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request.id).toBe(REQUEST_ID);
    expect(body.photos).toHaveLength(1);
    expect(body.photos[0]).toEqual({
      id: 'a-1',
      originalFilename: 'leak.jpg',
      url: 'https://signed/leak.jpg',
      thumbUrl: 'https://signed/leak-thumb.jpg',
      width: 800,
      height: 600,
    });
    expect(body.emailInput.shareUrl).toBe('https://stockpilotusa.com/m/tok');
    expect(ensureActiveLink).toHaveBeenCalledWith(REQUEST_ID);
  });

  it('omits the share link (shareUrl: null) when the org setting disables it, and never mints one', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ settings: { includeShareLinksInEmail: false } }) as never);
    const res = await GET(getReq(), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emailInput.shareUrl).toBeNull();
    expect(ensureActiveLink).not.toHaveBeenCalled();
  });

  it('defaults to ON (shareUrl minted) when no organization_modules settings row exists', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ settings: null }) as never);
    const res = await GET(getReq(), { params: params(REQUEST_ID) });
    const body = await res.json();
    expect(body.emailInput.shareUrl).toBe('https://stockpilotusa.com/m/tok');
  });

  it('never mints a share link for a request with zero photos', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ settings: { includeShareLinksInEmail: true } }) as never);
    get.mockResolvedValueOnce({ ...DETAIL, photoCount: 0 });
    const res = await GET(getReq(), { params: params(REQUEST_ID) });
    const body = await res.json();
    expect(body.emailInput.shareUrl).toBeNull();
    expect(ensureActiveLink).not.toHaveBeenCalled();
  });

  it('does not fail the whole detail read when the caller cannot mint a share link (read_all viewer of a foreign request)', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ settings: { includeShareLinksInEmail: true } }) as never);
    ensureActiveLink.mockRejectedValueOnce(new ServiceError('forbidden', 'Missing permission: maintenance_requests:manage'));
    const res = await GET(getReq(), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emailInput.shareUrl).toBeNull();
  });

  it('surfaces a non-ServiceError failure from the share-link mint as 500, never a silent degraded read', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx({ settings: { includeShareLinksInEmail: true } }) as never);
    ensureActiveLink.mockRejectedValueOnce(new Error('boom'));
    const res = await GET(getReq(), { params: params(REQUEST_ID) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
  });

  it('reports canManage true when the caller holds maintenance_requests:manage', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(
      buildCtx({ permissions: ['maintenance_requests:manage'], settings: {} }) as never,
    );
    const res = await GET(getReq(), { params: params(REQUEST_ID) });
    const body = await res.json();
    expect(body.canManage).toBe(true);
  });

  it('reports canManage false when the caller only holds submit', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(
      buildCtx({ permissions: ['maintenance_requests:submit'], settings: {} }) as never,
    );
    const res = await GET(getReq(), { params: params(REQUEST_ID) });
    const body = await res.json();
    expect(body.canManage).toBe(false);
  });

  it('maps a not_found ServiceError to 404', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    get.mockRejectedValueOnce(new ServiceError('not_found', 'Maintenance request not found'));
    const res = await GET(getReq(), { params: params(REQUEST_ID) });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/v1/maintenance-requests/[id]', () => {
  it('returns 401 with no context', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(null);
    const res = await PATCH(patchReq({ subject: 'New subject line here' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(401);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a malformed id with 400 and never calls the service', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const res = await PATCH(patchReq({ subject: 'New subject line here' }), { params: params(BAD_ID) });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('forwards the body to service.update and returns { ok: true }', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    update.mockResolvedValueOnce(undefined);
    const body = { subject: 'New subject line here' };
    const res = await PATCH(patchReq(body), { params: params(REQUEST_ID) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith(REQUEST_ID, body);
  });

  it('maps a forbidden ServiceError (foreign requester) to 403', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    update.mockRejectedValueOnce(new ServiceError('forbidden', 'Not your request.'));
    const res = await PATCH(patchReq({ subject: 'New subject line here' }), { params: params(REQUEST_ID) });
    expect(res.status).toBe(403);
  });

  it('returns 400 on invalid JSON', async () => {
    vi.mocked(withApiContext).mockResolvedValueOnce(buildCtx() as never);
    const req = new NextRequest(`http://localhost/api/v1/maintenance-requests/${REQUEST_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await PATCH(req, { params: params(REQUEST_ID) });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
