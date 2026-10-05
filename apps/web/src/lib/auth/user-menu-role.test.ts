import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { userMenuRoleLabel } from './user-menu-role';

/**
 * A3 review 2026-10-05: the user menu labelled owners and admins alike "Super
 * Admin" (core ROLE_LABELS), so an admin could not tell from the menu whether
 * they were the owner, and the A3 delete text turns on "if you are the only
 * owner". The menu now says "(Owner)" for the owner; every other role keeps
 * its label.
 */
describe('userMenuRoleLabel', () => {
  it('marks the owner', () => {
    expect(userMenuRoleLabel('owner')).toBe('Super Admin (Owner)');
  });

  it('keeps every other role label', () => {
    expect(userMenuRoleLabel('admin')).toBe('Super Admin');
    expect(userMenuRoleLabel('manager')).toBe('Manager');
    expect(userMenuRoleLabel('staff')).toBe('Warehouse User');
    expect(userMenuRoleLabel('viewer')).toBe('Read-Only Auditor');
  });

  it('is what the dashboard layout shows in the user menu', () => {
    const layout = readFileSync(join(__dirname, '../../app/(dashboard)/layout.tsx'), 'utf8');
    expect(layout).toContain('userRole={`${userMenuRoleLabel(ctx.role)} · ${ctx.organizationName}`}');
  });
});
