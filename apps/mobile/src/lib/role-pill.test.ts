import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { settingsRolePill } from './role-pill';

/**
 * A3 review 2026-10-05: the Settings account card showed a hard-coded OWNER
 * pill to every member (since 2026-05-27). The A3 delete text turns on "if you
 * are the only owner", so a staff member saw OWNER beside the rule about
 * owners. The pill now shows the member's real role in the active
 * organization (the Team list's words), and nothing while it is unknown.
 */
describe('settingsRolePill', () => {
  it("shows the member's real role", () => {
    expect(settingsRolePill('owner')).toEqual({ label: 'OWNER', status: 'ok' });
    expect(settingsRolePill('admin')).toEqual({ label: 'ADMIN', status: 'ok' });
    expect(settingsRolePill('manager')).toEqual({ label: 'MANAGER', status: 'default' });
    expect(settingsRolePill('staff')).toEqual({ label: 'STAFF', status: 'default' });
    expect(settingsRolePill('viewer')).toEqual({ label: 'VIEWER', status: 'default' });
  });

  it('shows nothing while the role is unknown', () => {
    expect(settingsRolePill(null)).toBeNull();
  });
});

describe('Settings wiring', () => {
  const src = readFileSync(join(__dirname, '../../app/(drawer)/settings.tsx'), 'utf8');
  it('no longer hard-codes OWNER and reads the role', () => {
    expect(src).not.toMatch(/>\s*OWNER\s*<\/Pill>/);
    expect(src).toContain('const { isAdmin, role } = useRole();');
    expect(src).toContain('const rolePill = settingsRolePill(role);');
  });
});
