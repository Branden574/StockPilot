import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { isUuid } from '@stockpilot/core';

import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { apiContextGate } from '@/server/lib/api-context-gate';
import { ordersCatalogTag } from '@/server/services/lib/order-catalog-hidden';
import { UserCategoriesService } from '@/server/services/user-categories';

import {
  MEMBER_ID_INVALID_MESSAGE,
  membersErrorResponse,
  membersRateLimitedResponse,
} from '../../error-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Strict: one category and one flag, and no other key. A list of categories
// is refused, not ignored, so no caller can believe it replaced a set.
const bodySchema = z
  .object({
    categoryId: z.string().refine(isUuid),
    granted: z.boolean(),
  })
  .strict();

/**
 * POST /api/v1/members/[id]/category-access: grant or revoke ONE category for
 * ONE member. Cookie or Bearer, so the phone can call it, once per box
 * ticked. `[id]` is the membership id (organization_members.id), in either
 * case; it and the category id are lower-cased before use.
 *
 * Body: `{ categoryId, granted }`, and nothing else. `granted: true` adds the
 * grant, `false` removes it. The member's other grants are not in the request
 * and are not touched: the server changes the one row
 * (UserCategoriesService.setMemberCategoryGrant), so another person's change
 * to another category of the same member is kept whatever this caller's
 * screen showed.
 *
 * Who: members:assign_categories and the manager role, the organization's
 * authenticator rule, the member and (for a grant) the category in the
 * caller's organization. The service writes the one
 * user.category_access.updated audit row when something changed; this route
 * writes none.
 *
 * Answers:
 *   200 `{ ok: true, changed, granted, categoryIds }`. `changed` is false
 *       when the grant was already there or there was nothing to revoke.
 *       `categoryIds` is the member's grants after the request, read on the
 *       server (null if that read failed): an empty list means the member is
 *       not restricted to categories;
 *   400 `validation_error`: an id that is not a uuid, a body that is not
 *       JSON, or a body that is not exactly `{ categoryId, granted }`;
 *   401 `unauthenticated`: no session, or a session that still owes its
 *       authenticator code (an account with an authenticator, signed in with
 *       the password alone). withApiContext refuses that session before
 *       anything is read, and the phone answers the 401 by asking for the
 *       code;
 *   403 `forbidden`, with the service's words: `details.reason` mfa_required
 *       for a caller with no authenticator when the organization requires
 *       one, or when its rule could not be read and is held to the strictest
 *       (a session at aal2 with an authenticator still passes);
 *   404 `not_found`: no such member, or no such category, in the caller's
 *       organization;
 *   409 `conflict`: the grant changed meanwhile; reload and try again;
 *   429 `rate_limited`, with Retry-After (120 changes a minute per account);
 *   500 `internal_error`, with a fixed sentence;
 *   503 `check_failed`, with Retry-After 5 and details { reason:
 *       'context_unavailable', retryable, nothingWritten }: the caller's
 *       access could not be read, so the request was refused before anything
 *       here ran (the API context gate). The same request may be sent again.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const rl = await checkRateLimit(`member-category-access:${ctx.userId}`, 120, 60_000);
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
      {
        error: 'validation_error',
        message: 'Send one category id and whether it is granted, and nothing else.',
      },
      { status: 400 },
    );
  }
  const categoryId = parsed.data.categoryId.toLowerCase();
  const { granted } = parsed.data;

  let result: Awaited<ReturnType<UserCategoriesService['setMemberCategoryGrant']>>;
  try {
    result = await new UserCategoriesService(ctx).setMemberCategoryGrant(
      memberId,
      categoryId,
      granted,
    );
  } catch (e) {
    return membersErrorResponse(e, 'api.v1.members.category_access', ctx.organizationId);
  }

  if (result.changed) {
    // What the web action refreshes after a category-access change: the order
    // catalog entries cached per access, and the pages that list by category.
    // The change is saved by now, so a refresh that fails is reported, never
    // answered.
    try {
      // This organization's catalog entries only ('max': see the web action
      // in actions/user-categories.ts; the access key is resolved live).
      revalidateTag(ordersCatalogTag(ctx.organizationId), 'max');
      revalidatePath('/dashboard/inventory');
      revalidatePath('/dashboard/books');
      revalidatePath('/dashboard/team');
    } catch (e) {
      void reportError(e, {
        tag: 'api.v1.members.category_access.revalidate',
        organizationId: ctx.organizationId,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    changed: result.changed,
    granted,
    categoryIds: result.categoryIds,
  });
}
