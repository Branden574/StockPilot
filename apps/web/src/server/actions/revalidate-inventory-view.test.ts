// @vitest-environment node
import { refresh, revalidateTag } from 'next/cache';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ROLE_PERMISSIONS, type Permission, type Role } from '@stockpilot/core';

import { withContext } from '@/server/services/context';

import { revalidateInventoryViewAction } from './revalidate-inventory-view';

/**
 * The realtime watcher's action (one call per change transaction per visible
 * tab) re-renders the tab, and expires the organization's shared Items/Books
 * list caches only where they can matter: a tab on Items or Books, of a caller
 * whose pages read those caches (manager and above with items:read). The
 * organization is always the session's.
 */

vi.mock('next/cache', () => ({
  revalidateTag: vi.fn(),
  refresh: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));

const ORG = '00000000-0000-4000-8000-00000000000a';
const OTHER_ORG = '00000000-0000-4000-8000-00000000000b';

function session(role: Role, permissions?: Permission[]) {
  vi.mocked(withContext).mockResolvedValue({
    organizationId: ORG,
    userId: 'u-1',
    role,
    permissions: new Set(permissions ?? ROLE_PERMISSIONS[role]),
  } as never);
}

const expiries = () => vi.mocked(revalidateTag).mock.calls;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('revalidateInventoryViewAction', () => {
  it("a manager on Items: expires the session organization's list caches (the render rides on it)", async () => {
    session('manager');
    await expect(revalidateInventoryViewAction('items')).resolves.toBe(true);
    expect(expiries()).toEqual([[`inventory-list-${ORG}`, { expire: 0 }]]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a manager on Books: the same expiry', async () => {
    session('manager');
    await expect(revalidateInventoryViewAction('books')).resolves.toBe(true);
    expect(expiries()).toEqual([[`inventory-list-${ORG}`, { expire: 0 }]]);
  });

  it.each(['owner', 'admin'] as const)('%s on Items: the same expiry', async (role) => {
    session(role);
    await revalidateInventoryViewAction('items');
    expect(expiries()).toEqual([[`inventory-list-${ORG}`, { expire: 0 }]]);
  });

  it.each(['staff', 'viewer'] as const)(
    '%s on Items: no expiry (their pages never read the shared caches), only a re-render',
    async (role) => {
      session(role);
      await expect(revalidateInventoryViewAction('items')).resolves.toBe(true);
      expect(revalidateTag).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledTimes(1);
    },
  );

  it('a manager whose items:read was revoked: no expiry, only a re-render', async () => {
    session(
      'manager',
      ROLE_PERMISSIONS.manager.filter((p) => p !== 'items:read'),
    );
    await revalidateInventoryViewAction('items');
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the Dashboard', null],
    ['no view (an older tab)', undefined],
    ['an unknown view', 'admin'],
    ['an object', { view: 'items' }],
  ])('a manager on %s: no expiry, only a re-render', async (_name, view) => {
    session('manager');
    await expect(revalidateInventoryViewAction(view)).resolves.toBe(true);
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("the organization is the session's: extra arguments never name another one", async () => {
    session('manager');
    const call = revalidateInventoryViewAction as unknown as (
      ...args: unknown[]
    ) => Promise<boolean>;
    await call('items', OTHER_ORG, { organizationId: OTHER_ORG });
    expect(expiries()).toEqual([[`inventory-list-${ORG}`, { expire: 0 }]]);
    expect(expiries().flat().join(' ')).not.toContain(OTHER_ORG);
  });

  it('no context (signed out, a code owed, a failed read): nothing marked, answers false', async () => {
    vi.mocked(withContext).mockRejectedValue(new Error('NEXT_REDIRECT'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(revalidateInventoryViewAction('items')).resolves.toBe(false);
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
