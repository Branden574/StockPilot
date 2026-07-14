import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { assertPermission, ServiceError, serviceErrorStatus } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Mobile "Restore" — the REST parity for web's archived-item restore, which
 * today only runs as a Next.js Server Action (bulkUpdateInventoryAction →
 * InventoryService.bulkUpdate({op:{kind:'unarchive'}})) invoked from
 * bulk-actions.tsx over Next's internal RSC action protocol tied to the
 * browser session — not a stable HTTP contract the mobile Bearer-token
 * client can call. This route gives it one.
 *
 * Why mobile MUST go through the service and not a raw client `.update()`:
 * bulkUpdate (a) asserts the 'items:update' PERMISSION (a viewer/staff
 * member without it could otherwise flip status straight through
 * PostgREST — restore is reversible but still a real inventory-state
 * change, same gate as the web settings/archive path), (b) clears
 * `auto_archived` on restore so a later PO receipt's system-only revive
 * logic (receiving.ts's maybeAutoUnarchive, which only acts on rows the
 * ZERO-STOCK CRON auto-archived) can't be fooled by a stale flag left
 * over from a human-initiated restore, and (c) writes the
 * `inventory.item.restored` audit event so the Recovery page's "View
 * history" stays accurate. None of that happens on a bare client update.
 *
 * Body: none — restore is a single boolean flip, unlike transfer's
 * quantity/destination payload.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Per-user throttle — defense-in-depth on top of the service's items:update
  // gate, matching transfer's rate limit (60/min is far above a human tapping
  // through restores).
  const rl = await checkRateLimit(`items-restore:${ctx.userId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Too many requests — slow down.' },
      {
        status: 429,
        headers: {
          'retry-after': String(Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000))),
        },
      },
    );
  }

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Invalid item id.' },
      { status: 400 },
    );
  }

  try {
    // Fail-fast on authorization BEFORE touching the service — mirrors
    // transfer's ordering. bulkUpdate re-asserts 'items:update' internally
    // (defense in depth), same relationship as transfer/stock:transfer.
    assertPermission(ctx, 'items:update');

    const svc = new InventoryService(ctx);
    const res = await svc.bulkUpdate({ ids: [id], op: { kind: 'unarchive' } });

    // `ok` is 0 when the item wasn't found in-org, was already filtered by
    // RLS, or sits in a warehouse this user can't write to (bulkUpdate's
    // per-row warehouse-access check) — surface that as 404 rather than a
    // silent "success" the client would wrongly optimistic-update on.
    if (res.ok === 0) {
      return NextResponse.json(
        { error: 'not_found', message: 'Item not found, or you cannot write to its warehouse.' },
        { status: 404 },
      );
    }

    // Restoring flips status archived → active, which changes which tab
    // (Items vs the Archived filter) the item shows up under — refresh the
    // org's cached Items/Books list so it doesn't linger under the old
    // filter, same rationale as transfer's post-move revalidate.
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof ServiceError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: serviceErrorStatus(e.code) },
      );
    }
    void reportError(e, { tag: 'api.v1.items.restore' });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
