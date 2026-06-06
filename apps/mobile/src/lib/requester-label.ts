/**
 * Resolve an order's requester display name on mobile, mirroring the web's
 * `summaryRequesterLabel` + `OrderRequestsService` join.
 *
 * Internal team members place orders with `requester_name` / `requester_email`
 * left NULL on the row — their name lives in their `user_profiles` row, resolved
 * via the `user_profiles!requester_user_id` embed (RLS lets org members read each
 * other). Only EXTERNAL/public requesters denormalize name+email onto the row.
 * Without the profile fallback those team-member orders showed "Unknown
 * requester" in the app.
 */
export type RequesterProfile = { full_name: string | null; email: string | null };

/** Normalize a PostgREST embed (`requester:user_profiles!...`) which can arrive
 *  as an object or a single-element array. */
export function profileFromEmbed(embed: unknown): RequesterProfile | null {
  const p = Array.isArray(embed) ? embed[0] : embed;
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  return {
    full_name: typeof o.full_name === 'string' ? o.full_name : null,
    email: typeof o.email === 'string' ? o.email : null,
  };
}

export function resolveRequesterLabel(args: {
  requesterName: string | null;
  requesterEmail: string | null;
  requesterUserId: string | null;
  profile: RequesterProfile | null;
}): string {
  const name = args.requesterName?.trim() || args.profile?.full_name?.trim() || '';
  const email = args.requesterEmail?.trim() || args.profile?.email?.trim() || '';
  return name || email || (args.requesterUserId ? 'Team member' : 'External requester');
}
