import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_DELETE_AAL2_COPY,
  ACCOUNT_DELETE_CODE_NO_ANSWER_COPY,
  ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY,
  ACCOUNT_DELETE_CODE_REFUSED_COPY,
  ACCOUNT_DELETE_CODE_ROUTE_ANSWERS,
  ACCOUNT_DELETE_CODE_SEND_FAILED_NO_PASSWORD_COPY,
  ACCOUNT_DELETE_CODE_SEND_PAUSED_NO_PASSWORD_COPY,
  ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY,
  ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY,
  ACCOUNT_DELETE_DONE_COPY,
  ACCOUNT_DELETE_NO_ANSWER_COPY,
  ACCOUNT_DELETE_PASSWORD_REFUSED_COPY,
  ACCOUNT_DELETE_RETRY_COPY,
  ACCOUNT_DELETE_ROUTE_ANSWERS,
  ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY,
  ACCOUNT_DELETE_UNSURE_COPY,
} from '@stockpilot/core';

import {
  ACCOUNT_DELETE_CODE_PATH,
  ACCOUNT_DELETE_PATH,
  ACCOUNT_DELETE_TIMEOUT_MS,
  accountDeleteInFlight,
  answerFromBody,
  answerFromError,
  appAccountDeleteDeps,
  createAccountDeleteFlow,
  createAccountDeleteOpener,
  hasVerifiedAuthenticator,
  type AccountDeleteDeps,
} from './account-delete';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  getUser: vi.fn(),
  handOverLiveUser: vi.fn((answer: unknown) => answer),
}));
vi.mock('./api', () => ({ api: mocks.api }));
vi.mock('./supabase', () => ({ supabase: { auth: { getUser: mocks.getUser } } }));
vi.mock('./mfa-reconcile', () => ({ handOverLiveUser: mocks.handOverLiveUser }));

/**
 * Security invariant: deleting an account from the phone signs out and
 * discards queued work only when the delete route answered that the account
 * is gone; every sentence is core's; the password, the code and the challenge
 * are never logged, kept after a cancel, or put in the state a screen reads;
 * only the newest challenge goes with a code.
 */

// Made-up values only.
const PASSWORD = 'correct horse battery staple 9!';
const CHALLENGE_1 = 'challenge-one.aaaaaaaaaaaaaaaa';
const CHALLENGE_2 = 'challenge-two.bbbbbbbbbbbbbbbb';
const CODE = '123456';

/** api()'s ApiError, by shape: what the flow reads is `status` and `code`. */
class HttpRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`server message for ${status} ${code ?? ''}`);
  }
}

type Post = AccountDeleteDeps['post'];

function harness(opts: { hasAuthenticator?: boolean; post?: Post } = {}) {
  const post = vi.fn<Post>(opts.post ?? (async () => ({ ok: true })));
  const deps = {
    post,
    signOutAfterDeleted: vi.fn(async () => undefined),
    announceDeleted: vi.fn(),
    rereadFactors: vi.fn(),
  };
  const flow = createAccountDeleteFlow({ hasAuthenticator: opts.hasAuthenticator ?? false, deps });
  return { flow, deps, post };
}

/** Answers one call each, in order. */
function answers(...queue: ({ body: unknown } | { error: unknown })[]): Post {
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error('no answer queued');
    if ('error' in next) throw next.error;
    return next.body;
  };
}

/** A flow at the password field, ready to send. */
function typedPassword(flow: ReturnType<typeof harness>['flow']) {
  flow.setTyped('DELETE');
  flow.setPassword(PASSWORD);
}

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  }
});
afterEach(() => {
  // Nothing typed and no challenge reaches the console, in any test here.
  for (const spy of consoleSpies.splice(0)) {
    const printed = JSON.stringify(spy.mock.calls);
    for (const secret of [PASSWORD, CHALLENGE_1, CHALLENGE_2, CODE]) {
      expect(printed).not.toContain(secret);
    }
    spy.mockRestore();
  }
  mocks.api.mockReset();
  mocks.getUser.mockReset();
  mocks.handOverLiveUser.mockClear();
});

describe('what is asked first', () => {
  it('an account with no verified authenticator starts at the password field', () => {
    const { flow } = harness();
    expect(flow.getState()).toMatchObject({ method: 'password', ready: false, ended: null });
  });

  it('an account with a verified authenticator confirms with the typed word alone', () => {
    const { flow } = harness({ hasAuthenticator: true });
    expect(flow.getState().method).toBe('authenticator');
    flow.setTyped('DELETE');
    expect(flow.getState().ready).toBe(true);
  });

  it('hasVerifiedAuthenticator reads only a verified factor, of any type', () => {
    expect(hasVerifiedAuthenticator(undefined)).toBe(false);
    expect(hasVerifiedAuthenticator(null)).toBe(false);
    expect(hasVerifiedAuthenticator([])).toBe(false);
    expect(hasVerifiedAuthenticator([{ status: 'unverified' }, null])).toBe(false);
    expect(hasVerifiedAuthenticator([{ status: 'unverified' }, { status: 'verified' }])).toBe(true);
  });

  it('Delete waits for the word typed exactly and the password or a six-digit code with its challenge', async () => {
    const { flow } = harness({ post: answers({ body: { ok: true, challenge: CHALLENGE_1 } }) });
    flow.setPassword(PASSWORD);
    flow.setTyped('delete');
    expect(flow.getState().ready).toBe(false);
    flow.setTyped(' DELETE ');
    expect(flow.getState().ready).toBe(true);
    flow.setPassword('');
    expect(flow.getState().ready).toBe(false);

    await flow.sendCode();
    expect(flow.getState()).toMatchObject({ method: 'code', hasChallenge: true });
    flow.setCode('12a3-45');
    expect(flow.getState().code).toBe('12345');
    expect(flow.getState().ready).toBe(false);
    flow.setCode('1234567');
    expect(flow.getState().code).toBe('123456');
    expect(flow.getState().ready).toBe(true);
  });
});

describe('switching between the password and the code', () => {
  it('the password typed before "Email me a code instead" is not kept', async () => {
    const { flow } = harness({ post: answers({ body: { ok: true, challenge: CHALLENGE_1 } }) });
    typedPassword(flow);
    await flow.sendCode();
    expect(flow.getState()).toMatchObject({ method: 'code', password: '' });
    flow.usePassword();
    expect(flow.getState().password).toBe('');
  });

  it('the code typed before "Use my password instead" is not kept', async () => {
    const { flow } = harness({ post: answers({ body: { ok: true, challenge: CHALLENGE_1 } }) });
    await flow.sendCode();
    flow.setCode(CODE);
    flow.usePassword();
    expect(flow.getState()).toMatchObject({ method: 'password', code: '' });
  });

  it('a pasted code with spaces or dashes keeps its six digits', async () => {
    const { flow } = harness({ post: answers({ body: { ok: true, challenge: CHALLENGE_1 } }) });
    await flow.sendCode();
    flow.setCode('123 456');
    expect(flow.getState().code).toBe('123456');
    flow.setCode(' 12-34-56 ');
    expect(flow.getState().code).toBe('123456');
  });
});

describe('the request shapes', () => {
  it('password: the word and the password, to the delete route', async () => {
    const { flow, post } = harness();
    typedPassword(flow);
    await flow.confirm();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(ACCOUNT_DELETE_PATH, {
      confirm: 'DELETE',
      password: PASSWORD,
    });
  });

  it('authenticator: the word alone', async () => {
    const { flow, post } = harness({ hasAuthenticator: true });
    flow.setTyped('DELETE');
    await flow.confirm();
    expect(post).toHaveBeenCalledWith(ACCOUNT_DELETE_PATH, { confirm: 'DELETE' });
  });

  it('code: the code route with no body, then the word, the code and its challenge', async () => {
    const { flow, post } = harness({
      post: answers({ body: { ok: true, challenge: CHALLENGE_1 } }, { body: { ok: true } }),
    });
    await flow.sendCode();
    expect(post).toHaveBeenNthCalledWith(1, ACCOUNT_DELETE_CODE_PATH, undefined);
    flow.setTyped('DELETE');
    flow.setCode(CODE);
    await flow.confirm();
    expect(post).toHaveBeenNthCalledWith(2, ACCOUNT_DELETE_PATH, {
      confirm: 'DELETE',
      code: CODE,
      challenge: CHALLENGE_1,
    });
  });

  it("the app's deps POST through api() as the sheet's account: the delete with its body and 45 s, the code with neither", async () => {
    mocks.api.mockResolvedValue({ ok: true });
    const deps = appAccountDeleteDeps({
      userId: 'u-1',
      signOut: vi.fn(),
      announceDeleted: vi.fn(),
    });
    await deps.post(ACCOUNT_DELETE_PATH, { confirm: 'DELETE', password: PASSWORD });
    await deps.post(ACCOUNT_DELETE_CODE_PATH, undefined);
    expect(ACCOUNT_DELETE_TIMEOUT_MS).toBe(45_000);
    expect(mocks.api).toHaveBeenNthCalledWith(1, ACCOUNT_DELETE_PATH, {
      method: 'POST',
      body: { confirm: 'DELETE', password: PASSWORD },
      asUserId: 'u-1',
      timeoutMs: 45_000,
    });
    expect(mocks.api).toHaveBeenNthCalledWith(2, ACCOUNT_DELETE_CODE_PATH, {
      method: 'POST',
      asUserId: 'u-1',
    });
  });

  it('with no account, the request names one no session matches (api() sends nothing)', async () => {
    mocks.api.mockResolvedValue({ ok: true });
    const deps = appAccountDeleteDeps({ userId: null, signOut: vi.fn(), announceDeleted: vi.fn() });
    await deps.post(ACCOUNT_DELETE_CODE_PATH, undefined);
    expect(mocks.api).toHaveBeenCalledWith(ACCOUNT_DELETE_CODE_PATH, {
      method: 'POST',
      asUserId: '',
    });
  });

  it("the app's sign-out is the one that discards a deleted account's queued work", async () => {
    const signOut = vi.fn(async () => undefined);
    const deps = appAccountDeleteDeps({ userId: 'u-1', signOut, announceDeleted: vi.fn() });
    await deps.signOutAfterDeleted();
    expect(signOut).toHaveBeenCalledWith({ afterAccountDeleted: true });
  });

  it("the app's factor re-read hands the server's user to the code gate's hand-over", async () => {
    const answer = { data: { user: { id: 'u-1', factors: [] } }, error: null };
    mocks.getUser.mockResolvedValue(answer);
    appAccountDeleteDeps({
      userId: 'u-1',
      signOut: vi.fn(),
      announceDeleted: vi.fn(),
    }).rereadFactors();
    await vi.waitFor(() => expect(mocks.handOverLiveUser).toHaveBeenCalledWith(answer));
  });
});

describe('reading an answer', () => {
  it('ok and challenge come from a JSON object only', () => {
    expect(answerFromBody({ ok: true, challenge: CHALLENGE_1 })).toEqual({
      status: 200,
      ok: true,
      challenge: CHALLENGE_1,
    });
    for (const body of [null, undefined, 'ok', true, [{ ok: true }], 0]) {
      expect(answerFromBody(body)).toEqual({ status: 200, ok: undefined, challenge: undefined });
    }
  });

  it('a throw with no status is no answer; a refusal carries its status and code', () => {
    expect(answerFromError(new SyntaxError('JSON Parse error: Unexpected end of input'))).toEqual({
      status: null,
    });
    expect(answerFromError(new TypeError('Network request failed'))).toEqual({ status: null });
    expect(answerFromError(null)).toEqual({ status: null });
    expect(answerFromError({ status: 0 })).toEqual({ status: null });
    expect(answerFromError(new HttpRefusal(403, 'password_incorrect'))).toEqual({
      status: 403,
      error: 'password_incorrect',
    });
    expect(answerFromError({ status: 503 })).toEqual({ status: 503, error: undefined });
  });
});

describe('the delete route: every answer leads to its state', () => {
  it('200 { ok: true }: done, then signed out with the discard, then the sentence', async () => {
    const { flow, deps } = harness();
    const order: string[] = [];
    deps.signOutAfterDeleted.mockImplementation(async () => {
      order.push('signOut');
    });
    deps.announceDeleted.mockImplementation(() => order.push('announce'));
    typedPassword(flow);
    await flow.confirm();
    expect(flow.getState()).toMatchObject({
      ended: 'done',
      notice: ACCOUNT_DELETE_DONE_COPY,
      password: '',
      typed: '',
      ready: false,
    });
    expect(order).toEqual(['signOut', 'announce']);
    expect(deps.announceDeleted).toHaveBeenCalledWith(ACCOUNT_DELETE_DONE_COPY);
  });

  it('nothing closes or sends while the sign-out after a deletion runs; closing after it keeps it ended', async () => {
    let finish: () => void = () => undefined;
    const { flow, deps, post } = harness();
    deps.signOutAfterDeleted.mockImplementation(
      () => new Promise<undefined>((r) => (finish = () => r(undefined))),
    );
    typedPassword(flow);
    const deleting = flow.confirm();
    await vi.waitFor(() => expect(deps.signOutAfterDeleted).toHaveBeenCalledTimes(1));
    expect(flow.getState()).toMatchObject({ ended: 'done', busy: 'delete' });
    expect(flow.cancel()).toBe(false);
    flow.setTyped('DELETE');
    await flow.confirm();
    finish();
    await deleting;
    expect(flow.getState()).toMatchObject({ ended: 'done', busy: null });
    expect(flow.cancel()).toBe(true);
    expect(flow.getState().ended).toBe('done');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a sign-out that throws after the deletion leaves the flow ended and idle (the sheet offers Close), announced once', async () => {
    const { flow, deps } = harness();
    deps.signOutAfterDeleted.mockRejectedValue(new Error('the sign-out could not finish'));
    typedPassword(flow);
    await flow.confirm();
    expect(flow.getState()).toMatchObject({ ended: 'done', busy: null, ready: false });
    expect(deps.announceDeleted).toHaveBeenCalledTimes(1);
    expect(accountDeleteInFlight()).toBe(false);
    expect(flow.cancel()).toBe(true);
  });

  it('aal2_required: the factors are read again and the sentence shows', async () => {
    const { flow, deps } = harness({
      post: answers({ error: new HttpRefusal(403, 'aal2_required') }),
    });
    typedPassword(flow);
    await flow.confirm();
    expect(flow.getState()).toMatchObject({ ended: null, notice: ACCOUNT_DELETE_AAL2_COPY });
    expect(deps.rereadFactors).toHaveBeenCalledTimes(1);
    expect(deps.signOutAfterDeleted).not.toHaveBeenCalled();
  });

  it('no other refusal asks for the factors to be read again', async () => {
    for (const code of ['password_incorrect', 'credential_required', 'last_owner']) {
      const { flow, deps } = harness({ post: answers({ error: new HttpRefusal(403, code) }) });
      typedPassword(flow);
      await flow.confirm();
      expect(deps.rereadFactors, code).not.toHaveBeenCalled();
    }
  });

  it.each([
    [
      'an empty or unparseable 2xx (api() throws with no status)',
      { error: new SyntaxError('JSON Parse error') },
      ACCOUNT_DELETE_NO_ANSWER_COPY,
    ],
    [
      'a network failure',
      { error: new TypeError('Network request failed') },
      ACCOUNT_DELETE_NO_ANSWER_COPY,
    ],
    [
      'a timeout',
      { error: new Error('The request took too long.') },
      ACCOUNT_DELETE_NO_ANSWER_COPY,
    ],
    ["a 2xx that is not the route's answer", { body: { ok: 'yes' } }, ACCOUNT_DELETE_UNSURE_COPY],
    ['a 2xx with a body that is not an object', { body: [true] }, ACCOUNT_DELETE_UNSURE_COPY],
  ] as const)(
    '%s is never "deleted": nothing signed out, the field kept',
    async (_label, answer, sentence) => {
      const { flow, deps } = harness({ post: answers(answer) });
      typedPassword(flow);
      await flow.confirm();
      expect(flow.getState()).toMatchObject({
        ended: null,
        busy: null,
        method: 'password',
        notice: sentence,
        password: PASSWORD,
        ready: true,
      });
      expect(deps.signOutAfterDeleted).not.toHaveBeenCalled();
      expect(deps.announceDeleted).not.toHaveBeenCalled();
    },
  );

  it('401: "sign in again" from core; nothing signed out here (the account probe decides)', async () => {
    const { flow, deps } = harness({
      post: answers({ error: new HttpRefusal(401, 'unauthenticated') }),
    });
    typedPassword(flow);
    await flow.confirm();
    expect(flow.getState()).toMatchObject({
      ended: 'sign_in',
      notice: ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY,
      password: '',
    });
    expect(deps.signOutAfterDeleted).not.toHaveBeenCalled();
    expect(deps.rereadFactors).not.toHaveBeenCalled();
  });

  for (const row of ACCOUNT_DELETE_ROUTE_ANSWERS) {
    it(`${row.status} ${row.error}: ${row.next}, with core's sentence`, async () => {
      // Sent with the code, so a move to the password field shows.
      const { flow, deps } = harness({
        post: answers(
          { body: { ok: true, challenge: CHALLENGE_1 } },
          { error: new HttpRefusal(row.status, row.error) },
        ),
      });
      await flow.sendCode();
      flow.setTyped('DELETE');
      flow.setCode(CODE);
      await flow.confirm();
      const s = flow.getState();
      expect(s.notice).toBe(row.sentence);
      expect(s.notice).not.toContain('server message');
      expect(s.ended).toBeNull();
      expect(s.busy).toBeNull();
      expect(s.method).toBe(row.next === 'password' ? 'password' : 'code');
      if (row.next === 'code') expect(s.code).toBe('');
      expect(deps.signOutAfterDeleted).not.toHaveBeenCalled();
    });
  }

  it("credential_required on the word alone opens the password field with core's sentence", async () => {
    const { flow } = harness({
      hasAuthenticator: true,
      post: answers({ error: new HttpRefusal(403, 'credential_required') }),
    });
    flow.setTyped('DELETE');
    await flow.confirm();
    expect(flow.getState()).toMatchObject({
      method: 'password',
      notice: ACCOUNT_DELETE_CREDENTIAL_REQUIRED_COPY,
      ready: false,
    });
  });

  it('mfa_required on the word alone opens the password field too', async () => {
    const { flow } = harness({
      hasAuthenticator: true,
      post: answers({ error: new HttpRefusal(403, 'mfa_required') }),
    });
    flow.setTyped('DELETE');
    await flow.confirm();
    expect(flow.getState().method).toBe('password');
  });

  it('a wrong password is cleared; a wrong code is cleared and the code field stays', async () => {
    const wrongPassword = harness({
      post: answers({ error: new HttpRefusal(403, 'password_incorrect') }),
    });
    typedPassword(wrongPassword.flow);
    await wrongPassword.flow.confirm();
    expect(wrongPassword.flow.getState()).toMatchObject({
      password: '',
      notice: ACCOUNT_DELETE_PASSWORD_REFUSED_COPY,
      typed: 'DELETE',
    });

    const wrongCode = harness({
      post: answers(
        { body: { ok: true, challenge: CHALLENGE_1 } },
        { error: new HttpRefusal(403, 'code_incorrect') },
      ),
    });
    await wrongCode.flow.sendCode();
    wrongCode.flow.setTyped('DELETE');
    wrongCode.flow.setCode(CODE);
    await wrongCode.flow.confirm();
    expect(wrongCode.flow.getState()).toMatchObject({
      method: 'code',
      code: '',
      notice: ACCOUNT_DELETE_CODE_REFUSED_COPY,
    });
  });

  it('the limits: 429 says too many tries and that nothing was deleted', async () => {
    const { flow, deps } = harness({
      post: answers({ error: new HttpRefusal(429, 'rate_limited') }),
    });
    typedPassword(flow);
    await flow.confirm();
    expect(flow.getState().notice).toBe(ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY);
    expect(ACCOUNT_DELETE_CREDENTIAL_PAUSED_COPY).toContain('Nothing was deleted.');
    expect(deps.signOutAfterDeleted).not.toHaveBeenCalled();
  });

  it('an unknown 4xx and 5xx claim no deletion', async () => {
    for (const [status, sentence] of [
      [418, ACCOUNT_DELETE_RETRY_COPY],
      [502, ACCOUNT_DELETE_UNSURE_COPY],
    ] as const) {
      const { flow, deps } = harness({ post: answers({ error: new HttpRefusal(status) }) });
      typedPassword(flow);
      await flow.confirm();
      expect(flow.getState().notice).toBe(sentence);
      expect(deps.signOutAfterDeleted).not.toHaveBeenCalled();
    }
  });
});

describe('the code route: every answer leads to its state', () => {
  it('200 with a challenge: the code field, the challenge held but never in the state', async () => {
    const { flow } = harness({
      post: answers({ body: { ok: true, challenge: CHALLENGE_1, message: 'x' } }),
    });
    flow.setCode('99');
    await flow.sendCode();
    const s = flow.getState();
    expect(s).toMatchObject({
      method: 'code',
      hasChallenge: true,
      code: '',
      notice: null,
      busy: null,
    });
    expect(JSON.stringify(s)).not.toContain(CHALLENGE_1);
  });

  it.each([
    ['200 without a challenge', { body: { ok: true } }],
    ['200 with an empty challenge', { body: { ok: true, challenge: '' } }],
    ['an empty or unparseable 2xx', { error: new SyntaxError('JSON Parse error') }],
    ['a network failure', { error: new TypeError('Network request failed') }],
  ] as const)(
    '%s: a code may not have been sent; still the password field',
    async (_label, answer) => {
      const { flow } = harness({ post: answers(answer) });
      await flow.sendCode();
      expect(flow.getState()).toMatchObject({
        method: 'password',
        hasChallenge: false,
        notice: ACCOUNT_DELETE_CODE_NO_ANSWER_COPY,
        busy: null,
      });
    },
  );

  it('401: ended with "sign in again", nothing signed out', async () => {
    const { flow, deps } = harness({
      post: answers({ error: new HttpRefusal(401, 'unauthenticated') }),
    });
    await flow.sendCode();
    expect(flow.getState()).toMatchObject({
      ended: 'sign_in',
      notice: ACCOUNT_DELETE_SIGN_IN_AGAIN_COPY,
    });
    expect(deps.signOutAfterDeleted).not.toHaveBeenCalled();
  });

  it('409 not_offered: the factors are read again and the flow ends with its sentence', async () => {
    const { flow, deps } = harness({
      post: answers({ error: new HttpRefusal(409, 'not_offered') }),
    });
    flow.setTyped('DELETE');
    await flow.sendCode();
    expect(flow.getState()).toMatchObject({
      ended: 'not_offered',
      notice: ACCOUNT_DELETE_CODE_NOT_OFFERED_COPY,
      typed: '',
      ready: false,
    });
    expect(deps.rereadFactors).toHaveBeenCalledTimes(1);
    expect(deps.signOutAfterDeleted).not.toHaveBeenCalled();
    // Ended: nothing more is sent.
    await flow.confirm();
    await flow.sendCode();
    expect(deps.post).toHaveBeenCalledTimes(1);
  });

  for (const row of ACCOUNT_DELETE_CODE_ROUTE_ANSWERS.filter((r) => r.error !== 'not_offered')) {
    it(`${row.status} ${row.error}: stays, with the phone's sentence`, async () => {
      const { flow, deps } = harness({
        post: answers({ error: new HttpRefusal(row.status, row.error) }),
      });
      await flow.sendCode();
      expect(flow.getState()).toMatchObject({
        ended: null,
        method: 'password',
        notice: row.sentence,
        busy: null,
      });
      expect(deps.rereadFactors).not.toHaveBeenCalled();
    });
  }

  it('the limits: too many codes, and a send that failed, offer the password only to an account that has one', async () => {
    const paused = harness({ post: answers({ error: new HttpRefusal(429, 'rate_limited') }) });
    await paused.flow.sendCode();
    expect(paused.flow.getState().notice).toBe(ACCOUNT_DELETE_CODE_SEND_PAUSED_NO_PASSWORD_COPY);
    expect(ACCOUNT_DELETE_CODE_SEND_PAUSED_NO_PASSWORD_COPY).toContain('if you have one');

    const failed = harness({ post: answers({ error: new HttpRefusal(503, 'send_failed') }) });
    await failed.flow.sendCode();
    expect(failed.flow.getState().notice).toBe(ACCOUNT_DELETE_CODE_SEND_FAILED_NO_PASSWORD_COPY);
  });

  it('an account confirming with its authenticator asks for no code', async () => {
    const { flow, post } = harness({ hasAuthenticator: true });
    await flow.sendCode();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('the newest challenge only', () => {
  it('a new code replaces the challenge; the delete sends the newest', async () => {
    const { flow, post } = harness({
      post: answers(
        { body: { ok: true, challenge: CHALLENGE_1 } },
        { body: { ok: true, challenge: CHALLENGE_2 } },
        { body: { ok: true } },
      ),
    });
    await flow.sendCode();
    flow.setCode('111111');
    await flow.sendCode();
    expect(flow.getState().code).toBe('');
    flow.setTyped('DELETE');
    flow.setCode(CODE);
    await flow.confirm();
    expect(post).toHaveBeenLastCalledWith(ACCOUNT_DELETE_PATH, {
      confirm: 'DELETE',
      code: CODE,
      challenge: CHALLENGE_2,
    });
  });

  it('a later send that failed keeps the challenge of the code already sent', async () => {
    const { flow, post } = harness({
      post: answers(
        { body: { ok: true, challenge: CHALLENGE_1 } },
        { error: new HttpRefusal(429, 'rate_limited') },
        { body: { ok: true } },
      ),
    });
    await flow.sendCode();
    await flow.sendCode();
    expect(flow.getState()).toMatchObject({ method: 'code', hasChallenge: true });
    flow.setTyped('DELETE');
    flow.setCode(CODE);
    await flow.confirm();
    expect(post).toHaveBeenLastCalledWith(ACCOUNT_DELETE_PATH, {
      confirm: 'DELETE',
      code: CODE,
      challenge: CHALLENGE_1,
    });
  });

  it('back to the password sends the password, never the challenge', async () => {
    const { flow, post } = harness({
      post: answers({ body: { ok: true, challenge: CHALLENGE_1 } }, { body: { ok: true } }),
    });
    await flow.sendCode();
    flow.usePassword();
    expect(flow.getState()).toMatchObject({ method: 'password', notice: null });
    typedPassword(flow);
    await flow.confirm();
    expect(post).toHaveBeenLastCalledWith(ACCOUNT_DELETE_PATH, {
      confirm: 'DELETE',
      password: PASSWORD,
    });
  });
});

describe('one request at a time', () => {
  it('a double tap on Delete sends once', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { flow, post } = harness({ post: () => new Promise((r) => (release = r)) });
    typedPassword(flow);
    const first = flow.confirm();
    const second = flow.confirm();
    expect(flow.getState()).toMatchObject({ busy: 'delete', ready: false });
    release({ ok: true });
    await Promise.all([first, second]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a double tap on "Email me a code instead" sends once, and Delete waits for it', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { flow, post } = harness({ post: () => new Promise((r) => (release = r)) });
    typedPassword(flow);
    const first = flow.sendCode();
    const second = flow.sendCode();
    await flow.confirm();
    flow.usePassword();
    expect(flow.getState()).toMatchObject({ busy: 'code', method: 'password' });
    release({ ok: true, challenge: CHALLENGE_1 });
    await Promise.all([first, second]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(flow.getState().method).toBe('code');
  });
});

describe('one delete in the whole app, and the opener', () => {
  it("while one flow's delete runs, another flow sends none", async () => {
    let release: (v: unknown) => void = () => undefined;
    const a = harness({ post: () => new Promise((r) => (release = r)) });
    const b = harness();
    typedPassword(a.flow);
    typedPassword(b.flow);
    const deleting = a.flow.confirm();
    expect(accountDeleteInFlight()).toBe(true);
    await b.flow.confirm();
    expect(b.post).not.toHaveBeenCalled();
    release(null);
    await deleting;
    expect(accountDeleteInFlight()).toBe(false);
    await b.flow.confirm();
    expect(b.post).toHaveBeenCalledTimes(1);
  });

  it('the in-flight mark lasts through the sign-out after a deletion', async () => {
    let finish: () => void = () => undefined;
    const { flow, deps } = harness();
    deps.signOutAfterDeleted.mockImplementation(
      () => new Promise<undefined>((r) => (finish = () => r(undefined))),
    );
    typedPassword(flow);
    const deleting = flow.confirm();
    await vi.waitFor(() => expect(deps.signOutAfterDeleted).toHaveBeenCalledTimes(1));
    expect(accountDeleteInFlight()).toBe(true);
    finish();
    await deleting;
    expect(accountDeleteInFlight()).toBe(false);
  });

  it('open shows the sheet once; closed hides it; listeners hear each change', () => {
    const opener = createAccountDeleteOpener();
    const listener = vi.fn();
    opener.subscribe(listener);
    expect(opener.isOpen()).toBe(false);
    opener.open();
    opener.open();
    expect(opener.isOpen()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    opener.closed();
    opener.closed();
    expect(opener.isOpen()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('open does nothing while a delete is under way anywhere in the app', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { flow } = harness({ post: () => new Promise((r) => (release = r)) });
    typedPassword(flow);
    const deleting = flow.confirm();
    const opener = createAccountDeleteOpener();
    opener.open();
    expect(opener.isOpen()).toBe(false);
    release(null);
    await deleting;
    opener.open();
    expect(opener.isOpen()).toBe(true);
  });

  it("the opener has no way to close but the sheet's own onClose", () => {
    expect(Object.keys(createAccountDeleteOpener()).sort()).toEqual([
      'closed',
      'isOpen',
      'open',
      'subscribe',
    ]);
  });
});

describe('cancel leaves nothing behind', () => {
  it('forgets the word, the password, the code and the challenge', async () => {
    const { flow, post } = harness({
      post: answers({ body: { ok: true, challenge: CHALLENGE_1 } }, { body: { ok: true } }),
    });
    typedPassword(flow);
    await flow.sendCode();
    flow.setCode(CODE);
    expect(flow.cancel()).toBe(true);
    expect(flow.getState()).toEqual({
      method: 'password',
      typed: '',
      password: '',
      code: '',
      hasChallenge: false,
      busy: null,
      notice: null,
      ended: null,
      ready: false,
    });
    // The old challenge is gone: a code typed after the cancel cannot be sent without a new one.
    flow.setTyped('DELETE');
    flow.setCode(CODE);
    expect(flow.getState().ready).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('the challenge from before a cancel never goes with a code typed after it', async () => {
    const { flow, post } = harness({
      post: answers(
        { body: { ok: true, challenge: CHALLENGE_1 } },
        { error: new HttpRefusal(403, 'code_incorrect') },
      ),
    });
    await flow.sendCode();
    expect(flow.cancel()).toBe(true);
    // An answer that opens the code field again: it holds no challenge.
    typedPassword(flow);
    await flow.confirm();
    flow.setCode(CODE);
    expect(flow.getState()).toMatchObject({ method: 'code', hasChallenge: false, ready: false });
    await flow.confirm();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('a code answer that comes back after the cancel is dropped', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { flow } = harness({ post: () => new Promise((r) => (release = r)) });
    const sending = flow.sendCode();
    expect(flow.cancel()).toBe(true);
    release({ ok: true, challenge: CHALLENGE_1 });
    await sending;
    expect(flow.getState()).toMatchObject({ method: 'password', hasChallenge: false, busy: null });
  });

  it('is refused while a delete is under way, whose answer still decides', async () => {
    let release: (v: unknown) => void = () => undefined;
    const { flow, deps } = harness({ post: () => new Promise((r) => (release = r)) });
    typedPassword(flow);
    const deleting = flow.confirm();
    expect(flow.cancel()).toBe(false);
    release({ ok: true });
    await deleting;
    expect(flow.getState().ended).toBe('done');
    expect(deps.signOutAfterDeleted).toHaveBeenCalledTimes(1);
  });
});

describe('the state a screen reads', () => {
  it('notifies its listeners and stops after unsubscribe', () => {
    const { flow } = harness();
    const listener = vi.fn();
    const stop = flow.subscribe(listener);
    flow.setTyped('D');
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    flow.setTyped('DE');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a new snapshot per change, the same one between changes', () => {
    const { flow } = harness();
    const a = flow.getState();
    expect(flow.getState()).toBe(a);
    flow.setTyped('D');
    expect(flow.getState()).not.toBe(a);
  });
});
