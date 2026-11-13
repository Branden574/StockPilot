import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { AuthRetryableFetchError, GoTrueClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authStorageKeyFor, readStoredAuthSession, type StoredAuthSession } from './auth-storage';
import { endSession } from './sign-out-flow';

/**
 * session-scope.ts: WHO the outbox and the sign-out read-back think is signed
 * in, EXECUTED with the real module.
 *
 * The S4 review found both high findings in code whose tests mocked this
 * module away: liveOutboxScope() and the sign-out read-back were
 * getSession() calls, and getSession() answers "no session" for an access
 * token it cannot refresh offline while auth-js keeps the session stored. Here
 * getSession() is wired to answer exactly that, so reading it (the old code)
 * fails these tests; the stored session is what must be read.
 */

const auth = vi.hoisted(() => ({
  /** What readDeviceAuthSession() answers, or throws. */
  stored: { present: true, userId: 'u1' } as
    | { present: boolean; userId: string | null; stepUpOwed?: boolean; level?: string | null }
    | Error,
  /** Replaces `stored` for the end-to-end block (a real GoTrueClient's storage). */
  read: null as
    | null
    | (() => Promise<{
        present: boolean;
        userId: string | null;
        stepUpOwed?: boolean;
        level?: string | null;
      }>),
  getSession: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('./supabase', async () => {
  const { vi: v } = await import('vitest');
  const { AuthRetryableFetchError: Retryable } = await import('@supabase/supabase-js');
  auth.getSession = v.fn(async () => ({
    data: { session: null },
    error: new Retryable('Network request failed', 0),
  }));
  return {
    supabase: { auth: { getSession: auth.getSession } },
    readDeviceAuthSession: v.fn(async () => {
      if (auth.read) return auth.read();
      if (auth.stored instanceof Error) throw auth.stored;
      return auth.stored;
    }),
  };
});

// The saved workspace and the account that saved it (workspace-keys.ts): u1's
// own, as this build saves it, unless a test says otherwise. ownerId null is
// an older build's record (its single workspace key, no owner).
const saved = vi.hoisted(() => ({
  orgId: 'org-a' as string | null,
  ownerId: 'u1' as string | null,
}));
vi.mock('@react-native-async-storage/async-storage', async () => {
  const { storedWorkspaceItem } = await import('./__fixtures__/saved-workspace');
  return { default: { getItem: async (key: string) => storedWorkspaceItem(key, saved) } };
});

type Scope = typeof import('./session-scope');
let scope: Scope;
/** From the same (reset) module graph session-scope throws it from. */
let OwnerUnknown: typeof import('./outbox-scope').OutboxOwnerUnknownError;
let WorkspaceLoading: typeof import('./outbox-scope').OutboxWorkspaceLoadingError;

beforeEach(async () => {
  auth.stored = { present: true, userId: 'u1' };
  auth.read = null;
  saved.orgId = 'org-a';
  saved.ownerId = 'u1';
  vi.resetModules(); // a fresh "last seen" per test
  scope = await import('./session-scope');
  OwnerUnknown = (await import('./outbox-scope')).OutboxOwnerUnknownError;
  WorkspaceLoading = (await import('./outbox-scope')).OutboxWorkspaceLoadingError;
});

describe('liveOutboxScope reads the STORED session, never a refreshing getSession()', () => {
  it('an operator offline past token expiry is still themselves: no owner lost, no 25 s wait', async () => {
    expect(await scope.liveOutboxScope()).toEqual({
      orgId: 'org-a',
      userId: 'u1',
      stepUpOwed: false,
    });
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it('nobody signed in reads as nobody', async () => {
    auth.stored = { present: false, userId: null };
    // Re-pinned by docket B10 (was `orgId: 'org-a'`, read from an older
    // build's record): u1's own workspace is nobody's with nobody signed in.
    expect(await scope.liveOutboxScope()).toEqual({
      orgId: null,
      userId: null,
      stepUpOwed: false,
    });
  });

  it('unreadable storage reads as nobody: every row is held, nothing is sent on a guess', async () => {
    auth.stored = new Error('keychain locked');
    expect((await scope.liveOutboxScope()).userId).toBeNull();
  });
});

/**
 * docket S43b: the live scope says whether the session still owes its
 * authenticator code, from the stored session (auth-storage.ts), and the
 * drains send nothing while it does (outbox-scope.ts 'step-up-owed').
 */
describe('liveOutboxScope says whether the session still owes its authenticator code', () => {
  it('the stored session owes it: the scope says so, and no row is sent under it', async () => {
    auth.stored = { present: true, userId: 'u1', stepUpOwed: true };
    const live = await scope.liveOutboxScope();
    expect(live).toEqual({ orgId: 'org-a', userId: 'u1', stepUpOwed: true });
    const { outboxSendDecision } = await import('./outbox-scope');
    expect(outboxSendDecision({ organizationId: 'org-a', userId: 'u1' }, live)).toEqual({
      send: false,
      reason: 'step-up-owed',
    });
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it('the code was entered: the same row goes', async () => {
    auth.stored = { present: true, userId: 'u1', stepUpOwed: false };
    const live = await scope.liveOutboxScope();
    expect(live.stepUpOwed).toBe(false);
    const { outboxSendDecision } = await import('./outbox-scope');
    expect(outboxSendDecision({ organizationId: 'org-a', userId: 'u1' }, live).send).toBe(true);
  });

  it('unreadable storage owes it: held twice over (nobody, and a code not known to be entered)', async () => {
    auth.stored = new Error('keychain locked');
    expect(await scope.liveOutboxScope()).toEqual({ orgId: null, userId: null, stepUpOwed: true });
  });

  it("the server's word for this account holds the drains too, while the stored copy is behind", async () => {
    // mfa-reconcile.ts: the server listed a verified factor for u1 and the
    // session could not be refreshed, so the stored copy still shows none.
    const reconcile = await import('./mfa-reconcile');
    reconcile.setStepUpForcedFor('u1');
    expect((await scope.liveOutboxScope()).stepUpOwed).toBe(true);
    // Settled (a refresh, the code, a sign-out): the hold goes with the note.
    reconcile.setStepUpForcedFor(null);
    expect((await scope.liveOutboxScope()).stepUpOwed).toBe(false);
  });

  it('a note about another account says nothing about this session', async () => {
    const reconcile = await import('./mfa-reconcile');
    reconcile.setStepUpForcedFor('u9');
    expect((await scope.liveOutboxScope()).stepUpOwed).toBe(false);
    auth.stored = { present: false, userId: null };
    expect((await scope.liveOutboxScope()).stepUpOwed).toBe(false);
  });

  it('the note holds a stored session below aal2, and one whose level cannot be read', async () => {
    const reconcile = await import('./mfa-reconcile');
    reconcile.setStepUpForcedFor('u1');
    auth.stored = { present: true, userId: 'u1', stepUpOwed: false, level: 'aal1' };
    expect((await scope.liveOutboxScope()).stepUpOwed).toBe(true);
    auth.stored = { present: true, userId: 'u1', stepUpOwed: false, level: null };
    expect((await scope.liveOutboxScope()).stepUpOwed).toBe(true);
    auth.stored = { present: true, userId: 'u1', stepUpOwed: false };
    expect((await scope.liveOutboxScope()).stepUpOwed).toBe(true);
  });

  it('the note never holds a stored session at aal2: the code was entered, the rows go', async () => {
    const reconcile = await import('./mfa-reconcile');
    reconcile.setStepUpForcedFor('u1');
    auth.stored = { present: true, userId: 'u1', stepUpOwed: false, level: 'aal2' };
    const live = await scope.liveOutboxScope();
    expect(live).toEqual({ orgId: 'org-a', userId: 'u1', stepUpOwed: false });
    const { outboxSendDecision } = await import('./outbox-scope');
    expect(outboxSendDecision({ organizationId: 'org-a', userId: 'u1' }, live).send).toBe(true);
  });
});

/**
 * docket S43b: THE GATE AND THE OUTBOX HOLD ARE ONE ANSWER. The code screen
 * (mfa-level.ts codeGateUp, on the session) and the hold of the pull and both
 * drains (liveOutboxScope, on the stored session) read the server-backed note
 * by the same rule, so neither can be up while the other is down. Run through
 * the real reconciler, the real gate and the real scope, for every state of
 * the note and both levels, and for a reconcile whose refresh ends after the
 * code was entered.
 */
describe('the code screen and the outbox hold agree, whatever the note says', () => {
  function jwt(claims: Record<string, unknown>): string {
    return [{ alg: 'HS256', typ: 'JWT' }, claims, 'signature']
      .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
      .join('.');
  }
  const TOTP = { id: 'factor-totp', factor_type: 'totp', status: 'verified' };
  type Held = { access_token: string; user: { id: string; factors?: (typeof TOTP)[] } };
  const held = (aal: string, factors?: (typeof TOTP)[]): Held => ({
    access_token: jwt({ sub: 'u1', aal }),
    user: { id: 'u1', ...(factors ? { factors } : {}) },
  });
  /** The stored entry, read by the real reader, for the session auth-js holds. */
  function store(session: Held) {
    const raw = JSON.stringify({ ...session, refresh_token: 'r', expires_at: 1 });
    auth.read = () => readStoredAuthSession({ head: async () => raw, full: async () => raw }, 'k');
  }

  it('for every note and level, the gate is up exactly when the scope holds', async () => {
    const level = await import('./mfa-level');
    const reconcile = await import('./mfa-reconcile');
    const seen: string[] = [];
    for (const note of [null, 'u1', 'u9']) {
      for (const session of [held('aal1'), held('aal1', [TOTP]), held('aal2'), held('aal2', [TOTP])]) {
        reconcile.setStepUpForcedFor(note);
        store(session);
        const gate = level.codeGateUp(session, reconcile.stepUpForcedFor());
        const hold = (await scope.liveOutboxScope()).stepUpOwed;
        expect(hold, `note ${note}, ${level.tokenAal(session.access_token)}`).toBe(gate);
        seen.push(`${note}:${level.tokenAal(session.access_token)}:${session.user.factors ? 'factor' : 'none'}:${gate}`);
      }
    }
    // Up for a factor below aal2 and for this account's note below aal2; never at aal2.
    expect(seen).toEqual([
      'null:aal1:none:false',
      'null:aal1:factor:true',
      'null:aal2:none:false',
      'null:aal2:factor:false',
      'u1:aal1:none:true',
      'u1:aal1:factor:true',
      'u1:aal2:none:false',
      'u1:aal2:factor:false',
      'u9:aal1:none:false',
      'u9:aal1:factor:true',
      'u9:aal2:none:false',
      'u9:aal2:factor:false',
    ]);
  });

  it('a reconcile whose refresh ends after the code was entered leaves no note and no hold', async () => {
    const level = await import('./mfa-level');
    const reconcile = await import('./mfa-reconcile');
    const { outboxSendDecision } = await import('./outbox-scope');

    // The phone's copy lists no factor at aal1; the server lists one.
    let current = held('aal1');
    store(current);
    let failRefresh!: () => void;
    const refreshPending = new Promise<null>((resolve) => {
      failRefresh = () => resolve(null);
    });
    const run = reconcile.createStepUpReconciler({
      currentSession: async () => current,
      refreshSession: () => refreshPending,
    });

    // The run reads the aal1 session and waits on its refresh.
    const running = run({ id: 'u1', factors: [TOTP] });
    await Promise.resolve();
    await Promise.resolve();

    // Meanwhile the code is entered: the aal2 session is stored, and the
    // provider clears the note (auth-context.tsx, MFA_CHALLENGE_VERIFIED).
    current = held('aal2', [TOTP]);
    store(current);
    reconcile.setStepUpForcedFor(null);

    // The refresh the run waited on fails, or passes its bound.
    failRefresh();
    expect(await running).toBe('none');
    expect(reconcile.stepUpForcedFor()).toBeNull();

    // No code screen, and the pull and both drains go.
    expect(level.codeGateUp(current, reconcile.stepUpForcedFor())).toBe(false);
    const live = await scope.liveOutboxScope();
    expect(live.stepUpOwed).toBe(false);
    expect(outboxSendDecision({ organizationId: 'org-a', userId: 'u1' }, live).send).toBe(true);
  });

  it('a note already on a session at aal2 holds nothing, and the next reconcile withdraws it', async () => {
    const level = await import('./mfa-level');
    const reconcile = await import('./mfa-reconcile');
    const current = held('aal2', [TOTP]);
    store(current);
    reconcile.setStepUpForcedFor('u1');

    expect(level.codeGateUp(current, reconcile.stepUpForcedFor())).toBe(false);
    expect((await scope.liveOutboxScope()).stepUpOwed).toBe(false);

    const run = reconcile.createStepUpReconciler({
      currentSession: async () => current,
      refreshSession: async () => null,
    });
    expect(await run({ id: 'u1', factors: [TOTP] })).toBe('none');
    expect(reconcile.stepUpForcedFor()).toBeNull();
  });
});

describe('outboxWriteScope never names NULL as the owner', () => {
  it('stamps the stored account', async () => {
    expect(await scope.outboxWriteScope()).toEqual({ orgId: 'org-a', userId: 'u1' });
  });

  it('just after the session ended (the count screen saving on unmount), stamps the account that was signed in', async () => {
    await scope.liveOutboxScope(); // u1 seen this run (the screen read its counters)
    auth.stored = { present: false, userId: null }; // revoked: auth-js removed it
    expect(await scope.outboxWriteScope()).toEqual({ orgId: 'org-a', userId: 'u1' });
  });

  it('while the stored entry is mid-rewrite or unreadable, stamps the account last seen', async () => {
    await scope.liveOutboxScope();
    auth.stored = { present: true, userId: null };
    expect((await scope.outboxWriteScope()).userId).toBe('u1');
    auth.stored = new Error('keychain locked');
    expect((await scope.outboxWriteScope()).userId).toBe('u1');
  });

  it('a new account signing in is stamped as itself at once', async () => {
    await scope.liveOutboxScope();
    auth.stored = { present: true, userId: 'u2' };
    saved.ownerId = 'u2'; // its workspace load has saved its own choice
    expect((await scope.outboxWriteScope()).userId).toBe('u2');
  });

  it('with no account at all this run, refuses instead of queueing a row anyone would adopt', async () => {
    auth.stored = { present: false, userId: null };
    await expect(scope.outboxWriteScope()).rejects.toBeInstanceOf(OwnerUnknown);
  });
});

/**
 * A queued row's workspace is the one the account it is stamped for saved
 * (docket B10). That account is the only one whose session may send the row
 * (api() asUserId), so the row's workspace and the token it goes out with are
 * one account's. While the saved workspace is ANOTHER account's (the moment
 * after a different account signs in, before its workspace load saves its own
 * choice, or longer if that load fails offline), a new row is refused with a
 * sentence to try again (integrator decision 2): stamped with no workspace it
 * would be sent under whichever one is saved when it is sent, after a switch
 * the wrong one (the S4a defect); main stamped the other account's, which the
 * server refused, and the write was lost.
 */
describe("the outbox stamps only the stamped account's own saved workspace", () => {
  it('the stored account saved it: stamped with it', async () => {
    saved.ownerId = 'u1';
    expect(await scope.liveOutboxScope()).toEqual({
      orgId: 'org-a',
      userId: 'u1',
      stepUpOwed: false,
    });
    expect(await scope.outboxWriteScope()).toEqual({ orgId: 'org-a', userId: 'u1' });
  });

  it('another account saved it: the readers see no workspace, and a new row is refused to try again', async () => {
    saved.ownerId = 'u0';
    expect(await scope.liveOutboxScope()).toEqual({
      orgId: null,
      userId: 'u1',
      stepUpOwed: false,
    });
    const refusal = await scope.outboxWriteScope().catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(WorkspaceLoading);
    expect((refusal as Error).message).toBe(
      'Your workspace is still loading. Try again in a moment.',
    );
  });

  it("just after the session ended, the account last seen gets its own workspace, and another's is refused", async () => {
    saved.ownerId = 'u1';
    await scope.liveOutboxScope(); // u1 seen this run
    auth.stored = { present: false, userId: null };
    expect(await scope.outboxWriteScope()).toEqual({ orgId: 'org-a', userId: 'u1' });
    saved.ownerId = 'u0';
    await expect(scope.outboxWriteScope()).rejects.toBeInstanceOf(WorkspaceLoading);
  });

  it('nothing saved (a fresh install before its first workspace load): stamped with no workspace, as on main', async () => {
    saved.orgId = null;
    expect(await scope.outboxWriteScope()).toEqual({ orgId: null, userId: 'u1' });
    // ...and such a row waits for this account's own workspace before it is
    // sent (outbox-scope.ts 'workspace-loading'): the readers see none yet.
    expect(await scope.liveOutboxScope()).toEqual({
      orgId: null,
      userId: 'u1',
      stepUpOwed: false,
    });
  });

  /**
   * Integrator decision 3. An older build saved the workspace with no owner,
   * and every account trusted it: a row stamped with it may carry another
   * account's choice (left by a fallback sign-out on that build). A new row is
   * refused instead, with the same retryable sentence, until this account's
   * next workspace load records the owner; and a row with no workspace of its
   * own is not sent under it (the readers see none). Requests still name it
   * (api.org-header.test.ts): the server checks membership on each one.
   */
  it('a workspace saved by an older build (no owner): a new row is refused to try again, and the readers see none', async () => {
    saved.ownerId = null;
    const refusal = await scope.outboxWriteScope().catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(WorkspaceLoading);
    expect((refusal as Error).message).toBe(
      'Your workspace is still loading. Try again in a moment.',
    );
    expect(await scope.liveOutboxScope()).toEqual({
      orgId: null,
      userId: 'u1',
      stepUpOwed: false,
    });
  });

  it('once the workspace load records this account as its owner, the same write is stamped with it', async () => {
    saved.ownerId = null;
    await expect(scope.outboxWriteScope()).rejects.toBeInstanceOf(WorkspaceLoading);
    saved.ownerId = 'u1';
    expect(await scope.outboxWriteScope()).toEqual({ orgId: 'org-a', userId: 'u1' });
    expect(await scope.liveOutboxScope()).toEqual({
      orgId: 'org-a',
      userId: 'u1',
      stepUpOwed: false,
    });
  });

  it('with no account at all, the owner refusal comes first', async () => {
    saved.ownerId = 'u0';
    auth.stored = { present: false, userId: null };
    await expect(scope.outboxWriteScope()).rejects.toBeInstanceOf(OwnerUnknown);
  });
});

describe('hasStoredSession: the sign-out read-back fails closed', () => {
  it('a session still stored is a session, even when getSession() says none', async () => {
    expect(await scope.hasStoredSession()).toBe(true);
    auth.stored = { present: true, userId: null }; // present, owner unreadable right now
    expect(await scope.hasStoredSession()).toBe(true);
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it('no stored session: ended', async () => {
    auth.stored = { present: false, userId: null };
    expect(await scope.hasStoredSession()).toBe(false);
  });

  it('endSession: offline failure with the session stored = NOT ended (the lock stays, nothing is wiped)', async () => {
    const ended = await endSession(
      {
        signOut: async () => ({ error: new AuthRetryableFetchError('Network request failed', 0) }),
        hasSession: scope.hasStoredSession,
      },
      'local',
    );
    expect(ended).toBe(false);
  });

  it('endSession: storage unreadable = NOT ended', async () => {
    auth.stored = new Error('keychain locked');
    const ended = await endSession(
      { signOut: async () => ({ error: null }), hasSession: scope.hasStoredSession },
      'local',
    );
    expect(ended).toBe(false);
  });

  it('endSession: the session removed = ended', async () => {
    const ended = await endSession(
      {
        signOut: async () => {
          auth.stored = { present: false, userId: null };
          return { error: null };
        },
        hasSession: scope.hasStoredSession,
      },
      'global',
    );
    expect(ended).toBe(true);
  });
});

describe('end to end with the real auth-js client (offline, access token expired)', () => {
  const store = new Map<string, string>();
  const KEY = authStorageKeyFor('https://abcdefghijklmnopqrst.supabase.co');
  const memory = {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: async (k: string) => {
      store.delete(k);
    },
  };
  let client: GoTrueClient;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.clear();
    const now = Math.floor(Date.now() / 1000);
    store.set(
      KEY,
      JSON.stringify({
        access_token: 'x.y.z',
        refresh_token: 'r',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: now - 30,
        user: {
          id: 'u1',
          aud: 'authenticated',
          app_metadata: {},
          user_metadata: {},
          created_at: '2026-09-24T00:00:00Z',
        },
      }),
    );
    client = new GoTrueClient({
      url: 'http://127.0.0.1:9',
      storage: memory,
      storageKey: KEY,
      autoRefreshToken: false,
      persistSession: true,
      detectSessionInUrl: false,
      fetch: async () => {
        throw new TypeError('Network request failed');
      },
    });
    const init = client.initialize();
    await vi.advanceTimersByTimeAsync(60_000);
    await init;
    auth.read = (): Promise<StoredAuthSession> =>
      readStoredAuthSession({ head: memory.getItem, full: memory.getItem }, KEY);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('"Use password instead" cannot unlock: the sign-out fails and the read-back sees the session', async () => {
    const run = endSession(
      { signOut: (s) => client.signOut({ scope: s }), hasSession: scope.hasStoredSession },
      'local',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await run).toBe(false);
  });

  it('the outbox still knows whose work this is, at once', async () => {
    expect(await scope.liveOutboxScope()).toEqual({
      orgId: 'org-a',
      userId: 'u1',
      stepUpOwed: false,
    });
    expect((await scope.outboxWriteScope()).userId).toBe('u1');
  });
});

describe('wiring: every owner and session-presence read goes through the stored session', () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fnBody = (src: string, decl: string) => {
    const start = src.indexOf(decl);
    expect(start, decl).toBeGreaterThan(-1);
    return src.slice(start).split('\n}\n')[0] ?? '';
  };

  it('session-scope.ts never asks the refreshing getSession()', () => {
    expect(code(read('./session-scope.ts'))).not.toContain('getSession');
  });

  it('both sign-out flows read the session back with hasStoredSession, and no getSession-based check remains', () => {
    const auth = code(read('./auth-context.tsx'));
    expect(auth.match(/hasSession: hasStoredSession,/g)).toHaveLength(2);
    expect(auth).not.toMatch(/function hasSession\(/);
    expect(auth).toMatch(
      /import \{ hasStoredSession, liveOutboxScope \} from '\.\/session-scope';/,
    );
  });

  it('the client persists under the key the reader reads, with the user in that one entry', () => {
    const client = code(read('./supabase.ts'));
    expect(client).toContain('const AUTH_STORAGE_KEY = authStorageKeyFor(url);');
    expect(client).toContain('storageKey: AUTH_STORAGE_KEY,');
    expect(fnBody(client, 'export function readDeviceAuthSession(')).toContain('AUTH_STORAGE_KEY');
    // A separate userStorage would move `user` out of the entry the reader parses.
    expect(client).not.toContain('userStorage');
  });

  it('both outbox writers stamp through outboxWriteScope (never a nullable read)', () => {
    const enqueue = fnBody(code(read('./queue.ts')), 'export async function enqueue(');
    expect(enqueue).toContain('await outboxWriteScope()');
    expect(enqueue).not.toContain('liveOutboxScope');
    // The count outbox's one writer (a count or a clear of it, B4a), and
    // both of its callers going through it.
    const cache = code(read('./cycle-count-cache.ts'));
    const write = fnBody(cache, 'async function queueLineEdit(');
    expect(write).toContain('await outboxWriteScope()');
    expect(write).not.toContain('liveOutboxScope');
    // No "nobody" branch that could delete another account's held row.
    expect(write).not.toMatch(/\? is null/);
    expect(fnBody(cache, 'export async function updateLocalLine(')).toContain(
      "return queueLineEdit(lineId, { kind: 'count', counted });",
    );
    expect(fnBody(cache, 'export async function clearLocalLine(')).toContain(
      "return queueLineEdit(lineId, { kind: 'clear' });",
    );
    // Nothing else in the cache writes an outbox row.
    expect(cache.match(/insert into pending_actions/g)).toHaveLength(1);
  });
});
