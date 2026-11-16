import { describe, expect, it } from 'vitest';

import * as copy from './delete-account-copy';
import {
  ACCOUNT_DELETE_AAL2_COPY,
  ACCOUNT_DELETE_BLOCKED_COPY,
  ACCOUNT_DELETE_CODE_NO_ANSWER_COPY,
  ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY,
  ACCOUNT_DELETE_CODE_RE,
  ACCOUNT_DELETE_CODE_REFUSED_COPY,
  ACCOUNT_DELETE_CODE_ROUTE_ANSWERS,
  ACCOUNT_DELETE_CODE_SEND_FAILED_COPY,
  ACCOUNT_DELETE_CODE_SEND_FAILED_NO_PASSWORD_COPY,
  ACCOUNT_DELETE_CODE_SEND_PAUSED_COPY,
  ACCOUNT_DELETE_CODE_SEND_PAUSED_NO_PASSWORD_COPY,
  ACCOUNT_DELETE_CODE_SENT_COPY,
  ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY,
  ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY,
  ACCOUNT_DELETE_DONE_COPY,
  ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE,
  ACCOUNT_DELETE_NO_ANSWER_COPY,
  ACCOUNT_DELETE_PASSWORD_REFUSED_COPY,
  ACCOUNT_DELETE_PLATFORM_ADMIN_COPY,
  ACCOUNT_DELETE_RETRY_COPY,
  ACCOUNT_DELETE_ROUTE_ANSWERS,
  ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY,
  ACCOUNT_DELETE_TYPE_DELETE_COPY,
  ACCOUNT_DELETE_UNSURE_COPY,
  DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY,
  DELETE_ACCOUNT_CONFIRM_COPY,
  accountDeleteAnswer,
  type AccountDeleteAnswer,
} from './delete-account-copy';

/**
 * The phone's one reading of the two delete routes' answers, and the words
 * they use. The mapper reads the status and, from the body, the `error` code,
 * `ok` and whether `challenge` is a string; never the message.
 */

const ans = (next: AccountDeleteAnswer['next'], sentence: string): AccountDeleteAnswer => ({
  next,
  sentence,
});

describe('accountDeleteAnswer: POST /api/v1/account/delete', () => {
  it.each<[number, string, AccountDeleteAnswer]>([
    [400, 'validation_error', ans('message', ACCOUNT_DELETE_TYPE_DELETE_COPY)],
    [403, 'aal2_required', ans('message', ACCOUNT_DELETE_AAL2_COPY)],
    [403, 'mfa_required', ans('password', ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY)],
    [403, 'credential_required', ans('password', ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY)],
    [403, 'password_incorrect', ans('password', ACCOUNT_DELETE_PASSWORD_REFUSED_COPY)],
    [403, 'code_incorrect', ans('code', ACCOUNT_DELETE_CODE_REFUSED_COPY)],
    [403, 'last_owner', ans('message', ACCOUNT_DELETE_LAST_OWNER_COPY_MOBILE)],
    [403, 'platform_admin', ans('message', ACCOUNT_DELETE_PLATFORM_ADMIN_COPY)],
    [403, 'account_linked_records', ans('message', ACCOUNT_DELETE_BLOCKED_COPY)],
    [429, 'rate_limited', ans('message', ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY)],
    [503, 'check_failed', ans('message', ACCOUNT_DELETE_RETRY_COPY)],
    [500, 'internal_error', ans('message', ACCOUNT_DELETE_UNSURE_COPY)],
  ])('%i %s', (status, error, expected) => {
    expect(accountDeleteAnswer({ status, error })).toEqual(expected);
    expect(accountDeleteAnswer({ route: 'delete', status, error })).toEqual(expected);
  });

  it('every row of the table is one of the cases above, once', () => {
    const keys = ACCOUNT_DELETE_ROUTE_ANSWERS.map((r) => `${r.status} ${r.error}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      [
        '400 validation_error',
        '403 aal2_required',
        '403 mfa_required',
        '403 credential_required',
        '403 password_incorrect',
        '403 code_incorrect',
        '403 last_owner',
        '403 platform_admin',
        '403 account_linked_records',
        '429 rate_limited',
        '503 check_failed',
        '500 internal_error',
      ].sort(),
    );
  });

  it("credential_required opens the password step with core's sentence, never the server's", () => {
    const a = accountDeleteAnswer({ status: 403, error: 'credential_required' });
    expect(a.next).toBe('password');
    expect(a.sentence).toBe(
      'Enter your password, or ask for a code by email, to confirm. Nothing was deleted.',
    );
  });

  it("200 with ok: true, the route's own answer: the account is gone", () => {
    expect(accountDeleteAnswer({ status: 200, ok: true })).toEqual(
      ans('done', ACCOUNT_DELETE_DONE_COPY),
    );
    expect(accountDeleteAnswer({ route: 'delete', status: 200, ok: true })).toEqual(
      ans('done', ACCOUNT_DELETE_DONE_COPY),
    );
  });

  it('any other 2xx is never done: it claims nothing either way', () => {
    for (const body of [
      { status: 200 },
      { status: 200, ok: false },
      { status: 200, ok: 'true' },
      { status: 200, ok: 1 },
      { status: 204 },
      { status: 204, ok: true },
      { status: 201, ok: true },
      { status: 299, ok: true },
    ]) {
      expect(accountDeleteAnswer(body), JSON.stringify(body)).toEqual(
        ans('message', ACCOUNT_DELETE_UNSURE_COPY),
      );
    }
  });

  it('401, with any code or none: sign in again', () => {
    for (const error of ['unauthenticated', undefined, 'anything']) {
      expect(accountDeleteAnswer({ status: 401, error })).toEqual(
        ans('sign_in', ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY),
      );
    }
    expect(ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY).toBe('Sign in again to continue.');
  });

  it('no answer (a timeout or no connection): it may not have been deleted', () => {
    for (const status of [null, undefined, 0]) {
      expect(accountDeleteAnswer({ status })).toEqual(
        ans('message', ACCOUNT_DELETE_NO_ANSWER_COPY),
      );
    }
  });

  it('an unknown code: a 4xx says nothing was changed, anything else claims nothing', () => {
    expect(accountDeleteAnswer({ status: 403, error: 'forbidden' })).toEqual(
      ans('message', ACCOUNT_DELETE_RETRY_COPY),
    );
    expect(accountDeleteAnswer({ status: 404, error: 'not_found' })).toEqual(
      ans('message', ACCOUNT_DELETE_RETRY_COPY),
    );
    expect(accountDeleteAnswer({ status: 409 })).toEqual(ans('message', ACCOUNT_DELETE_RETRY_COPY));
    expect(accountDeleteAnswer({ status: 502 })).toEqual(
      ans('message', ACCOUNT_DELETE_UNSURE_COPY),
    );
    expect(accountDeleteAnswer({ status: 504, error: 'check_failed' })).toEqual(
      ans('message', ACCOUNT_DELETE_UNSURE_COPY),
    );
    expect(accountDeleteAnswer({ status: 302 })).toEqual(
      ans('message', ACCOUNT_DELETE_UNSURE_COPY),
    );
  });

  it('a known code at a status the route does not give it is unknown', () => {
    expect(accountDeleteAnswer({ status: 400, error: 'password_incorrect' })).toEqual(
      ans('message', ACCOUNT_DELETE_RETRY_COPY),
    );
    expect(accountDeleteAnswer({ status: 500, error: 'credential_required' })).toEqual(
      ans('message', ACCOUNT_DELETE_UNSURE_COPY),
    );
  });

  it('a code that is not a string never matches a row', () => {
    for (const error of [null, 403, { code: 'last_owner' }, ['last_owner']]) {
      expect(accountDeleteAnswer({ status: 403, error })).toEqual(
        ans('message', ACCOUNT_DELETE_RETRY_COPY),
      );
    }
  });
});

describe('accountDeleteAnswer: POST /api/v1/account/delete/code', () => {
  it.each<[number, string, AccountDeleteAnswer]>([
    [409, 'not_offered', ans('message', ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY)],
    [429, 'rate_limited', ans('message', ACCOUNT_DELETE_CODE_SEND_PAUSED_NO_PASSWORD_COPY)],
    [503, 'send_failed', ans('message', ACCOUNT_DELETE_CODE_SEND_FAILED_NO_PASSWORD_COPY)],
    [500, 'internal_error', ans('message', ACCOUNT_DELETE_CODE_SEND_FAILED_NO_PASSWORD_COPY)],
  ])('%i %s', (status, error, expected) => {
    expect(accountDeleteAnswer({ route: 'code', status, error })).toEqual(expected);
  });

  it('every row of the table is one of the cases above, once', () => {
    const keys = ACCOUNT_DELETE_CODE_ROUTE_ANSWERS.map((r) => `${r.status} ${r.error}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      ['409 not_offered', '429 rate_limited', '503 send_failed', '500 internal_error'].sort(),
    );
  });

  it("200 with ok: true and a challenge, the route's own answer: a code was sent; enter it", () => {
    expect(
      accountDeleteAnswer({ route: 'code', status: 200, ok: true, challenge: 'v1.a.b.c.d' }),
    ).toEqual(ans('code', ACCOUNT_DELETE_CODE_SENT_COPY));
  });

  it('any other 2xx: a code may not have been sent', () => {
    for (const body of [
      { status: 200 },
      { status: 200, ok: true },
      { status: 200, ok: true, challenge: '' },
      { status: 200, ok: true, challenge: 7 },
      { status: 200, ok: true, challenge: null },
      { status: 200, ok: false, challenge: 'v1.a.b.c.d' },
      { status: 204 },
      { status: 204, ok: true, challenge: 'v1.a.b.c.d' },
      { status: 201, ok: true, challenge: 'v1.a.b.c.d' },
    ]) {
      expect(accountDeleteAnswer({ route: 'code', ...body }), JSON.stringify(body)).toEqual(
        ans('message', ACCOUNT_DELETE_CODE_NO_ANSWER_COPY),
      );
    }
  });

  it('401 (also the answer for an account that is gone): sign in again', () => {
    expect(accountDeleteAnswer({ route: 'code', status: 401, error: 'unauthenticated' })).toEqual(
      ans('sign_in', ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY),
    );
  });

  it('no answer: a code may not have been sent; ask for a new one', () => {
    for (const status of [null, undefined, 0]) {
      expect(accountDeleteAnswer({ route: 'code', status })).toEqual(
        ans('message', ACCOUNT_DELETE_CODE_NO_ANSWER_COPY),
      );
    }
  });

  it('an unknown code: the code could not be sent', () => {
    for (const [status, error] of [
      [403, 'forbidden'],
      [404, undefined],
      [429, 'something_else'],
      [502, undefined],
    ] as const) {
      expect(accountDeleteAnswer({ route: 'code', status, error })).toEqual(
        ans('message', ACCOUNT_DELETE_CODE_SEND_FAILED_NO_PASSWORD_COPY),
      );
    }
  });

  it("the code route's phone sentences suit an account with no password; the website's stay as they are", () => {
    expect(ACCOUNT_DELETE_CODE_SEND_PAUSED_NO_PASSWORD_COPY).toBe(
      'Too many codes requested. Wait a few minutes, then ask for a new code, or enter your password if you have one.',
    );
    expect(ACCOUNT_DELETE_CODE_SEND_FAILED_NO_PASSWORD_COPY).toBe(
      'The code could not be sent just now. Try again in a few minutes, or enter your password if you have one.',
    );
    expect(ACCOUNT_DELETE_CODE_SEND_FAILED_COPY).toBe(
      'The code could not be sent just now. Try again in a few minutes, or enter your password.',
    );
    for (const row of ACCOUNT_DELETE_CODE_ROUTE_ANSWERS) {
      expect(row.sentence).not.toMatch(/or enter your password\.$/);
    }
    expect(ACCOUNT_DELETE_CODE_SEND_PAUSED_COPY).toBe(DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY);
    expect(DELETE_ACCOUNT_CODE_SEND_PAUSED_COPY).toBe(
      'Too many codes requested. Try again in a few minutes, or enter your password.',
    );
  });
});

describe('the words', () => {
  it("the code sent sentence is the dialog's own", () => {
    expect(ACCOUNT_DELETE_CODE_SENT_COPY).toBe(DELETE_ACCOUNT_CONFIRM_COPY.codeSent);
  });

  it('a code is exactly six digits', () => {
    expect(ACCOUNT_DELETE_CODE_RE.test('123456')).toBe(true);
    expect(ACCOUNT_DELETE_CODE_RE.test('012345')).toBe(true);
    for (const bad of ['12345', '1234567', '12345a', ' 123456', '123456\n', '１２３４５６', '']) {
      expect(ACCOUNT_DELETE_CODE_RE.test(bad)).toBe(false);
    }
  });

  it('every sentence is plain: no exclamation mark, no emoji, never "book", never MFA or two-factor', () => {
    const sentences: string[] = [];
    for (const value of Object.values(copy)) {
      if (typeof value === 'string') sentences.push(value);
      else if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof RegExp)
      ) {
        for (const v of Object.values(value)) if (typeof v === 'string') sentences.push(v);
      }
    }
    for (const row of [...ACCOUNT_DELETE_ROUTE_ANSWERS, ...ACCOUNT_DELETE_CODE_ROUTE_ANSWERS]) {
      sentences.push(row.sentence);
    }
    expect(sentences.length).toBeGreaterThan(30);
    for (const s of sentences) {
      expect(s).not.toContain('!');
      expect(s).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(s.toLowerCase()).not.toMatch(/\bbooks?\b/);
      expect(s).not.toMatch(/\bMFA\b|\b2FA\b|two-factor|multi-factor/i);
    }
  });

  it('every sentence the mapper gives says nothing about whether the account has a password', () => {
    const given = [
      ...ACCOUNT_DELETE_ROUTE_ANSWERS.map((r) => r.sentence),
      ...ACCOUNT_DELETE_CODE_ROUTE_ANSWERS.map((r) => r.sentence),
      ACCOUNT_DELETE_DONE_COPY,
      ACCOUNT_DELETE_NO_ANSWER_COPY,
      ACCOUNT_DELETE_CODE_NO_ANSWER_COPY,
      ACCOUNT_DELETE_UNSURE_COPY,
      ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY,
    ];
    for (const s of given) {
      expect(s).not.toMatch(/has no password|does not have a password|your password is not set/i);
    }
  });
});
