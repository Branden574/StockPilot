import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  can,
  canDistributeBundles,
  effectivePermissions,
  FULLY_GRANTABLE_PERMISSIONS,
  hasPermission,
  isPlatformManagedPermission,
  PERMISSION_GROUP_ORDER,
  PERMISSION_META,
  PERMISSIONS,
  PLATFORM_MANAGED_PERMISSIONS,
  ROLE_PERMISSIONS,
  withoutPlatformManaged,
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

  it('includes returns:manage (every RMA write gates on has_permission since 0394) so a grant is end-to-end', () => {
    expect(FULLY_GRANTABLE_PERMISSIONS.has('returns:manage')).toBe(true);
  });
});

describe('auditor read permissions (0279) defaults', () => {
  const ALL_FIVE = [
    'cycle_counts:read',
    'schedule:read',
    'bundles:read',
    'rentals:read',
    'returns:read',
  ] as const;

  it('admin and manager have all five by default', () => {
    for (const p of ALL_FIVE) {
      expect(hasPermission('admin', p)).toBe(true);
      expect(hasPermission('manager', p)).toBe(true);
    }
  });

  it('staff mirrors its write-perm surfaces: cycle counts, bundles, rentals — not schedule/returns', () => {
    expect(hasPermission('staff', 'cycle_counts:read')).toBe(true);
    expect(hasPermission('staff', 'bundles:read')).toBe(true);
    expect(hasPermission('staff', 'rentals:read')).toBe(true);
    expect(hasPermission('staff', 'schedule:read')).toBe(false);
    expect(hasPermission('staff', 'returns:read')).toBe(false);
  });

  it('viewer has none by default (grant-only via matrix / Auditor preset)', () => {
    for (const p of ALL_FIVE) {
      expect(hasPermission('viewer', p)).toBe(false);
    }
  });

  it('all five are fully grantable (RLS read floors verified)', () => {
    for (const p of ALL_FIVE) {
      expect(FULLY_GRANTABLE_PERMISSIONS.has(p)).toBe(true);
    }
  });
});

describe('PERMISSION_GROUP_ORDER', () => {
  it('lists every group used in PERMISSION_META (unlisted groups render appended out of order)', () => {
    const usedGroups = new Set(Object.values(PERMISSION_META).map((m) => m.group));
    for (const g of usedGroups) {
      expect(PERMISSION_GROUP_ORDER).toContain(g);
    }
  });

  it('has no stale entries for groups no permission uses', () => {
    const usedGroups = new Set(Object.values(PERMISSION_META).map((m) => m.group));
    for (const g of PERMISSION_GROUP_ORDER) {
      expect(usedGroups.has(g)).toBe(true);
    }
  });
});

describe('maintenance permissions', () => {
  const FOUR = [
    'maintenance_requests:submit',
    'maintenance_requests:read_all',
    'maintenance_requests:manage',
    'maintenance_requests:configure',
  ] as const;

  it('registers exactly the four maintenance permission strings (literal pins)', () => {
    for (const p of FOUR) expect(PERMISSIONS).toContain(p);
  });

  it('role defaults mirror migration 0314 exactly (8 seeded rows)', () => {
    expect(ROLE_PERMISSIONS.viewer).toContain('maintenance_requests:submit');
    expect(ROLE_PERMISSIONS.staff).toContain('maintenance_requests:submit');
    expect(ROLE_PERMISSIONS.manager).toContain('maintenance_requests:submit');
    expect(ROLE_PERMISSIONS.manager).toContain('maintenance_requests:read_all');
    expect(ROLE_PERMISSIONS.manager).toContain('maintenance_requests:manage');
    expect(ROLE_PERMISSIONS.admin).toContain('maintenance_requests:read_all');
    expect(ROLE_PERMISSIONS.admin).toContain('maintenance_requests:manage');
    // staff/viewer never see all requests or manage them by default:
    expect(ROLE_PERMISSIONS.staff).not.toContain('maintenance_requests:read_all');
    expect(ROLE_PERMISSIONS.viewer).not.toContain('maintenance_requests:read_all');
  });

  it('configure is owner-only: admin does NOT derive it (controller adjudication C2)', () => {
    expect(ROLE_PERMISSIONS.admin).not.toContain('maintenance_requests:configure');
    expect(effectivePermissions('owner').has('maintenance_requests:configure')).toBe(true);
    expect(effectivePermissions('admin').has('maintenance_requests:configure')).toBe(false);
  });

  it('submit/read_all/manage are fully grantable; configure is not', () => {
    expect(FULLY_GRANTABLE_PERMISSIONS.has('maintenance_requests:submit')).toBe(true);
    expect(FULLY_GRANTABLE_PERMISSIONS.has('maintenance_requests:read_all')).toBe(true);
    expect(FULLY_GRANTABLE_PERMISSIONS.has('maintenance_requests:manage')).toBe(true);
    expect(FULLY_GRANTABLE_PERMISSIONS.has('maintenance_requests:configure')).toBe(false);
  });

  it('every maintenance permission has meta in the Maintenance group', () => {
    for (const p of FOUR) expect(PERMISSION_META[p].group).toBe('Maintenance');
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

describe('canDistributeBundles', () => {
  // The database refuses distribution below manager (0101), so Distribute is
  // offered only to managers and above who hold bundles:distribute.
  it('offers Distribute to owner, admin and manager by default', () => {
    for (const role of ['owner', 'admin', 'manager'] as const) {
      expect(canDistributeBundles({ role }), role).toBe(true);
      expect(canDistributeBundles({ role, permissions: effectivePermissions(role) }), role).toBe(true);
    }
  });

  it('never offers it to staff, although staff hold bundles:distribute by default', () => {
    expect(ROLE_PERMISSIONS.staff).toContain('bundles:distribute');
    expect(canDistributeBundles({ role: 'staff' })).toBe(false);
    expect(canDistributeBundles({ role: 'staff', permissions: effectivePermissions('staff') })).toBe(false);
  });

  it('never offers it to a viewer, even one granted the permission', () => {
    const granted = effectivePermissions('viewer', [{ permission: 'bundles:distribute', granted: true }]);
    expect(granted.has('bundles:distribute')).toBe(true);
    expect(canDistributeBundles({ role: 'viewer', permissions: granted })).toBe(false);
  });

  it('a manager whose bundles:distribute was revoked is not offered it', () => {
    const revoked = effectivePermissions('manager', [{ permission: 'bundles:distribute', granted: false }]);
    expect(canDistributeBundles({ role: 'manager', permissions: revoked })).toBe(false);
  });
});

// ── Ordering visibility (owner brief 2026-10-26, migration 0413) ───────────
//
// orders:manage_catalog_visibility is held by managers, admins and owners by
// default, and only StockPilot support (the platform console) may allow it to,
// deny it to or reset it for one member. Resolution for this key, for EVERY
// role including the owner: explicit deny, then explicit allow, then the role
// default. Role-level overrides of the key are ignored (the database refuses
// them anyway: tg_platform_managed_permission_guard).
describe('orders:manage_catalog_visibility (platform-managed)', () => {
  const KEY = 'orders:manage_catalog_visibility' as const;
  const deny = [{ permission: KEY, granted: false }] as const;
  const allow = [{ permission: KEY, granted: true }] as const;

  it('is a registered key with its label, group and description', () => {
    expect(PERMISSIONS).toContain(KEY);
    expect(PERMISSION_META[KEY]).toEqual({
      group: 'Order requests',
      label: 'Manage order items',
      description:
        "Choose which items and books appear in Place an Order. Does not allow editing stock, approving orders or changing anyone's access.",
    });
    expect(FULLY_GRANTABLE_PERMISSIONS.has(KEY)).toBe(true);
  });

  it('defaults: owner, admin and manager hold it; staff and viewer do not', () => {
    for (const role of ['owner', 'admin', 'manager'] as const) {
      expect(hasPermission(role, KEY), role).toBe(true);
      expect(effectivePermissions(role).has(KEY), role).toBe(true);
    }
    for (const role of ['staff', 'viewer'] as const) {
      expect(hasPermission(role, KEY), role).toBe(false);
      expect(effectivePermissions(role).has(KEY), role).toBe(false);
    }
  });

  it('PLATFORM_MANAGED_PERMISSIONS lists exactly this key', () => {
    expect([...PLATFORM_MANAGED_PERMISSIONS]).toEqual([KEY]);
    expect(isPlatformManagedPermission(KEY)).toBe(true);
    expect(isPlatformManagedPermission('orders:approve')).toBe(false);
    expect(isPlatformManagedPermission('nonexistent:perm')).toBe(false);
  });

  it('an explicit deny holds for the OWNER too, and takes away nothing else', () => {
    const perms = effectivePermissions('owner', [], [...deny]);
    expect(perms.has(KEY)).toBe(false);
    expect(perms.size).toBe(PERMISSIONS.length - 1);
  });

  it('the owner stays immutable for every other key', () => {
    const perms = effectivePermissions(
      'owner',
      [{ permission: 'items:read', granted: false }],
      [
        { permission: 'billing:manage', granted: false },
        { permission: KEY, granted: true },
      ],
    );
    expect(perms.size).toBe(PERMISSIONS.length);
  });

  it('a ROLE override of the key is ignored for every role (only the platform sets it, per user)', () => {
    expect(effectivePermissions('owner', [...deny]).has(KEY)).toBe(true);
    expect(effectivePermissions('admin', [...deny]).has(KEY)).toBe(true);
    expect(effectivePermissions('manager', [...deny]).has(KEY)).toBe(true);
    expect(effectivePermissions('staff', [...allow]).has(KEY)).toBe(false);
    expect(effectivePermissions('viewer', [...allow]).has(KEY)).toBe(false);
  });

  it('an explicit deny removes the default from an admin and a manager', () => {
    expect(effectivePermissions('admin', [], [...deny]).has(KEY)).toBe(false);
    expect(effectivePermissions('manager', [], [...deny]).has(KEY)).toBe(false);
  });

  it('an explicit allow gives a staff member or viewer this ONE key and nothing else', () => {
    for (const role of ['staff', 'viewer'] as const) {
      const perms = effectivePermissions(role, [], [...allow]);
      expect([...perms].sort(), role).toEqual([...ROLE_PERMISSIONS[role], KEY].sort());
      expect(perms.has('orders:approve'), role).toBe(false);
      expect(perms.has('members:update_role'), role).toBe(false);
    }
  });

  it('the exception follows the member, not the role: a deny survives promotion, an allow survives demotion', () => {
    for (const role of ['viewer', 'staff', 'manager', 'admin', 'owner'] as const) {
      expect(effectivePermissions(role, [], [...deny]).has(KEY), `deny as ${role}`).toBe(false);
      expect(effectivePermissions(role, [], [...allow]).has(KEY), `allow as ${role}`).toBe(true);
    }
  });

  it('can() never answers yes for a platform-managed key from the static role defaults alone', () => {
    // A context without an effective set cannot know whether a deny exists.
    expect(can({ role: 'manager' }, KEY)).toBe(false);
    expect(can({ role: 'owner' }, KEY)).toBe(false);
    expect(can({ role: 'manager', permissions: effectivePermissions('manager') }, KEY)).toBe(true);
    expect(
      can({ role: 'manager', permissions: effectivePermissions('manager', [], [...deny]) }, KEY),
    ).toBe(false);
    // Every other key keeps the static fallback.
    expect(can({ role: 'manager' }, 'orders:approve')).toBe(true);
  });

  it('withoutPlatformManaged drops the key from a fallback set (fail closed)', () => {
    const fallback = withoutPlatformManaged(new Set<Permission>(ROLE_PERMISSIONS.manager));
    expect(fallback.has(KEY)).toBe(false);
    expect(fallback.has('orders:approve')).toBe(true);
    expect(fallback.size).toBe(ROLE_PERMISSIONS.manager.length - 1);
  });
});

// The SQL twin of PLATFORM_MANAGED_PERMISSIONS is public._platform_managed_permissions()
// (0413), and its role defaults are role_default_permissions seed rows. Read
// the newest definition from the migrations, so the two lists cannot drift.
describe('platform-managed permissions: parity with the database', () => {
  const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../../supabase/migrations');
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const sqlOf = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8');

  it('_platform_managed_permissions() returns exactly PLATFORM_MANAGED_PERMISSIONS', () => {
    const defining = files.filter((f) =>
      /create (or replace )?function public\._platform_managed_permissions\(\)/i.test(sqlOf(f)),
    );
    expect(defining.length).toBeGreaterThan(0);
    const sql = sqlOf(defining[defining.length - 1]!);
    const body = sql.slice(sql.search(/function public\._platform_managed_permissions\(\)/i));
    const arr = /array\[([^\]]*)\]::text\[\]/i.exec(body);
    expect(arr).not.toBeNull();
    const keys = [...arr![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(keys).toEqual([...PLATFORM_MANAGED_PERMISSIONS]);
  });

  it('each platform-managed key is seeded for exactly the non-owner roles that hold it by default', () => {
    for (const key of PLATFORM_MANAGED_PERMISSIONS) {
      const seeded = new Set<string>();
      for (const f of files) {
        const sql = sqlOf(f);
        for (const block of sql.matchAll(/insert into public\.role_default_permissions[^;]*;/gi)) {
          for (const row of block[0].matchAll(/\(\s*'(\w+)'\s*,\s*'([^']+)'\s*\)/g)) {
            if (row[2] === key) seeded.add(row[1]!);
          }
        }
      }
      const expected = (['admin', 'manager', 'staff', 'viewer'] as const).filter((r) =>
        ROLE_PERMISSIONS[r].includes(key),
      );
      expect([...seeded].sort(), key).toEqual([...expected].sort());
    }
  });
});
