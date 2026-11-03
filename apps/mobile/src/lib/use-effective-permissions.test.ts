import type { Permission } from '@stockpilot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EFFECTIVE_PERMISSIONS_META_KEY,
  NO_PERMISSIONS,
  permissionsOnceRead,
  refreshEffectivePermissions,
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

describe('useEffectivePermissionsState', () => {
  it('before the saved set is read: not read, no set, and a gate on it offers nothing (mutation: start as read)', () => {
    db.getMeta.mockReturnValue(new Promise(() => undefined));
    const first = useEffectivePermissionsState();
    expect(first).toEqual({ permissions: undefined, read: false });
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
    expect(now).toEqual({ permissions: undefined, read: true });
    expect(permissionsOnceRead(now)).toBeUndefined();
  });

  // "Never block the screen indefinitely": the order screen's load waits for
  // `read`, so a store that cannot be read must still end the wait.
  it('a store that cannot be read still counts as read, with no set (mutation: no catch, or read left false)', async () => {
    db.getMeta.mockRejectedValue(new Error('database is locked'));
    useEffectivePermissionsState();
    await settle();
    expect(useEffectivePermissionsState()).toEqual({ permissions: undefined, read: true });
  });

  it('a later read that fails keeps the set already read (as before: a failed read never blanked it)', async () => {
    db.getMeta.mockResolvedValue(saved('orders:approve'));
    useEffectivePermissionsState();
    await settle();
    const before = useEffectivePermissionsState() as EffectivePermissionsState;
    db.getMeta.mockRejectedValue(new Error('database is locked'));
    refreshEffectivePermissions();
    await settle();
    expect(useEffectivePermissionsState()).toBe(before);
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

describe('useEffectivePermissions (every other screen): unchanged', () => {
  it('answers the set alone: undefined until read, then the saved set', async () => {
    db.getMeta.mockResolvedValue(saved('orders:request'));
    expect(useEffectivePermissions()).toBeUndefined();
    await settle();
    expect([...(useEffectivePermissions() ?? [])]).toEqual(['orders:request']);
  });
});
