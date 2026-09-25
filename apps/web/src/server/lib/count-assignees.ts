import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * WHO A CYCLE COUNT CAN BE ASSIGNED TO: the org's accepted members, named by
 * full name else email, sorted by name.
 *
 * One query for every assignee picker a count has (pattern #26): the Start a
 * count screen (selection-confirm.tsx), the count's own detail page, and the
 * recount dialog the Exception Center and the item page open (F1-2). They
 * used to paste the same organization_members read into each page.
 *
 * The read runs on the CALLER's client, so organization_members RLS scopes it
 * to their orgs and the org filter pins it to this one. It does no permission
 * check of its own: every caller is gated on cycle_counts:assign before it
 * gets here, and assign_cycle_count re-checks the assignee (invalid_assignee).
 *
 * A failed read THROWS. The two pages that always showed an empty list on a
 * failure keep doing so by catching; the recount dialog says the list could
 * not be loaded instead of offering "Unassigned" as if nobody else existed.
 */
export interface CountAssignee {
  id: string;
  name: string;
  email: string;
}

export async function fetchCountAssignees(
  supabase: Pick<SupabaseClient, 'from'>,
  organizationId: string,
): Promise<CountAssignee[]> {
  const { data, error } = await supabase
    .from('organization_members')
    .select('user_id, user:user_profiles!user_id (id, full_name, email)')
    .eq('organization_id', organizationId)
    .not('accepted_at', 'is', null);
  if (error) throw new Error(`organization_members read failed: ${error.message}`);
  type MemberRow = {
    user_id: string;
    user:
      | { id: string; full_name: string | null; email: string }
      | { id: string; full_name: string | null; email: string }[]
      | null;
  };
  return ((data ?? []) as MemberRow[])
    .map((row) => {
      const u = Array.isArray(row.user) ? row.user[0] : row.user;
      if (!u) return null;
      return { id: u.id, name: u.full_name ?? u.email, email: u.email };
    })
    .filter((m): m is CountAssignee => Boolean(m))
    .sort((a, b) => a.name.localeCompare(b.name));
}
