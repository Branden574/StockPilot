import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { effectCallback } from './__fixtures__/screen-functions';
import { countLoadClearsScreen, countReloadIsQuiet } from './count-access-refresh';
import { createDraftDebouncer } from './draft-debouncer';

import type { ScreenAccess } from './screen-access';

/**
 * COUNTS TYPED FOR ONE ACCOUNT ARE NEVER SHOWN OR SAVED FOR ANOTHER.
 *
 * The count screen keeps the counts typed in its boxes (its drafts) and saves
 * each 300 ms after the last keystroke. When the screen is cleared for
 * another count, workspace or account (count-access-refresh.ts
 * countLoadClearsScreen, round 3), the header and lines went, but the drafts
 * stayed on screen and their waiting saves still ran: a number typed under
 * account A was saved under account B, the one signed in when the timer fired.
 * Now the drafts are cleared with the screen, and their waiting saves are:
 *   - dropped, never sent, when the account changes or the workspace changes
 *     from one to another;
 *   - saved at once, as on leaving the screen, for the same account and
 *     workspace (another count), or when the workspace has just become known.
 * The scanner's confirm sheet, typed for one account, closes the same way.
 *
 * The count screen's and the scanner's own effects are RUN here
 * (screen-functions.ts).
 */

const COUNT = 'app/cycle-count/[id].tsx';
const SCAN = 'app/cycle-count/scan/[id].tsx';
const COUNT_ID = '0a000000-0000-0000-0000-0000000000f1';

type Key = { id: string; orgId: string | null; userId: string | null; access: ScreenAccess };
const keyFor = (userId: string | null, orgId: string | null = 'org-a', id = COUNT_ID): Key => ({
  id,
  orgId,
  userId,
  access: 'allowed',
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('countLoadDraftAction', () => {
  it('keeps them while the screen is not cleared; drops them for another account or workspace; saves them otherwise', async () => {
    const mod = (await import('./count-access-refresh')) as Record<string, unknown>;
    const action = mod.countLoadDraftAction as (b: Key | null, n: Key) => string;
    expect(action(null, keyFor('user-a'))).toBe('keep');
    expect(action(keyFor('user-a'), { ...keyFor('user-a'), access: 'not-synced' })).toBe('keep');
    expect(action(keyFor('user-a'), keyFor('user-b'))).toBe('drop');
    expect(action(keyFor('user-a'), keyFor(null))).toBe('drop');
    expect(action(keyFor('user-a', 'org-a'), keyFor('user-a', 'org-b'))).toBe('drop');
    expect(action(keyFor('user-a', null), keyFor('user-a', 'org-a'))).toBe('save');
    expect(action(keyFor('user-a'), keyFor('user-a', 'org-a', 'other-count'))).toBe('save');
  });
});

describe('createDraftDebouncer().dropAll', () => {
  it('forgets every waiting save: none runs, then or later', () => {
    const persist = vi.fn();
    const saver = createDraftDebouncer(300, persist) as ReturnType<typeof createDraftDebouncer> & {
      dropAll: () => void;
    };
    saver.schedule('l1', '7');
    saver.dropAll();
    vi.advanceTimersByTime(1000);
    saver.flushAll();
    expect(persist).not.toHaveBeenCalled();
  });
});

/** The count screen's load effect, run for each key in turn, with a draft typed under the first. */
function countScreen() {
  const persist = vi.fn();
  const lineSaver = createDraftDebouncer(300, persist);
  const screen = { draft: {} as Record<string, string>, lines: ['line'] as unknown[] };
  const lastLoadKey = { current: null as Key | null };
  const mod = import('./count-access-refresh');
  const runFor = async (key: Key) => {
    const { countLoadDraftAction } = (await mod) as Record<string, unknown>;
    effectCallback<() => void>(COUNT, 'countLoadClearsScreen(lastLoadKey.current', {
      lastLoadKey,
      loadKeyNow: () => ({ key, linesShown: screen.lines.length > 0 }),
      countReloadIsQuiet,
      countLoadClearsScreen,
      countLoadDraftAction,
      lineSaver,
      setDraft: (v: unknown) => {
        screen.draft =
          typeof v === 'function'
            ? (v as (d: Record<string, string>) => Record<string, string>)(screen.draft)
            : (v as Record<string, string>);
      },
      setHeader: () => undefined,
      setLines: (v: unknown[]) => {
        screen.lines = v;
      },
      setLoading: () => undefined,
      setReadError: () => undefined,
      setEmptyState: () => undefined,
      // The rest of the count's state, cleared with it
      // (count-screens-keyed.test.ts).
      setLinked: () => undefined,
      setServerLocations: () => undefined,
      setScope: () => undefined,
      setConflictBanner: () => undefined,
      rememberedCloseGate: () => null,
      setCloseGate: () => undefined,
      load: async () => {
        screen.lines = ['line'];
      },
    })();
  };
  const type = (lineId: string, v: string) => {
    screen.draft = { ...screen.draft, [lineId]: v };
    lineSaver.schedule(lineId, v);
  };
  return { runFor, type, screen, persist };
}

describe('the count screen cleared for another account', () => {
  it('a draft typed under account A is not on screen, and is not sent, after the screen loads for account B', async () => {
    const s = countScreen();
    await s.runFor(keyFor('user-a'));
    s.type('l1', '7');
    await s.runFor(keyFor('user-b'));
    expect(s.screen.draft).toEqual({});
    vi.advanceTimersByTime(1000);
    expect(s.persist).not.toHaveBeenCalled();
  });

  it('nor after a sign-out, nor for another workspace', async () => {
    for (const next of [keyFor(null), keyFor('user-a', 'org-b')]) {
      const s = countScreen();
      await s.runFor(keyFor('user-a'));
      s.type('l1', '7');
      await s.runFor(next);
      expect(s.screen.draft).toEqual({});
      vi.advanceTimersByTime(1000);
      expect(s.persist).not.toHaveBeenCalled();
    }
  });

  it('the same account when its workspace becomes known: the draft is saved at once, not lost', async () => {
    const s = countScreen();
    await s.runFor(keyFor('user-a', null));
    s.type('l1', '7');
    await s.runFor(keyFor('user-a', 'org-a'));
    expect(s.persist).toHaveBeenCalledWith('l1', '7');
    expect(s.screen.draft).toEqual({});
    vi.advanceTimersByTime(1000);
    expect(s.persist).toHaveBeenCalledTimes(1);
  });
});

describe('the scanner cleared for another account', () => {
  it('closes a confirm sheet typed under account A when the screen loads for account B', async () => {
    const { countLoadDraftAction } = (await import('./count-access-refresh')) as Record<
      string,
      unknown
    >;
    const sheets: unknown[] = [];
    const lastLinesKey = { current: null as Key | null };
    const run = (user: { id: string } | null, orgId: string) =>
      effectCallback<() => void>(SCAN, 'void loadLines()', {
        id: COUNT_ID,
        orgId,
        user,
        access: 'allowed',
        lastLinesKey,
        countLoadClearsScreen,
        countLoadDraftAction,
        loadLines: async () => undefined,
        setLines: () => undefined,
        setScannedMap: () => undefined,
        setSheet: (v: unknown) => sheets.push(v),
      })();
    run({ id: 'user-a' }, 'org-a');
    run({ id: 'user-b' }, 'org-a');
    expect(sheets).toEqual([null]);
  });
});
