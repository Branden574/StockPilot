import { describe, expect, it } from 'vitest';

import type { Permission } from '@stockpilot/core';

import { showDistributeCta, showWriteCta, showWriteCtaForRole } from './cta-gating';

describe('showWriteCta', () => {
  it('perms not loaded (undefined) → show, matching current behavior', () => {
    expect(showWriteCta(undefined, 'stock:adjust')).toBe(true);
    expect(showWriteCta(undefined, 'schedule:manage')).toBe(true);
  });

  it('loaded set holding the permission → show', () => {
    const perms = new Set<Permission>(['stock:adjust']);
    expect(showWriteCta(perms, 'stock:adjust')).toBe(true);
  });

  it('loaded set lacking the permission → hide', () => {
    const perms = new Set<Permission>(['items:read']);
    expect(showWriteCta(perms, 'stock:adjust')).toBe(false);
    expect(showWriteCta(perms, 'schedule:manage')).toBe(false);
  });

  it('empty loaded set hides write CTAs (viewer with zero grants)', () => {
    expect(showWriteCta(new Set<Permission>(), 'stock:adjust')).toBe(false);
  });
});

describe('showWriteCtaForRole — one stock:adjust rule for the item screen', () => {
  it('a loaded effective set decides, whatever the role (a revoked manager is hidden)', () => {
    // A 0207 override can revoke stock:adjust from any role but owner; the
    // old "manager or above" short-circuit still showed "Remove from rack".
    const revoked = new Set<Permission>(['items:read', 'stock:transfer']);
    expect(showWriteCtaForRole('manager', revoked, 'stock:adjust')).toBe(false);
    expect(showWriteCtaForRole('admin', revoked, 'stock:adjust')).toBe(false);
    // ...and a grant to a viewer shows it.
    const granted = new Set<Permission>(['items:read', 'stock:adjust']);
    expect(showWriteCtaForRole('viewer', granted, 'stock:adjust')).toBe(true);
  });

  it('while the set loads, the role defaults decide (a viewer is never offered a write)', () => {
    // showWriteCta alone showed the quick adjust to a viewer in this window.
    expect(showWriteCtaForRole('viewer', undefined, 'stock:adjust')).toBe(false);
    expect(showWriteCtaForRole('staff', undefined, 'stock:adjust')).toBe(true);
    expect(showWriteCtaForRole('manager', undefined, 'stock:adjust')).toBe(true);
  });

  it('knowing neither, it shows, like showWriteCta (the API is the real gate)', () => {
    expect(showWriteCtaForRole(null, undefined, 'stock:adjust')).toBe(true);
  });

  it('agrees with showWriteCta whenever the set has loaded', () => {
    for (const perms of [new Set<Permission>(), new Set<Permission>(['stock:adjust'])]) {
      for (const role of ['owner', 'admin', 'manager', 'staff', 'viewer', null] as const) {
        expect(showWriteCtaForRole(role, perms, 'stock:adjust')).toBe(
          showWriteCta(perms, 'stock:adjust'),
        );
      }
    }
  });
});

describe('showDistributeCta — Distribute matches the database (0101: manager or above)', () => {
  const withDistribute = new Set<Permission>(['bundles:read', 'bundles:distribute']);

  it('staff are not offered Distribute, although they hold bundles:distribute', () => {
    expect(showDistributeCta('staff', withDistribute)).toBe(false);
    expect(showDistributeCta('staff', undefined)).toBe(false);
  });

  it('managers and above holding the permission are offered it', () => {
    for (const role of ['manager', 'admin', 'owner'] as const) {
      expect(showDistributeCta(role, withDistribute), role).toBe(true);
      expect(showDistributeCta(role, undefined), role).toBe(true);
    }
  });

  it('a manager whose permission was revoked is not offered it', () => {
    expect(showDistributeCta('manager', new Set<Permission>(['bundles:read']))).toBe(false);
  });

  it('an unknown role is not offered it: the server would refuse a staff member', () => {
    expect(showDistributeCta(null, withDistribute)).toBe(false);
    expect(showDistributeCta(null, undefined)).toBe(false);
  });

  it('a viewer granted the permission is still not offered it', () => {
    expect(showDistributeCta('viewer', withDistribute)).toBe(false);
  });
});
