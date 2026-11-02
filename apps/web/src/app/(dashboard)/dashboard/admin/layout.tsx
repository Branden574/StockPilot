import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { requireOrgContext } from '@/lib/auth/session';
import { can } from '@stockpilot/core';

/**
 * Hard guard: every page under /dashboard/admin requires the
 * `organization:update` permission. Owners and admins hold it by default,
 * and an owner or admin can give it to a manager, staff member or viewer
 * (Settings > Roles), so it is NOT the same audience as the admin role.
 * The guard stays on the permission: Bins, unit conversions and vendor
 * mappings sit under it with manager floors in the database, so a manager
 * given the permission can use them. Warehouses and charters ask the admin
 * role as well (core canEditOrganizationSetup, B99): their pages are
 * read-only for everyone else, and their services refuse.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'organization:update')) redirect('/dashboard');
  return <>{children}</>;
}
