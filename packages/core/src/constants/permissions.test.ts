import { describe, expect, it } from 'vitest';

import {
  effectivePermissions,
  FULLY_GRANTABLE_PERMISSIONS,
  hasPermission,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type Permission,
} from './permissions';

describe('effectivePermissions', () => {
  it('returns the static defaults when there are no overrides', () => {
    const perms = effectivePermissions('viewer');
    expect([...perms].sort()).toEqual([...ROLE_PERMISSIONS.viewer].sort());
  });

  it('owner always has every permission and ignores overrides (cannot be locked out)', () => {
    const perms = effectivePermissions(
      'owner',
      [{ permission: 'items:read', granted: false }],
      [{ permission: 'billing:manage', granted: false }],
    );
    expect(perms.size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) expect(perms.has(p)).toBe(true);
  });

  it('grants a permission the role lacks by default (viewer ⇒ purchase_orders:manage)', () => {
    expect(ROLE_PERMISSIONS.viewer).not.toContain('purchase_orders:manage');
    const perms = effectivePermissions('viewer', [
      { permission: 'purchase_orders:manage', granted: true },
    ]);
    expect(perms.has('purchase_orders:manage')).toBe(true);
    // still keeps its defaults
    expect(perms.has('items:read')).toBe(true);
  });

  it('revokes a permission the role has by default', () => {
    const perms = effectivePermissions('manager', [
      { permission: 'purchase_orders:manage', granted: false },
    ]);
    expect(perms.has('purchase_orders:manage')).toBe(false);
  });

  it('user override beats role override (grant)', () => {
    const perms = effectivePermissions(
      'viewer',
      [{ permission: 'items:create', granted: false }], // role: explicitly off
      [{ permission: 'items:create', granted: true }], // user: on → wins
    );
    expect(perms.has('items:create')).toBe(true);
  });

  it('user override beats role override (revoke)', () => {
    const perms = effectivePermissions(
      'manager',
      [{ permission: 'purchase_orders:manage', granted: true }], // role: on
      [{ permission: 'purchase_orders:manage', granted: false }], // user: off → wins
    );
    expect(perms.has('purchase_orders:manage')).toBe(false);
  });

  it('ignores unknown permission strings defensively', () => {
    const perms = effectivePermissions('viewer', [
      { permission: 'nonexistent:perm' as Permission, granted: true },
    ]);
    expect(perms.has('nonexistent:perm' as Permission)).toBe(false);
    // unchanged from defaults
    expect([...perms].sort()).toEqual([...ROLE_PERMISSIONS.viewer].sort());
  });

  it('does not mutate ROLE_PERMISSIONS', () => {
    const before = [...ROLE_PERMISSIONS.viewer];
    effectivePermissions('viewer', [{ permission: 'items:delete', granted: true }]);
    expect([...ROLE_PERMISSIONS.viewer]).toEqual(before);
  });
});

describe('FULLY_GRANTABLE_PERMISSIONS', () => {
  it('only contains real permissions', () => {
    for (const p of FULLY_GRANTABLE_PERMISSIONS) {
      expect(PERMISSIONS).toContain(p);
    }
  });

  it('includes purchase_orders:manage (RLS migrated) so the auditor PO-import grant is end-to-end', () => {
    expect(FULLY_GRANTABLE_PERMISSIONS.has('purchase_orders:manage')).toBe(true);
  });

  it('includes movements:edit_notes (RPC gate is has_permission) so a grant is end-to-end', () => {
    expect(FULLY_GRANTABLE_PERMISSIONS.has('movements:edit_notes')).toBe(true);
  });
});

describe('movements:edit_notes defaults', () => {
  it('manager has it by default', () => {
    expect(hasPermission('manager', 'movements:edit_notes')).toBe(true);
  });

  it('admin has it by default (all-except-billing:manage)', () => {
    expect(hasPermission('admin', 'movements:edit_notes')).toBe(true);
  });

  it('viewer and staff do NOT have it by default', () => {
    expect(hasPermission('viewer', 'movements:edit_notes')).toBe(false);
    expect(hasPermission('staff', 'movements:edit_notes')).toBe(false);
  });
});
