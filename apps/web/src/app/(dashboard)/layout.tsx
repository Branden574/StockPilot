import type { ReactNode } from 'react';

import { Sidebar } from '@/components/dashboard/sidebar';
import { Topbar } from '@/components/dashboard/topbar';
import { requireOrgContext } from '@/lib/auth/session';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  // Cached: this resolves with the same data the page will use in the
  // same render — zero extra DB round trips beyond the page's own.
  const ctx = await requireOrgContext();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        className="hidden lg:flex"
        organizationName={ctx.organizationName}
        userName={ctx.fullName ?? ctx.email}
        userRole={`${ctx.role.charAt(0).toUpperCase() + ctx.role.slice(1)} · ${ctx.organizationName}`}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          email={ctx.email}
          fullName={ctx.fullName}
          avatarUrl={ctx.avatarUrl}
          organizationName={ctx.organizationName}
        />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
