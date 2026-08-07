import { NextResponse, type NextRequest } from 'next/server';

import { can } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { fetchAcceptedMembers } from '@/server/lib/maintenance-members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Roster for the mobile assign-owner picker — mirrors the web
 * AssignOwnerSelect's data source (fetchAcceptedMembers, lifted into
 * server/lib/maintenance-members.ts in this same task so the page and this
 * route share exactly ONE query).
 *
 * A STATIC `members` segment living alongside the DYNAMIC `[id]` segment at
 * the same directory level — the App Router always prefers the static
 * match for a literal `/maintenance-requests/members` request, so this
 * route is reached correctly and `[id]/route.ts` never sees "members" as an
 * id. It would fail that route's own uuid check regardless if it somehow
 * did.
 *
 * manage-gated directly here via `can()` (no service call —
 * fetchAcceptedMembers is a shared QUERY, not a service method), matching
 * the orders drivers-roster route's precedent
 * (api/v1/orders/[id]/drivers/route.ts): only a manage-holder may pull the
 * org roster to assign a local owner. Returns an ALLOW-LIST projection
 * only — userId + display name, never email/role/raw member row — so a
 * cross-org or over-privileged read here can leak at most a name.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!can(ctx, 'maintenance_requests:manage')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const members = await fetchAcceptedMembers(ctx);
    return NextResponse.json({ members });
  } catch (e) {
    void reportError(e, { tag: 'api.v1.maintenance-requests.members' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
