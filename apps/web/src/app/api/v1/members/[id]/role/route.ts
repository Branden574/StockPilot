import { revalidatePath } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { isUuid } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { apiContextGate } from '@/server/lib/api-context-gate';
import { TeamService } from '@/server/services/team';

import {
  MEMBER_ID_INVALID_MESSAGE,
  membersErrorResponse,
  membersRateLimitedResponse,
} from '../../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The four roles a member can be given here. 'owner' is not one: ownership
// moves by transfer, so it is refused as a bad body, in the same words.
const bodySchema = z.object({
  role: z.enum(['admin', 'manager', 'staff', 'viewer']),
});

/**
 * PATCH /api/v1/members/[id]/role: change a member's role. Cookie or Bearer,
 * so the phone can call it. `[id]` is the membership id
 * (organization_members.id), in either case; it is lower-cased before use, so
 * the audit row names the member as the database spells the id.
 *
 * Body: `{ role }`, one of admin, manager, staff, viewer.
 *
 * The change is TeamService.updateMemberRole, as on the Team page, under the
 * caller's own session: members:update_role, the organization's authenticator
 * rule, the caller's role unchanged since the request began, never the
 * owner's row, never the caller's own row. The service writes the audit row
 * and sends the security event; this route writes neither. A save of the
 * role the member already has changes nothing and answers 200.
 *
 * Answers:
 *   200 `{ ok: true, role }`;
 *   400 `validation_error`: an id that is not a uuid, a body that is not
 *       JSON, or a role that is not one of the four ('owner' included);
 *   401 `unauthenticated`: no session, or a session that still owes its
 *       authenticator code (an account with an authenticator, signed in with
 *       the password alone). withApiContext refuses that session before
 *       anything is read, and the phone answers the 401 by asking for the
 *       code;
 *   403 `forbidden`, with the service's words: `details.reason` mfa_required
 *       for a caller with no authenticator when the organization requires
 *       one, or when its rule could not be read and is held to the strictest
 *       (a session at aal2 with an authenticator still passes);
 *   404 `not_found`: no such member in the caller's organization;
 *   409 `conflict`: the member was removed or changed meanwhile;
 *   429 `rate_limited`, with Retry-After (30 changes a minute per account);
 *   500 `internal_error`, with a fixed sentence;
 *   503 `check_failed`, with Retry-After 5 and details { reason:
 *       'context_unavailable', retryable, nothingWritten }: the caller's
 *       access could not be read, so the request was refused before anything
 *       here ran (the API context gate). The same request may be sent again.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // First, before the id, the rate limit, the body or the write: a context
  // that could not be built because the caller's access could not be read
  // answers the 503 a caller may send again (server/lib/api-context-gate.ts).
  const gate = await apiContextGate(req);
  if ('response' in gate) return gate.response;
  const ctx = gate.ctx;
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json(
      { error: 'validation_error', message: MEMBER_ID_INVALID_MESSAGE },
      { status: 400 },
    );
  }
  const memberId = id.toLowerCase();

  const rl = await checkRateLimit(`member-role:${ctx.userId}`, 30, 60_000);
  if (!rl.allowed) return membersRateLimitedResponse(rl.resetAt);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'validation_error', message: 'The request body is not valid JSON.' },
      { status: 400 },
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Choose a role: admin, manager, staff or viewer.' },
      { status: 400 },
    );
  }

  try {
    await new TeamService(ctx).updateMemberRole(memberId, parsed.data.role);
  } catch (e) {
    return membersErrorResponse(e, 'api.v1.members.role', ctx.organizationId);
  }

  // The Team page lists roles; the web action refreshes it too. The change is
  // saved by now, so a refresh that fails is reported, never answered.
  try {
    revalidatePath('/dashboard/team');
  } catch (e) {
    void reportError(e, {
      tag: 'api.v1.members.role.revalidate',
      organizationId: ctx.organizationId,
    });
  }
  return NextResponse.json({ ok: true, role: parsed.data.role });
}
