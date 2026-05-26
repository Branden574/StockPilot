import 'server-only';

import { env } from '@/lib/env';

/**
 * Platform-admin gate. Distinct from org-scoped roles (owner/admin/manager) —
 * a platform admin operates ABOVE any single org, e.g. to provision a new
 * tenant org for a prospective customer.
 *
 * The allowlist lives in the STOCKPILOT_PLATFORM_ADMIN_EMAILS env var as
 * a comma-separated list of lowercased emails. Empty / unset == no
 * platform admins (locked down by default).
 */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowlist = env.STOCKPILOT_PLATFORM_ADMIN_EMAILS;
  if (!allowlist) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return allowlist.split(',').includes(normalized);
}
