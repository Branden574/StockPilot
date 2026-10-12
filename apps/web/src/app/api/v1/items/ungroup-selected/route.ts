import { NextResponse, type NextRequest } from 'next/server';

import { GROUPING_ERROR_TABLE, GROUPING_ERROR_WORDS } from '@stockpilot/core';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { ServiceError, serviceErrorStatus } from '@/server/services/context';
import { UngroupSelectedService } from '@/server/services/ungroup-selected';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ungroup anything from the phone (owner 2026-10-12): the REST twin of the web
 * action ungroupSelectedAction, over the same service (UngroupSelectedService),
 * which reuses the existing writes in a fixed order: remove from a display
 * group (apply_item_grouping), then the SKU split (split_item_sku), then the
 * size family unlink (unlinkItems). Bearer (the phone) or cookie. Online only:
 * the phone never queues it.
 *
 * Body: core's UngroupSelectedBody (parseUngroupSelectedBody refuses anything
 * else): { organizationId, actorUserId, remove: { idempotencyKey, itemIds,
 * expectedGroups } | null, split: { idempotencyKey, itemIds, expectedSkus,
 * anchorItemIds } | null, unlink: { itemIds, expectedFamilies } | null }. The
 * keys are minted once per Save and sent again, with the SAME body, by every
 * retry.
 *
 * 200 { organizationId, result: UngroupSelectedOutcome }: once a write may
 *     have run, the answer is always the per-step outcome (applied, refused,
 *     partly applied, not tried), never an error that hides what applied.
 * Refusals before any write { error, message, details: { reason, itemIds?,
 * field? } }, core's words: 400 validation_error; 401 unauthenticated; 403
 * forbidden (permission, family_permission, workspace_changed,
 * actor_mismatch, MFA); 404 not_found (a family record gone); 409 conflict
 * (family_changed); 429 rate_limited (retry-after); 500 internal_error.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json(
      { error: 'unauthenticated', message: GROUPING_ERROR_WORDS.unauthenticated },
      { status: 401 },
    );
  }

  // The same per-user bucket as every grouping write (30 a minute).
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
    const answer = await new UngroupSelectedService(ctx).apply(raw, 'app');
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
    void reportError(e, {
      tag: 'api.v1.items.ungroup-selected',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json(
      { error: 'internal_error', message: GROUPING_ERROR_WORDS.internal },
      { status: 500 },
    );
  }
}
