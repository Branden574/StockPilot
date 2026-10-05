import { ROLE_LABELS, type Role } from '@stockpilot/core';

/**
 * The role shown under the user's name in the dashboard menu. Core labels the
 * owner and admins alike "Super Admin", so the owner is marked "(Owner)": an
 * admin can tell from the menu that they are not the owner, which the account
 * deletion text turns on ("if you are the only owner", A3 review).
 */
export function userMenuRoleLabel(role: Role): string {
  const label = ROLE_LABELS[role].label;
  return role === 'owner' ? `${label} (Owner)` : label;
}
