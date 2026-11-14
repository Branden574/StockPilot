import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import * as roleCache from './role-cache';

/**
 * THE ROLE OF THE PREVIOUS WORKSPACE IS NEVER ANSWERED FOR THE NEXT (B124).
 *
 * useRole held the role in React state and, on a workspace change, kept it
 * until the new workspace's role read answered (and for good when that read
 * failed, offline): a member who is a manager in one workspace and staff in
 * another was decided as a manager there meanwhile. The role now goes with
 * the member and workspace it was read for (role-cache.ts roleShownFor): for
 * another one it is that one's cached role, or unknown and loading.
 */

type RoleShownFor = (
  held: { userId: string; orgId: string; role: string | null; loading: boolean } | null,
  userId: string | null,
  orgId: string | null,
) => { role: string | null; loading: boolean };

const roleShownFor = (roleCache as unknown as { roleShownFor?: RoleShownFor }).roleShownFor;

beforeEach(() => roleCache.resetRoleCacheForTests());

describe('roleShownFor', () => {
  it('is exported by role-cache.ts', () => {
    expect(typeof roleShownFor).toBe('function');
  });

  it('answers the role held for this member and workspace', () => {
    const held = { userId: 'u1', orgId: 'org-a', role: 'manager', loading: false };
    expect(roleShownFor?.(held, 'u1', 'org-a')).toEqual({ role: 'manager', loading: false });
  });

  it('after a switch, never the previous workspace’s role: unknown and loading until read', () => {
    const held = { userId: 'u1', orgId: 'org-a', role: 'manager', loading: false };
    expect(roleShownFor?.(held, 'u1', 'org-b')).toEqual({ role: null, loading: true });
  });

  it("after a switch to a workspace whose role is cached, that workspace's role", () => {
    roleCache.storeRole('u1', 'org-b', 'staff');
    const held = { userId: 'u1', orgId: 'org-a', role: 'manager', loading: false };
    expect(roleShownFor?.(held, 'u1', 'org-b')).toEqual({ role: 'staff', loading: false });
  });

  it('with nobody signed in or no workspace: no role, not loading', () => {
    const held = { userId: 'u1', orgId: 'org-a', role: 'manager', loading: false };
    expect(roleShownFor?.(held, null, null)).toEqual({ role: null, loading: false });
    expect(roleShownFor?.(held, 'u1', null)).toEqual({ role: null, loading: false });
  });
});

describe('useRole answers through roleShownFor', () => {
  it('derives what it returns from the held role and the identity on screen', () => {
    const src = readFileSync(path.join(__dirname, 'use-role.ts'), 'utf8').replace(/\s+/g, ' ');
    expect(src).toContain('const shown = roleShownFor(held, userId, orgId);');
    expect(src).toContain(
      'return { role: shown.role, isAdmin: shown.role ? isAdminRole(shown.role) : false, loading: shown.loading, };',
    );
  });
});
