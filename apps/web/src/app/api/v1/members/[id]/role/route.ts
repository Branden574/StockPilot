import { revalidatePath } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { isUuid, ROLES } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { TeamService } from '@/server/services/team';

import {
  MEMBER_ID_INVALID_MESSAGE,
  membersErrorResponse,
  membersRateLimitedResponse,
} from '../../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  role: z.enum(ROLES),
});

/**
 * PATCH /api/v1/members/[id]/role: change a member's role. Cookie or Bearer,
 * so the phone can call it. `[id]` is the membership id
 * (organization_members.id), in either case; it is lower-cased before use, so
 * the audit row names the member as the database spells the id.
 *
 * Body: `{ role }`, one of owner, admin, manager, staff, viewer.
 *
 * The change is TeamService.updateMemberRole, as on the Team page, under the
 * caller's own session: members:update_role, the organization's authenticator
 * rule, the caller's role unchanged since the request began, never 'owner'
 * (ownership moves by transfer), never the owner's row, never the caller's
 * own row. The service writes the audit row and sends the security event;
 * this route writes neither. A save of the role the member already has
 * changes nothing and answers 200.
 *
 * Answers:
 *   200 `{ ok: true, role }`;
 *   400 `validation_error`: an id that is not a uuid, a body that is not
 *       JSON, or a role that is not one of the five;
 *   401 `unauthenticated`;
 *   403 `forbidden` (`details.reason` aal2_required or mfa_required when the
 *       authenticator rule refused);
 *   404 `not_found`: no such member in the caller's organization;
 *   409 `conflict`: the member was removed or changed meanwhile;
 *   429 `rate_limited`, with Retry-After (30 changes a minute per account);
 *   500 `internal_error`, with a fixed sentence.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
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
