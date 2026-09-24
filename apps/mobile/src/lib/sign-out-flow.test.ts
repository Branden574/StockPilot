import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  endSession,
  runSignOutFlow,
  unsyncedPrompt,
  type SignOutFlowDeps,
  type UnsyncedChoice,
} from './sign-out-flow';

/**
 * The sign-out sequence (S4b, owner decision D5), executed with every effect
 * recorded in order. The React Native auth context cannot load in vitest; the
 * sequence lives in sign-out-flow.ts precisely so it can be run here.
 */

interface Harness {
  deps: SignOutFlowDeps;
  log: string[];
  state: {
    unsynced: number;
    afterDrain: number;
    online: boolean;
    globalError: unknown;
    localError: unknown;
    session: boolean;
    choice: UnsyncedChoice;
  };
}

function harness(overrides: Partial<Harness['state']> = {}): Harness {
  const log: string[] = [];
  const state: Harness['state'] = {
    unsynced: 0,
    afterDrain: 0,
    online: true,
    globalError: null,
    localError: null,
    session: true,
    choice: 'sign-out',
    ...overrides,
  };
  let drained = false;
  const deps: SignOutFlowDeps = {
    countUnsynced: vi.fn(async () => {
      log.push('count');
      return drained ? state.afterDrain : state.unsynced;
    }),
    isOnline: vi.fn(async () => state.online),
    drain: vi.fn(async () => {
      log.push('drain');
      drained = true;
    }),
    confirmUnsynced: vi.fn(async (count: number, opts: { canDiscard: boolean }) => {
      log.push(`confirm:${count}:${opts.canDiscard ? 'can-discard' : 'no-discard'}`);
      return state.choice;
    }),
    holdForAccount: vi.fn(async () => {
      log.push('hold');
    }),
    signOut: vi.fn(async (scope: 'global' | 'local') => {
      log.push(`signOut:${scope}`);
      const error = scope === 'global' ? state.globalError : state.localError;
      if (!error) state.session = false;
      return { error };
    }),
    hasSession: vi.fn(async () => state.session),
    discardUnsynced: vi.fn(async () => {
      log.push('discard');
    }),
    wipeCache: vi.fn(async () => {
      log.push('wipe');
    }),
  };
  return { deps, log, state };
}

const OFFLINE = Object.assign(new Error('Network request failed'), { name: 'AuthRetryableFetchError' });

describe('runSignOutFlow — honour the result of signOut', () => {
  it('a global sign-out error falls back to local; if the session survives NOTHING is wiped or discarded', async () => {
    // Offline: auth-js keeps the session for BOTH scopes (a local sign-out
    // POSTs /logout too). The old code wiped the outbox and cache anyway and
    // left the user signed in on an empty cache.
    const h = harness({ globalError: OFFLINE, localError: OFFLINE });
    expect(await runSignOutFlow(h.deps)).toBe('still-signed-in');
    expect(h.log).toEqual(['count', 'hold', 'signOut:global', 'signOut:local']);
    expect(h.deps.wipeCache).not.toHaveBeenCalled();
    expect(h.deps.discardUnsynced).not.toHaveBeenCalled();
  });

  it('a global-only failure is rescued by the local sign-out, then the cache is cleared', async () => {
    const h = harness({ globalError: new Error('500'), localError: null });
    expect(await runSignOutFlow(h.deps)).toBe('signed-out');
    expect(h.log).toEqual(['count', 'hold', 'signOut:global', 'signOut:local', 'wipe']);
  });

  it('the session is read back, not inferred: a "successful" call that left a session wipes nothing', async () => {
    const h = harness();
    h.deps.signOut = vi.fn(async () => ({ error: null })); // but state.session stays true
    expect(await runSignOutFlow(h.deps)).toBe('still-signed-in');
    expect(h.deps.wipeCache).not.toHaveBeenCalled();
  });

  it('an unreadable session after sign-out fails closed (nothing wiped)', async () => {
    const h = harness();
    h.deps.hasSession = vi.fn(async () => {
      throw new Error('keychain locked');
    });
    expect(await runSignOutFlow(h.deps)).toBe('still-signed-in');
    expect(h.deps.wipeCache).not.toHaveBeenCalled();
  });
});

describe('runSignOutFlow — unsynced work is never lost silently', () => {
  it('nothing unsynced: no drain, no question, straight to sign-out', async () => {
    const h = harness({ unsynced: 0 });
    expect(await runSignOutFlow(h.deps)).toBe('signed-out');
    expect(h.deps.drain).not.toHaveBeenCalled();
    expect(h.deps.confirmUnsynced).not.toHaveBeenCalled();
    expect(h.log).toEqual(['count', 'hold', 'signOut:global', 'wipe']);
  });

  it('online with unsynced work: it tries to send it first; if that empties the queue there is no question', async () => {
    const h = harness({ unsynced: 3, afterDrain: 0 });
    expect(await runSignOutFlow(h.deps)).toBe('signed-out');
    expect(h.log).toEqual(['count', 'drain', 'count', 'hold', 'signOut:global', 'wipe']);
  });

  it('work still unsynced after the drain and the person stays: no sign-out, no hold, no wipe', async () => {
    const h = harness({ unsynced: 3, afterDrain: 2, choice: 'stay' });
    expect(await runSignOutFlow(h.deps)).toBe('stayed');
    expect(h.log).toEqual(['count', 'drain', 'count', 'confirm:2:can-discard']);
    expect(h.deps.signOut).not.toHaveBeenCalled();
    expect(h.deps.wipeCache).not.toHaveBeenCalled();
  });

  it('"Sign out" keeps the work: it is held for this account, never discarded', async () => {
    const h = harness({ unsynced: 2, afterDrain: 2, choice: 'sign-out' });
    expect(await runSignOutFlow(h.deps)).toBe('signed-out');
    expect(h.log).toEqual(['count', 'drain', 'count', 'confirm:2:can-discard', 'hold', 'signOut:global', 'wipe']);
    expect(h.deps.discardUnsynced).not.toHaveBeenCalled();
  });

  it('"Sign out and discard" after a drain: discards only once the session is gone, then clears the cache', async () => {
    const h = harness({ unsynced: 2, afterDrain: 2, choice: 'discard' });
    expect(await runSignOutFlow(h.deps)).toBe('signed-out');
    expect(h.log).toEqual([
      'count',
      'drain',
      'count',
      'confirm:2:can-discard',
      'hold',
      'signOut:global',
      'discard',
      'wipe',
    ]);
  });

  it('discard chosen but the sign-out failed: the work is kept (the person is still signed in)', async () => {
    const h = harness({ unsynced: 2, afterDrain: 2, choice: 'discard', globalError: OFFLINE, localError: OFFLINE });
    expect(await runSignOutFlow(h.deps)).toBe('still-signed-in');
    expect(h.deps.discardUnsynced).not.toHaveBeenCalled();
  });

  it('offline: no drain, and Discard is NOT offered (it exists only after a real attempt to send)', async () => {
    const h = harness({ unsynced: 4, online: false, choice: 'discard' });
    await runSignOutFlow(h.deps);
    expect(h.deps.drain).not.toHaveBeenCalled();
    expect(h.log[1]).toBe('confirm:4:no-discard');
    // Even if a discard answer came back, it is not honoured without a drain.
    expect(h.deps.discardUnsynced).not.toHaveBeenCalled();
  });

  it('a drain that hangs is bounded: the question is still asked', async () => {
    const h = harness({ unsynced: 1 });
    h.deps.drain = vi.fn(() => new Promise<void>(() => undefined));
    h.state.choice = 'stay';
    expect(await runSignOutFlow(h.deps, { drainTimeoutMs: 20 })).toBe('stayed');
    expect(h.deps.confirmUnsynced).toHaveBeenCalledWith(1, { canDiscard: true });
  });

  it('this account’s legacy rows are held for it BEFORE the session goes', async () => {
    const h = harness();
    await runSignOutFlow(h.deps);
    expect(h.log.indexOf('hold')).toBeLessThan(h.log.indexOf('signOut:global'));
  });

  it('after an in-app account deletion: nothing to ask, the queued work is discarded after sign-out', async () => {
    const h = harness({ unsynced: 5 });
    expect(await runSignOutFlow(h.deps, { discardWithoutAsking: true })).toBe('signed-out');
    expect(h.deps.confirmUnsynced).not.toHaveBeenCalled();
    expect(h.log).toEqual(['hold', 'signOut:global', 'discard', 'wipe']);
  });
});

describe('endSession (also used by "Use password instead" / "Use a different account")', () => {
  it('local scope, offline: reports the session still exists', async () => {
    const h = harness({ localError: OFFLINE });
    expect(await endSession(h.deps, 'local')).toBe(false);
    expect(h.log).toEqual(['signOut:local']);
  });

  it('local scope, online: ended', async () => {
    const h = harness();
    expect(await endSession(h.deps, 'local')).toBe(true);
  });

  it('a throwing sign-out counts as an error, not a success', async () => {
    const h = harness();
    h.deps.signOut = vi.fn(async () => {
      throw new Error('boom');
    });
    expect(await endSession(h.deps, 'global')).toBe(false);
    expect(h.deps.signOut).toHaveBeenCalledTimes(2); // global, then local
  });
});

describe('unsyncedPrompt', () => {
  it('offers Discard only after a drain attempt', () => {
    expect(unsyncedPrompt(2, false).buttons.map((b) => b.choice)).toEqual(['stay', 'sign-out']);
    expect(unsyncedPrompt(2, true).buttons.map((b) => b.choice)).toEqual(['stay', 'sign-out', 'discard']);
    expect(unsyncedPrompt(2, true).buttons.at(-1)).toEqual({
      choice: 'discard',
      label: 'Sign out and discard',
      style: 'destructive',
    });
  });

  it('says how many, and that signing out keeps them', () => {
    expect(unsyncedPrompt(1, true).title).toBe('1 change has not synced');
    expect(unsyncedPrompt(3, false).title).toBe('3 changes have not synced');
    expect(unsyncedPrompt(3, false).message).toContain('stay on this device');
  });
});

describe('auth-context wiring', () => {
  const src = readFileSync(path.resolve(__dirname, './auth-context.tsx'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = (name: string) => code.slice(code.indexOf(`const ${name}: AuthState['${name}']`)).split('\n  };\n')[0] ?? '';

  it('signOut runs the sequence, with the outbox-keeping wipe as its cache wipe', () => {
    const body = fn('signOut');
    expect(body).toContain('runSignOutFlow(');
    expect(body).toContain('wipeCache: wipeForSignOut');
    expect(body).toContain('countUnsynced: () => totalPendingCount()');
    expect(body).toContain('await cycleCountSync.forceSync()');
    expect(body).not.toMatch(/await supabase\.auth\.signOut\(/);
  });

  it('signOutToFallback lifts the biometric lock / MFA gate only once the session is really gone', () => {
    const body = fn('signOutToFallback');
    const ended = body.indexOf('if (!ended)');
    const unlock = body.indexOf('setLocked(false)');
    expect(body).toContain("endSession(");
    expect(ended).toBeGreaterThan(-1);
    expect(unlock).toBeGreaterThan(ended);
    expect(body.slice(ended, unlock)).toContain('return false;');
  });

  it('the disabled screen clears its gate only after a sign-out that ended the session', () => {
    const screen = readFileSync(path.resolve(__dirname, '../components/account-disabled-screen.tsx'), 'utf8');
    const ended = screen.indexOf('const ended = await signOutToFallback();');
    expect(ended).toBeGreaterThan(-1);
    expect(screen.indexOf('setAccountDisabled(false);')).toBeGreaterThan(ended);
  });

  it('no button hands its press event to signOut as options', () => {
    for (const rel of ['../components/drawer-content.tsx', '../../app/(drawer)/settings.tsx']) {
      const screen = readFileSync(path.resolve(__dirname, rel), 'utf8');
      expect(screen, rel).not.toMatch(/onPress=\{signOut\}/);
      expect(screen, rel).toContain('onPress={() => void signOut()}');
    }
  });
});
