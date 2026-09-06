import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { ReceivingService } from '@/server/services/receiving';
import { ServiceError } from '@/server/services/context';

import { postReceiptSchema } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Multi-line PO receipt — the Bearer twin of `postReceiptAction` (the web
 * receive dialog's server action).
 *
 * WHY THIS ROUTE EXISTS (SP-007b). The mobile PO screen used to call the
 * `post_receipt_v2` RPC DIRECTLY through supabase-js. The RPC writes the
 * receipt and the stock correctly, so nothing looked broken — but every side
 * effect `ReceivingService.postReceipt` performs AROUND the RPC was skipped
 * for any delivery received on a phone:
 *
 *   • no `stock.receipt.posted` audit row (invisible in Activity / the
 *     Exception Center),
 *   • no `publish_outbox('receipt.posted')` — and `receipt.posted` is in the
 *     QuickBooks connector's subscribedTopics, so phone receipts never
 *     reached accounting,
 *   • no `dispatchEvent('po.received')` — webhooks/Slack/Teams stayed silent,
 *   • no auto-unarchive of items the zero-stock cron had archived,
 *   • no inventory-list cache revalidation.
 *
 * Routing the phone through the service instead of the RPC closes all of
 * them at once. The RPC's own guards (manager role, idempotency, lot/serial
 * rules) still apply underneath — this adds the surrounding contract, it does
 * not replace anything.
 *
 * RELEASE ORDER: this route must be LIVE before the mobile OTA ships, or an
 * updated bundle posts into a 404. Older binaries keep using the RPC until
 * they update, which still works — the change is additive.
 */

/**
 * The body is the shared `postReceiptSchema` with two deliberate deltas:
 *
 *  1. `purchaseOrderId` comes from the PATH, not the body, so a caller can
 *     never receive against a different PO than the URL it posted to.
 *  2. `idempotencyKey` is NOT a uuid here. The mobile screen mints
 *     `mobile-<poId>-<ts>-<rand>` (a human-readable intent id it can keep in
 *     a ref across retries) and `idempotency_keys.key` / the RPC's
 *     `p_idempotency_key` are plain `text` (0296:45). Pinning `.uuid()` here
 *     — the obvious copy from the web action — would 400 EVERY receipt taken
 *     on a phone. Bounded in length instead, since it is stored verbatim.
 *
 * Everything else (the per-line refine, the serial `.trim()` landmine, lots)
 * is inherited so the two clients cannot drift.
 */
const bodySchema = postReceiptSchema
  .omit({ purchaseOrderId: true, idempotencyKey: true })
  .extend({ idempotencyKey: z.string().trim().min(8).max(200) });

/**
 * The mobile screen's recovery policy differs for exactly ONE of the three
 * refusals that arrive as `conflict`:
 *
 *   • `idempotency_conflict` — the FIRST post committed and its ack was lost;
 *     the phone must retire the intent key AND reload the PO, or it will hit
 *     the same wall forever (that is the bug wave 1 closed in
 *     receipt-post-error.ts).
 *   • `po_already_closed` and a duplicate serial — nothing was written, so
 *     the key must be KEPT for a straight retry.
 *
 * HTTP 409 cannot tell them apart, so hand back a machine-readable reason.
 * `ApiError` on the phone carries `details` through verbatim, which is the
 * channel designed for exactly this (app-authored structured metadata).
 *
 * It is matched off the service's own conflict message because
 * `ReceivingService` throws all three as a bare `ServiceError('conflict', …)`
 * with no structured code. The cleaner fix is for the service to attach
 * `details: { reason: 'idempotency_conflict' }` at the throw site; until it
 * does, this mapping lives here and is pinned by route.test.ts — including a
 * negative case proving the closed-PO conflict is NOT tagged.
 */
function conflictReason(e: ServiceError): { reason: string } | undefined {
  if (e.code !== 'conflict') return undefined;
  return /idempotency key/i.test(e.message)
    ? { reason: 'idempotency_conflict' }
    : undefined;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await withApiContext(req);
  if (!ctx) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { id: poId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(poId)) {
    return NextResponse.json({ error: 'invalid_po_id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'validation_error',
        message: parsed.error.issues[0]?.message ?? 'Invalid input',
      },
      { status: 400 },
    );
  }

  try {
    const svc = new ReceivingService(ctx);
    const receipt = await svc.postReceipt({
      ...parsed.data,
      purchaseOrderId: poId,
    });
    // Mirrors postReceiptAction: the Items list is cached per org and a
    // receipt changes on-hand, so the next read must see the write
    // (expire:0, not stale-while-revalidate — recurring pattern #12).
    revalidateInventoryList(ctx.organizationId);
    return NextResponse.json({
      receiptId: receipt.id,
      receiptNumber: receipt.receipt_number,
      receiptStatus: receipt.status,
      lineCount: parsed.data.lines.length,
    });
  } catch (e) {
    if (e instanceof ServiceError) {
      // Every code the service can actually raise is mapped. An unmapped one
      // falling through to 500 reads to the phone as "the server is broken,
      // retry" — and a retry loop on a permanent refusal is exactly the
      // failure mode recurring pattern #28 describes. Mirrors the sibling
      // receive-line route: a module/plan refusal is an ACCESS answer (403),
      // not a state conflict.
      const status =
        e.code === 'conflict'
          ? 409
          : e.code === 'forbidden' ||
              e.code === 'module_disabled' ||
              e.code === 'plan_limit_exceeded'
            ? 403
            : e.code === 'not_found'
              ? 404
              : e.code === 'validation_error'
                ? 400
                : e.code === 'unauthenticated'
                  ? 401
                  : 500;
      const details = conflictReason(e) ?? (e.code !== 'internal_error' ? e.details : undefined);
      return NextResponse.json(
        {
          error: e.code,
          message: e.message,
          // APP-AUTHORED metadata only. `internal_error` details are raw
          // DB/PostgREST text and must stay server-side (S13).
          ...(details ? { details } : {}),
        },
        { status },
      );
    }
    void reportError(e, {
      tag: 'api.v1.po.receipts',
      organizationId: ctx.organizationId,
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
