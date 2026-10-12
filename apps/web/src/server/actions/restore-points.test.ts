import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The restore point actions (PR stage, security review SEC-T2). An internal
 * error's text is database or network detail (a PostgREST message, a socket
 * error), so it stays in the server log and the browser gets fixed words, as
 * the Ungroup actions do. Every other refusal keeps its own words, and the
 * reason the screens act on (the MFA step-up, the audit log the SKU-change
 * check cannot read).
 */

const h = vi.hoisted(() => ({
  createSnapshot: vi.fn(),
  restoreSnapshot: vi.fn(),
  restorePointSkuChanges: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateInventoryListForCurrentOrg: vi.fn(async () => undefined),
}));

vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: h.revalidateInventoryListForCurrentOrg,
}));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...actual,
    withContext: vi.fn(async () => ({ organizationId: 'org-1', userId: 'user-1', role: 'owner' })),
  };
});
vi.mock('@/server/services/restore-points', () => ({
  createSnapshot: h.createSnapshot,
  restoreSnapshot: h.restoreSnapshot,
  restorePointSkuChanges: h.restorePointSkuChanges,
}));

import { ServiceError } from '@/server/services/context';

import {
  createRestorePointAction,
  restoreFromPointAction,
  restorePointSkuChangesAction,
} from './restore-points';

const POINT = '33333333-3333-4333-8333-333333333333';
// What a database or a socket says. None of it may reach the browser.
const RAW_DB =
  'new row for relation "restore_points" violates check constraint "restore_points_kind_check"';
const RAW_NET = 'fetch failed: connect ECONNRESET 10.0.0.12:6543';

let logged: unknown[][];
beforeEach(() => {
  vi.clearAllMocks();
  logged = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    logged.push(a);
  });
});

const CASES = [
  {
    name: 'createRestorePointAction',
    words: 'Could not create the restore point. Please try again.',
    mock: h.createSnapshot,
    call: () => createRestorePointAction({ label: 'before a bulk edit' }),
  },
  {
    name: 'restoreFromPointAction',
    words: 'Could not restore this point. Please try again.',
    mock: h.restoreSnapshot,
    call: () => restoreFromPointAction({ id: POINT, confirm: 'RESTORE' }),
  },
  {
    name: 'restorePointSkuChangesAction',
    words: 'Could not check for SKU changes. Please try again.',
    mock: h.restorePointSkuChanges,
    call: () => restorePointSkuChangesAction({ id: POINT }),
  },
] as const;

describe.each(CASES)('$name', ({ words, mock, call }) => {
  it('answers an internal error with fixed words and keeps the raw text in the server log', async () => {
    const e = new ServiceError('internal_error', RAW_DB);
    mock.mockRejectedValueOnce(e);
    const r = await call();
    expect(r).toEqual({ ok: false, error: { code: 'internal_error', message: words } });
    expect(JSON.stringify(r)).not.toContain('restore_points_kind_check');
    expect(logged.flat()).toContain(e);
  });

  it('answers an unexpected throw (not a ServiceError) the same way', async () => {
    const e = new Error(RAW_NET);
    mock.mockRejectedValueOnce(e);
    const r = await call();
    expect(r).toEqual({ ok: false, error: { code: 'internal_error', message: words } });
    expect(JSON.stringify(r)).not.toContain('ECONNRESET');
    expect(logged.flat()).toContain(e);
  });

  it('keeps the words of every other refusal, which the service wrote for people', async () => {
    mock.mockRejectedValueOnce(
      new ServiceError(
        'plan_limit_exceeded',
        'Restore points are a Business feature. Upgrade to Business or above to enable them.',
      ),
    );
    expect(await call()).toEqual({
      ok: false,
      error: {
        code: 'plan_limit_exceeded',
        message:
          'Restore points are a Business feature. Upgrade to Business or above to enable them.',
      },
    });
    expect(logged).toEqual([]);
  });
});

describe('the reasons the screens act on', () => {
  it('restoreFromPointAction passes the MFA step-up reason through, so the row asks for the code', async () => {
    h.restoreSnapshot.mockRejectedValueOnce(
      new ServiceError('forbidden', 'Re-authenticate with MFA before performing this action.', {
        reason: 'aal2_required',
      }),
    );
    expect(await restoreFromPointAction({ id: POINT, confirm: 'RESTORE' })).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Re-authenticate with MFA before performing this action.',
        details: { reason: 'aal2_required' },
      },
    });
  });

  it('restorePointSkuChangesAction passes the audit-log reason through, so the row says why the check cannot run (DATA-1)', async () => {
    h.restorePointSkuChanges.mockRejectedValueOnce(
      new ServiceError(
        'forbidden',
        'Checking for SKU changes reads the audit log, which you cannot view.',
        {
          reason: 'audit_log_hidden',
        },
      ),
    );
    expect(await restorePointSkuChangesAction({ id: POINT })).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Checking for SKU changes reads the audit log, which you cannot view.',
        details: { reason: 'audit_log_hidden' },
      },
    });
  });

  it('an internal error carries no details at all, even when the service attached some', async () => {
    h.restoreSnapshot.mockRejectedValueOnce(
      new ServiceError('internal_error', RAW_DB, {
        reason: 'leaks',
        hint: 'restore_points_kind_check',
      }),
    );
    const r = await restoreFromPointAction({ id: POINT, confirm: 'RESTORE' });
    expect(r).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Could not restore this point. Please try again.' },
    });
  });
});
