import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The current-password check's security events (part 1 of the security
 * tools). verifyPasswordSideChannel sends a signed-in member's password to
 * the sign-in service for six features (changing the password or the email,
 * setting up an authenticator, a recovery code, moving ownership, deleting
 * the account). A password the service judged wrong is
 * wrong_current_password, in the account's organization (looked up after the
 * response, server/security/account-events.ts); a refusal with the same
 * status that is not a wrong password is sign_in_refused_other, with no
 * organization. So every password our own server sends that the service
 * refuses has a record, and the reader of the service's own log
 * (server/security/auth-logs.ts) can compare the two counts.
 *
 * Recording changes nothing the member sees: the answer is the same, it
 * never throws, and it does not wait on anything but the request's headers.
 *
 * Addresses are from the documentation ranges (RFC 5737).
 */

const h = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  requestHeaders: new Headers({ 'x-forwarded-for': '203.0.113.7' }) as Headers | null,
  recordAccountCodeBlocked: vi.fn(),
  recordSignInBlocked: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: {
      signInWithPassword: (...a: unknown[]) => h.signInWithPassword(...a),
      signOut: (...a: unknown[]) => h.signOut(...a),
    },
  }),
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => {
    if (!h.requestHeaders) throw new Error('`headers` was called outside a request scope');
    return h.requestHeaders;
  }),
}));
vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  },
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/security/account-events', () => ({
  recordAccountCodeBlocked: (...a: unknown[]) => h.recordAccountCodeBlocked(...a),
  recordSignInBlocked: (...a: unknown[]) => h.recordSignInBlocked(...a),
}));

import { verifyPasswordSideChannel } from './verify-password';

const EMAIL = 'ada@example.com';
const USER = '5eed0000-0002-4000-8000-000000000001';
// A dull value under a neutral name (src/test/secret-shaped-fixtures.guard.test.ts).
const TYPED_VALUE = 'the-typed-value';
const REFUSED = { ok: false, reason: 'invalid_password', message: 'Password is incorrect.' };

const answers = (error: unknown) =>
  h.signInWithPassword.mockResolvedValue({ data: { session: null }, error });

beforeEach(() => {
  h.signInWithPassword.mockReset();
  h.signOut.mockReset();
  h.signOut.mockResolvedValue({ error: null });
  h.recordAccountCodeBlocked.mockReset();
  h.recordSignInBlocked.mockReset();
  h.requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.7' });
});

describe('a refused current password is recorded', () => {
  it('a password the service judged wrong: wrong_current_password, for the account, with the request headers', async () => {
    answers({ status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' });
    await expect(verifyPasswordSideChannel(EMAIL, TYPED_VALUE, USER)).resolves.toEqual(REFUSED);
    expect(h.recordAccountCodeBlocked.mock.calls).toEqual([
      ['wrong_current_password', USER, h.requestHeaders],
    ]);
    expect(h.recordSignInBlocked).not.toHaveBeenCalled();
  });

  it.each([
    ['a disabled account', 'user_banned'],
    ['an unconfirmed email', 'email_not_confirmed'],
    ['a code this does not know', 'something_new'],
    ['no code at all', undefined],
  ])(
    'the same status for another reason (%s): sign_in_refused_other, with no organization',
    async (_what, code) => {
      answers({ status: 400, code, message: 'refused' });
      await expect(verifyPasswordSideChannel(EMAIL, TYPED_VALUE, USER)).resolves.toEqual(REFUSED);
      expect(h.recordSignInBlocked.mock.calls).toEqual([
        ['sign_in_refused_other', EMAIL, h.requestHeaders],
      ]);
      expect(h.recordAccountCodeBlocked).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["the service's own limit", { status: 429, code: 'over_request_rate_limit' }],
    ['a limit named only by its code', { status: 400, code: 'over_request_rate_limit' }],
    ['an outage', { status: 500, message: 'upstream' }],
    ['no answer', { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' }],
    ['an error with no status', { message: 'Invalid login credentials' }],
  ])('%s judged no password: nothing is recorded', async (_what, error) => {
    answers(error);
    await expect(verifyPasswordSideChannel(EMAIL, TYPED_VALUE, USER)).resolves.toEqual(REFUSED);
    expect(h.recordAccountCodeBlocked).not.toHaveBeenCalled();
    expect(h.recordSignInBlocked).not.toHaveBeenCalled();
  });

  it('a right password records nothing', async () => {
    h.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
    await expect(verifyPasswordSideChannel(EMAIL, TYPED_VALUE, USER)).resolves.toEqual({
      ok: true,
    });
    expect(h.recordAccountCodeBlocked).not.toHaveBeenCalled();
    expect(h.recordSignInBlocked).not.toHaveBeenCalled();
  });

  it('a check that threw records nothing (it judged no password)', async () => {
    h.signInWithPassword.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    await expect(verifyPasswordSideChannel(EMAIL, TYPED_VALUE, USER)).resolves.toMatchObject({
      ok: false,
      reason: 'internal_error',
    });
    expect(h.recordAccountCodeBlocked).not.toHaveBeenCalled();
    expect(h.recordSignInBlocked).not.toHaveBeenCalled();
  });
});

describe('recording changes nothing the member sees', () => {
  it('outside a request there are no headers: recorded without them, the answer the same', async () => {
    h.requestHeaders = null;
    answers({ status: 400, code: 'invalid_credentials' });
    await expect(verifyPasswordSideChannel(EMAIL, TYPED_VALUE, USER)).resolves.toEqual(REFUSED);
    expect(h.recordAccountCodeBlocked.mock.calls).toEqual([['wrong_current_password', USER, null]]);
  });

  it.each([
    ['wrong password', { status: 400, code: 'invalid_credentials' }],
    ['another refusal', { status: 400, code: 'user_banned' }],
  ])(
    'a recorder that throws (%s) never reaches the caller: the answer is the same',
    async (_w, e) => {
      h.recordAccountCodeBlocked.mockImplementation(() => {
        throw new Error('recorder down');
      });
      h.recordSignInBlocked.mockImplementation(() => {
        throw new Error('recorder down');
      });
      answers(e);
      await expect(verifyPasswordSideChannel(EMAIL, TYPED_VALUE, USER)).resolves.toEqual(REFUSED);
    },
  );

  it('the answer does not wait for the recorder: it is handed the event and returns at once', async () => {
    // The real helper registers its work to run after the response
    // (account-events.test.ts); here it is a call that returns nothing.
    let recorderReturned = false;
    h.recordAccountCodeBlocked.mockImplementation(() => {
      recorderReturned = true;
      return new Promise(() => undefined);
    });
    answers({ status: 400, code: 'invalid_credentials' });
    await expect(verifyPasswordSideChannel(EMAIL, TYPED_VALUE, USER)).resolves.toEqual(REFUSED);
    expect(recorderReturned).toBe(true);
  });

  it('an account id that is not text is not recorded under one, and nothing throws', async () => {
    answers({ status: 400, code: 'invalid_credentials' });
    await expect(
      verifyPasswordSideChannel(EMAIL, TYPED_VALUE, undefined as unknown as string),
    ).resolves.toEqual(REFUSED);
    expect(h.recordAccountCodeBlocked).not.toHaveBeenCalled();
  });
});
