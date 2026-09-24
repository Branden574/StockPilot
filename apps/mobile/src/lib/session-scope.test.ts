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
  stored: { present: true, userId: 'u1' } as { present: boolean; userId: string | null } | Error,
  /** Replaces `stored` for the end-to-end block (a real GoTrueClient's storage). */
  read: null as null | (() => Promise<{ present: boolean; userId: string | null }>),
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

const saved = vi.hoisted(() => ({ orgId: 'org-a' as string | null }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => (key === 'workspace.activeOrgId' ? saved.orgId : null),
  },
}));

type Scope = typeof import('./session-scope');
let scope: Scope;
/** From the same (reset) module graph session-scope throws it from. */
let OwnerUnknown: typeof import('./outbox-scope').OutboxOwnerUnknownError;

beforeEach(async () => {
  auth.stored = { present: true, userId: 'u1' };
  auth.read = null;
  saved.orgId = 'org-a';
  vi.resetModules(); // a fresh "last seen" per test
  scope = await import('./session-scope');
  OwnerUnknown = (await import('./outbox-scope')).OutboxOwnerUnknownError;
});

describe('liveOutboxScope reads the STORED session, never a refreshing getSession()', () => {
  it('an operator offline past token expiry is still themselves: no owner lost, no 25 s wait', async () => {
    expect(await scope.liveOutboxScope()).toEqual({ orgId: 'org-a', userId: 'u1' });
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it('nobody signed in reads as nobody', async () => {
    auth.stored = { present: false, userId: null };
    expect(await scope.liveOutboxScope()).toEqual({ orgId: 'org-a', userId: null });
  });

  it('unreadable storage reads as nobody: every row is held, nothing is sent on a guess', async () => {
    auth.stored = new Error('keychain locked');
    expect((await scope.liveOutboxScope()).userId).toBeNull();
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
    expect((await scope.outboxWriteScope()).userId).toBe('u2');
  });

  it('with no account at all this run, refuses instead of queueing a row anyone would adopt', async () => {
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
        user: { id: 'u1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-24T00:00:00Z' },
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
    expect(await scope.liveOutboxScope()).toEqual({ orgId: 'org-a', userId: 'u1' });
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
    expect(auth).toMatch(/import \{ hasStoredSession, liveOutboxScope \} from '\.\/session-scope';/);
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
    const update = fnBody(code(read('./cycle-count-cache.ts')), 'export async function updateLocalLine(');
    expect(update).toContain('await outboxWriteScope()');
    expect(update).not.toContain('liveOutboxScope');
    // No "nobody" branch that could delete another account's held row.
    expect(update).not.toMatch(/\? is null/);
  });
});
