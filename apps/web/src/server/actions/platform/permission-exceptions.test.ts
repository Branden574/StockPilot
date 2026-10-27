import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ORDER_ITEMS_ACCESS_BUSY_COPY,
  ORDER_ITEMS_ACCESS_CHANGED_COPY,
  ORDER_ITEMS_ACCESS_INVALID_COPY,
  ORDER_ITEMS_ACCESS_MEMBER_NOT_FOUND_COPY,
  ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY,
} from '@stockpilot/core';

/**
 * setOrderItemsAccessAction: the console's Order items access dialog.
 *
 *   - every state (Allow, Deny and Follow role default) needs a FRESH step-up:
 *     Reset can give a manager their default access back, so it is gated as a
 *     grant (re-enable precedent). A stale step-up comes back as
 *     details.reason 'aal2_required' so useStepUp() re-prompts in place;
 *   - only the session's user id goes down (the service re-verifies the email
 *     from GoTrue);
 *   - a lost compare-and-set is a conflict with the stale-state sentence and
 *     the current state, never "not authorized".
 *
 * Synthetic data only.
 */

const checkPlatformAdmin = vi.fn();
const set = vi.fn();
const revalidatePath = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: (...a: unknown[]) => checkPlatformAdmin(...a),
}));
vi.mock('@/server/services/platform/permission-exceptions', () => ({
  PermissionExceptionsService: { set: (...a: unknown[]) => set(...a) },
}));

import { setOrderItemsAccessAction } from './permission-exceptions';

const ORG = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const SESSION = { userId: '33333333-3333-4333-8333-333333333333', email: 'support-admin@example.org' };
const INPUT = { organizationId: ORG, targetUserId: TARGET, state: 'deny' as const, expectedState: 'default' as const };

beforeEach(() => {
  vi.clearAllMocks();
  checkPlatformAdmin.mockResolvedValue({ ok: true, session: SESSION });
  set.mockResolvedValue({ ok: true, before: 'default', after: 'deny', targetRole: 'manager', changed: true });
});

describe('setOrderItemsAccessAction: the gate', () => {
  it.each(['allow', 'deny', 'default'] as const)('%s requires a FRESH step-up', async (state) => {
    await setOrderItemsAccessAction({ ...INPUT, state });
    expect(checkPlatformAdmin).toHaveBeenCalledWith({ requireStepUp: true });
  });

  it('a stale step-up is forbidden with reason aal2_required, and nothing is written', async () => {
    checkPlatformAdmin.mockResolvedValue({ ok: false, reason: 'aal2_required' });
    const res = await setOrderItemsAccessAction(INPUT);
    expect(res).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Not authorized.', details: { reason: 'aal2_required' } },
    });
    expect(set).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('a non-admin is forbidden without the step-up reason', async () => {
    checkPlatformAdmin.mockResolvedValue({ ok: false, reason: 'forbidden' });
    const res = await setOrderItemsAccessAction(INPUT);
    expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: 'Not authorized.' } });
    expect(set).not.toHaveBeenCalled();
  });

  it('a malformed input is refused before the gate', async () => {
    for (const bad of [
      { ...INPUT, organizationId: 'not-a-uuid' },
      { ...INPUT, targetUserId: '' },
      { ...INPUT, state: 'grant' },
      { ...INPUT, expectedState: undefined },
    ]) {
      const res = await setOrderItemsAccessAction(bad as never);
      expect(res).toEqual({
        ok: false,
        error: { code: 'validation_error', message: ORDER_ITEMS_ACCESS_INVALID_COPY },
      });
    }
    expect(checkPlatformAdmin).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });
});

describe('setOrderItemsAccessAction: the write', () => {
  it('hands the service only the session user id, then refreshes the org page', async () => {
    const res = await setOrderItemsAccessAction(INPUT);
    expect(set).toHaveBeenCalledWith({
      organizationId: ORG,
      targetUserId: TARGET,
      state: 'deny',
      expectedState: 'default',
      actorUserId: SESSION.userId,
    });
    expect(res).toEqual({ ok: true, data: { before: 'default', after: 'deny', targetRole: 'manager', changed: true } });
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/orgs/${ORG}`);
  });

  it('a repeat of the current state is ok with changed false', async () => {
    set.mockResolvedValue({ ok: true, before: 'deny', after: 'deny', targetRole: 'owner', changed: false });
    const res = await setOrderItemsAccessAction({ ...INPUT, expectedState: 'deny' });
    expect(res).toEqual({ ok: true, data: { before: 'deny', after: 'deny', targetRole: 'owner', changed: false } });
  });

  it('a lost compare-and-set is a conflict with the stale-state sentence and the current state', async () => {
    set.mockResolvedValue({ ok: false, code: 'changed', current: 'allow' });
    const res = await setOrderItemsAccessAction(INPUT);
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message: ORDER_ITEMS_ACCESS_CHANGED_COPY,
        details: { reason: 'permission_exception_changed', current: 'allow' },
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/platform/orgs/${ORG}`);
  });

  it.each([
    [{ ok: false, code: 'member_not_found' }, 'not_found', ORDER_ITEMS_ACCESS_MEMBER_NOT_FOUND_COPY, { reason: 'member_not_found' }],
    [{ ok: false, code: 'invalid', field: 'target' }, 'validation_error', ORDER_ITEMS_ACCESS_INVALID_COPY, { reason: 'permission_exception_invalid', field: 'target' }],
    [{ ok: false, code: 'busy' }, 'conflict', ORDER_ITEMS_ACCESS_BUSY_COPY, { reason: 'busy' }],
    [{ ok: false, code: 'not_authorized' }, 'forbidden', 'Not authorized.', undefined],
    [{ ok: false, code: 'internal' }, 'internal_error', ORDER_ITEMS_ACCESS_SAVE_FAILED_COPY, undefined],
  ])('service %j maps to %s', async (serviceResult, code, message, details) => {
    set.mockResolvedValue(serviceResult);
    const res = await setOrderItemsAccessAction(INPUT);
    expect(res).toEqual({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
  });
});
