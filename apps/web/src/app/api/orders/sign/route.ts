import { revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { sendOrderRequestEmail } from '@/lib/email/order-requests';
import { sendEmail } from '@/lib/email/resend';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  notifyRequesterBackordered,
  notifyRequesterBackorderShipped,
  sendBackorderEmail,
} from '@/server/lib/order-handover-notify';
import { dispatchEvent } from '@/server/services/integration-events';

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

  // Returns Phase B (B4): ONLY a completed order is RETURNABLE. A backordered
  // hand-over must NOT mint a return token or email a return link. If the org
  // has the off-by-default `returns` module enabled, mint a per-order
  // return_token (0156) so the requester can be emailed a self-service return
  // link. Idempotent — token minted only while still NULL, so a replayed sign
  // never rotates an issued token. Best-effort: a failure never fails the sign.
  if (isCompleted) {
    try {
      const { data: modRow } = await admin
        .from('organization_modules')
        .select('module_id')
        .eq('organization_id', order.organization_id)
        .eq('module_id', 'returns')
        .eq('enabled', true)
        .maybeSingle();
      if (modRow) {
        const newToken = crypto.randomUUID();
        const { data: tokened } = await admin
          .from('order_requests')
          .update({ return_token: newToken })
          .eq('id', order.id)
          .is('return_token', null)
          .select('id')
          .maybeSingle();
        if (tokened && order.requester_email) {
          await sendReturnLinkEmail({
            to: order.requester_email,
            recipientName: order.requester_name,
            appUrl: env.NEXT_PUBLIC_APP_URL,
            token: newToken,
          });
        }
      }
    } catch {
      /* non-fatal — the order is completed regardless of token issuance */
    }
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
        await sendBackorderEmail({
          to: parsed.data.signerEmail,
          recipientName: parsed.data.signerName,
          subject: `Order #${order.id.slice(0, 8).toUpperCase()}: partial delivery receipt`,
          message:
            `This confirms your signature for a partial delivery — ${totalFulfilled} of ` +
            `${totalRequested} items were provided. The remaining ${owed} are backordered ` +
            `and will ship separately.`,
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

/**
 * Lightweight return-link email (Returns Phase B, B4). Sent once, when a
 * completed order first gets a return_token issued, to the order's requester.
 * Deliberately uses the bare `sendEmail` (not the heavier order-request
 * templates) so the return portal can ship without coupling to in-flight
 * template work. Best-effort: the caller wraps it so a send failure never
 * fails the signature.
 */
async function sendReturnLinkEmail(args: {
  to: string;
  recipientName: string | null;
  appUrl: string;
  token: string;
}): Promise<void> {
  const firstName = args.recipientName?.split(' ')[0] ?? 'there';
  const base = args.appUrl.replace(/\/+$/, '');
  const url = `${base}/returns/request/${args.token}`;
  const safeName = escapeHtml(firstName);
  const safeUrl = escapeHtml(url);
  await sendEmail({
    to: args.to,
    subject: 'Need to return anything from your order?',
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;color:#111">` +
      `<p>Hi ${safeName},</p>` +
      `<p>Your order is complete. If you need to send anything back, you can start a return request below — the warehouse team will review it.</p>` +
      `<p><a href="${safeUrl}" style="display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Request a return</a></p>` +
      `<p style="color:#666;font-size:12px">Or paste this link into your browser:<br>${safeUrl}</p>` +
      `</div>`,
    text:
      `Hi ${firstName},\n\nYour order is complete. If you need to send anything back, ` +
      `start a return request here:\n${url}\n\nThe warehouse team will review it.`,
  });
}

/** Minimal HTML escaping for the few interpolated values above. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
