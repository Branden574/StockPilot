import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate is the whole point of this layer. Disabling an account is
 * destructive and cross-org, so it sits on the 15-minute FRESH step-up tier
 * (the same one act-as, billing and provisioning use), and a stale step-up must
 * come back as details.reason='aal2_required' or the shipped useStepUp() retry
 * loop cannot re-challenge in place.
 *
 * The other half of this layer's job is HONEST reporting. The service returns
 * `partial` + `partialReasons` for a half-applied change and
 * ACCOUNT_STATUS_CHANGED for a lost compare-and-set; both must reach the
 * operator intact — a partial must never read as a clean success, and a lost
 * race must never read as "you don't have permission".
 */

const checkPlatformAdmin = vi.fn();
const disableUserAccount = vi.fn();
const reenableUserAccount = vi.fn();

vi.mock('@/lib/auth/platform-admin', () => ({
  checkPlatformAdmin: (...a: unknown[]) => checkPlatformAdmin(...a),
}));
vi.mock('@/server/services/platform/account-status', () => ({
  disableUserAccount: (...a: unknown[]) => disableUserAccount(...a),
  reenableUserAccount: (...a: unknown[]) => reenableUserAccount(...a),
}));
vi.mock('@/server/services/platform/users', () => ({ sendPasswordResetForUser: vi.fn() }));

import { disableUserAccountAction, reenableUserAccountAction } from './users';

const TARGET = '11111111-1111-1111-1111-111111111111';
/**
 * `email` is present because the real ServerSession carries it — its presence
 * here is what makes the "called with EXACTLY these keys" assertions below a
 * real guard: the actions must resolve nothing from it, because it is sourced
 * from the attacker-writable `user_profiles.email` column.
 */
const SESSION = { userId: '22222222-2222-2222-2222-222222222222', email: 'god@stockpilotusa.com' };
const REASON = { category: 'security_investigation' as const };

describe('disableUserAccountAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkPlatformAdmin.mockResolvedValue({ ok: true, session: SESSION });
    disableUserAccount.mockResolvedValue({
      ok: true,
      alreadyDisabled: false,
      banned: true,
      sessionsRevoked: 2,
      partial: false,
      partialReasons: [],
    });
  });

  it('requires a FRESH step-up', async () => {
    await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(checkPlatformAdmin).toHaveBeenCalledWith({ requireStepUp: true });
  });

  it('passes aal2_required back so useStepUp can re-challenge in place', async () => {
    checkPlatformAdmin.mockResolvedValue({ ok: false, reason: 'aal2_required' });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.details?.reason).toBe('aal2_required');
    expect(disableUserAccount).not.toHaveBeenCalled();
  });

  it('refuses a non-admin without calling the service', async () => {
    checkPlatformAdmin.mockResolvedValue({ ok: false, reason: 'forbidden' });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok === false && res.error.code).toBe('forbidden');
    expect(res.ok === false && res.error.details?.code).toBe('ACCOUNT_DISABLE_NOT_AUTHORIZED');
    expect(res.ok === false && res.error.details?.reason).toBeUndefined();
    expect(disableUserAccount).not.toHaveBeenCalled();
  });

  it('rejects a reason whose notes are missing before the gate even matters', async () => {
    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: { category: 'other' } });

    expect(res.ok === false && res.error.code).toBe('validation_error');
    expect(res.ok === false && res.error.details?.code).toBe('ACCOUNT_DISABLE_REASON_REQUIRED');
    expect(checkPlatformAdmin).not.toHaveBeenCalled();
    expect(disableUserAccount).not.toHaveBeenCalled();
  });

  it('rejects a wholly missing reason', async () => {
    const res = await disableUserAccountAction({
      targetUserId: TARGET,
    } as unknown as Parameters<typeof disableUserAccountAction>[0]);

    expect(res.ok === false && res.error.code).toBe('validation_error');
    expect(res.ok === false && res.error.details?.code).toBe('ACCOUNT_DISABLE_REASON_REQUIRED');
    expect(res.ok === false && res.error.message).toBe('A reason is required.');
  });

  it('rejects a non-uuid target', async () => {
    const res = await disableUserAccountAction({ targetUserId: 'nope', reason: REASON });

    expect(res.ok === false && res.error.code).toBe('validation_error');
    expect(disableUserAccount).not.toHaveBeenCalled();
  });

  it('maps PROTECTED_ADMIN_ACCOUNT to a forbidden result with the sub-code', async () => {
    disableUserAccount.mockResolvedValue({ ok: false, code: 'PROTECTED_ADMIN_ACCOUNT' });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok === false && res.error.code).toBe('forbidden');
    expect(res.ok === false && res.error.details?.code).toBe('PROTECTED_ADMIN_ACCOUNT');
    expect(res.ok === false && res.error.message).toBe('Platform administrators cannot be disabled.');
  });

  it('maps ACCOUNT_NOT_FOUND to not_found', async () => {
    disableUserAccount.mockResolvedValue({ ok: false, code: 'ACCOUNT_NOT_FOUND' });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok === false && res.error.code).toBe('not_found');
    expect(res.ok === false && res.error.details?.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('reports a lost compare-and-set race as a retryable conflict, NOT a permission error', async () => {
    disableUserAccount.mockResolvedValue({ ok: false, code: 'ACCOUNT_STATUS_CHANGED' });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok === false && res.error.code).toBe('conflict');
    expect(res.ok === false && res.error.details?.code).toBe('ACCOUNT_STATUS_CHANGED');
    expect(res.ok === false && res.error.message).toMatch(/reload/i);
    // The actor's allowlist membership was verified before the write; telling a
    // god admin they lack permission because a peer won the race is a lie.
    expect(res.ok === false && res.error.code).not.toBe('forbidden');
  });

  it('reports a partial disable so the operator knows to press it again', async () => {
    disableUserAccount.mockResolvedValue({
      ok: true,
      alreadyDisabled: false,
      banned: false,
      sessionsRevoked: 0,
      partial: true,
      partialReasons: ['ban_not_applied', 'sessions_not_revoked'],
    });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok === false && res.error.code).toBe('internal_error');
    expect(res.ok === false && res.error.message).toContain('Disable again');
    expect(res.ok === false && res.error.details?.partialReasons).toEqual([
      'ban_not_applied',
      'sessions_not_revoked',
    ]);
  });

  it('names the audit gap and DOES promise the retry, because the service now re-attempts it', async () => {
    disableUserAccount.mockResolvedValue({
      ok: true,
      alreadyDisabled: false,
      banned: true,
      sessionsRevoked: 1,
      partial: true,
      partialReasons: ['not_audited'],
    });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok === false && res.error.code).toBe('internal_error');
    expect(res.ok === false && res.error.message).toMatch(/audit log/i);
    // The service no longer short-circuits the audit write on the
    // already-disabled healing path, so a second press really does re-attempt
    // the missing row. The advice is now true instead of false comfort.
    expect(res.ok === false && res.error.message).toContain('Disable again');
    expect(res.ok === false && res.error.details?.partialReasons).toEqual(['not_audited']);
  });

  it('names EVERY gap in a mixed set and keeps the retry advice honest', async () => {
    disableUserAccount.mockResolvedValue({
      ok: true,
      alreadyDisabled: false,
      banned: false,
      sessionsRevoked: 0,
      partial: true,
      partialReasons: ['ban_not_applied', 'not_audited'],
    });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    // The mixed set is what the suite never covered. It used to be judged by
    // `.some()`: one retryable member made the whole message say "press it
    // again", the retry forced audited=true on the already-disabled path, and
    // the second press reported a clean success with the audit row gone for
    // good. Both clauses must be named, and the advice must hold for BOTH.
    expect(res.ok === false && res.error.message).toMatch(/sign-in block/i);
    expect(res.ok === false && res.error.message).toMatch(/audit log/i);
    expect(res.ok === false && res.error.message).toContain('Disable again');
    expect(res.ok === false && res.error.details?.partialReasons).toEqual([
      'ban_not_applied',
      'not_audited',
    ]);
  });

  it('says so when the two layers could not be confirmed to agree', async () => {
    disableUserAccount.mockResolvedValue({
      ok: true,
      alreadyDisabled: false,
      banned: true,
      sessionsRevoked: 1,
      superseded: false,
      partial: true,
      partialReasons: ['status_unverified'],
    });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    // The convergence read is the thing that stops a flag/ban divergence being
    // silent. When IT is the thing that failed, saying nothing would restore
    // exactly the silence it was added to remove.
    expect(res.ok === false && res.error.message).toMatch(/could not be confirmed/i);
    // Pressing again re-runs the whole sequence, re-read included.
    expect(res.ok === false && res.error.message).toContain('Disable again');
  });

  it('names the RIGHT button when a peer admin superseded the disable', async () => {
    disableUserAccount.mockResolvedValue({
      ok: true,
      alreadyDisabled: false,
      banned: true,
      sessionsRevoked: 0,
      superseded: true,
      partial: true,
      partialReasons: ['ban_not_lifted'],
    });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    const message = res.ok === false ? res.error.message : '';
    // The account ended up ACTIVE, so "the account is flagged as disabled"
    // would be a false lede and "press Disable again" the wrong instruction —
    // it is the sign-in block that is stuck, and Re-enable is what clears it.
    expect(message).not.toMatch(/flagged as disabled/i);
    expect(message).toMatch(/re-enabled it first|another administrator/i);
    expect(message).toContain('Re-enable');
  });

  it('never promises a retry for a gap it does not know how to heal', async () => {
    disableUserAccount.mockResolvedValue({
      ok: true,
      alreadyDisabled: false,
      banned: true,
      sessionsRevoked: 1,
      partial: true,
      // A reason this layer has no healing verdict for — the shape a future
      // layer would arrive in. Unknown must mean "do not promise a retry",
      // never "press it again and hope".
      partialReasons: ['some_future_layer_failed'],
    });

    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res.ok === false && res.error.message).not.toContain('Disable again');
  });

  it('returns the revoked-session count on success', async () => {
    const res = await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    expect(res).toEqual({ ok: true, data: { sessionsRevoked: 2, alreadyDisabled: false } });
  });

  it('hands the service the actor ID only — never the profile-sourced email', async () => {
    await disableUserAccountAction({ targetUserId: TARGET, reason: REASON });

    // Exact-shape equality: an extra actorEmail key fails this on purpose. The
    // service resolves the actor's VERIFIED email from GoTrue itself.
    expect(disableUserAccount).toHaveBeenCalledWith({
      targetUserId: TARGET,
      reason: REASON,
      actorUserId: SESSION.userId,
    });
  });

  it('reports a replayed disable as already-disabled rather than failing', async () => {
    disableUserAccount.mockResolvedValue({
      ok: true,
      alreadyDisabled: true,
      banned: true,
      sessionsRevoked: 0,
      partial: false,
      partialReasons: [],
    });

    expect(await disableUserAccountAction({ targetUserId: TARGET, reason: REASON })).toEqual({
      ok: true,
      data: { sessionsRevoked: 0, alreadyDisabled: true },
    });
  });
});

describe('reenableUserAccountAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkPlatformAdmin.mockResolvedValue({ ok: true, session: SESSION });
    reenableUserAccount.mockResolvedValue({
      ok: true,
      alreadyActive: false,
      banned: false,
      partial: false,
      partialReasons: [],
    });
  });

  it('is step-up gated too — re-enable GRANTS access', async () => {
    await reenableUserAccountAction({ targetUserId: TARGET });

    expect(checkPlatformAdmin).toHaveBeenCalledWith({ requireStepUp: true });
  });

  it('passes aal2_required back so useStepUp can re-challenge in place', async () => {
    checkPlatformAdmin.mockResolvedValue({ ok: false, reason: 'aal2_required' });

    const res = await reenableUserAccountAction({ targetUserId: TARGET });

    expect(res.ok === false && res.error.details?.reason).toBe('aal2_required');
    expect(reenableUserAccount).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid target', async () => {
    const res = await reenableUserAccountAction({ targetUserId: 'nope' });

    expect(res.ok === false && res.error.code).toBe('validation_error');
    expect(reenableUserAccount).not.toHaveBeenCalled();
  });

  it('succeeds idempotently when the account was already active', async () => {
    reenableUserAccount.mockResolvedValue({
      ok: true,
      alreadyActive: true,
      banned: false,
      partial: false,
      partialReasons: [],
    });

    expect(await reenableUserAccountAction({ targetUserId: TARGET })).toEqual({
      ok: true,
      data: { alreadyActive: true },
    });
  });

  it('reports a partial re-enable rather than claiming success', async () => {
    reenableUserAccount.mockResolvedValue({
      ok: true,
      alreadyActive: false,
      banned: true,
      partial: true,
      partialReasons: ['ban_not_lifted'],
    });

    const res = await reenableUserAccountAction({ targetUserId: TARGET });

    expect(res.ok === false && res.error.code).toBe('internal_error');
    expect(res.ok === false && res.error.message).toContain('Re-enable again');
    expect(res.ok === false && res.error.details?.partialReasons).toEqual(['ban_not_lifted']);
  });

  it('names an audit-only gap and promises the retry the service can now honour', async () => {
    reenableUserAccount.mockResolvedValue({
      ok: true,
      alreadyActive: false,
      banned: false,
      partial: true,
      partialReasons: ['not_audited'],
    });

    const res = await reenableUserAccountAction({ targetUserId: TARGET });

    expect(res.ok === false && res.error.code).toBe('internal_error');
    expect(res.ok === false && res.error.message).toMatch(/audit log/i);
    expect(res.ok === false && res.error.message).toContain('Re-enable again');
  });

  it('names every gap in a mixed set', async () => {
    reenableUserAccount.mockResolvedValue({
      ok: true,
      alreadyActive: false,
      banned: true,
      partial: true,
      partialReasons: ['ban_not_lifted', 'not_audited'],
    });

    const res = await reenableUserAccountAction({ targetUserId: TARGET });

    expect(res.ok === false && res.error.message).toMatch(/sign-in block/i);
    expect(res.ok === false && res.error.message).toMatch(/audit log/i);
    expect(res.ok === false && res.error.message).toContain('Re-enable again');
    expect(res.ok === false && res.error.details?.partialReasons).toEqual([
      'ban_not_lifted',
      'not_audited',
    ]);
  });

  it('names the RIGHT button when a peer admin superseded the re-enable', async () => {
    reenableUserAccount.mockResolvedValue({
      ok: true,
      alreadyActive: false,
      banned: false,
      superseded: true,
      partial: true,
      partialReasons: ['ban_not_applied'],
    });

    const res = await reenableUserAccountAction({ targetUserId: TARGET });

    const message = res.ok === false ? res.error.message : '';
    // The account ended up DISABLED, so telling the operator the flag was
    // cleared and to press Re-enable again would send them at the wrong half.
    expect(message).not.toMatch(/disable flag was cleared/i);
    expect(message).toMatch(/disabled it first|another administrator/i);
    expect(message).toContain('Disable');
  });

  it('reports a lost compare-and-set race as a retryable conflict', async () => {
    reenableUserAccount.mockResolvedValue({ ok: false, code: 'ACCOUNT_STATUS_CHANGED' });

    const res = await reenableUserAccountAction({ targetUserId: TARGET });

    expect(res.ok === false && res.error.code).toBe('conflict');
    expect(res.ok === false && res.error.details?.code).toBe('ACCOUNT_STATUS_CHANGED');
  });

  it('maps ACCOUNT_NOT_FOUND to not_found', async () => {
    reenableUserAccount.mockResolvedValue({ ok: false, code: 'ACCOUNT_NOT_FOUND' });

    const res = await reenableUserAccountAction({ targetUserId: TARGET });

    expect(res.ok === false && res.error.code).toBe('not_found');
  });

  it('hands the service the actor ID only — never the profile-sourced email', async () => {
    await reenableUserAccountAction({ targetUserId: TARGET });

    expect(reenableUserAccount).toHaveBeenCalledWith({
      targetUserId: TARGET,
      actorUserId: SESSION.userId,
    });
  });
});
