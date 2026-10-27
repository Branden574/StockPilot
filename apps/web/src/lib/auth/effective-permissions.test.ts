import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { effectivePermissions, PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '@stockpilot/core';

import { loadEffectivePermissions } from './effective-permissions';

/**
 * The legacy (no request-context bundle) resolver, for the platform-managed
 * key orders:manage_catalog_visibility (ordering visibility, migration 0413):
 *
 *   - the OWNER is no longer a zero-read short-circuit: an explicit deny from
 *     StockPilot support takes the key from them too, so their own rows for
 *     the platform-managed keys are read (one query, nothing else);
 *   - a failed read FAILS CLOSED for the platform-managed keys: without the
 *     member's rows nobody can tell whether the key was denied, so the
 *     fallback set never contains it (every other key keeps the old
 *     static-default fallback).
 */

const KEY: Permission = 'orders:manage_catalog_visibility';
const ORG = 'org-1';
const USER = 'user-1';

interface Read {
  data: Array<{ permission: string; granted: boolean }> | null;
  error: { message: string } | null;
}
const reads: Record<string, Read> = {};
const calls: Array<{ table: string; filters: Array<[string, string, unknown]> }> = [];

function client() {
  return {
    from: (table: string) => {
      const call = { table, filters: [] as Array<[string, string, unknown]> };
      calls.push(call);
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, val: unknown) => (call.filters.push(['eq', col, val]), q);
      q.in = (col: string, val: unknown) => (call.filters.push(['in', col, val]), q);
      q.then = (resolve: (v: Read) => unknown) =>
        Promise.resolve(reads[table] ?? { data: [], error: null }).then(resolve);
      return q;
    },
  };
}

beforeEach(() => {
  for (const k of Object.keys(reads)) delete reads[k];
  calls.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('loadEffectivePermissions: the owner', () => {
  it('reads ONLY their own rows for the platform-managed keys, and keeps every key without a deny', async () => {
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'owner');
    expect(perms).toEqual(effectivePermissions('owner'));
    expect(calls).toEqual([
      {
        table: 'user_permission_overrides',
        filters: [
          ['eq', 'organization_id', ORG],
          ['eq', 'user_id', USER],
          ['in', 'permission', [KEY]],
        ],
      },
    ]);
  });

  it('an explicit deny from StockPilot takes the key from the owner, and nothing else', async () => {
    reads.user_permission_overrides = { data: [{ permission: KEY, granted: false }], error: null };
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'owner');
    expect(perms.has(KEY)).toBe(false);
    expect(perms.size).toBe(PERMISSIONS.length - 1);
  });

  it('never applies an owner row for any other key, even if one came back', async () => {
    reads.user_permission_overrides = {
      data: [
        { permission: 'billing:manage', granted: false },
        { permission: KEY, granted: true },
      ],
      error: null,
    };
    expect((await loadEffectivePermissions(client(), ORG, USER, 'owner')).size).toBe(PERMISSIONS.length);
  });

  it('a failed read fails closed for the platform-managed key only', async () => {
    reads.user_permission_overrides = { data: null, error: { message: 'timeout' } };
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'owner');
    expect(perms.has(KEY)).toBe(false);
    expect(perms.has('billing:manage')).toBe(true);
    expect(perms.size).toBe(PERMISSIONS.length - 1);
  });
});

describe('loadEffectivePermissions: every other role', () => {
  it('a manager holds the key by default and loses it to an explicit deny', async () => {
    expect((await loadEffectivePermissions(client(), ORG, USER, 'manager')).has(KEY)).toBe(true);
    reads.user_permission_overrides = { data: [{ permission: KEY, granted: false }], error: null };
    expect((await loadEffectivePermissions(client(), ORG, USER, 'manager')).has(KEY)).toBe(false);
  });

  it('a role row for the key is ignored (only StockPilot sets it, per member)', async () => {
    reads.role_permission_overrides = { data: [{ permission: KEY, granted: true }], error: null };
    expect((await loadEffectivePermissions(client(), ORG, USER, 'staff')).has(KEY)).toBe(false);
    reads.role_permission_overrides = { data: [{ permission: KEY, granted: false }], error: null };
    expect((await loadEffectivePermissions(client(), ORG, USER, 'manager')).has(KEY)).toBe(true);
  });

  it('an explicit allow gives a staff member the key', async () => {
    reads.user_permission_overrides = { data: [{ permission: KEY, granted: true }], error: null };
    expect((await loadEffectivePermissions(client(), ORG, USER, 'staff')).has(KEY)).toBe(true);
  });

  it('a failed read falls back to the static defaults WITHOUT the platform-managed key', async () => {
    reads.user_permission_overrides = { data: null, error: { message: 'timeout' } };
    const perms = await loadEffectivePermissions(client(), ORG, USER, 'manager');
    expect(perms.has(KEY)).toBe(false);
    expect([...perms].sort()).toEqual(ROLE_PERMISSIONS.manager.filter((p) => p !== KEY).sort());
  });
});
