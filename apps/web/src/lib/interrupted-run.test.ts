// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginRun,
  expireInterruptedRuns,
  finishRun,
  INTERRUPTED_RUN_PREFIX,
  INTERRUPTED_RUN_TTL_MS,
  leaveRunUnfinished,
  purgeInterruptedRuns,
  recordRun,
  type RunAccount,
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
 * it: a deliberate end of the session removes every record in the tab, the app
 * shell removes every record that is not the signed-in account's, and a record
 * over an hour old goes on any page of the app.
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

/** A run that has recorded this step and is still going in this page. */
function going(kind: string, account: RunAccount, id: string) {
  const run = beginRun(kind, account);
  recordRun(run, { id });
  return run;
}

/** A run that a redirect cut short in this page, after recording this step. */
function cutShort(kind: string, account: RunAccount, id: string) {
  leaveRunUnfinished(going(kind, account, id));
}

/** A record as recordRun() writes it, for a run that ended in another page. */
function stored(account: RunAccount, at: number, id = 'p-1') {
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

/** A sessionStorage stand-in that refuses every call. */
function refusingStorage() {
  const refuse = (): never => {
    throw new DOMException('blocked', 'SecurityError');
  };
  return {
    get length(): number {
      return refuse();
    },
    key: refuse,
    getItem: refuse,
    setItem: refuse,
    removeItem: refuse,
    clear: refuse,
  };
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // A run a test leaves going in this page, or a timer it leaves armed, would
  // change the next test's outcome: the purge ends every run and the timer.
  purgeInterruptedRuns();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('interrupted run record', () => {
  it('is handed once to the page the person comes back to when a redirect cut the run short', () => {
    cutShort(KIND, ME, 'p-1');

    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('survives a page load: the next page finds it with no run going in it', async () => {
    going(KIND, ME, 'p-1');

    // A reload, or the browser going to sign-in, starts every module afresh.
    vi.resetModules();
    const nextPage = await import('./interrupted-run');

    expect(nextPage.takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
  });

  it('is not handed out while the run is still going in this page, and is kept', () => {
    going(KIND, ME, 'p-1');

    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
  });

  it('nor while a run of its kind has begun and not yet recorded anything', () => {
    sessionStorage.setItem(KEY, stored(ME, Date.now()));
    beginRun(KIND, ME);

    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
  });

  it('is removed when the run ends on the page', () => {
    finishRun(going(KIND, ME, 'p-1'));

    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
  });

  it('holds the latest step: each step rewrites it and restarts its hour', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    const run = going(KIND, ME, 'p-1');
    // A long batch: the next step comes almost an hour later.
    now.mockReturnValue(1_000_000 + INTERRUPTED_RUN_TTL_MS - 1);
    recordRun(run, { id: 'p-2' });
    leaveRunUnfinished(run);
    now.mockReturnValue(1_000_000 + INTERRUPTED_RUN_TTL_MS + MINUTE);

    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-2' });
  });

  it('lasts an hour: handed out 59 minutes after the last step, and not 61 minutes after', () => {
    expect(INTERRUPTED_RUN_TTL_MS).toBe(60 * MINUTE);
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(1_000_000);
    cutShort(KIND, ME, 'p-1');
    now.mockReturnValue(1_000_000 + 59 * MINUTE);
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });

    now.mockReturnValue(1_000_000);
    cutShort(KIND, ME, 'p-2');
    now.mockReturnValue(1_000_000 + 61 * MINUTE);
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('is dropped, never shown, once it is more than an hour old', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    cutShort(KIND, ME, 'p-1');
    now.mockReturnValue(1_000_000 + INTERRUPTED_RUN_TTL_MS + 1);

    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('is never handed to another account signed in on this tab, and is dropped', () => {
    for (const other of [OTHER_USER, OTHER_ORG]) {
      cutShort(KIND, ME, 'p-1');

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
    going(OTHER_KIND, ME, 'p-2');
    cutShort(KIND, ME, 'p-1');

    // The other run is still going here; this one was cut short.
    expect(takeInterruptedRun(OTHER_KIND, ME, parseId)).toBeNull();
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
  });

  it('a run that ends on the page removes only the record it wrote, not one a later run of its kind wrote since', () => {
    // The New procedure form opened again while the first batch runs on, and
    // a second batch started there.
    const first = going(KIND, ME, 'p-1');
    const second = going(KIND, ME, 'p-2');

    finishRun(first);
    expect(sessionStorage.getItem(KEY)).not.toBeNull();

    // The second is cut short: its record is what the next page finds.
    leaveRunUnfinished(second);
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-2' });
  });

  it('a run that ends having recorded nothing leaves the record stored before it', () => {
    sessionStorage.setItem(KEY, stored(ME, Date.now()));
    finishRun(beginRun(KIND, ME));

    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
  });

  it('never throws when the browser refuses storage, and hands nothing out', () => {
    vi.stubGlobal('sessionStorage', refusingStorage());

    const run = beginRun(KIND, ME);
    expect(recordRun(run, { id: 'p-1' })).toBe(false);
    expect(() => leaveRunUnfinished(run)).not.toThrow();
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
    expect(() => finishRun(beginRun(KIND, ME))).not.toThrow();
    expect(() => purgeInterruptedRuns()).not.toThrow();
    expect(() => sweepInterruptedRuns(ME)).not.toThrow();
    expect(() => expireInterruptedRuns()).not.toThrow();
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
      const run = beginRun(KIND, ME);
      expect(recordRun(run, { id: 'p-1' })).toBe(false);
      expect(() => leaveRunUnfinished(run)).not.toThrow();
      expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
      expect(() => finishRun(beginRun(KIND, ME))).not.toThrow();
      expect(() => purgeInterruptedRuns()).not.toThrow();
      expect(() => sweepInterruptedRuns(ME)).not.toThrow();
      expect(() => expireInterruptedRuns()).not.toThrow();
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
    const run = going(KIND, ME, 'p-1');

    purgeInterruptedRuns();
    // The batch goes on for a moment (an upload finishing) and records its
    // next step before the action that the ended session refuses.
    expect(recordRun(run, { id: 'p-2' })).toBe(false);
    leaveRunUnfinished(run);

    expect(recordKeysLeft()).toEqual([]);
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
  });

  it('a run whose first save is still on its way writes nothing either', () => {
    // beginRun goes before the first save; the person signs out while it is
    // on its way; the save lands and the run would record it.
    const run = beginRun(KIND, ME);

    purgeInterruptedRuns();
    expect(recordRun(run, { id: 'p-1' })).toBe(false);
    leaveRunUnfinished(run);

    expect(recordKeysLeft()).toEqual([]);
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
  });

  it('a run that begins after it keeps its record again', () => {
    const before = going(KIND, ME, 'p-1');
    purgeInterruptedRuns();
    leaveRunUnfinished(before);

    const after = beginRun(KIND, ME);
    expect(recordRun(after, { id: 'p-3' })).toBe(true);
    leaveRunUnfinished(after);
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-3' });
  });

  it('a stopped run that ends later leaves a newer run of its kind alone', () => {
    const stopped = going(KIND, ME, 'p-1');
    purgeInterruptedRuns();
    const newer = going(KIND, ME, 'p-2');

    finishRun(stopped);

    expect(sessionStorage.getItem(KEY)).not.toBeNull();
    leaveRunUnfinished(newer);
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-2' });
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
    vi.stubGlobal('sessionStorage', refusingStorage());

    expect(() => purgeInterruptedRuns()).not.toThrow();
  });

  it('leaves no timer behind: nothing is left to remove at its hour', () => {
    vi.useFakeTimers();
    going(KIND, ME, 'p-1');
    expect(vi.getTimerCount()).toBe(1);

    purgeInterruptedRuns();

    expect(vi.getTimerCount()).toBe(0);
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
    const run = going(KIND, ME, 'p-1');

    // Someone else signed in on this tab (in another tab of this browser), and
    // this tab's next page renders the shell for them.
    sweepInterruptedRuns(OTHER_USER);

    expect(recordKeysLeft()).toEqual([]);
    expect(recordRun(run, { id: 'p-2' })).toBe(false);
    leaveRunUnfinished(run);
    expect(takeInterruptedRun(KIND, ME, parseId)).toBeNull();
  });

  it('a run of another account whose first save is still on its way writes nothing either', () => {
    for (const other of [OTHER_USER, OTHER_ORG]) {
      const run = beginRun(KIND, ME);

      sweepInterruptedRuns(other);

      expect(recordRun(run, { id: 'p-1' })).toBe(false);
      leaveRunUnfinished(run);
      expect(recordKeysLeft()).toEqual([]);
    }
  });

  it('a run of this account keeps its record and goes on, whether or not it has recorded yet', () => {
    const recorded = going(KIND, ME, 'p-1');
    const firstSaveOnItsWay = beginRun(OTHER_KIND, ME);

    sweepInterruptedRuns(ME);

    expect(recordKeysLeft()).toEqual([KEY]);
    expect(recordRun(recorded, { id: 'p-2' })).toBe(true);
    expect(recordRun(firstSaveOnItsWay, { id: 'p-3' })).toBe(true);
    leaveRunUnfinished(recorded);
    leaveRunUnfinished(firstSaveOnItsWay);
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-2' });
    expect(takeInterruptedRun(OTHER_KIND, ME, parseId)).toEqual({ id: 'p-3' });
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

describe('a record over an hour old goes on any page (expireInterruptedRuns, and its timer)', () => {
  it('as a page loads: removes every record over an hour old or unreadable, whoever its account, and hands nothing out', () => {
    const now = 10_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const key = (kind: string) => `${INTERRUPTED_RUN_PREFIX}${kind}`;
    sessionStorage.setItem(KEY, stored(ME, now - 59 * MINUTE));
    sessionStorage.setItem(key('other-user-fresh'), stored(OTHER_USER, now - 10 * MINUTE));
    sessionStorage.setItem(key('mine-old'), stored(ME, now - 61 * MINUTE));
    sessionStorage.setItem(key('other-org-old'), stored(OTHER_ORG, now - 120 * MINUTE));
    sessionStorage.setItem(key('not-json'), '{not json');
    sessionStorage.setItem(key('v2'), JSON.stringify({ v: 2, ...ME, at: now, payload: {} }));
    sessionStorage.setItem('theme', 'dark');

    expireInterruptedRuns();

    // The sign-in page knows no account: a fresh record stays for whichever
    // account's page takes it.
    expect(recordKeysLeft()).toEqual([key('other-user-fresh'), KEY]);
    expect(sessionStorage.getItem('theme')).toBe('dark');
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-1' });
  });

  it('a record a run left in a page that stays open goes at its hour, with no page load', () => {
    // The redirect to sign-in is a navigation inside the app: the page the
    // run was cut short in stays loaded, and the tab sits on sign-in.
    vi.useFakeTimers({ now: 1_000_000 });
    cutShort(KIND, ME, 'p-1');

    vi.advanceTimersByTime(59 * MINUTE);
    expect(sessionStorage.getItem(KEY)).not.toBeNull();

    vi.advanceTimersByTime(2 * MINUTE);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('a record found as the page loads goes at its hour while the page stays open', () => {
    vi.useFakeTimers({ now: 10_000_000 });
    sessionStorage.setItem(KEY, stored(OTHER_USER, 10_000_000 - 30 * MINUTE));

    expireInterruptedRuns();
    vi.advanceTimersByTime(29 * MINUTE);
    expect(sessionStorage.getItem(KEY)).not.toBeNull();

    vi.advanceTimersByTime(2 * MINUTE);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('each step of a run still going restarts its hour, so the timer never removes a fresh record', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const run = going(KIND, ME, 'p-1');
    vi.advanceTimersByTime(50 * MINUTE);
    recordRun(run, { id: 'p-2' });

    // The first step's hour passes: the record holds the second step's.
    vi.advanceTimersByTime(11 * MINUTE);
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
    leaveRunUnfinished(run);
    vi.advanceTimersByTime(48 * MINUTE);
    expect(takeInterruptedRun(KIND, ME, parseId)).toEqual({ id: 'p-2' });

    // And the second step's hour removes it in turn.
    const later = going(KIND, ME, 'p-3');
    leaveRunUnfinished(later);
    vi.advanceTimersByTime(61 * MINUTE);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('never throws when the browser refuses storage, from its timer or from a page load', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    cutShort(KIND, ME, 'p-1');
    expect(vi.getTimerCount()).toBe(1);
    vi.stubGlobal('sessionStorage', refusingStorage());

    // The timer fires with the browser refusing storage.
    expect(() => vi.advanceTimersByTime(2 * INTERRUPTED_RUN_TTL_MS)).not.toThrow();
    expect(() => expireInterruptedRuns()).not.toThrow();
  });
});
