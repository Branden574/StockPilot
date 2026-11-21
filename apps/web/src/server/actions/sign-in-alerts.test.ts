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
 *     reported is said so, and nothing more happens (review 1, finding 2).
 */

const h = vi.hoisted(() => ({
  ctx: null as null | Record<string, unknown>,
  confirm: vi.fn(),
  read: vi.fn(),
  report: vi.fn(),
  signOut: vi.fn(async (_o: unknown) => ({ error: null })),
  revalidate: vi.fn(),
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
}));
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

  it('an alert already reported: said so, nothing more happens, and this browser stays signed in', async () => {
    h.report.mockResolvedValue({ outcome: 'already_reported' });
    const res = await reportSignInAlertAction({ alertId: ALERT });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'conflict',
        message:
          'You already reported this sign-in. If you have not reset your password yet, reset it now.',
      },
    });
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.revalidate).toHaveBeenCalledWith('/dashboard/settings/security');
  });

  it('an id that is not a uuid is refused before any read', async () => {
    const res = await reportSignInAlertAction({ alertId: 'nope' });
    expect(res.ok).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
  });
});
