import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { Sidebar } from '@/components/dashboard/sidebar';
import { Topbar } from '@/components/dashboard/topbar';
import { requireSession } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const supabase = await createClient();

  // Find any membership; if none, the user needs onboarding.
  const { data: memberships } = await supabase
    .from('organization_members')
    .select('organization_id, role, organizations:organization_id (id, name, slug)')
    .eq('user_id', session.userId)
    .not('accepted_at', 'is', null)
    .limit(5);

  if (!memberships || memberships.length === 0) {
    redirect('/onboarding');
  }

  const active =
    memberships.find((m) => m.organization_id === session.defaultOrganizationId) ?? memberships[0];
  const orgs = active?.organizations as { name?: string } | { name?: string }[] | null | undefined;
  const orgObj = Array.isArray(orgs) ? orgs[0] : orgs;
  const orgName = orgObj?.name ?? 'Workspace';
  const role = (active?.role as string | undefined) ?? 'Member';

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        className="hidden lg:flex"
        organizationName={orgName}
        userName={session.fullName ?? session.email}
        userRole={`${role.charAt(0).toUpperCase() + role.slice(1)} · ${orgName}`}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          email={session.email}
          fullName={session.fullName}
          avatarUrl={session.avatarUrl}
          organizationName={orgName}
        />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
