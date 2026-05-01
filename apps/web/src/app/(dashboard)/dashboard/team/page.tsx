import { TeamManager } from '@/components/team/team-manager';
import { requireOrgContext } from '@/lib/auth/session';
import { TeamService } from '@/server/services/team';
import { env } from '@/lib/env';

import type { Role } from '@stockpilot/core';

export default async function TeamPage() {
  const [ctx, svc] = await Promise.all([requireOrgContext(), TeamService.forCurrentUser()]);
  const [members, invites] = await Promise.all([svc.listMembers(), svc.listPendingInvites()]);

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
      />
    </div>
  );
}
