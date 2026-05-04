import { TeamManager } from '@/components/team/team-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { ChartersService } from '@/server/services/charters';
import { TeamService } from '@/server/services/team';
import { WarehousesService } from '@/server/services/warehouses';
import { createClient } from '@/lib/supabase/server';
import { env } from '@/lib/env';

import { resolveTerminology, type Role } from '@stockpilot/core';

export default async function TeamPage() {
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const [team, charterSvc, warehouseSvc, orgRow] = await Promise.all([
    TeamService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    WarehousesService.forCurrentUser(),
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
  ]);

  const [members, invites, chartersList, warehousesList] = await Promise.all([
    team.listMembers(),
    team.listPendingInvites(),
    charterSvc.list(),
    warehouseSvc.list(),
  ]);

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
          acceptUrl: `${env.NEXT_PUBLIC_APP_URL}/invite/${i.token as string}`,
        }))}
        charters={chartersList.map((c) => ({ id: c.id, name: c.name }))}
        warehouses={warehousesList.map((w) => ({
          id: w.id,
          name: w.name,
          charter_id: w.charter_id,
        }))}
        charterSingular={terminology.charter_singular}
        warehouseSingular={terminology.warehouse_singular}
      />
    </div>
  );
}
