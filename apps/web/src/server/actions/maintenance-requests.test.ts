import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * resolveMaintenanceRequestAction (Maintenance Resolved, Task 4) — the
 * archiveMaintenanceRequestAction/cancelMaintenanceRequestAction clone with
 * the values pass-through per the brief's Step 3 note. Mocks
 * MaintenanceRequestsService as a spy constructor (the inventory.
 * placeStock.test.ts convention) rather than a full supabase-mock stub: the
 * action's own job is uuid-validate + delegate + revalidate, and the
 * service's OWN behavior is already covered exhaustively by
 * maintenance-requests.test.ts.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { mockResolve, ctxRef } = vi.hoisted(() => ({
  mockResolve: vi.fn(async () => undefined),
  ctxRef: { ctx: null as unknown },
}));

vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...actual,
    withContext: vi.fn(async () => ctxRef.ctx),
  };
});

vi.mock('@/server/services/maintenance-requests', () => ({
  MaintenanceRequestsService: class {
    resolve = mockResolve;
  },
}));

import { revalidatePath } from 'next/cache';

import { ServiceError } from '@/server/services/context';

import { resolveMaintenanceRequestAction } from './maintenance-requests';

const ORG_ID = 'org-test';
const USER_ID = 'user-test';
const VALID_ID = '11111111-1111-4111-8111-111111111111';
const NOTE_VALUES = { note: 'Replaced the AC unit compressor and tested airflow.' };

beforeEach(() => {
  vi.clearAllMocks();
  ctxRef.ctx = {
    organizationId: ORG_ID,
    userId: USER_ID,
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    enabledModules: new Set(['maintenance_requests']),
    supabase: {},
  };
});

describe('resolveMaintenanceRequestAction', () => {
  it('rejects a malformed id (uuid-validates BEFORE ever calling the service)', async () => {
    const res = await resolveMaintenanceRequestAction('not-a-uuid', NOTE_VALUES);
    expect('ok' in res && res.ok).not.toBe(true);
    if (!('ok' in res)) expect(res.error.message).toBe('That request id is not valid.');
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('calls service.resolve(id, values) and returns ok on success', async () => {
    const res = await resolveMaintenanceRequestAction(VALID_ID, NOTE_VALUES);
    expect(res).toEqual({ ok: true });
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith(VALID_ID, NOTE_VALUES);
  });

  it('revalidates BOTH the list path and the detail path on success', async () => {
    await resolveMaintenanceRequestAction(VALID_ID, NOTE_VALUES);
    expect(revalidatePath).toHaveBeenCalledWith('/dashboard/maintenance');
    expect(revalidatePath).toHaveBeenCalledWith(`/dashboard/maintenance/${VALID_ID}`);
    expect(revalidatePath).toHaveBeenCalledTimes(2);
  });

  it('a ServiceError from the service maps to { error: { message } } — no revalidation on failure', async () => {
    mockResolve.mockRejectedValueOnce(new ServiceError('conflict', 'This request is already resolved.'));
    const res = await resolveMaintenanceRequestAction(VALID_ID, NOTE_VALUES);
    expect(res).toEqual({ error: { message: 'This request is already resolved.' } });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a non-ServiceError failure degrades to the generic message, never leaking internals', async () => {
    mockResolve.mockRejectedValueOnce(new Error('some internal DB detail'));
    const res = await resolveMaintenanceRequestAction(VALID_ID, NOTE_VALUES);
    expect(res).toEqual({ error: { message: 'Something went wrong. Please try again.' } });
  });
});
