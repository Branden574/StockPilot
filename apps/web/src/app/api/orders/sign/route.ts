import { revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { sendOrderRequestEmail } from '@/lib/email/order-requests';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { maybeSendReturnPrompt } from '@/server/email/return-prompt';
import {
  notifyRequesterBackordered,
  notifyRequesterBackorderShipped,
  sendPartialReceiptEmail,
} from '@/server/lib/order-handover-notify';
import { dispatchEvent } from '@/server/services/integration-events';
import { syncOrderScheduleEvent } from '@/server/services/order-requests';

// Why a route handler instead of a Server Action: the public sign page
// renders <SignatureCollector /> only while `signed_at IS NULL`. A
// Server Action automatically triggers an RSC re-fetch of the calling
// route after returning — that re-render sees the row is now signed
// and swaps the collector for the "already signed" panel, unmounting
// the client component and obliterating its success state. A regular
// fetch() to this route handler is silent on the page tree, so the
// client component keeps showing its "Thank you" panel.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOKEN_RE = /^[0-9a-f]{64}$/i;
const DATA_URL_RE = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/;

const submitSchema = z.object({
  token: z.string().regex(TOKEN_RE),
  signerName: z.string().trim().min(1).max(120),
  signerEmail: z.string().trim().email().max(254),
  signatureDataUrl: z
    .string()
    .min(64)
    .max(500_000)
    .regex(DATA_URL_RE, 'Invalid signature image'),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: 'validation_error', message: 'Invalid request body' } },
      { status: 400 },
    );
  }

  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'validation_error',
          message: parsed.error.issues[0]?.message ?? 'Invalid input',
        },
      },
      { status: 400 },
    );
  }

  // Rate-limit per token. Closed mode: a DB outage denies rather than
  // unlocks unlimited submissions on a public endpoint.
  const rl = await checkRateLimit(
    `order-sign:${parsed.data.token}`,
    10,
    60 * 60 * 1000,
    'closed',
  );
  if (!rl.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'rate_limited',
          message: 'Too many attempts. Try again in a few minutes.',
        },
      },
      { status: 429 },
    );
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Server is missing SUPABASE_SERVICE_ROLE_KEY. Try again in a few minutes.',
        },
      },
      { status: 500 },
    );
  }

  const { data: row } = await admin
    .from('order_requests')
    .select(
      'id, organization_id, requester_user_id, requester_name, requester_email, fulfillment_type',
    )
    .eq('signature_token', parsed.data.token)
    .maybeSingle();
  if (!row) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'not_found', message: 'This signature link is invalid or expired.' },
      },
      { status: 404 },
    );
  }
  const order = row as {
    id: string;
    organization_id: string;
    requester_user_id: string | null;
    requester_name: string | null;
    requester_email: string | null;
    fulfillment_type: 'pickup' | 'delivery';
  };

  // Before the hand-over: how much had ALREADY shipped. >0 means a prior batch
  // went out (i.e. this order was resumed from backordered), so a completion now
  // is the "backordered remainder shipped" case rather than a first delivery.
  let priorFulfilled = 0;
  {
    const { data: priorLines } = await admin
      .from('order_request_lines')
      .select('quantity_fulfilled')
      .eq('order_request_id', order.id);
    priorFulfilled = ((priorLines ?? []) as { quantity_fulfilled: number | null }[]).reduce(
      (s, l) => s + (Number(l.quantity_fulfilled) || 0),
      0,
    );
  }

  const { data: confirmed, error } = await admin.rpc('confirm_order_signature', {
    p_id: order.id,
    p_signature_token: parsed.data.token,
    p_signer_name: parsed.data.signerName,
    p_signer_email: parsed.data.signerEmail,
    p_signature_data_url: parsed.data.signatureDataUrl,
  });
  if (error) {
    await reportError(error, {
      tag: 'orders.sign.rpc',
      extra: { orderId: order.id },
    });
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Signature could not be recorded. Please try again.',
        },
      },
      { status: 500 },
    );
  }
  if (!confirmed) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_found',
          message: 'This order is already signed, expired, or cannot be signed.',
        },
      },
      { status: 409 },
    );
  }

  // Hand-over decrements on-hand + consumes reservations — bust the
  // storefront catalog so the Place-an-Order avail pills update immediately.
  revalidateTag('orders-new-v2-catalog', 'max');

  // The hand-over either COMPLETED the order (owed 0) or forked it to
  // BACKORDERED (still owed units) — the 0244 fork. Read the resulting status
  // + line totals once and branch every downstream side effect on it: a
  // backordered hand-over is NOT a completion, so it must not mint a return
  // token, send a "completed" email, or fire order.completed.
  const { data: fullRow } = await admin
    .from('order_requests')
    .select('*')
    .eq('id', order.id)
    .single();
  const newStatus = (fullRow as { status?: string } | null)?.status ?? null;
  const isCompleted = newStatus === 'completed';
  const isBackordered = newStatus === 'backordered';

  const { data: aggLines } = await admin
    .from('order_request_lines')
    .select('quantity_requested, quantity_fulfilled')
    .eq('order_request_id', order.id);
  const aggRows = (aggLines ?? []) as {
    quantity_requested: number | null;
    quantity_fulfilled: number | null;
  }[];
  const totalRequested = aggRows.reduce((s, l) => s + (Number(l.quantity_requested) || 0), 0);
  const totalFulfilled = aggRows.reduce((s, l) => s + (Number(l.quantity_fulfilled) || 0), 0);
  const owed = Math.max(0, totalRequested - totalFulfilled);

  // Live tracking: purge the driver's live GPS point after this leg (best-effort).
  try {
    await admin.from('delivery_locations').delete().eq('order_request_id', order.id);
  } catch {
    /* non-fatal */
  }

  // Requester email opt-out (notification_preferences.email_order_completed,
  // 0113), computed ONCE and honored by BOTH the completion receipt and the
  // backorder notices — a requester who muted order emails stays muted for the
  // partial / backorder-shipped notices too. External requesters (no user row)
  // can't opt out and always get transactional mail.
  let requesterEmailOptedOut = false;
  if (order.requester_user_id && order.requester_email) {
    const { data: prefRow } = await admin
      .from('notification_preferences')
      .select('email_order_completed')
      .eq('user_id', order.requester_user_id)
      .maybeSingle();
    requesterEmailOptedOut =
      ((prefRow as { email_order_completed?: boolean } | null)?.email_order_completed ?? true) ===
      false;
  }

  // Returns Phase B (B4) + returns-access Unit A: ONLY a completed order is
  // RETURNABLE. A backordered hand-over must NOT mint a return token or email
  // a return link. The shared helper owns the whole flow — module gate,
  // guarded token mint (never rotates an issued token), fulfilled-qty guard,
  // and the 0278 `return_prompt_sent_at` marker claimed before the send, so
  // an order that crosses multiple completion paths gets exactly ONE prompt.
  // Best-effort: never throws, never fails the sign.
  if (isCompleted) {
    // Close the linked auto-created Schedule event (order fulfilled).
    void syncOrderScheduleEvent(order.id, 'completed', order.organization_id);
    await maybeSendReturnPrompt(admin, order.id, { appUrl: env.NEXT_PUBLIC_APP_URL });
  }

  // Backordered fork: the customer took what we had; the order stays open owing
  // `owed`. Tell the REQUESTER (in-app + email), fire a status_changed event,
  // and stop here — none of the completion side effects apply.
  if (isBackordered) {
    // AWAIT — this is the ONLY customer comms for the fork, and a fire-and-forget
    // promise can be dropped when the serverless function returns. It's internally
    // best-effort (never throws), so awaiting is safe.
    await notifyRequesterBackordered({
      organizationId: order.organization_id,
      orderId: order.id,
      requesterUserId: order.requester_user_id,
      requesterEmail: order.requester_email,
      requesterName: order.requester_name,
      appUrl: env.NEXT_PUBLIC_APP_URL,
      provided: totalFulfilled,
      requested: totalRequested,
      owed,
      emailOptedOut: requesterEmailOptedOut,
    });
    // The physical SIGNER gets a transactional receipt of what they just signed
    // for — parity with the completed path, where the signer is always emailed.
    // Deduped against the requester notice — but only when that notice was
    // actually SENT: an opted-out requester who signs still gets their
    // transactional receipt (matching the completed path's semantics).
    const signerIsRequester =
      parsed.data.signerEmail.toLowerCase() ===
      (order.requester_email ?? '').toLowerCase();
    if (!signerIsRequester || requesterEmailOptedOut) {
      try {
        // es `partial-receipt` template: external-recipient receipt from
        // "<supplier> via StockPilot" — the signer may not be a StockPilot
        // user, so it carries receipt language and an explainer footer
        // (no unsubscribe: one-time transactional record).
        await sendPartialReceiptEmail({
          organizationId: order.organization_id,
          orderId: order.id,
          to: parsed.data.signerEmail,
          signerName: parsed.data.signerName,
          unitsReceived: totalFulfilled,
          unitsTotal: totalRequested,
          unitsPending: owed,
          appUrl: env.NEXT_PUBLIC_APP_URL,
        });
      } catch {
        /* best-effort — receipt failure never fails the fulfillment */
      }
    }
    void dispatchEvent(order.organization_id, 'order.status_changed', {
      id: order.id,
      orderNumber: order.id.slice(0, 8).toUpperCase(),
      status: 'backordered',
    });
    return NextResponse.json({ ok: true, data: { id: order.id } }, { status: 200 });
  }

  if (isCompleted && fullRow) {
    // A previously-backordered order whose remainder just shipped — tell the
    // requester their wait is over (in-app + email), on top of the receipt.
    if (priorFulfilled > 0) {
      // AWAIT — see the backordered branch; don't let the "your backorder
      // shipped" notice get dropped on function return.
      await notifyRequesterBackorderShipped({
        organizationId: order.organization_id,
        orderId: order.id,
        requesterUserId: order.requester_user_id,
        requesterEmail: order.requester_email,
        requesterName: order.requester_name,
        appUrl: env.NEXT_PUBLIC_APP_URL,
        emailOptedOut: requesterEmailOptedOut,
        // Display-only: how many units the remainder batch carried.
        unitsShipped: Math.max(0, totalFulfilled - priorFulfilled),
      });
    }
    try {
      // Completion receipt. Honors the requester's email_order_completed opt-out
      // (computed once above); the physical signer always gets a transactional
      // receipt of the signature they just submitted.
      const recipients = new Set<string>();
      if (order.requester_email && !requesterEmailOptedOut) {
        recipients.add(order.requester_email);
      }
      recipients.add(parsed.data.signerEmail);
      for (const recipient of recipients) {
        await sendOrderRequestEmail({
          kind: 'completed',
          request: fullRow as Parameters<typeof sendOrderRequestEmail>[0]['request'],
          recipientEmail: recipient,
          recipientName:
            recipient === order.requester_email
              ? order.requester_name
              : parsed.data.signerName,
          appUrl: env.NEXT_PUBLIC_APP_URL,
        });
      }
    } catch {
      /* email failure is non-fatal; the row is completed */
    }
  }

  // Dispatch order.completed integration event (best-effort, fire-and-forget).
  // Only a genuine completion — the backordered fork returned above.
  if (isCompleted) {
    void dispatchEvent(order.organization_id, 'order.completed', {
      id: order.id,
      orderNumber: order.id.slice(0, 8).toUpperCase(),
      signerName: parsed.data.signerName,
      signerEmail: parsed.data.signerEmail,
    });
  }

  return NextResponse.json({ ok: true, data: { id: order.id } }, { status: 200 });
}
