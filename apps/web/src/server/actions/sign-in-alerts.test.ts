// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Part 3 (sign-in alerts): the two answers a signed-in member gives on Active
 * sessions (server/actions/sign-in-alerts.ts).
 *   - "This was me" goes to SignInAlertsService.confirm, which holds the
 *     authenticator rule and the one update.
 *   - "This was not me" acts only on the member's OWN alert (read on the
 *     server; another account's alert, a made-up id and a failed read are all
 *     refused alike), runs the same report the emailed link runs, and then
 *     signs this browser out too. A report that could not finish is said so,
 *     and this browser stays signed in to try again. An alert already
 *     reported is said so and ends nothing (one alert, one sign-out). The
 *     action is counted per account, closed, as the link is counted.
 */

const h = vi.hoisted(() => ({
  ctx: null as null | Record<string, unknown>,
  confirm: vi.fn(),
  read: vi.fn(),
  report: vi.fn(),
  signOut: vi.fn(async (_o: unknown) => ({ error: null })),
  revalidate: vi.fn(),
  limit: vi.fn(),
  reportedMeanwhile: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: (p: string) => h.revalidate(p) }));
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({ 'x-real-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15' }),
}));
vi.mock('@/server/services/context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/services/context')>();
  return { ...real, withContext: async () => h.ctx };
});
vi.mock('@/server/services/sign-in-alerts', () => ({
  SignInAlertsService: class {
    confirm(id: string) {
      return h.confirm(id);
    }
  },
}));
vi.mock('@/server/services/sign-in-alert-report', () => ({
  readSignInAlert: (id: string) => h.read(id),
  reportSignInAlertNotMe: (a: unknown) => h.report(a),
  alertReportedMeanwhile: (...a: unknown[]) => h.reportedMeanwhile(...a),
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: (...a: unknown[]) => h.limit(...a) }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import { ServiceError } from '@/server/services/context';

import { confirmSignInAlertAction, reportSignInAlertAction } from './sign-in-alerts';

const ME = '11111111-1111-4111-8111-111111111111';
const SOMEONE = '99999999-9999-4999-8999-999999999999';
const ALERT = 'a1e27000-0000-4000-8000-000000000001';

function alert(userId = ME) {
  return {
    id: ALERT,
    userId,
    sessionId: null,
    newDevice: true,
    newCountry: false,
    client: 'web',
    deviceLabel: 'Firefox on Windows',
    deviceFamily: 'Firefox on Windows',
    deviceHash: 'ab'.repeat(20),
    country: null,
    city: null,
    status: 'open',
    createdAt: '2026-11-20T15:30:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.ctx = {
    userId: ME,
    organizationId: 'org-test',
    role: 'staff',
    mfaRequired: false,
    mfaSatisfied: true,
    supabase: { auth: { signOut: h.signOut } },
  };
  h.confirm.mockResolvedValue('confirmed');
  h.read.mockResolvedValue({ kind: 'found', alert: alert() });
  h.report.mockResolvedValue({ outcome: 'done', adminsTold: true });
  h.limit.mockResolvedValue({ allowed: true, count: 1, resetAt: Date.now() + 60_000 });
  h.reportedMeanwhile.mockResolvedValue(false);
});

describe('confirmSignInAlertAction', () => {
  it('confirms through the service and refreshes the Security page', async () => {
    const res = await confirmSignInAlertAction({ alertId: ALERT });
    expect(res).toEqual({ ok: true, data: { answer: 'confirmed' } });
    expect(h.confirm).toHaveBeenCalledWith(ALERT);
    expect(h.revalidate).toHaveBeenCalledWith('/dashboard/settings/security');
  });

  it('an id that is not a uuid is refused before anything', async () => {
    const res = await confirmSignInAlertAction({ alertId: 'nope' });
    expect(res.ok).toBe(false);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('another member’s alert and a made-up id: the service’s "not found" is the answer, the same for both', async () => {
    h.confirm.mockRejectedValue(new ServiceError('not_found', 'That sign-in alert was not found.'));
    const other = await confirmSignInAlertAction({ alertId: ALERT });
    const madeUp = await confirmSignInAlertAction({ alertId: 'a1e27000-0000-4000-8000-00000000ffff' });
    expect(other).toMatchObject({ ok: false, error: { code: 'not_found', message: 'That sign-in alert was not found.' } });
    expect(madeUp).toEqual(other);
  });

  it('the service’s refusal (the authenticator step owed) is the answer', async () => {
    h.confirm.mockRejectedValue(
      new ServiceError('forbidden', 'Verify with your authenticator first.', { reason: 'aal2_required' }),
    );
    const res = await confirmSignInAlertAction({ alertId: ALERT });
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
});

describe('reportSignInAlertAction', () => {
  it('the member’s own alert: the report runs as signed_in, then this browser signs out', async () => {
    const res = await reportSignInAlertAction({ alertId: ALERT });
    expect(res).toEqual({ ok: true, data: { signedOut: true } });
    expect(h.read).toHaveBeenCalledWith(ALERT);
    expect(h.report).toHaveBeenCalledWith({
      alert: alert(),
      via: 'signed_in',
      auditFrom: { ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15' },
    });
    expect(h.signOut).toHaveBeenCalledWith({ scope: 'local' });
    // The sign-out comes after the report.
    expect(h.report.mock.invocationCallOrder[0]!).toBeLessThan(h.signOut.mock.invocationCallOrder[0]!);
  });

  it('another account’s alert, a missing one and a failed read are refused alike, and nothing runs', async () => {
    const answers = [];
    h.read.mockResolvedValueOnce({ kind: 'found', alert: alert(SOMEONE) });
    answers.push(await reportSignInAlertAction({ alertId: ALERT }));
    h.read.mockResolvedValueOnce({ kind: 'missing' });
    answers.push(await reportSignInAlertAction({ alertId: ALERT }));
    for (const a of answers) expect(a).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(answers[0]).toEqual(answers[1]);
    h.read.mockResolvedValueOnce({ kind: 'failed' });
    expect(await reportSignInAlertAction({ alertId: ALERT })).toMatchObject({ ok: false });
    expect(h.report).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('a report that could not finish: said so, and this browser stays signed in to try again', async () => {
    h.report.mockResolvedValue({ outcome: 'failed' });
    const res = await reportSignInAlertAction({ alertId: ALERT });
    expect(res).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('the words of a report that could not finish promise nothing that did not happen', async () => {
    h.report.mockResolvedValue({ outcome: 'failed' });
    const res = await reportSignInAlertAction({ alertId: ALERT });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toBe('We could not finish this just now. Press the button again in a minute.');
    }
  });

  it('an alert already reported: said so, nothing is ended or told again, and this browser stays signed in', async () => {
    const reported = { ...alert(), status: 'not_me' };
    h.read.mockResolvedValue({ kind: 'found', alert: reported });
    // The report itself ends nothing for a reported alert (its own tests).
    h.report.mockResolvedValue({ outcome: 'already_reported' });
    const res = await reportSignInAlertAction({ alertId: ALERT });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message:
          'You already reported this sign-in. Every session of your account was ended then. To end them again, use Sign out all other devices, then reset your password.',
      },
    });
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.revalidate).toHaveBeenCalledWith('/dashboard/settings/security');
  });

  it('is counted per account, 10 an hour, closed, before the alert is read', async () => {
    await reportSignInAlertAction({ alertId: ALERT });
    expect(h.limit.mock.calls).toEqual([[`sign-in-alert-report:user:${ME}`, 10, 60 * 60 * 1000, 'closed']]);
    expect(h.limit.mock.invocationCallOrder[0]!).toBeLessThan(h.read.mock.invocationCallOrder[0]!);
  });

  it('past its count the action is refused, and nothing is read, ended or told', async () => {
    h.limit.mockResolvedValue({ allowed: false, count: 10, resetAt: Date.now() + 60_000 });
    const res = await reportSignInAlertAction({ alertId: ALERT });
    expect(res).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.report).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('a count that cannot be read refuses too (closed), as "try again in a moment", not "too many"', async () => {
    h.limit.mockResolvedValue({ allowed: false, count: 10, resetAt: Date.now() + 60_000, failed: true });
    const res = await reportSignInAlertAction({ alertId: ALERT });
    expect(res).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'Please try again in a moment.' },
    });
    expect(h.report).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it('a count that cannot be read, and the member’s own alert is reported by then (two presses at once): the "already reported" answer', async () => {
    h.limit.mockResolvedValue({ allowed: false, count: 10, resetAt: Date.now() + 60_000, failed: true });
    h.reportedMeanwhile.mockResolvedValue(true);
    const res = await reportSignInAlertAction({ alertId: ALERT });
    expect(res).toMatchObject({ ok: false, error: { code: 'conflict' } });
    if (!res.ok) expect(res.error.message).toMatch(/^You already reported this sign-in\./);
    // The one more look names the caller: another account's alert can never answer it.
    expect(h.reportedMeanwhile).toHaveBeenCalledTimes(1);
    expect(h.reportedMeanwhile).toHaveBeenCalledWith(ALERT, ME);
    // Closed all the same: nothing is reported, ended or told.
    expect(h.report).not.toHaveBeenCalled();
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.revalidate).toHaveBeenCalledWith('/dashboard/settings/security');
  });

  it('an id that is not a uuid is refused before any read', async () => {
    const res = await reportSignInAlertAction({ alertId: 'nope' });
    expect(res.ok).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
  });
});
