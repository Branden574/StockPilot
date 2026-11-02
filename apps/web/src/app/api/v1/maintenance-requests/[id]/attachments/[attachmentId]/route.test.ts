import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';

/**
 * DELETE /api/v1/maintenance-requests/[id]/attachments/[attachmentId]: the
 * web photo panel's Remove (the phone has no photo remove).
 *
 * Driven through the REAL MaintenanceAttachmentsService.remove with a stub
 * for the caller's own client, so these pin what the route answers each
 * person (B104): the request's requester or a holder of
 * maintenance_requests:manage removes the photo; anyone else gets 403 'Not
 * your request.' before anything is deleted, never the 500 a database refusal
 * would become.
 */

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => undefined) }));
const storageRemove = vi.hoisted(() => vi.fn(async () => ({ data: null, error: null })));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ remove: storageRemove }) } }),
}));

import { withApiContext } from '@/lib/auth/api-context';
import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { DELETE } from './route';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const PHOTO_ID = '22222222-2222-4222-8222-222222222222';

function arrange(opts: {
  role: 'manager' | 'staff';
  permissions?: string[];
  requesterUserId: string;
}) {
  const stub = makeSupabaseStub({
    'maintenance_request_attachments.select': {
      data: { id: PHOTO_ID, storage_path: `org-test/${REQUEST_ID}/a.jpg`, thumbnail_path: null },
      error: null,
    },
    // The delete answers as the policy does today: its role arm lets a
    // manager through.
    'maintenance_request_attachments.delete': { data: { id: PHOTO_ID }, error: null },
    // The request answers only a read whose filters match it (a read keyed
    // by the photo's id finds no requester, as in the database).
    'maintenance_requests.select': servedLikePostgrest([
      {
        id: REQUEST_ID,
        organization_id: 'org-test',
        requester_user_id: opts.requesterUserId,
        archived_at: null,
        cancelled_at: null,
        resolved_at: null,
      },
    ]),
  });
  const ctx = makeServiceContext(stub.client, {
    userId: 'u-1',
    role: opts.role,
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
    enabledModules: new Set<ModuleId>([...DEFAULT_MODULE_IDS, 'maintenance_requests']),
  });
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  return stub;
}

function removeRequest() {
  return new NextRequest(
    `http://localhost/api/v1/maintenance-requests/${REQUEST_ID}/attachments/${PHOTO_ID}`,
    { method: 'DELETE' },
  );
}

function params() {
  return { params: Promise.resolve({ id: REQUEST_ID, attachmentId: PHOTO_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DELETE /api/v1/maintenance-requests/[id]/attachments/[attachmentId]', () => {
  it('a manager whose manage permission is switched off gets 403 "Not your request." on another member\'s photo, and nothing is deleted', async () => {
    const stub = arrange({
      role: 'manager',
      permissions: ['maintenance_requests:submit', 'maintenance_requests:read_all'],
      requesterUserId: 'someone-else',
    });

    const res = await DELETE(removeRequest(), params());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', message: 'Not your request.' });
    expect(stub.chainsAll.get('maintenance_request_attachments.delete')).toBeUndefined();
    expect(storageRemove).not.toHaveBeenCalled();
  });

  async function expectRemoved(res: Response, stub: ReturnType<typeof arrange>) {
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(stub.chainsAll.get('maintenance_request_attachments.delete')).toHaveLength(1);
    expect(storageRemove).toHaveBeenCalledWith([`org-test/${REQUEST_ID}/a.jpg`]);
  }

  it('the requester (staff: submit only) gets 200 and the photo is removed, after one read of the requester of this request in this organization', async () => {
    const stub = arrange({ role: 'staff', requesterUserId: 'u-1' });

    const res = await DELETE(removeRequest(), params());

    await expectRemoved(res, stub);
    expect(stub.chainArgsAll.get('maintenance_requests.select')).toEqual([
      [['requester_user_id'], ['organization_id', 'org-test'], ['id', REQUEST_ID]],
    ]);
  });

  it('a manage holder who did not file the request gets 200 and the photo is removed, with no read of the requester', async () => {
    const stub = arrange({ role: 'manager', requesterUserId: 'someone-else' });

    const res = await DELETE(removeRequest(), params());

    await expectRemoved(res, stub);
    expect(stub.chainsAll.get('maintenance_requests.select')).toBeUndefined();
  });
});
