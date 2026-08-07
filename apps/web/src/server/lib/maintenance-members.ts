import 'server-only';

import type { MaintenanceOwnerOption } from '@/components/maintenance/assign-owner-select';
import type { ServiceContext } from '@/server/services/context';

/**
 * organization_members embedding user_profiles!user_id, filtered to
 * accepted members — same query cycle-counts/new/page.tsx:36-57 uses for its
 * own assignee picker.
 *
 * Lifted out of the web detail page (Task 8, Maintenance Resolved) so the
 * page and the mobile assign-owner picker's Bearer route
 * (api/v1/maintenance-requests/members/route.ts) share exactly ONE query
 * instead of two copies that could silently drift apart. Backs the web owner
 * picker + note-author name resolution AND the mobile members list.
 *
 * This module does NO permission check of its own — every caller is
 * manage-gated BEFORE reaching it (the web page's `if (canManage)` branch;
 * the route's `can(ctx, 'maintenance_requests:manage')` check). It also
 * returns an ALLOW-LIST projection only (`userId` + display `name`) — never
 * email, role, or the raw member row — so a caller that reaches this
 * function can leak at most a name, never a credential-adjacent field.
 */
export async function fetchAcceptedMembers(ctx: ServiceContext): Promise<MaintenanceOwnerOption[]> {
  const { data: rawMembers } = await ctx.supabase
    .from('organization_members')
    .select('user_id, user:user_profiles!user_id (id, full_name, email)')
    .eq('organization_id', ctx.organizationId)
    .not('accepted_at', 'is', null);
  type MemberRow = {
    user_id: string;
    user:
      | { id: string; full_name: string | null; email: string }
      | { id: string; full_name: string | null; email: string }[]
      | null;
  };
  return ((rawMembers ?? []) as MemberRow[])
    .map((row) => {
      const u = Array.isArray(row.user) ? row.user[0] : row.user;
      if (!u) return null;
      return { userId: u.id, name: u.full_name ?? u.email };
    })
    .filter((m): m is MaintenanceOwnerOption => Boolean(m))
    .sort((a, b) => a.name.localeCompare(b.name));
}
