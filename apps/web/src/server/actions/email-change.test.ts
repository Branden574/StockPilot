import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The web actions for the verified email change authenticate with a bare
 * auth.getUser() — the same identity funnel as changePasswordAction — so
 * they own the account-status guard. These tests pin that guard and the
 * translation between the service's errors and the ActionResult contract
 * the Profile page acts on (`rate_limited`, `aal2_required`).
 *
 * The MFA posture is the validated user's own (S50a): the factors come from
 * the same getUser() answer, and the level from a verified session of that
 * same user (readVerifiedSessionClaimsOf); anything else is not aal2.
 */

import { verifiedSessionAuth, type StubbedCookieSession } from '@/test/verified-session-stub';

const getUser = vi.fn();
const listFactors = vi.fn();
const getAuthenticatorAssuranceLevel = vi.fn();
const cookie: { session: StubbedCookieSession } = { session: { sub: 'u-1', aal: 'aal1' } };
const maybeSingle = vi.fn();
const orgMaybeSingle = vi.fn();
const requestEmailChange = vi.fn();
const resendEmailChange = vi.fn();
const cancelEmailChange = vi.fn();

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser,
      ...verifiedSessionAuth(() => cookie.session),
      mfa: { listFactors, getAuthenticatorAssuranceLevel },
    },
    // The account status read (user_profiles), and the organization row read
    // when the membership does not carry it (organizations).
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: table === 'organizations' ? orgMaybeSingle : maybeSingle }),
      }),
    }),
  }),
}));
// Which organization applies to this request (lib/auth/session.ts). By
// default the account has none; the set-up cases below name one.
const readSessionOrganization = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  readSessionOrganization: () => readSessionOrganization(),
}));
vi.mock('@/server/services/email-change', () => ({
  requestEmailChange: (...a: unknown[]) => requestEmailChange(...a),
  resendEmailChange: (...a: unknown[]) => resendEmailChange(...a),
  cancelEmailChange: (...a: unknown[]) => cancelEmailChange(...a),
}));

import { ServiceError } from '@/server/services/context';

import { cancelEmailChangeAction, requestEmailChangeAction, resendEmailChangeAction } from './email-change';

const INPUT = { newEmail: 'new@example.com', currentPassword: 'test-only-current-password' };

const VERIFIED_TOTP = { id: 'f-1', factor_type: 'totp', status: 'verified' };

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'old@example.com' } } });
  cookie.session = { sub: 'u-1', aal: 'aal1' };
  maybeSingle.mockResolvedValue({ data: { disabled_at: null }, error: null });
  requestEmailChange.mockResolvedValue({
    pendingEmail: 'new@example.com',
    sentAt: '2026-08-25T16:00:00.000Z',
    expiresAt: '2026-08-25T17:00:00.000Z',
  });
  resendEmailChange.mockResolvedValue({ pendingEmail: 'new@example.com', sentAt: 'x', expiresAt: 'y' });
  cancelEmailChange.mockResolvedValue({ cancelled: true });
  readSessionOrganization.mockResolvedValue({ ok: true, userId: 'u-1', organization: null });
});

describe('requestEmailChangeAction — identity funnel', () => {
  it('validates input before touching the session', async () => {
    const res = await requestEmailChangeAction({ newEmail: 'nope', currentPassword: 'x' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation_error');
    expect(getUser).not.toHaveBeenCalled();
    expect(requestEmailChange).not.toHaveBeenCalled();
  });

  it('refuses when signed out', async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await requestEmailChangeAction(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unauthenticated');
    expect(requestEmailChange).not.toHaveBeenCalled();
  });

  it('refuses a DISABLED account and never reaches the service', async () => {
    maybeSingle.mockResolvedValue({ data: { disabled_at: '2026-07-31T00:00:00.000Z' }, error: null });
    const res = await requestEmailChangeAction(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(requestEmailChange).not.toHaveBeenCalled();
  });

  it('fails CLOSED on an unreadable status — as an internal error, not as "disabled"', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { message: 'boom' } });
    const res = await requestEmailChangeAction(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('internal_error');
    expect(requestEmailChange).not.toHaveBeenCalled();
  });

  it('takes the factors from the getUser() answer that names the user: no second factor read', async () => {
    // getUser() is the identity read, and GoTrue's answer lists the user's
    // factors. An unreadable answer is "Sign in required", never "not enrolled".
    getUser.mockResolvedValue({
      data: { user: null },
      error: { name: 'AuthRetryableFetchError', message: 'x' },
    });
    const res = await requestEmailChangeAction(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unauthenticated');
    expect(requestEmailChange).not.toHaveBeenCalled();
    expect(listFactors).not.toHaveBeenCalled();
  });

  it('passes the session MFA posture to the service (enrolled + AAL2)', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'u-1', email: 'old@example.com', factors: [VERIFIED_TOTP] } },
    });
    cookie.session = { sub: 'u-1', aal: 'aal2' };
    const res = await requestEmailChangeAction(INPUT);
    expect(res.ok).toBe(true);
    expect(requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1', newEmail: 'new@example.com', mfa: { enrolled: true, aal2: true, setUpOwed: false }, source: 'web' }),
    );
    expect(listFactors).not.toHaveBeenCalled();
    expect(getAuthenticatorAssuranceLevel).not.toHaveBeenCalled();
  });

  it('an enrolled user whose verified session is not theirs is not aal2', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'u-1', email: 'old@example.com', factors: [VERIFIED_TOTP] } },
    });
    cookie.session = { sub: 'u-2', aal: 'aal2' };
    await requestEmailChangeAction(INPUT);
    expect(requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1', mfa: { enrolled: true, aal2: false, setUpOwed: false } }),
    );
  });

  it('an enrolled user with no verified session is not aal2', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'u-1', email: 'old@example.com', factors: [VERIFIED_TOTP] } },
    });
    cookie.session = { sub: 'u-1', aal: 'aal2', read: 'error' };
    await resendEmailChangeAction();
    expect(resendEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1', mfa: { enrolled: true, aal2: false, setUpOwed: false } }),
    );
  });

  it('a factor that was never verified is not enrolled', async () => {
    getUser.mockResolvedValue({
      data: {
        user: {
          id: 'u-1',
          email: 'old@example.com',
          factors: [{ ...VERIFIED_TOTP, status: 'unverified' }],
        },
      },
    });
    await requestEmailChangeAction(INPUT);
    expect(requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: { enrolled: false, aal2: false, setUpOwed: false } }),
    );
  });

  it('maps the rate-limit reason to the rate_limited action code', async () => {
    requestEmailChange.mockRejectedValue(new ServiceError('forbidden', 'Too many.', { reason: 'rate_limited' }));
    const res = await requestEmailChangeAction(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('rate_limited');
  });

  it('keeps aal2_required in details so the step-up modal can fire', async () => {
    requestEmailChange.mockRejectedValue(new ServiceError('forbidden', 'Step up.', { reason: 'aal2_required' }));
    const res = await requestEmailChangeAction(INPUT);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('forbidden');
      expect(res.error.details).toEqual({ reason: 'aal2_required' });
    }
  });
});

describe('resend / cancel actions', () => {
  it('resend and cancel run the same guard and delegate for the signed-in user only', async () => {
    const r1 = await resendEmailChangeAction();
    expect(r1.ok).toBe(true);
    expect(resendEmailChange).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1', source: 'web' }));
    const r2 = await cancelEmailChangeAction();
    expect(r2.ok).toBe(true);
    expect(cancelEmailChange).toHaveBeenCalledWith({ userId: 'u-1', source: 'web' });
  });

  it('resend is refused for a disabled account', async () => {
    maybeSingle.mockResolvedValue({ data: { disabled_at: '2026-07-31T00:00:00.000Z' }, error: null });
    const res = await resendEmailChangeAction();
    expect(res.ok).toBe(false);
    expect(resendEmailChange).not.toHaveBeenCalled();
  });
});

describe('authenticator set-up in the current organization (request and resend)', () => {
  const ORG = 'aaaaaaaa-1111-4111-8111-111111111111';
  /** The membership get_request_context() answered with, carrying the organization's policy. */
  const held = (mfaPolicy: string, role = 'staff') => ({
    organization_id: ORG,
    role,
    organization: { id: ORG, name: 'Example Org', mfa_policy: mfaPolicy },
  });
  const inOrg = (mfaPolicy: string | null, role = 'staff') => ({
    ok: true,
    userId: 'u-1',
    organization: {
      organizationId: ORG,
      role,
      held: mfaPolicy === null ? null : held(mfaPolicy, role),
    },
  });
  const COULD_NOT_CHECK = {
    ok: false,
    error: { code: 'internal_error', message: 'Your access could not be checked. Please try again.' },
  };

  it('a member with no authenticator under all_required owes set-up: the service is told so on request and resend', async () => {
    readSessionOrganization.mockResolvedValue(inOrg('all_required'));
    await requestEmailChangeAction(INPUT);
    expect(requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: { enrolled: false, aal2: false, setUpOwed: true } }),
    );
    await resendEmailChangeAction();
    expect(resendEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: { enrolled: false, aal2: false, setUpOwed: true } }),
    );
  });

  it('admins_required: an admin owes set-up, a staff member does not', async () => {
    readSessionOrganization.mockResolvedValue(inOrg('admins_required', 'admin'));
    await requestEmailChangeAction(INPUT);
    expect(requestEmailChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mfa: expect.objectContaining({ setUpOwed: true }) }),
    );
    readSessionOrganization.mockResolvedValue(inOrg('admins_required', 'staff'));
    await requestEmailChangeAction(INPUT);
    expect(requestEmailChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mfa: expect.objectContaining({ setUpOwed: false }) }),
    );
  });

  it('an optional policy owes nothing', async () => {
    readSessionOrganization.mockResolvedValue(inOrg('optional'));
    await requestEmailChangeAction(INPUT);
    expect(requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: expect.objectContaining({ setUpOwed: false }) }),
    );
  });

  it('a factor that was never verified still owes set-up', async () => {
    getUser.mockResolvedValue({
      data: {
        user: { id: 'u-1', email: 'old@example.com', factors: [{ ...VERIFIED_TOTP, status: 'unverified' }] },
      },
    });
    readSessionOrganization.mockResolvedValue(inOrg('all_required'));
    await requestEmailChangeAction(INPUT);
    expect(requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: { enrolled: false, aal2: false, setUpOwed: true } }),
    );
  });

  it('an organization row that came back empty is held to the strictest policy: the access could not be checked, and the service is never asked', async () => {
    readSessionOrganization.mockResolvedValue(inOrg(null));
    orgMaybeSingle.mockResolvedValue({ data: null, error: null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await requestEmailChangeAction(INPUT)).toEqual(COULD_NOT_CHECK);
    expect(await resendEmailChangeAction()).toEqual(COULD_NOT_CHECK);
    expect(requestEmailChange).not.toHaveBeenCalled();
    expect(resendEmailChange).not.toHaveBeenCalled();
  });

  it('an organization row that could not be read: the access could not be checked, and the service is never asked', async () => {
    readSessionOrganization.mockResolvedValue(inOrg(null));
    orgMaybeSingle.mockResolvedValue({ data: null, error: { code: '57014', message: 'timeout' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await requestEmailChangeAction(INPUT)).toEqual(COULD_NOT_CHECK);
    expect(await resendEmailChangeAction()).toEqual(COULD_NOT_CHECK);
    expect(requestEmailChange).not.toHaveBeenCalled();
    expect(resendEmailChange).not.toHaveBeenCalled();
  });

  it('memberships that could not be read, no verified session, or a session of another account: the access could not be checked, reported with which', async () => {
    const { reportError } = await import('@/lib/error-reporter');
    readSessionOrganization.mockResolvedValue({ ok: false, reason: 'memberships_unreadable' });
    expect(await requestEmailChangeAction(INPUT)).toEqual(COULD_NOT_CHECK);
    readSessionOrganization.mockResolvedValue({ ok: false, reason: 'no_verified_session' });
    expect(await requestEmailChangeAction(INPUT)).toEqual(COULD_NOT_CHECK);
    readSessionOrganization.mockResolvedValue({ ok: true, userId: 'u-2', organization: null });
    expect(await resendEmailChangeAction()).toEqual(COULD_NOT_CHECK);
    expect(requestEmailChange).not.toHaveBeenCalled();
    expect(resendEmailChange).not.toHaveBeenCalled();
    const reasons = vi
      .mocked(reportError)
      .mock.calls.map((c) => (c[1] as { extra?: { reason?: string } } | undefined)?.extra?.reason);
    expect(reasons).toEqual(['memberships_unreadable', 'no_verified_session', 'another_account']);
  });

  it('an account with no organization owes nothing and keeps working as before', async () => {
    readSessionOrganization.mockResolvedValue({ ok: true, userId: 'u-1', organization: null });
    expect((await requestEmailChangeAction(INPUT)).ok).toBe(true);
    expect((await resendEmailChangeAction()).ok).toBe(true);
    expect((await cancelEmailChangeAction()).ok).toBe(true);
    expect(requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: { enrolled: false, aal2: false, setUpOwed: false } }),
    );
  });

  it('an account with a verified authenticator is not asked: it keeps its own rule (aal2)', async () => {
    getUser.mockResolvedValue({
      data: { user: { id: 'u-1', email: 'old@example.com', factors: [VERIFIED_TOTP] } },
    });
    readSessionOrganization.mockResolvedValue(inOrg('all_required'));
    await requestEmailChangeAction(INPUT);
    expect(readSessionOrganization).not.toHaveBeenCalled();
    expect(requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ mfa: { enrolled: true, aal2: false, setUpOwed: false } }),
    );
  });

  it('cancel does not ask: it only removes a pending change', async () => {
    readSessionOrganization.mockResolvedValue({ ok: false, reason: 'memberships_unreadable' });
    expect(await cancelEmailChangeAction()).toEqual({ ok: true, data: { cancelled: true } });
    expect(readSessionOrganization).not.toHaveBeenCalled();
  });

  it('the service refusal reaches the page as the name and avatar answer it, details kept', async () => {
    readSessionOrganization.mockResolvedValue(inOrg('all_required'));
    const { mfaGateError } = await import('@/server/services/context');
    requestEmailChange.mockRejectedValue(mfaGateError({ mfaEnrolled: false }));
    expect(await requestEmailChangeAction(INPUT)).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: 'Multi-factor authentication required. Enroll in MFA before performing this action.',
        details: { reason: 'mfa_required' },
      },
    });
  });
});
