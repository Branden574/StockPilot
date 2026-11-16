import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_DELETE_CODE_NO_ANSWER_COPY,
  ACCOUNT_DELETE_DONE_COPY,
  ACCOUNT_DELETE_NO_ANSWER_COPY,
  ACCOUNT_DELETE_PASSWORD_REFUSED_COPY,
  ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY,
} from '@stockpilot/core';

import {
  ACCOUNT_DELETE_CODE_PATH,
  ACCOUNT_DELETE_PATH,
  appAccountDeleteDeps,
  createAccountDeleteFlow,
} from './account-delete';

/**
 * Security invariant: the delete-account flow, through the REAL api() helper
 * with a stand-in fetch. The requests go out as the sheet's account with the
 * bearer and a JSON body (none on the code route); an empty or HTML 200 is
 * "no answer", never "deleted"; a refusal shows core's sentence, never the
 * server's message; only `{ ok: true }` signs out, once.
 *
 * Executed against the real api.ts; vi.hoisted and vi.mock run before it loads
 * (the method of api.org-header.test.ts).
 */

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).__DEV__ = true;
});

// Made-up values only.
const PASSWORD = 'made-up pass phrase 42';
const CHALLENGE = 'challenge-made-up.cccccccccccc';
const CODE = '654321';

const state = vi.hoisted(() => ({
  session: { access_token: 'token-u2', user: { id: 'u2' } } as null | {
    access_token: string;
    user: { id: string };
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null) },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: state.session } })) } },
  readDeviceAuthSession: vi.fn(async () => ({ present: true, userId: 'u2' })),
}));
vi.mock('./account-eviction', () => ({ notifyUnauthorized: vi.fn() }));
vi.mock('./request-cancellation', () => ({ registerInFlight: vi.fn(() => vi.fn()) }));
vi.mock('./mfa-reconcile', () => ({ handOverLiveUser: vi.fn((a: unknown) => a) }));

type Reply = { status: number; body: string };
const replies: Reply[] = [];

const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => {
  const r = replies.shift();
  if (!r) throw new TypeError('Network request failed');
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    text: async () => r.body,
    json: async () => JSON.parse(r.body) as unknown,
  };
});

function sent(n: number): {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
} {
  const [url, init] = fetchMock.mock.calls[n] as unknown as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body as string | undefined,
  };
}

function flowAs(userId: string | null) {
  const signOut = vi.fn(async () => undefined);
  const announceDeleted = vi.fn();
  const flow = createAccountDeleteFlow({
    hasAuthenticator: false,
    deps: appAccountDeleteDeps({ userId, signOut, announceDeleted }),
  });
  return { flow, signOut, announceDeleted };
}

beforeEach(() => {
  replies.length = 0;
  state.session = { access_token: 'token-u2', user: { id: 'u2' } };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('the requests, as api() sends them', () => {
  it('the delete: POST, the bearer, JSON, the word and the password; 200 { ok: true } signs out once', async () => {
    replies.push({ status: 200, body: '{"ok":true}' });
    const { flow, signOut, announceDeleted } = flowAs('u2');
    flow.setTyped('DELETE');
    flow.setPassword(PASSWORD);
    await flow.confirm();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const req = sent(0);
    expect(req.url.endsWith(ACCOUNT_DELETE_PATH)).toBe(true);
    expect(req.url).not.toContain('?');
    expect(req.method).toBe('POST');
    expect(req.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token-u2',
    });
    expect(req.body).toBe(JSON.stringify({ confirm: 'DELETE', password: PASSWORD }));

    expect(flow.getState()).toMatchObject({ ended: 'done', notice: ACCOUNT_DELETE_DONE_COPY });
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith({ afterAccountDeleted: true });
    expect(announceDeleted).toHaveBeenCalledTimes(1);
  });

  it('the code: POST with no body, then the delete with the word, the code and the challenge', async () => {
    replies.push(
      {
        status: 200,
        body: JSON.stringify({ ok: true, challenge: CHALLENGE, expiresAt: 1, message: 'x' }),
      },
      { status: 200, body: '{"ok":true}' },
    );
    const { flow } = flowAs('u2');
    await flow.sendCode();
    const codeReq = sent(0);
    expect(codeReq.url.endsWith(ACCOUNT_DELETE_CODE_PATH)).toBe(true);
    expect(codeReq.method).toBe('POST');
    expect(codeReq.body).toBeUndefined();
    expect(codeReq.headers.Authorization).toBe('Bearer token-u2');

    flow.setTyped('DELETE');
    flow.setCode(CODE);
    await flow.confirm();
    expect(sent(1).body).toBe(
      JSON.stringify({ confirm: 'DELETE', code: CODE, challenge: CHALLENGE }),
    );
  });
});

describe('answers that are not the route\'s are never "deleted"', () => {
  it.each([
    ['an empty 200', ''],
    ['an HTML 200', '<!doctype html><html><body>Sign in to this network</body></html>'],
  ])('%s on the delete: no answer, nothing signed out', async (_label, body) => {
    replies.push({ status: 200, body });
    const { flow, signOut } = flowAs('u2');
    flow.setTyped('DELETE');
    flow.setPassword(PASSWORD);
    await flow.confirm();
    expect(flow.getState()).toMatchObject({ ended: null, notice: ACCOUNT_DELETE_NO_ANSWER_COPY });
    expect(signOut).not.toHaveBeenCalled();
  });

  it('an HTML 200 on the code route: a code may not have been sent', async () => {
    replies.push({ status: 200, body: '<html></html>' });
    const { flow } = flowAs('u2');
    await flow.sendCode();
    expect(flow.getState()).toMatchObject({
      hasChallenge: false,
      notice: ACCOUNT_DELETE_CODE_NO_ANSWER_COPY,
    });
  });

  it("a 403 with a code: core's sentence, never the server's message", async () => {
    replies.push({
      status: 403,
      body: JSON.stringify({
        error: 'password_incorrect',
        message: 'A server sentence the phone never shows.',
      }),
    });
    const { flow, signOut } = flowAs('u2');
    flow.setTyped('DELETE');
    flow.setPassword(PASSWORD);
    await flow.confirm();
    expect(flow.getState()).toMatchObject({
      method: 'password',
      password: '',
      notice: ACCOUNT_DELETE_PASSWORD_REFUSED_COPY,
    });
    expect(JSON.stringify(flow.getState())).not.toContain('A server sentence');
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("sent only as the sheet's account", () => {
  it('another session live: nothing is sent, and the flow ends with "Sign in again to continue."', async () => {
    const { flow, signOut } = flowAs('u1');
    flow.setTyped('DELETE');
    flow.setPassword(PASSWORD);
    await flow.confirm();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(flow.getState()).toMatchObject({
      ended: 'sign_in',
      notice: ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY,
      password: '',
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it('no account known: nothing is sent; the code request ends the same way', async () => {
    const { flow } = flowAs(null);
    await flow.sendCode();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(flow.getState()).toMatchObject({
      ended: 'sign_in',
      notice: ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY,
    });
  });

  it('nobody signed in: nothing is sent, "Sign in again to continue."', async () => {
    state.session = null;
    const { flow, signOut } = flowAs('u2');
    flow.setTyped('DELETE');
    flow.setPassword(PASSWORD);
    await flow.confirm();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(flow.getState()).toMatchObject({
      ended: 'sign_in',
      notice: ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY,
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it('offline (fetch throws): still the connection sentence, the password kept', async () => {
    // No reply queued: the stand-in fetch throws a network error.
    const { flow, signOut } = flowAs('u2');
    flow.setTyped('DELETE');
    flow.setPassword(PASSWORD);
    await flow.confirm();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(flow.getState()).toMatchObject({
      ended: null,
      notice: ACCOUNT_DELETE_NO_ANSWER_COPY,
      password: PASSWORD,
    });
    expect(signOut).not.toHaveBeenCalled();
  });

  it('offline on the code request: the code connection sentence', async () => {
    const { flow } = flowAs('u2');
    await flow.sendCode();
    expect(flow.getState()).toMatchObject({
      ended: null,
      notice: ACCOUNT_DELETE_CODE_NO_ANSWER_COPY,
    });
  });
});
