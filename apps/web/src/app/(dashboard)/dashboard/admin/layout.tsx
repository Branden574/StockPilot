import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { requireOrgContext } from '@/lib/auth/session';
import { can } from '@stockpilot/core';

/**
 * Hard guard: every page under /dashboard/admin requires owner or admin
 * role. Gated on the `organization:update` permission (admin+ in the
 * matrix) rather than `isAdminRole()` so routing flows through the
 * permission matrix consistently — same audience today, but role surgery
 * stays a one-line matrix change.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'organization:update')) redirect('/dashboard');
  return <>{children}</>;
}
