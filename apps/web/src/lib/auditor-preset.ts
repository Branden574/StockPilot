import type { Permission } from '@stockpilot/core';

/**
 * The exact grant set behind the roles page's "Apply Auditor preset" button
 * (Unit 4 of the auditor-visibility plan). Applying the preset writes a
 * role-level GRANT override for the viewer role for each of these, opening
 * every reporting and operations surface read-only (plus the two exports).
 *
 * Lives outside `server/actions/permissions.ts` because 'use server' modules
 * may only export async functions — the client matrix imports this constant
 * to update its checkbox state after a successful apply, and the action
 * imports it as its single source of truth. Every entry must stay a real
 * `Permission` (the type annotation enforces it at compile time).
 */
export const AUDITOR_PRESET_PERMISSIONS: readonly Permission[] = [
  'reports:read',
  'activity_logs:read',
  'cycle_counts:read',
  'schedule:read',
  'bundles:read',
  'rentals:read',
  'returns:read',
  'items:export',
  'reports:export',
];
