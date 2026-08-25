import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The web actions for the verified email change authenticate with a bare
 * auth.getUser() — the same identity funnel as changePasswordAction — so
 * they own the account-status guard. These tests pin that guard and the
 * translation between the service's errors and the ActionResult contract
 * the Profile page acts on (`rate_limited`, `aal2_required`).
 */

const getUser = vi.fn();
const listFactors = vi.fn();
const getAuthenticatorAssuranceLevel = vi.fn();
const maybeSingle = vi.fn();
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
    auth: { getUser, mfa: { listFactors, getAuthenticatorAssuranceLevel } },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  }),
}));
vi.mock('@/server/services/email-change', () => ({
  requestEmailChange: (...a: unknown[]) => requestEmailChange(...a),
  resendEmailChange: (...a: unknown[]) => resendEmailChange(...a),
  cancelEmailChange: (...a: unknown[]) => cancelEmailChange(...a),
}));

import { ServiceError } from '@/server/services/context';

import { cancelEmailChangeAction, requestEmailChangeAction, resendEmailChangeAction } from './email-change';

const INPUT = { newEmail: 'new@example.com', currentPassword: 'test-only-current-password' };

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: 'u-1', email: 'old@example.com' } } });
  maybeSingle.mockResolvedValue({ data: { disabled_at: null }, error: null });
  listFactors.mockResolvedValue({ data: { totp: [] } });
  getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1' } });
  requestEmailChange.mockResolvedValue({
    pendingEmail: 'new@example.com',
    sentAt: '2026-08-25T16:00:00.000Z',
    expiresAt: '2026-08-25T17:00:00.000Z',
  });
  resendEmailChange.mockResolvedValue({ pendingEmail: 'new@example.com', sentAt: 'x', expiresAt: 'y' });
  cancelEmailChange.mockResolvedValue({ cancelled: true });
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

  it('passes the session MFA posture to the service (enrolled + AAL2)', async () => {
    listFactors.mockResolvedValue({ data: { totp: [{ status: 'verified' }] } });
    getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal2' } });
    const res = await requestEmailChangeAction(INPUT);
    expect(res.ok).toBe(true);
    expect(requestEmailChange).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-1', newEmail: 'new@example.com', mfa: { enrolled: true, aal2: true }, source: 'web' }),
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
