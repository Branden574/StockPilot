import { TeamManager } from '@/components/team/team-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { ChartersService } from '@/server/services/charters';
import { TeamService } from '@/server/services/team';
import { WarehousesService } from '@/server/services/warehouses';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';
import { createClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';

import { resolveTerminology, type Role } from '@stockpilot/core';

export default async function TeamPage() {
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const [team, charterSvc, warehouseSvc, whCharterSvc, orgRow] = await Promise.all([
    TeamService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
  ]);

  const [
    members,
    invites,
    chartersList,
    warehousesList,
    warehouseCharters,
    categoriesRes,
    grantsRes,
  ] = await Promise.all([
    team.listMembers(),
    team.listPendingInvites(),
    charterSvc.list(),
    warehouseSvc.list(),
    whCharterSvc.listPairs(),
    // All active categories in this org — populates the viewer
    // category-access dialog. Sorted alphabetically for predictable UI.
    supabase
      .from('categories')
      .select('id, name')
      .eq('organization_id', ctx.organizationId)
      .is('deleted_at', null)
      .order('name', { ascending: true }),
    // All current grant rows for this org — keyed by user_id in the
    // map below so each viewer-row's dialog hydrates with its existing
    // selection. RLS-scoped on user_category_assignments restricts this
    // read to manager+ (which is the only role that gets to this page).
    supabase
      .from('user_category_assignments')
      .select('user_id, category_id')
      .eq('organization_id', ctx.organizationId),
  ]);

  const allCategories = ((categoriesRes.data ?? []) as Array<{
    id: string;
    name: string;
  }>).map((c) => ({ id: c.id, name: c.name }));

  const grantsByUser: Record<string, string[]> = {};
  for (const row of (grantsRes.data ?? []) as Array<{
    user_id: string;
    category_id: string;
  }>) {
    const list = grantsByUser[row.user_id] ?? [];
    list.push(row.category_id);
    grantsByUser[row.user_id] = list;
  }

  const terminology = resolveTerminology(
    (orgRow.data?.terminology as Partial<{
      charter_singular: string;
      warehouse_singular: string;
    }> | null) ?? null,
  );

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Invite, assign roles, and manage workspace access.
        </p>
      </div>
      <TeamManager
        currentUserRole={ctx.role}
        members={members.map((m) => ({
          id: m.id,
          userId: m.user_id,
          role: m.role as Role,
          invitedAt: m.invited_at,
          acceptedAt: m.accepted_at,
          email: m.user?.email ?? '—',
          fullName: m.user?.full_name ?? null,
          avatarUrl: m.user?.avatar_url ?? null,
        }))}
        pendingInvites={invites.map((i) => ({
          id: i.id as string,
          email: i.email as string,
          role: i.role as Role,
          expiresAt: i.expires_at as string,
          // Short /i/<token> alias — keeps the URL on one line in chat
          // clients (Teams/Slack) so the whole link stays clickable.
          // The /i route 308-redirects to /invite/<token>.
          acceptUrl: `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/i/${i.token as string}`,
        }))}
        charters={chartersList.map((c) => ({ id: c.id, name: c.name }))}
        warehouses={warehousesList.map((w) => ({ id: w.id, name: w.name }))}
        warehouseCharters={warehouseCharters}
        allCategories={allCategories}
        grantsByUser={grantsByUser}
        charterSingular={terminology.charter_singular}
        warehouseSingular={terminology.warehouse_singular}
      />
    </div>
  );
}
