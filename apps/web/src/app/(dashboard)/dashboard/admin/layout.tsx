import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { requireOrgContext } from '@/lib/auth/session';
import { isAdminRole } from '@stockpilot/core';

/**
 * Hard guard: every page under /dashboard/admin requires owner or admin
 * role. Non-admin users are bounced to the regular dashboard. The
 * Admin section in the sidebar is also hidden from them, but this layout
 * is the actual security boundary.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const ctx = await requireOrgContext();
  if (!isAdminRole(ctx.role)) redirect('/dashboard');
  return <>{children}</>;
}
