// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  finishRun,
  INTERRUPTED_RUN_PREFIX,
  INTERRUPTED_RUN_TTL_MS,
  leaveRunUnfinished,
  purgeInterruptedRuns,
  recordRun,
  sweepInterruptedRuns,
  takeInterruptedRun,
} from './interrupted-run';

/**
 * A flow that saves something and then keeps sending Server Actions (the New
 * procedure form's video batch, the Sage 50 wizard's chunks) holds what it has
 * done in memory. When the session ends partway through, the next action is
 * answered with a redirect, the browser loads sign-in, and that memory is
 * gone. The record below is what the page the person comes back to reads
 * instead. It is kept for an hour at most, and only while somebody can need
 * it: a deliberate end of the session removes every record in the tab, and
 * the app shell removes every record that is not the signed-in account's.
 */

const KIND = 'test-run';
const OTHER_KIND = 'other-run';
const ME = { userId: 'user-1', organizationId: 'org-1' };
const OTHER_USER = { userId: 'user-2', organizationId: 'org-1' };
const OTHER_ORG = { userId: 'user-1', organizationId: 'org-2' };
const KEY = `${INTERRUPTED_RUN_PREFIX}${KIND}`;
const MINUTE = 60_000;

function parseId(value: unknown): { id: string } | null {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? { id } : null;
}

/** A record as recordRun() writes it, for a run that ended in another page. */
function stored(account: { userId: string; organizationId: string }, at: number, id = 'p-1') {
  return JSON.stringify({ v: 1, ...account, at, payload: { id } });
}

/** The interrupted-run keys left in this tab. */
function recordKeysLeft(): string[] {
  return Object.keys(sessionStorage)
    .filter((k) => k.startsWith(INTERRUPTED_RUN_PREFIX))
    .sort();
}

/** A sessionStorage stand-in backed by a Map, whose calls a test can make fail. */
function mapStorage(refuseRemoving: (key: string) => boolean = () => false) {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      get length() {
        return map.size;
      },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => {
        if (refuseRemoving(k)) throw new DOMException('blocked', 'SecurityError');
        map.delete(k);
      },
      clear: () => map.clear(),
    },
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  // A run a test leaves going (or marked ended) in this page would change the
  // next test's outcome. Ending each kind clears both.
  finishRun(KIND);
  finishRun(OTHER_KIND);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('interrupted run record', () => {
  it('is handed once to the page the person comes back to when a redirect cut the run short', () => {
    recordRun(KIND, ME, { id: 'p-1' });
    leaveRunUnfinished(KIND);

    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('survives a page load: the next page finds it with no live run in it', async () => {
    recordRun(KIND, ME, { id: 'p-1' });

    // A reload, or the browser going to sign-in, starts every module afresh.
    vi.resetModules();
    const nextPage = await import('./interrupted-run');

    expect(nextPage.takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
  });

  it('is not handed out while the run is still going in this page, and is kept', () => {
    recordRun(KIND, ME, { id: 'p-1' });

    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
  });

  it('is removed when the run ends on the page', () => {
    recordRun(KIND, ME, { id: 'p-1' });
    finishRun(KIND);

    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
  });

  it('holds the latest step: each step rewrites it and restarts its hour', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    recordRun(KIND, ME, { id: 'p-1' });
    // A long batch: the next step comes almost an hour later.
    now.mockReturnValue(1_000_000 + INTERRUPTED_RUN_TTL_MS - 1);
    recordRun(KIND, ME, { id: 'p-2' });
    leaveRunUnfinished(KIND);
    now.mockReturnValue(1_000_000 + INTERRUPTED_RUN_TTL_MS + MINUTE);

    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-2' });
  });

  it('lasts an hour: handed out 59 minutes after the last step, and not 61 minutes after', () => {
    expect(INTERRUPTED_RUN_TTL_MS).toBe(60 * MINUTE);
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(1_000_000);
    recordRun(KIND, ME, { id: 'p-1' });
    leaveRunUnfinished(KIND);
    now.mockReturnValue(1_000_000 + 59 * MINUTE);
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });

    now.mockReturnValue(1_000_000);
    recordRun(KIND, ME, { id: 'p-2' });
    leaveRunUnfinished(KIND);
    now.mockReturnValue(1_000_000 + 61 * MINUTE);
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('is dropped, never shown, once it is more than an hour old', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    recordRun(KIND, ME, { id: 'p-1' });
    leaveRunUnfinished(KIND);
    now.mockReturnValue(1_000_000 + INTERRUPTED_RUN_TTL_MS + 1);

    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('is never handed to another account signed in on this tab, and is dropped', () => {
    for (const other of [OTHER_USER, OTHER_ORG]) {
      recordRun(KIND, ME, { id: 'p-1' });
      leaveRunUnfinished(KIND);

      expect(takeInterruptedRun(KIND, other, parseId)).toBeNull();
      // Dropped: the first account does not get it later either.
      expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    }
  });

  it('drops a record it cannot use: unreadable, another version, or a payload the page refuses', () => {
    const at = Date.now();
    const records = [
      '{not json',
      JSON.stringify({ v: 2, ...ME, at, payload: { id: 'p-1' } }),
      JSON.stringify({ v: 1, ...ME, at: 'yesterday', payload: { id: 'p-1' } }),
      JSON.stringify({ v: 1, ...ME, at, payload: { id: 42 } }),
      JSON.stringify(null),
    ];
    for (const raw of records) {
      sessionStorage.setItem(KEY, raw);

      expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
      expect(sessionStorage.getItem(KEY)).toBeNull();
    }
  });

  it('keeps each kind of run apart', () => {
    recordRun(KIND, ME, { id: 'p-1' });
    recordRun(OTHER_KIND, ME, { id: 'p-2' });
    leaveRunUnfinished(KIND);

    // The other run is still going here; this one was cut short.
    expect(takeInterruptedRun(OTHER_KIND, ME, parseId)).toBeNull();
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
  });

  it('never throws when the browser refuses storage, and hands nothing out', () => {
    const refusing = {
      length: 0,
      key: () => null,
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    vi.stubGlobal('sessionStorage', refusing);

    expect(() => recordRun(KIND, ME, { id: 'p-1' })).not.toThrow();
    expect(() => leaveRunUnfinished(KIND)).not.toThrow();
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(() => finishRun(KIND)).not.toThrow();
  });

  it('never throws when reading sessionStorage itself throws (site data blocked)', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      expect(() => recordRun(KIND, ME, { id: 'p-1' })).not.toThrow();
      expect(() => leaveRunUnfinished(KIND)).not.toThrow();
      expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
      expect(() => finishRun(KIND)).not.toThrow();
      expect(() => purgeInterruptedRuns()).not.toThrow();
      expect(() => sweepInterruptedRuns(ME)).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
      else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
    }
  });
});

describe('a deliberate end of the session in this tab (purgeInterruptedRuns)', () => {
  it('removes every record in this tab, of every kind and every account, and nothing else', () => {
    const at = Date.now();
    sessionStorage.setItem(KEY, stored(ME, at));
    sessionStorage.setItem(`${INTERRUPTED_RUN_PREFIX}${OTHER_KIND}`, stored(OTHER_USER, at));
    sessionStorage.setItem(`${INTERRUPTED_RUN_PREFIX}gone-kind`, '{not json');
    // Not the prefix's: another feature's keys, and a near miss.
    sessionStorage.setItem('sp:tour-state', 'kept');
    sessionStorage.setItem('sp:interrupted-run:v2:test-run', 'kept');
    sessionStorage.setItem('theme', 'dark');

    purgeInterruptedRuns();

    expect(recordKeysLeft()).toEqual([]);
    expect(Object.keys(sessionStorage).sort()).toEqual([
      'sp:interrupted-run:v2:test-run',
      'sp:tour-state',
      'theme',
    ]);
  });

  it('a run still going in this page writes nothing more, and leaves nothing for after signing in', () => {
    recordRun(KIND, ME, { id: 'p-1' });

    purgeInterruptedRuns();
    // The batch goes on for a moment (an upload finishing) and records its
    // next step before the action that the ended session refuses.
    expect(recordRun(KIND, ME, { id: 'p-2' })).toBe(false);
    leaveRunUnfinished(KIND);

    expect(recordKeysLeft()).toEqual([]);
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
  });

  it('once that run has ended, a new run of the same kind keeps its record again', () => {
    recordRun(KIND, ME, { id: 'p-1' });
    purgeInterruptedRuns();
    leaveRunUnfinished(KIND);

    expect(recordRun(KIND, ME, { id: 'p-3' })).toBe(true);
    leaveRunUnfinished(KIND);
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-3' });
  });

  it('a run that was not going is not held back by a purge', () => {
    recordRun(OTHER_KIND, ME, { id: 'p-1' });
    finishRun(OTHER_KIND);

    purgeInterruptedRuns();

    expect(recordRun(KIND, ME, { id: 'p-2' })).toBe(true);
    expect(recordRun(OTHER_KIND, ME, { id: 'p-3' })).toBe(true);
  });

  it('removes what the browser lets it when one removal is refused, and never throws', () => {
    const { map, storage } = mapStorage((key) => key === KEY);
    vi.stubGlobal('sessionStorage', storage);
    const at = Date.now();
    map.set(KEY, stored(ME, at));
    map.set(`${INTERRUPTED_RUN_PREFIX}${OTHER_KIND}`, stored(ME, at));
    map.set('theme', 'dark');

    expect(() => purgeInterruptedRuns()).not.toThrow();

    expect([...map.keys()].sort()).toEqual([KEY, 'theme']);
  });

  it('never throws when the browser refuses to list or read storage', () => {
    vi.stubGlobal('sessionStorage', {
      get length(): number {
        throw new DOMException('blocked', 'SecurityError');
      },
      key: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      removeItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });

    expect(() => purgeInterruptedRuns()).not.toThrow();
  });
});

describe('the signed-in app shell renders for an account (sweepInterruptedRuns)', () => {
  it("removes another user's, another organization's, an old and an unreadable record, and keeps the account's own", () => {
    const now = Date.now();
    const key = (kind: string) => `${INTERRUPTED_RUN_PREFIX}${kind}`;
    sessionStorage.setItem(KEY, stored(ME, now - 5 * MINUTE));
    sessionStorage.setItem(key('other-user'), stored(OTHER_USER, now));
    sessionStorage.setItem(key('other-org'), stored(OTHER_ORG, now));
    sessionStorage.setItem(key('old'), stored(ME, now - INTERRUPTED_RUN_TTL_MS - MINUTE));
    sessionStorage.setItem(key('not-json'), '{not json');
    sessionStorage.setItem(key('null'), 'null');
    sessionStorage.setItem(key('v2'), JSON.stringify({ v: 2, ...ME, at: now, payload: {} }));
    sessionStorage.setItem(key('no-time'), JSON.stringify({ v: 1, ...ME, at: 'today' }));
    sessionStorage.setItem('theme', 'dark');

    sweepInterruptedRuns(ME);

    expect(recordKeysLeft()).toEqual([KEY]);
    expect(sessionStorage.getItem('theme')).toBe('dark');
    // Nothing was handed out: the account's own record is still there for its
    // page, once.
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
  });

  it('keeps a record 59 minutes old and removes one 61 minutes old', () => {
    const now = 10_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    sessionStorage.setItem(KEY, stored(ME, now - 59 * MINUTE));
    sessionStorage.setItem(`${INTERRUPTED_RUN_PREFIX}${OTHER_KIND}`, stored(ME, now - 61 * MINUTE));

    sweepInterruptedRuns(ME);

    expect(recordKeysLeft()).toEqual([KEY]);
  });

  it('a run of another account still going in this page writes nothing more', () => {
    recordRun(KIND, ME, { id: 'p-1' });

    // Someone else signed in on this tab (in another tab of this browser), and
    // this tab's next page renders the shell for them.
    sweepInterruptedRuns(OTHER_USER);

    expect(recordKeysLeft()).toEqual([]);
    expect(recordRun(KIND, ME, { id: 'p-2' })).toBe(false);
    leaveRunUnfinished(KIND);
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
  });

  it('a run of this account still going in this page keeps its record and goes on', () => {
    recordRun(KIND, ME, { id: 'p-1' });

    sweepInterruptedRuns(ME);

    expect(recordKeysLeft()).toEqual([KEY]);
    expect(recordRun(KIND, ME, { id: 'p-2' })).toBe(true);
    leaveRunUnfinished(KIND);
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-2' });
  });

  it('never throws when the browser refuses storage, and removes what it is allowed to', () => {
    const { map, storage } = mapStorage((key) => key.endsWith('locked'));
    vi.stubGlobal('sessionStorage', storage);
    map.set(`${INTERRUPTED_RUN_PREFIX}locked`, stored(OTHER_USER, Date.now()));
    map.set(`${INTERRUPTED_RUN_PREFIX}free`, stored(OTHER_USER, Date.now()));

    expect(() => sweepInterruptedRuns(ME)).not.toThrow();

    expect([...map.keys()]).toEqual([`${INTERRUPTED_RUN_PREFIX}locked`]);
  });
});
