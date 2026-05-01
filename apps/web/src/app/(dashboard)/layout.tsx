import type { ReactNode } from 'react';

import { DashboardShell } from '@/components/dashboard/dashboard-shell';
import { requireOrgContext } from '@/lib/auth/session';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Cached: this resolves with the same data the page will use in the
  // same render — zero extra DB round trips beyond the page's own.
  const ctx = await requireOrgContext();

  return (
    <DashboardShell
      email={ctx.email}
      fullName={ctx.fullName}
      avatarUrl={ctx.avatarUrl}
      organizationName={ctx.organizationName}
      userName={ctx.fullName ?? ctx.email}
      userRole={`${ctx.role.charAt(0).toUpperCase() + ctx.role.slice(1)} · ${ctx.organizationName}`}
    >
      {children}
    </DashboardShell>
  );
}
