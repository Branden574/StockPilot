import { NextResponse, type NextRequest } from 'next/server';

import { GROUPING_ERROR_TABLE, GROUPING_ERROR_WORDS } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { ItemGroupingService } from '@/server/services/item-grouping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Group selected, Remove from group and Rename from the phone: the REST twin
 * of the web action applyGroupingAction, over the same service
 * (ItemGroupingService) and database function (apply_item_grouping,
 * migration 0400). Bearer (the phone) or cookie. Online only: the phone never
 * queues it.
 *
 * Body: core's GroupingBody (parseGroupingBody refuses anything else):
 *   { action: 'group', idempotencyKey, organizationId, actorUserId, itemIds,
 *     target: { kind: 'new', name } | { kind: 'existing', groupId,
 *     expectedVersion }, expectedGroups, moveItemIds?, acknowledgeProductFamily? }
 *   { action: 'remove', idempotencyKey, organizationId, actorUserId, itemIds,
 *     expectedGroups }
 *   { action: 'rename', idempotencyKey, organizationId, actorUserId, groupId,
 *     expectedVersion, name }
 * The key is minted once per Save and sent again, with the SAME body, by every
 * retry; the organization and the actor must be the ones this request runs as.
 *
 * 200 { organizationId, result: GroupingOutcome } (replay true: the key had
 *     already applied; outcome 'noop': nothing needed writing)
 * Refusals { error, message, details: { reason, itemIds?, field?, retryable? } },
 * core's words (design 3.4 mapping): 400 validation_error; 401
 * unauthenticated; 403 forbidden (permission, item_not_writable, not_member,
 * actor_mismatch, workspace_changed, rename_not_permitted, MFA); 404 not_found
 * (item_not_found, group_not_found); 409 conflict (idempotency_conflict,
 * item_changed, membership_changed, membership_conflict,
 * product_family_conflict, mixed_item_types, group_changed, group_too_large,
 * not_groupable); 429 rate_limited (retry-after); 503 busy (details.retryable:
 * send the same body and key again); 500 internal_error (no detail).
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json(
      { error: 'unauthenticated', message: GROUPING_ERROR_WORDS.unauthenticated },
      { status: 401 },
    );
  }

  // The same per-user bucket as Ungroup and the web actions: grouping writes,
  // 30 a minute (design 3.4). The limiter fails open; the key stops duplicates.
  const rl = await checkRateLimit(`item-grouping:${ctx.userId}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: GROUPING_ERROR_WORDS.rateLimited },
      {
        status: 429,
        headers: {
          'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
        },
      },
    );
  }

  const raw: unknown = await req.json().catch(() => null);
  try {
    const answer = await new ItemGroupingService(ctx).applyGrouping(raw, 'app');
    return NextResponse.json({ organizationId: answer.organizationId, result: answer.outcome });
  } catch (e) {
    if (e instanceof ServiceError && e.code !== 'internal_error') {
      const reason = typeof e.details?.reason === 'string' ? e.details.reason : null;
      const status = (reason && GROUPING_ERROR_TABLE[reason]?.status) || serviceErrorStatus(e.code);
      return NextResponse.json(
        { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
        { status },
      );
    }
    void reportError(e, { tag: 'api.v1.items.grouping', organizationId: ctx.organizationId });
    return NextResponse.json(
      { error: 'internal_error', message: GROUPING_ERROR_WORDS.internal },
      { status: 500 },
    );
  }
}
