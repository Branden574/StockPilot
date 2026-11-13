import { DEFAULT_MODULE_IDS, type ModuleId } from '@stockpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ENABLED_MODULES,
  ENABLED_MODULES_META_KEY,
  MODULES_READ_WAIT_MS,
  refreshEnabledModules,
  useEnabledModules,
  useEnabledModulesState,
} from './enabled-modules';

/**
 * THE SAVED MODULE SET: WHAT THE DEVICE STORE ANSWERED (S75).
 *
 * The side menu and the tabs draw from `modules`: DEFAULT_ENABLED_MODULES
 * until a saved set is read, and kept when nothing is saved. `read` turns
 * true after MODULES_READ_WAIT_MS whatever the store is doing. Neither can
 * tell a screen what is saved for this workspace, so a screen deciding what
 * it reads or shows (screen-access.ts) uses `answered`: false until a read
 * came back, however long it takes (never the wait), then 'saved' or
 * 'nothing-saved', or 'failed' when a read threw. `modules` and `read` keep their meaning
 * for the menu.
 *
 * React is replaced so a call is a render: the first runs the effect (a
 * mount), later calls return the state as it is now. The device store is
 * faked (use-effective-permissions.test.ts uses the same harness).
 */

const react = vi.hoisted(() => ({
  mounted: false,
  state: undefined as unknown,
  cleanup: undefined as undefined | (() => void),
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    if (!react.mounted) {
      react.mounted = true;
      react.state = initial;
    }
    const set = (next: unknown) => {
      react.state =
        typeof next === 'function' ? (next as (prev: unknown) => unknown)(react.state) : next;
    };
    return [react.state, set];
  },
  useEffect: (effect: () => undefined | (() => void)) => {
    if (react.cleanup === undefined) react.cleanup = effect() ?? (() => undefined);
  },
}));

const db = vi.hoisted(() => ({
  getMeta: vi.fn<(key: string) => Promise<string | null>>(),
}));
vi.mock('./db', () => db);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const saved = (...m: ModuleId[]) => JSON.stringify(m);

beforeEach(() => {
  react.mounted = false;
  react.state = undefined;
  db.getMeta.mockReset();
});

afterEach(() => {
  react.cleanup?.();
  react.cleanup = undefined;
});

describe('useEnabledModulesState', () => {
  it('before the store answers: the default set, not read, not answered', () => {
    db.getMeta.mockReturnValue(new Promise(() => undefined));
    expect(useEnabledModulesState()).toEqual({
      modules: DEFAULT_ENABLED_MODULES,
      read: false,
      answered: false,
    });
    expect(db.getMeta).toHaveBeenCalledWith(ENABLED_MODULES_META_KEY);
  });

  it('a store that has not answered is not answered, however long it takes; the wait sets only read', async () => {
    vi.useFakeTimers();
    try {
      let answer!: (v: string | null) => void;
      db.getMeta.mockReturnValue(
        new Promise<string | null>((r) => {
          answer = r;
        }),
      );
      useEnabledModulesState();
      await vi.advanceTimersByTimeAsync(MODULES_READ_WAIT_MS * 20);
      const waited = useEnabledModulesState();
      expect(waited.read).toBe(true);
      expect(waited.modules).toBe(DEFAULT_ENABLED_MODULES);
      expect(waited.answered).toBe(false);
      answer(saved('cycle_counts'));
      await vi.advanceTimersByTimeAsync(0);
      const now = useEnabledModulesState();
      expect(now.answered).toBe('saved');
      expect([...now.modules]).toEqual(['cycle_counts']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a saved set: answered saved, with it', async () => {
    db.getMeta.mockResolvedValue(saved('bundles', 'cycle_counts'));
    useEnabledModulesState();
    await settle();
    const now = useEnabledModulesState();
    expect(now.answered).toBe('saved');
    expect([...now.modules].sort()).toEqual(['bundles', 'cycle_counts']);
  });

  it('a saved empty set is a saved set (no optional modules)', async () => {
    db.getMeta.mockResolvedValue('[]');
    useEnabledModulesState();
    await settle();
    const now = useEnabledModulesState();
    expect(now.answered).toBe('saved');
    expect(now.modules.size).toBe(0);
  });

  it.each([
    ['nothing saved', null],
    ['a value that does not parse', 'not json'],
    ['a value that is not a list', '{"bundles":true}'],
  ])('%s: answered nothing-saved; the menu keeps the default set', async (_label, raw) => {
    db.getMeta.mockResolvedValue(raw);
    useEnabledModulesState();
    await settle();
    expect(useEnabledModulesState()).toEqual({
      modules: DEFAULT_ENABLED_MODULES,
      read: true,
      answered: 'nothing-saved',
    });
  });

  it('a store that throws: read, the default kept, answered failed', async () => {
    db.getMeta.mockRejectedValue(new Error('database is locked'));
    useEnabledModulesState();
    await settle();
    expect(useEnabledModulesState()).toEqual({
      modules: DEFAULT_ENABLED_MODULES,
      read: true,
      answered: 'failed',
    });
  });

  it('after a wipe (a switch, a sign-out) the re-read answers nothing-saved; the menu keeps the set it shows', async () => {
    db.getMeta.mockResolvedValue(saved('bundles'));
    useEnabledModulesState();
    await settle();
    db.getMeta.mockResolvedValue(null);
    // A switch waits for the re-read (use-workspace.ts): it resolves once read.
    await refreshEnabledModules();
    const now = useEnabledModulesState();
    expect(now.answered).toBe('nothing-saved');
    expect([...now.modules]).toEqual(['bundles']);
  });

  // A re-read is asked for after a wipe (a workspace switch): one that
  // throws must not let the previous workspace's set stand for the new one.
  it('a later read that throws answers failed; the menu keeps the set it shows', async () => {
    db.getMeta.mockResolvedValue(saved('bundles'));
    useEnabledModulesState();
    await settle();
    db.getMeta.mockRejectedValue(new Error('database is locked'));
    await refreshEnabledModules();
    const now = useEnabledModulesState();
    expect(now.answered).toBe('failed');
    expect([...now.modules]).toEqual(['bundles']);
  });
});

describe('a read that failed is read again at the end of every pull (S75)', () => {
  it('rereadFailedEnabledModules reads again a reader whose last read failed', async () => {
    const { rereadFailedEnabledModules } = await import('./enabled-modules');
    db.getMeta.mockRejectedValue(new Error('database is locked'));
    useEnabledModulesState();
    await settle();
    expect(useEnabledModulesState().answered).toBe('failed');
    db.getMeta.mockReset().mockResolvedValue(saved('bundles'));
    await rereadFailedEnabledModules();
    expect(db.getMeta).toHaveBeenCalledTimes(1);
    expect(useEnabledModulesState().answered).toBe('saved');
  });

  it('a reader whose last read answered is not read again', async () => {
    const { rereadFailedEnabledModules } = await import('./enabled-modules');
    db.getMeta.mockResolvedValue(saved('bundles'));
    useEnabledModulesState();
    await settle();
    db.getMeta.mockClear();
    await rereadFailedEnabledModules();
    expect(db.getMeta).not.toHaveBeenCalled();
  });
});

describe('useEnabledModules (the menu and the tabs): unchanged', () => {
  it('the default set until read, then the saved set', async () => {
    db.getMeta.mockResolvedValue(saved('bundles'));
    expect(useEnabledModules()).toBe(DEFAULT_ENABLED_MODULES);
    expect(DEFAULT_ENABLED_MODULES).toEqual(new Set(DEFAULT_MODULE_IDS));
    await settle();
    expect([...useEnabledModules()]).toEqual(['bundles']);
  });
});
