import {
  ACCOUNT_DELETE_CODE_RE,
  accountDeleteAnswer,
  type AccountDeleteAnswer,
} from '@stockpilot/core';

/**
 * DELETING YOUR OWN ACCOUNT FROM THE PHONE: the requests, what each answer
 * leads to, and the one challenge the emailed code goes with.
 *
 * How a deletion is confirmed is the server's decision
 * (apps/web/src/server/lib/account-deletion-credential.ts):
 *  - an account with a verified authenticator: the session entered its code
 *    (aal2), and the request carries only the typed word;
 *  - an account with none: its current password, or a six-digit code emailed
 *    to it (POST /api/v1/account/delete/code answers the challenge that goes
 *    with the code), sent with the typed word to POST /api/v1/account/delete.
 *
 * `hasAuthenticator` only chooses what is asked first, as the website's
 * dialog does. When the server answers that a password or a code is needed,
 * the password field shows whatever the phone thought.
 *
 * Every answer is read through core's accountDeleteAnswer, so every sentence
 * shown is one of core's, never the server's own `message`:
 *  - `ok` and `challenge` are read only from a body that parsed as a JSON
 *    object. An empty or unparseable 2xx makes api() throw with no status,
 *    which is "no answer": never "deleted";
 *  - the account is signed out, and its queued work discarded, only when the
 *    delete route answered that the account is gone;
 *  - a 401 signs nothing out here: api() already asked the account probe
 *    (account-eviction.ts notifyUnauthorized), which decides whether the
 *    session ended or the account was disabled and shows that screen;
 *  - "not offered" (the account has an authenticator after all) asks for the
 *    factors to be read again and ends the flow with its sentence; "enter
 *    your authenticator code first" asks for the same re-read and stays.
 *
 * One delete at a time in the whole app: while one, or the sign-out after
 * it, runs, no other flow sends one and no sheet opens.
 *
 * The password, the code and the challenge stay in memory, in this flow only.
 * Nothing here logs, stores or reports them, and the challenge is never part
 * of the state a screen reads. A flow that is cancelled forgets all three and
 * ignores any answer that comes back for it. A delete already sent cannot be
 * cancelled: its answer decides whether the account is gone.
 *
 * PURE: no react-native and no supabase at load (the defaults below import
 * them when first used), so the tests drive it with stand-ins.
 */

export const ACCOUNT_DELETE_PATH = '/api/v1/account/delete';
export const ACCOUNT_DELETE_CODE_PATH = '/api/v1/account/delete/code';

/**
 * How long the delete request may take before it reads as "no answer"
 * (api()'s `timeoutMs`): the route checks the account, runs the delete and
 * writes its record. The code request keeps api()'s default.
 */
export const ACCOUNT_DELETE_TIMEOUT_MS = 45_000;

/**
 * How long the sheet waits for the sign-out after a deletion before it lets
 * go: the account is gone either way. The sign-out itself keeps running.
 */
export const ACCOUNT_DELETE_SIGN_OUT_WAIT_MS = 20_000;

/**
 * Thrown by the app's `post` when api() refused to send because the live
 * session is not the sheet's account (or there is none). Nothing left the
 * phone; it reads as "sign in again", not as a connection problem.
 */
export class AccountDeleteNotSentError extends Error {
  readonly notSent = true;
  constructor() {
    super('Not sent: the signed-in account is not the one this sheet was opened for.');
    this.name = 'AccountDeleteNotSentError';
  }
}

// Deletes under way in this app, across every flow: while one runs, no other
// flow sends one and no sheet opens (createAccountDeleteOpener).
let deletesInFlight = 0;

/** Whether a delete request, or the sign-out after it, is under way anywhere in the app. */
export function accountDeleteInFlight(): boolean {
  return deletesInFlight > 0;
}

/** The word the person types, and the route requires as `confirm`. */
export const ACCOUNT_DELETE_WORD = 'DELETE';

/** How this flow confirms: the typed word alone, or with the password or an emailed code. */
export type AccountDeleteMethod = 'authenticator' | 'password' | 'code';

/**
 * Why the flow ended: the account is gone; the request was not accepted as
 * signed in; or the account has an authenticator, whose code confirms instead.
 */
export type AccountDeleteEnded = 'done' | 'sign_in' | 'not_offered';

/** What the sheet reads. Never the challenge. */
export interface AccountDeleteState {
  readonly method: AccountDeleteMethod;
  /** The typed word. */
  readonly typed: string;
  /** The password as typed (shown only as dots: the field uses secure entry). */
  readonly password: string;
  /** The emailed code as typed: digits only, at most six. */
  readonly code: string;
  /** Whether a code was sent in this flow and its challenge is held. */
  readonly hasChallenge: boolean;
  /** The request under way, if any. */
  readonly busy: 'delete' | 'code' | null;
  /** The sentence of the last answer, from core; null when there is nothing to say. */
  readonly notice: string | null;
  readonly ended: AccountDeleteEnded | null;
  /** Whether Delete may be pressed. */
  readonly ready: boolean;
}

/** What the flow needs from the app. */
export interface AccountDeleteDeps {
  /**
   * POST `path` with `body` (none for the code route): api()'s contract.
   * Resolves with the parsed body of a 2xx; rejects with `status` and `code`
   * for any other answer, with AccountDeleteNotSentError when nothing was
   * sent because the session is not the sheet's account, and with neither
   * for no answer or a body that did not parse.
   */
  post: (path: string, body: Record<string, string> | undefined) => Promise<unknown>;
  /** Sign out and discard this account's queued work (signOut({ afterAccountDeleted: true })). */
  signOutAfterDeleted: () => Promise<void> | void;
  /** Called once the account is gone and signed out, with core's sentence. */
  announceDeleted: (sentence: string) => void;
  /** Ask for the account's factors to be read again. Best-effort, never awaited. */
  rereadFactors: () => void;
}

export interface AccountDeleteFlow {
  getState: () => AccountDeleteState;
  subscribe: (listener: () => void) => () => void;
  setTyped: (value: string) => void;
  setPassword: (value: string) => void;
  setCode: (value: string) => void;
  /** Send the delete with the current method. One at a time: a second tap sends nothing. */
  confirm: () => Promise<void>;
  /** Ask for an emailed code ("Email me a code instead", "Send a new code"). */
  sendCode: () => Promise<void>;
  /** Back to the password field ("Use my password instead"). */
  usePassword: () => void;
  /**
   * Forget everything typed and the challenge, and ignore answers still to
   * come. Refused (false) while a delete, or the sign-out after it, is under
   * way.
   */
  cancel: () => boolean;
}

/** Whether a factor list holds a verified authenticator (any type; only `status` is read). */
export function hasVerifiedAuthenticator(
  factors: readonly ({ readonly status?: string | null } | null | undefined)[] | null | undefined,
): boolean {
  return (factors ?? []).some((factor) => factor?.status === 'verified');
}

/** What an answer gives core's reader: a status, the code, and `ok` and `challenge` from a JSON object only. */
export interface AccountDeleteAnswerInput {
  status: number | null;
  error?: string;
  ok?: unknown;
  challenge?: unknown;
}

/** A resolved post: api() resolves only for a 2xx whose body parsed, and these routes' only 2xx is 200. */
export function answerFromBody(body: unknown): AccountDeleteAnswerInput {
  const obj =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  return { status: 200, ok: obj?.ok, challenge: obj?.challenge };
}

/** A rejected post: the HTTP status and code when there was an answer, else no answer. */
export function answerFromError(err: unknown): AccountDeleteAnswerInput {
  const e = err as { status?: unknown; code?: unknown; notSent?: unknown } | null | undefined;
  // Not sent: this session is not the sheet's account. Read as the routes'
  // 401 ("Sign in again to continue."), which claims nothing either way.
  if (e?.notSent === true) return { status: 401 };
  const status = typeof e?.status === 'number' && e.status > 0 ? e.status : null;
  if (status === null) return { status: null };
  return { status, error: typeof e?.code === 'string' ? e.code : undefined };
}

/** Waits for `work` to settle (a throw counts) or for `ms`, whichever comes first. Never throws. */
function settledOrAfter(work: () => Promise<void> | void, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      Promise.resolve(work()).then(done, done);
    } catch {
      done();
    }
  });
}

function isReady(s: Omit<AccountDeleteState, 'ready'>, challenge: string | null): boolean {
  if (s.busy !== null || s.ended !== null) return false;
  if (s.typed.trim() !== ACCOUNT_DELETE_WORD) return false;
  if (s.method === 'password') return s.password.length > 0;
  if (s.method === 'code') return ACCOUNT_DELETE_CODE_RE.test(s.code) && challenge !== null;
  return true;
}

export function createAccountDeleteFlow(opts: {
  hasAuthenticator: boolean;
  deps: AccountDeleteDeps;
}): AccountDeleteFlow {
  const { deps } = opts;
  const firstMethod: AccountDeleteMethod = opts.hasAuthenticator ? 'authenticator' : 'password';
  const blank: Omit<AccountDeleteState, 'ready'> = {
    method: firstMethod,
    typed: '',
    password: '',
    code: '',
    hasChallenge: false,
    busy: null,
    notice: null,
    ended: null,
  };

  // The newest challenge, and only it: each send replaces it. Never in the state.
  let challenge: string | null = null;
  // Bumped by cancel(): an answer for an earlier generation is dropped.
  let generation = 0;
  let state: AccountDeleteState = { ...blank, ready: false };
  const listeners = new Set<() => void>();

  function set(patch: Partial<Omit<AccountDeleteState, 'ready'>>): void {
    const next = { ...state, ...patch };
    state = { ...next, ready: isReady(next, challenge) };
    for (const listener of listeners) listener();
  }

  /** The flow is over: nothing typed is kept. */
  function end(ended: AccountDeleteEnded, sentence: string): void {
    challenge = null;
    set({
      busy: null,
      ended,
      notice: sentence,
      typed: '',
      password: '',
      code: '',
      hasChallenge: false,
    });
  }

  function bodyFor(method: AccountDeleteMethod): Record<string, string> {
    if (method === 'password') return { confirm: ACCOUNT_DELETE_WORD, password: state.password };
    if (method === 'code') {
      return { confirm: ACCOUNT_DELETE_WORD, code: state.code, challenge: challenge ?? '' };
    }
    return { confirm: ACCOUNT_DELETE_WORD };
  }

  async function confirm(): Promise<void> {
    if (!state.ready || accountDeleteInFlight()) return;
    deletesInFlight += 1;
    try {
      await sendDelete();
    } finally {
      deletesInFlight -= 1;
    }
  }

  async function sendDelete(): Promise<void> {
    const body = bodyFor(state.method);
    set({ busy: 'delete', notice: null });

    let input: AccountDeleteAnswerInput;
    try {
      input = answerFromBody(await deps.post(ACCOUNT_DELETE_PATH, body));
    } catch (err) {
      input = answerFromError(err);
    }
    const answer: AccountDeleteAnswer = accountDeleteAnswer({ route: 'delete', ...input });

    switch (answer.next) {
      case 'done': {
        // Still busy through the sign-out: nothing closes or sends meanwhile.
        end('done', answer.sentence);
        set({ busy: 'delete' });
        // Bounded: a sign-out that does not settle (a logout call with no
        // answer) lets go after ACCOUNT_DELETE_SIGN_OUT_WAIT_MS. The sign-out
        // keeps running; the sheet then offers Close (ended 'done', nothing
        // under way), whether it threw or is still waiting.
        await settledOrAfter(deps.signOutAfterDeleted, ACCOUNT_DELETE_SIGN_OUT_WAIT_MS);
        set({ busy: null });
        deps.announceDeleted(answer.sentence);
        return;
      }
      case 'sign_in':
        end('sign_in', answer.sentence);
        return;
      case 'password':
        set({
          busy: null,
          method: 'password',
          notice: answer.sentence,
          ...(input.error === 'password_incorrect' ? { password: '' } : {}),
        });
        return;
      case 'code':
        set({ busy: null, method: 'code', code: '', notice: answer.sentence });
        return;
      default:
        // The account has an authenticator whose code this session has not
        // entered: the factors are read again, so the code screen can follow.
        if (input.status === 403 && input.error === 'aal2_required') deps.rereadFactors();
        set({ busy: null, notice: answer.sentence });
    }
  }

  async function sendCode(): Promise<void> {
    if (state.busy !== null || state.ended !== null || state.method === 'authenticator') return;
    const asked = generation;
    set({ busy: 'code', notice: null });

    let input: AccountDeleteAnswerInput;
    try {
      input = answerFromBody(await deps.post(ACCOUNT_DELETE_CODE_PATH, undefined));
    } catch (err) {
      input = answerFromError(err);
    }
    // Cancelled while it was under way: this answer belongs to nobody.
    if (asked !== generation) return;
    const answer = accountDeleteAnswer({ route: 'code', ...input });

    if (answer.next === 'code' && typeof input.challenge === 'string') {
      challenge = input.challenge;
      // The password typed before the switch is not kept.
      set({
        busy: null,
        method: 'code',
        code: '',
        password: '',
        hasChallenge: true,
        notice: null,
      });
      return;
    }
    if (answer.next === 'sign_in') {
      end('sign_in', answer.sentence);
      return;
    }
    if (input.status === 409 && input.error === 'not_offered') {
      end('not_offered', answer.sentence);
      deps.rereadFactors();
      return;
    }
    // A code that could not be sent: the challenge held, if any, still goes
    // with the code sent before it.
    set({ busy: null, notice: answer.sentence });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTyped(value) {
      if (state.ended !== null) return;
      set({ typed: value });
    },
    setPassword(value) {
      if (state.ended !== null) return;
      set({ password: value });
    },
    setCode(value) {
      if (state.ended !== null) return;
      set({ code: value.replace(/[^0-9]/g, '').slice(0, 6) });
    },
    confirm,
    sendCode,
    usePassword() {
      if (state.busy !== null || state.ended !== null) return;
      // The code typed before the switch is not kept.
      set({ method: 'password', code: '', notice: null });
    },
    cancel() {
      if (state.busy === 'delete') return false;
      generation += 1;
      challenge = null;
      // A deleted account stays ended: closing then is only closing.
      if (state.ended !== 'done') set({ ...blank });
      return true;
    },
  };
}

/**
 * The app's own deps: api() for the requests, the deliberate sign-out with
 * the discard for a deleted account, and the factors read again through the
 * code gate's own hand-over (mfa-reconcile.ts handOverLiveUser). Each module
 * is imported when first used, so loading this file reads no session.
 */
export function appAccountDeleteDeps(opts: {
  /**
   * The account the sheet was opened for (the session's user). Every request
   * is sent only under this account's token (api()'s asUserId); with none, or
   * another session live, nothing is sent and the flow ends with "Sign in
   * again to continue." (AccountDeleteNotSentError).
   */
  userId: string | null;
  signOut: (o?: { afterAccountDeleted?: boolean }) => Promise<void> | void;
  announceDeleted: (sentence: string) => void;
}): AccountDeleteDeps {
  return {
    post: async (path, body) => {
      const [{ api }, { OutboxSessionChangedError }] = await Promise.all([
        import('./api'),
        import('./outbox-scope'),
      ]);
      try {
        return await api<unknown>(path, {
          method: 'POST',
          ...(body ? { body } : {}),
          // An empty id matches no session, so api() refuses before sending.
          asUserId: opts.userId ?? '',
          ...(path === ACCOUNT_DELETE_PATH ? { timeoutMs: ACCOUNT_DELETE_TIMEOUT_MS } : {}),
        });
      } catch (err) {
        // api() refused before sending: the session is not this account's.
        if (err instanceof OutboxSessionChangedError) throw new AccountDeleteNotSentError();
        throw err;
      }
    },
    signOutAfterDeleted: () => opts.signOut({ afterAccountDeleted: true }),
    announceDeleted: opts.announceDeleted,
    rereadFactors: () => {
      void Promise.all([import('./supabase'), import('./mfa-reconcile')])
        .then(([{ supabase }, { handOverLiveUser }]) =>
          supabase.auth.getUser().then(handOverLiveUser),
        )
        .catch(() => undefined);
    },
  };
}

/**
 * Whether the delete sheet is open, for a screen that offers "Delete my
 * account" (the sheet's useDeleteAccountConfirm). One per screen.
 *  - open() does nothing while the sheet is open or while a delete is under
 *    way anywhere in the app;
 *  - closed() is the sheet's own onClose: the sheet calls it only after its
 *    flow agreed to close (never during a delete), so nothing else can drop
 *    the sheet while a delete runs and open a second one.
 */
export interface AccountDeleteOpener {
  isOpen: () => boolean;
  subscribe: (listener: () => void) => () => void;
  open: () => void;
  closed: () => void;
}

export function createAccountDeleteOpener(): AccountDeleteOpener {
  let isOpen = false;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    isOpen: () => isOpen,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open() {
      if (isOpen || accountDeleteInFlight()) return;
      isOpen = true;
      emit();
    },
    closed() {
      if (!isOpen) return;
      isOpen = false;
      emit();
    },
  };
}
