/**
 * The org's members with their profiles, for Users (admin), Team and the
 * cycle-count reassign sheet.
 *
 * Two reads, because organization_members has TWO foreign keys into
 * user_profiles (user_id and invited_by), which makes the PostgREST embed
 * ambiguous: organization_members, then user_profiles by id.
 *
 * THE BUG THIS REPLACES. Each screen made the two reads itself, put every
 * member id in one unbatched `.in('id', ids)` URL, and only logged (or, in the
 * reassign sheet, never read) either error:
 *
 * - a failed members read showed "No users yet." / "No team yet.";
 * - a failed profile read showed every member as "Unnamed", with no DISABLED
 *   badge, and still offered the role picker on those rows;
 * - the reassign sheet builds its list FROM the profiles, and supabase-js
 *   returns an error rather than throwing, so its `catch` never fired: a
 *   failed read showed "No other team members to assign." and the count could
 *   not be reassigned.
 *
 * NOW: loadOrgMembers THROWS when either read fails (the members read is
 * paged, the profile read batched), so each screen shows a failed load it can
 * retry instead of a list built on an error.
 *
 * Pure: the screens pass `supabase` in. Do not import ./supabase here.
 */

import {
  fetchAllPages,
  idReadSelect,
  type IdReadClient,
  type PageResult,
} from './id-batches';
import { readProfilesByIds } from './id-reads';

export interface OrgMemberRow {
  user_id: string;
  role: string;
  accepted_at: string | null;
  created_at: string | null;
}

/**
 * Every member of `orgId` (pending first, then most recently accepted, as the
 * screens always listed them), and the profiles of those members keyed by
 * user id. Throws IdBatchReadError if either read fails; never a partial or
 * empty answer standing in for an error.
 */
export async function loadOrgMembers<P extends { id: string }>(
  client: IdReadClient,
  orgId: string,
  opts: { profileColumns: string; acceptedOnly?: boolean },
): Promise<{ members: OrgMemberRow[]; profiles: Map<string, P> }> {
  const members = await fetchAllPages<OrgMemberRow>((from, to) => {
    let q = idReadSelect(client, 'organization_members', 'id, user_id, role, accepted_at, created_at')
      .eq('organization_id', orgId);
    if (opts.acceptedOnly) q = q.not('accepted_at', 'is', null);
    return q
      .order('accepted_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to) as PromiseLike<PageResult<OrgMemberRow>>;
  });
  const profiles = await readProfilesByIds<P>(
    client,
    members.map((m) => m.user_id),
    opts.profileColumns,
  );
  return { members, profiles };
}

/** Each member with its profile (null when it has none), in member order. */
export function joinMemberProfiles<P extends { id: string }>(
  members: readonly OrgMemberRow[],
  profiles: ReadonlyMap<string, P>,
): { member: OrgMemberRow; profile: P | null }[] {
  return members
    .filter((m) => Boolean(m.user_id))
    .map((member) => ({ member, profile: profiles.get(member.user_id) ?? null }));
}

export interface ReassignCandidate {
  userId: string;
  name: string;
  role: string;
}

/**
 * The reassign sheet's list: members that have a profile, named by full name,
 * then email, sorted by name. Unchanged from the sheet's own loop.
 */
export function buildReassignCandidates(
  members: readonly OrgMemberRow[],
  profiles: ReadonlyMap<string, { id: string; full_name: string | null; email: string | null }>,
): ReassignCandidate[] {
  const list: ReassignCandidate[] = [];
  for (const m of members) {
    const p = profiles.get(m.user_id);
    if (!p) continue;
    list.push({ userId: p.id, name: p.full_name ?? p.email ?? 'Unnamed', role: m.role ?? 'staff' });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}
