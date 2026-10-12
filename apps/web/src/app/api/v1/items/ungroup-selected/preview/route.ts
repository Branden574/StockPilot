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
 * Ungroup anything's review on the phone (owner 2026-10-12): the REST twin of
 * previewUngroupSelectedAction, over UngroupSelectedService.preview
 * (item_grouping_preview and the SKU preview, both read as the caller: RLS
 * decides every record it names). Reads only, so Cancel writes nothing. POST
 * so a selection of up to 100 ids never rides a URL.
 *
 * Body: { itemIds: string[] (1 to 100) }
 * 200 { organizationId, actorUserId, review, candidates, canUnlinkFamilies,
 *     previewKey } (Save sends the organization and the account back;
 *     previewKey says which selection the answer is for)
 * 400 validation_error; 401; 403 (permission, MFA); 429; 500.
 */
export async function POST(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json(
      { error: 'unauthenticated', message: GROUPING_ERROR_WORDS.unauthenticated },
      { status: 401 },
    );
  }

  const rl = await checkRateLimit(`item-grouping-preview:${ctx.userId}`, 60, 60_000);
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
  const itemIds =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).itemIds
      : undefined;
  if (!Array.isArray(itemIds) || !itemIds.every((id) => typeof id === 'string')) {
    return NextResponse.json(
      {
        error: 'validation_error',
        message: GROUPING_ERROR_WORDS.invalid,
        details: { reason: 'invalid', field: 'item_ids' },
      },
      { status: 400 },
    );
  }

  try {
    const answer = await new UngroupSelectedService(ctx).preview(itemIds as string[]);
    return NextResponse.json({
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      ...answer,
    });
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
      tag: 'api.v1.items.ungroup-selected.preview',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json(
      { error: 'internal_error', message: GROUPING_ERROR_WORDS.internal },
      { status: 500 },
    );
  }
}
