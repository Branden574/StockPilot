import type { Permission } from '@stockpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EFFECTIVE_PERMISSIONS_META_KEY,
  NO_PERMISSIONS,
  permissionsOnceRead,
  refreshEffectivePermissions,
  SAVED_PERMISSIONS_READ_WAIT_MS,
  useEffectivePermissions,
  useEffectivePermissionsState,
  type EffectivePermissionsState,
} from './use-effective-permissions';

/**
 * The saved permission set, and whether it has been read yet (S2 follow-up,
 * lab walk of #378). The order screen gates with nothing until the saved set
 * is read (permissionsOnceRead) and its load waits for it, so the hook must
 * say when the read is over, whatever it found: a saved set, nothing, or a
 * store that could not be read. Every other screen keeps
 * useEffectivePermissions(), unchanged.
 *
 * React is replaced so a call is a render: the first runs the effect (a
 * mount), later calls return the state as it is now (a re-render), and every
 * state set is recorded. The device store is faked.
 */

const react = vi.hoisted(() => ({
  mounted: false,
  state: undefined as unknown,
  published: [] as unknown[],
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
      react.published.push(react.state);
    };
    return [react.state, set];
  },
  useEffect: (effect: () => undefined | (() => void)) => {
    if (react.cleanup === undefined) react.cleanup = effect() ?? (() => undefined);
  },
}));

const db = vi.hoisted(() => ({
  getMeta: vi.fn<(key: string) => Promise<string | null>>(),
  setMeta: vi.fn<(key: string, value: string) => Promise<void>>(),
}));
vi.mock('./db', () => db);
vi.mock('./api', () => ({ api: vi.fn() }));

/** Let the effect's read (and the state it sets) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  react.mounted = false;
  react.state = undefined;
  react.published = [];
  db.getMeta.mockReset();
  db.setMeta.mockReset();
});

afterEach(() => {
  // Unmount: the hook stops listening, so a later test's refresh never
  // reaches this one.
  react.cleanup?.();
  react.cleanup = undefined;
});

const saved = (...p: Permission[]) => JSON.stringify(p);

/** A device-store read the test answers when it chooses. */
function deferredRead() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useEffectivePermissionsState', () => {
  it('before the saved set is read: not read, no set, and a gate on it offers nothing (mutation: start as read)', () => {
    db.getMeta.mockReturnValue(new Promise(() => undefined));
    const first = useEffectivePermissionsState();
    expect(first).toEqual({ permissions: undefined, read: false, answered: false });
    expect(permissionsOnceRead(first)).toBe(NO_PERMISSIONS);
    expect(db.getMeta).toHaveBeenCalledWith(EFFECTIVE_PERMISSIONS_META_KEY);
  });

  it('a saved set: read, with it', async () => {
    db.getMeta.mockResolvedValue(saved('orders:approve', 'items:update'));
    useEffectivePermissionsState();
    await settle();
    const now = useEffectivePermissionsState();
    expect(now.read).toBe(true);
    expect([...(now.permissions ?? [])].sort()).toEqual(['items:update', 'orders:approve']);
    expect(permissionsOnceRead(now)).toBe(now.permissions);
  });

  it.each([
    ['nothing saved', null],
    ['an empty set', '[]'],
    ['a set that does not parse', 'not json'],
  ])('%s: read, with no set, so the static defaults decide as before', async (_label, raw) => {
    db.getMeta.mockResolvedValue(raw);
    useEffectivePermissionsState();
    await settle();
    const now = useEffectivePermissionsState();
    expect(now).toEqual({ permissions: undefined, read: true, answered: true });
    expect(permissionsOnceRead(now)).toBeUndefined();
  });

  // "Never block the screen indefinitely": the order screen's load waits for
  // `read`, so a store that cannot be read must still end the wait.
  it('a store that cannot be read still counts as read, with no set (mutation: no catch, or read left false)', async () => {
    db.getMeta.mockRejectedValue(new Error('database is locked'));
    useEffectivePermissionsState();
    await settle();
    // Read, for the order screen; failed, for a screen that must not decide
    // from the defaults (screen-access.ts offers Try again).
    expect(useEffectivePermissionsState()).toEqual({
      permissions: undefined,
      read: true,
      answered: 'failed',
    });
  });

  it('a later read that fails keeps the set already read (as before: a failed read never blanked it)', async () => {
    db.getMeta.mockResolvedValue(saved('orders:approve'));
    useEffectivePermissionsState();
    await settle();
    const before = useEffectivePermissionsState() as EffectivePermissionsState;
    db.getMeta.mockRejectedValue(new Error('database is locked'));
    refreshEffectivePermissions();
    await settle();
    // The menu keeps the set (S75: a screen sees the read failed, below).
    const after = useEffectivePermissionsState();
    expect(after.permissions).toBe(before.permissions);
    expect(after.read).toBe(true);
  });

  // Review of the S2 follow-up, F5: the order screen's load waits for
  // `read`, so a device store that never answers (an open or a migration
  // that stalls) held its spinner up for good, with no Try again; before,
  // the order showed. After the wait it counts as read with nothing saved
  // (the static defaults decide, as before), and a set that lands later
  // still replaces it.
  it('a store that never answers counts as read, with nothing saved, after the wait (mutation: no wait, or a wait that sets nothing)', async () => {
    vi.useFakeTimers();
    try {
      const late = deferredRead();
      db.getMeta.mockReturnValue(late.promise);
      expect(useEffectivePermissionsState()).toEqual({
        permissions: undefined,
        read: false,
        answered: false,
      });
      await vi.advanceTimersByTimeAsync(SAVED_PERMISSIONS_READ_WAIT_MS - 1);
      expect(useEffectivePermissionsState().read).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(useEffectivePermissionsState()).toEqual({
        permissions: undefined,
        read: true,
        answered: false,
      });
      // The set lands late: it replaces the static defaults, still read.
      late.resolve(saved('orders:approve'));
      await vi.advanceTimersByTimeAsync(0);
      const now = useEffectivePermissionsState();
      expect(now.read).toBe(true);
      expect([...(now.permissions ?? [])]).toEqual(['orders:approve']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a read that answers in time leaves nothing waiting: the wait never sets the state after it', async () => {
    vi.useFakeTimers();
    try {
      db.getMeta.mockResolvedValue(saved('orders:approve'));
      useEffectivePermissionsState();
      await vi.advanceTimersByTimeAsync(0);
      const published = react.published.length;
      await vi.advanceTimersByTimeAsync(SAVED_PERMISSIONS_READ_WAIT_MS * 2);
      expect(react.published).toHaveLength(published);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unmounted before the wait is over: nothing is set, and no timer is left', async () => {
    vi.useFakeTimers();
    try {
      db.getMeta.mockReturnValue(new Promise(() => undefined));
      useEffectivePermissionsState();
      react.cleanup?.();
      react.cleanup = () => undefined;
      await vi.advanceTimersByTimeAsync(SAVED_PERMISSIONS_READ_WAIT_MS * 2);
      expect(react.published).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a change that is saved is read again and stays read', async () => {
    db.getMeta.mockResolvedValue(saved('items:update'));
    useEffectivePermissionsState();
    await settle();
    db.getMeta.mockResolvedValue(saved('items:update', 'orders:approve'));
    refreshEffectivePermissions();
    await settle();
    const now = useEffectivePermissionsState();
    expect(now.read).toBe(true);
    expect(now.permissions?.has('orders:approve')).toBe(true);
  });
});

describe('answered: the device store has answered, never the wait (S75)', () => {
  /**
   * `read` turns true after SAVED_PERMISSIONS_READ_WAIT_MS with nothing
   * saved, for the order screen, which must never wait for good. A screen
   * deciding what it reads or shows by the saved set (screen-access.ts) must
   * not decide from that default: it waits for `answered`, which only a read
   * that came back sets, however long it takes.
   */
  it('a store that has not answered is not answered, however long it takes; the wait never sets it', async () => {
    vi.useFakeTimers();
    try {
      const late = deferredRead();
      db.getMeta.mockReturnValue(late.promise);
      useEffectivePermissionsState();
      await vi.advanceTimersByTimeAsync(SAVED_PERMISSIONS_READ_WAIT_MS * 20);
      const waited = useEffectivePermissionsState();
      expect(waited.read).toBe(true);
      expect(waited.answered).toBe(false);
      late.resolve(saved('cycle_counts:read'));
      await vi.advanceTimersByTimeAsync(0);
      expect(useEffectivePermissionsState().answered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a saved set', saved('items:create')],
    ['nothing saved', null],
    ['a set that does not parse', 'not json'],
  ])('%s: answered', async (_label, raw) => {
    db.getMeta.mockResolvedValue(raw);
    useEffectivePermissionsState();
    await settle();
    expect(useEffectivePermissionsState().answered).toBe(true);
  });

  it('a store that throws answers failed; a later read that comes back answers', async () => {
    db.getMeta.mockRejectedValue(new Error('database is locked'));
    useEffectivePermissionsState();
    await settle();
    expect(useEffectivePermissionsState().answered).toBe('failed');
    db.getMeta.mockResolvedValue(saved('items:create'));
    await refreshEffectivePermissions();
    expect(useEffectivePermissionsState().answered).toBe(true);
  });

  // A re-read is asked for after a wipe (a workspace switch): one that
  // throws must not let the previous answer stand for the new workspace.
  it('a later read that throws stops counting as answered; the menu keeps the set read', async () => {
    db.getMeta.mockResolvedValue(saved('items:create'));
    useEffectivePermissionsState();
    await settle();
    db.getMeta.mockRejectedValue(new Error('database is locked'));
    await refreshEffectivePermissions();
    const now = useEffectivePermissionsState();
    expect(now.answered).toBe('failed');
    expect(now.read).toBe(true);
    expect([...(now.permissions ?? [])]).toEqual(['items:create']);
  });
});

describe('useEffectivePermissions (every other screen): unchanged', () => {
  it('answers the set alone: undefined until read, then the saved set', async () => {
    db.getMeta.mockResolvedValue(saved('orders:request'));
    expect(useEffectivePermissions()).toBeUndefined();
    await settle();
    expect([...(useEffectivePermissions() ?? [])]).toEqual(['orders:request']);
  });
});
