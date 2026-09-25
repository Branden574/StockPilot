import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ROLE_REVALIDATE_MS,
  cachedRoleFor,
  clearRoleCache,
  readRoleOnce,
  resetRoleCacheForTests,
  roleNeedsRead,
  storeRole,
  subscribeRole,
} from './role-cache';

// The phone's role cache (review finding, 2026-09-25): it used to be read once
// per app process and never cleared, so a manager demoted to staff kept
// 'manager' on their phone. The stock-in-other-warehouses reads skip their
// request for managers (0371), so that phone showed its own warehouses'
// holdings as the whole, even after signing out and back in.

const U = 'user-1';
const ORG = 'org-1';

beforeEach(() => resetRoleCacheForTests());

describe('role cache', () => {
  it('serves the stored role for the same user and org only', () => {
    storeRole(U, ORG, 'manager', 1000);
    expect(cachedRoleFor(U, ORG)).toBe('manager');
    expect(cachedRoleFor(U, 'org-2')).toBeNull();
    expect(cachedRoleFor('user-2', ORG)).toBeNull();
  });

  it('a stored role is due a re-read once it is ROLE_REVALIDATE_MS old, never kept forever', () => {
    storeRole(U, ORG, 'manager', 1000);
    expect(roleNeedsRead(U, ORG, 1000 + ROLE_REVALIDATE_MS - 1)).toBe(false);
    expect(roleNeedsRead(U, ORG, 1000 + ROLE_REVALIDATE_MS)).toBe(true);
    expect(roleNeedsRead(U, 'org-2', 1001)).toBe(true);
  });

  it('SIGN-OUT clears it: signing back in reads the role again', () => {
    storeRole(U, ORG, 'manager', Date.now());
    clearRoleCache();
    expect(cachedRoleFor(U, ORG)).toBeNull();
    expect(roleNeedsRead(U, ORG)).toBe(true);
  });

  it('a DEMOTION reaches every mounted screen: listeners hear a changed role, not an unchanged one', () => {
    const heard = vi.fn();
    const unsubscribe = subscribeRole(heard);
    storeRole(U, ORG, 'manager', 1);
    expect(heard).toHaveBeenCalledTimes(1);
    storeRole(U, ORG, 'manager', 2);
    expect(heard).toHaveBeenCalledTimes(1);
    storeRole(U, ORG, 'staff', 3);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(cachedRoleFor(U, ORG)).toBe('staff');
    unsubscribe();
    storeRole(U, ORG, 'viewer', 4);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('screens that mount together share ONE read', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const read = vi.fn(async () => {
      await held;
      return { ok: true as const, role: 'staff' as const };
    });
    const a = readRoleOnce(U, ORG, read);
    const b = readRoleOnce(U, ORG, read);
    release();
    await expect(Promise.all([a, b])).resolves.toEqual([
      { ok: true, role: 'staff' },
      { ok: true, role: 'staff' },
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(cachedRoleFor(U, ORG)).toBe('staff');
  });

  it('a re-read that finds the member demoted replaces the cached role', async () => {
    storeRole(U, ORG, 'manager', 0);
    await readRoleOnce(U, ORG, async () => ({ ok: true, role: 'staff' }));
    expect(cachedRoleFor(U, ORG)).toBe('staff');
  });

  it('a FAILED re-read keeps the role already known (no flicker to "no role")', async () => {
    storeRole(U, ORG, 'manager', 0);
    await expect(readRoleOnce(U, ORG, async () => ({ ok: false }))).resolves.toEqual({ ok: false });
    await readRoleOnce(U, ORG, async () => {
      throw new Error('network');
    });
    expect(cachedRoleFor(U, ORG)).toBe('manager');
  });

  it('an answer that lands after a sign-out is not stored', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const pending = readRoleOnce(U, ORG, async () => {
      await held;
      return { ok: true, role: 'manager' };
    });
    clearRoleCache();
    release();
    await pending;
    expect(cachedRoleFor(U, ORG)).toBeNull();
  });
});

// useRole() itself imports the Supabase client (expo-secure-store), which the
// node test environment cannot load, so its wiring is pinned by source.
describe('useRole wiring (use-role.ts)', () => {
  const src = readFileSync(path.resolve(__dirname, './use-role.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('keeps no role cache of its own: the module-level cachedRole is gone', () => {
    expect(src).not.toMatch(/let\s+cachedRole\b/);
  });

  it('clears the shared cache when the user signs out', () => {
    expect(src).toMatch(/if \(!user\) \{\s*clearRoleCache\(\);\s*\}/);
  });

  it('re-reads a role that is due, and follows the shared cache', () => {
    expect(src).toContain('if (roleNeedsRead(userId, orgId)) {');
    expect(src).toContain('readRoleOnce(userId, orgId, () => readRole(userId, orgId))');
    expect(src).toContain('const unsubscribe = subscribeRole(');
    expect(src).toContain('unsubscribe();');
  });

  it('a failed read is not "no role": readRole reports the error as a failure', () => {
    expect(src).toContain('if (error) return { ok: false };');
  });
});
