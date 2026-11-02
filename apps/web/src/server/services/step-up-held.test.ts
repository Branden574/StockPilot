import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Security invariant (docket S50a): assertStepUpHeld decides the
 * authenticator step-up for one account only, the account the action
 * validated. The level is that account's verified session claims
 * (readVerifiedSessionClaimsOf, null for anything else); the factors are that
 * account's, read by its id with the service role; core's stepUpOwed decides.
 * It refuses, in order: no verified session of that account, factors that
 * cannot be read, a step-up still owed.
 */

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));

import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';
import { verifiedSessionAuth, type StubbedCookieSession } from '@/test/verified-session-stub';

import { SESSION_CHANGED, assertStepUpHeld } from './step-up-held';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';

let session: StubbedCookieSession;
let factorsRead: {
  data: { factors: Array<{ id: string; factor_type: string; status: string }> } | null;
  error: { message: string; name?: string; status?: number; code?: string } | null;
};
const listFactors = vi.fn(async (_args: { userId: string }) => factorsRead);

const supabase = { auth: verifiedSessionAuth(() => session) };
const admin = { auth: { admin: { mfa: { listFactors } } } };

const VERIFIED = { id: 'factor-1', factor_type: 'totp', status: 'verified' };

beforeEach(() => {
  vi.clearAllMocks();
  session = { sub: USER, aal: 'aal1' };
  factorsRead = { data: { factors: [] }, error: null };
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

async function outcome(): Promise<'passed' | { code: string; message: string; details: unknown }> {
  try {
    await assertStepUpHeld({ supabase: supabase as never, admin: admin as never, userId: USER });
    return 'passed';
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceError);
    const err = e as ServiceError;
    return { code: err.code, message: err.message, details: err.details };
  }
}

const SIGN_IN_AGAIN = {
  code: 'unauthenticated',
  message: SESSION_CHANGED,
  details: { reason: 'session_changed' },
};

describe('assertStepUpHeld', () => {
  it('the refusal sentence is the one fixed sentence', () => {
    expect(SESSION_CHANGED).toBe('Sign in again, then try again.');
  });

  it('no verified session: session_changed, and the factors are not read', async () => {
    session = { sub: USER, aal: 'aal2', read: 'error' };
    expect(await outcome()).toEqual(SIGN_IN_AGAIN);
    expect(listFactors).not.toHaveBeenCalled();
  });

  it('a verified session of another account: session_changed, and the factors are not read', async () => {
    session = { sub: OTHER, aal: 'aal2' };
    factorsRead = { data: { factors: [VERIFIED] }, error: null };
    expect(await outcome()).toEqual(SIGN_IN_AGAIN);
    expect(listFactors).not.toHaveBeenCalled();
  });

  it('the factor read fails: refused as an internal error, and reported', async () => {
    factorsRead = { data: null, error: { message: 'service unavailable' } };
    expect(await outcome()).toMatchObject({ code: 'internal_error' });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  // GoTrue answers every /admin/users/<id> route, the factor list included,
  // with 404 user_not_found once the account is gone (the person's other
  // request deleted it): not an outage, and not a reason to keep this browser
  // signed in. The caller hears account_gone.
  it('no such account (404 user_not_found): account_gone, not reported as unreadable', async () => {
    factorsRead = {
      data: null,
      error: {
        name: 'AuthApiError',
        status: 404,
        code: 'user_not_found',
        message: 'User not found',
      },
    };
    expect(await outcome()).toEqual({
      code: 'unauthenticated',
      message: SESSION_CHANGED,
      details: { reason: 'account_gone' },
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a 404 without the user_not_found code (a proxy, not GoTrue) is not proof: unreadable, reported', async () => {
    factorsRead = {
      data: null,
      error: { name: 'AuthApiError', status: 404, code: 'not_found', message: 'Not found' },
    };
    expect(await outcome()).toMatchObject({ code: 'internal_error' });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('an authenticator and an aal1 session: aal2_required', async () => {
    factorsRead = { data: { factors: [VERIFIED] }, error: null };
    expect(await outcome()).toEqual({
      code: 'forbidden',
      message: 'Re-authenticate with MFA before performing this action.',
      details: { reason: 'aal2_required' },
    });
  });

  it('a session with no level claim counts as not aal2', async () => {
    session = { sub: USER, aal: null };
    factorsRead = { data: { factors: [VERIFIED] }, error: null };
    expect(await outcome()).toMatchObject({
      code: 'forbidden',
      details: { reason: 'aal2_required' },
    });
  });

  it('an authenticator and an aal2 session: passes', async () => {
    session = { sub: USER, aal: 'aal2' };
    factorsRead = { data: { factors: [VERIFIED] }, error: null };
    expect(await outcome()).toBe('passed');
  });

  it('no authenticator: passes at aal1', async () => {
    expect(await outcome()).toBe('passed');
  });

  it('a factor that was never verified is not an authenticator', async () => {
    factorsRead = { data: { factors: [{ ...VERIFIED, status: 'unverified' }] }, error: null };
    expect(await outcome()).toBe('passed');
  });

  it("reads the validated account's factors, by its id", async () => {
    await outcome();
    expect(listFactors).toHaveBeenCalledWith({ userId: USER });
  });
});
