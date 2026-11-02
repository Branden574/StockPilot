import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * session-check.ts: does the Auth server still accept this phone's session?
 * The phone acts on a "signed out from another device" message only when the
 * answer is 'gone' (use-session-revocation.ts). 'live' and 'no-answer' change
 * nothing, so the answer may only be 'gone' when the server said so.
 */

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetchAuthUser: vi.fn(),
}));

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: () => h.getSession() } },
  fetchAuthUser: (accessToken: string, signal: AbortSignal) => h.fetchAuthUser(accessToken, signal),
}));

import { checkThisSession, sessionCheckFromAuthAnswer } from './session-check';

const ACCESS = 'header.payload.signature';

function answer(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  h.getSession.mockReset();
  h.getSession.mockResolvedValue({ data: { session: { access_token: ACCESS } }, error: null });
  h.fetchAuthUser.mockReset();
});

describe('sessionCheckFromAuthAnswer: only the Auth server’s own codes say the session is gone', () => {
  it.each([
    [200, { id: 'u1' }, 'live'],
    [403, { code: 'session_not_found', message: 'Session not found' }, 'gone'],
    // An older Auth server: `code` is the status, the name is in error_code.
    [403, { code: 403, error_code: 'session_not_found', msg: 'Session not found' }, 'gone'],
    [401, { code: 'session_expired' }, 'gone'],
    [400, { code: 'refresh_token_not_found' }, 'gone'],
    [403, { code: 'user_banned' }, 'gone'],
    // Not about the session: an expired or unreadable token, an account the
    // server cannot find, the gateway refusing the request, a server failure.
    [401, { code: 'bad_jwt' }, 'no-answer'],
    [403, { code: 'user_not_found' }, 'no-answer'],
    [401, { message: 'Invalid authentication credentials' }, 'no-answer'],
    [500, { code: 'unexpected_failure' }, 'no-answer'],
    [502, null, 'no-answer'],
    [503, { message: 'unavailable' }, 'no-answer'],
    [403, null, 'no-answer'],
    [403, 'session_not_found', 'no-answer'],
  ])('%i %j -> %s', (status, body, expected) => {
    expect(sessionCheckFromAuthAnswer(status, body)).toBe(expected);
  });

  it('free text never counts, only the code', () => {
    expect(sessionCheckFromAuthAnswer(403, { message: 'session_not_found' })).toBe('no-answer');
    expect(
      sessionCheckFromAuthAnswer(403, {
        msg: 'Session from session_id claim in JWT does not exist',
      }),
    ).toBe('no-answer');
  });
});

describe('checkThisSession', () => {
  it('asks with the session’s current access token, and reads the answer', async () => {
    h.fetchAuthUser.mockResolvedValue(answer(403, { code: 'session_not_found' }));
    await expect(checkThisSession()).resolves.toBe('gone');
    expect(h.fetchAuthUser).toHaveBeenCalledTimes(1);
    expect(h.fetchAuthUser.mock.calls[0]![0]).toBe(ACCESS);
    expect(h.fetchAuthUser.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    h.fetchAuthUser.mockResolvedValue(answer(200, { id: 'u1' }));
    await expect(checkThisSession()).resolves.toBe('live');
  });

  it('a request that cannot be made is no answer', async () => {
    h.fetchAuthUser.mockRejectedValue(new TypeError('Network request failed'));
    await expect(checkThisSession()).resolves.toBe('no-answer');
  });

  it('an error answer whose body cannot be read is no answer', async () => {
    h.fetchAuthUser.mockResolvedValue(answer(403, '<html>'));
    await expect(checkThisSession()).resolves.toBe('no-answer');
  });

  it('no answer within the time allowed: no answer, and the request is aborted', async () => {
    let signal: AbortSignal | undefined;
    h.fetchAuthUser.mockImplementation((_t: string, s: AbortSignal) => {
      signal = s;
      return new Promise(() => undefined);
    });
    await expect(checkThisSession(20)).resolves.toBe('no-answer');
    expect(signal?.aborted).toBe(true);
  });

  it('a session read that never finishes is no answer too', async () => {
    h.getSession.mockImplementation(() => new Promise(() => undefined));
    await expect(checkThisSession(20)).resolves.toBe('no-answer');
    expect(h.fetchAuthUser).not.toHaveBeenCalled();
  });

  it('no session on the phone and no error: nothing to ask with, no answer', async () => {
    h.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(checkThisSession()).resolves.toBe('no-answer');
    expect(h.fetchAuthUser).not.toHaveBeenCalled();
  });

  it('the Auth server just refused the session’s refresh (auth-js removed it): gone', async () => {
    h.getSession.mockResolvedValue({
      data: { session: null },
      error: { name: 'AuthApiError', code: 'refresh_token_not_found', status: 400 },
    });
    await expect(checkThisSession()).resolves.toBe('gone');
    expect(h.fetchAuthUser).not.toHaveBeenCalled();
  });

  it('a refresh that could not be made (offline) is no answer', async () => {
    h.getSession.mockResolvedValue({
      data: { session: null },
      error: { name: 'AuthRetryableFetchError', status: 0 },
    });
    await expect(checkThisSession()).resolves.toBe('no-answer');
  });

  it('a session read that throws is no answer', async () => {
    h.getSession.mockRejectedValue(new Error('Keychain locked'));
    await expect(checkThisSession()).resolves.toBe('no-answer');
  });
});
