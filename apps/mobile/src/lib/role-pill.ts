import type { Role } from '@stockpilot/core';

type PillStatus = 'ok' | 'warn' | 'crit' | 'default';

/** The Team list's words for each role (team.tsx, admin/users.tsx). */
const ROLE_PILL: Record<Role, { label: string; status: PillStatus }> = {
  owner: { label: 'OWNER', status: 'ok' },
  admin: { label: 'ADMIN', status: 'ok' },
  manager: { label: 'MANAGER', status: 'default' },
  staff: { label: 'STAFF', status: 'default' },
  viewer: { label: 'VIEWER', status: 'default' },
};

/**
 * The Settings account card's role pill: the member's real role in the active
 * organization, or nothing while it is unknown. It used to say OWNER for every
 * member (A3 review: the delete text turns on "if you are the only owner").
 */
export function settingsRolePill(role: Role | null): { label: string; status: PillStatus } | null {
  return role ? ROLE_PILL[role] : null;
}
