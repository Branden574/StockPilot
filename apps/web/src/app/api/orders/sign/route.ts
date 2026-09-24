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

/**
 * Resolve WHO to email for this order's requester.
 *
 * SP-020: `OrderRequestsService.create()` fills `requester_name` /
 * `requester_email` ONLY for on-behalf-of (external) orders — a member who
 * submits their own order gets `requester_user_id` set and BOTH name/email
 * columns NULL. This route used to read the columns directly, so every
 * internal requester silently dropped out of the recipient set: no completion
 * receipt, no "partially fulfilled" notice, no "backordered items shipped"
 * notice, and their `email_order_completed` opt-out was never even read
 * (the read was gated on the always-NULL email column). The PAPER signature
 * path did email them, because it goes through the service's
 * `resolveRecipient()` -> `user_profiles` lookup. This mirrors that
 * resolution so both hand-over paths behave identically.
 *
 * Fails CLOSED-safe: if the profile read errors we return no address, which
 * degrades to the old in-app-notification-only behaviour rather than failing
 * a signature that the DB has already recorded.
 */
async function resolveRequesterContact(
  admin: ReturnType<typeof createAdminClient>,
  order: {
    requester_user_id: string | null;
    requester_name: string | null;
    requester_email: string | null;
  },
): Promise<{ email: string | null; name: string | null }> {
  if (order.requester_email) {
    return { email: order.requester_email, name: order.requester_name ?? null };
  }
  if (!order.requester_user_id) return { email: null, name: null };
  try {
    const { data } = await admin
      .from('user_profiles')
      .select('email, full_name')
      .eq('id', order.requester_user_id)
      .maybeSingle();
    const profile = data as { email?: string | null; full_name?: string | null } | null;
    return {
      email: profile?.email ?? null,
      name: profile?.full_name ?? order.requester_name ?? null,
    };
  } catch {
    return { email: null, name: order.requester_name ?? null };
  }
}

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

  // Live tracking: purge the driver's live GPS point after this leg (best-effort).
  // Ahead of the status read below: the leg is over whatever the status is,
  // and a failed status read returns early.
  try {
    await admin.from('delivery_locations').delete().eq('order_request_id', order.id);
  } catch {
    /* non-fatal */
  }

  // The hand-over either COMPLETED the order (owed 0) or forked it to
  // BACKORDERED (still owed units) — the 0244 fork. Read the resulting status
  // + line totals once and branch every downstream side effect on it: a
  // backordered hand-over is NOT a completion, so it must not mint a return
  // token, send a "completed" email, or fire order.completed.
  //
  // The signature is already recorded, so a failed re-read never fails the
  // signer. It is retried once (a transient blip is the realistic cause), and
  // if it still fails we report it and skip every status-dependent follow-up:
  // guessing the status would send a completion receipt for a backordered
  // order, or the reverse.
  const readStatusRow = () => admin.from('order_requests').select('*').eq('id', order.id).single();
  let statusRead = await readStatusRow();
  if (statusRead.error) statusRead = await readStatusRow();
  if (statusRead.error) {
    await reportError(statusRead.error, {
      tag: 'orders.sign.post_status_read',
      level: 'warning',
      extra: { orderId: order.id },
    });
    return NextResponse.json({ ok: true, data: { id: order.id } }, { status: 200 });
  }
  const fullRow = statusRead.data;
  const newStatus = (fullRow as { status?: string } | null)?.status ?? null;
  const isCompleted = newStatus === 'completed';
  const isBackordered = newStatus === 'backordered';

  // Line totals for the notices. A failed read leaves them null (not 0), and
  // every notice that would print them is skipped or sent without them: "0 of
  // 0 provided" is a wrong statement, not a degraded one.
  const { data: aggLines, error: aggErr } = await admin
    .from('order_request_lines')
    .select('quantity_requested, quantity_fulfilled')
    .eq('order_request_id', order.id);
  let totals: { requested: number; fulfilled: number; owed: number } | null = null;
  if (aggErr) {
    await reportError(aggErr, {
      tag: 'orders.sign.line_totals_read',
      level: 'warning',
      extra: { orderId: order.id },
    });
  } else {
    const aggRows = (aggLines ?? []) as {
      quantity_requested: number | null;
      quantity_fulfilled: number | null;
    }[];
    const requested = aggRows.reduce((s, l) => s + (Number(l.quantity_requested) || 0), 0);
    const fulfilled = aggRows.reduce((s, l) => s + (Number(l.quantity_fulfilled) || 0), 0);
    totals = { requested, fulfilled, owed: Math.max(0, requested - fulfilled) };
  }

  // WHO the requester is, resolved ONCE (see resolveRequesterContact): the
  // row's own columns for an external/on-behalf-of order, else the member's
  // user_profiles row. Every requester-facing notice below uses THIS, never
  // the raw column — internal requesters have a NULL email column.
  const requester = await resolveRequesterContact(admin, order);

  // Requester email opt-out (notification_preferences.email_order_completed,
  // 0113), computed ONCE and honored by BOTH the completion receipt and the
  // backorder notices — a requester who muted order emails stays muted for the
  // partial / backorder-shipped notices too. External requesters (no user row)
  // can't opt out and always get transactional mail.
  // SP-020: gated on requester_user_id ALONE. The old `&& order.requester_email`
  // conjunct made this a dead branch for exactly the population that CAN opt
  // out (internal members, whose email column is always NULL).
  // A failed read counts as OPTED OUT (fail closed): these emails are optional
  // for a member, and mailing someone who muted them is worse than one missed
  // notice. The in-app notices and the signer's receipt are unaffected.
  let requesterEmailOptedOut = false;
  if (order.requester_user_id) {
    const { data: prefRow, error: prefErr } = await admin
      .from('notification_preferences')
      .select('email_order_completed')
      .eq('user_id', order.requester_user_id)
      .maybeSingle();
    if (prefErr) {
      requesterEmailOptedOut = true;
      await reportError(prefErr, {
        tag: 'orders.sign.pref_read',
        level: 'warning',
        extra: { orderId: order.id },
      });
    } else {
      requesterEmailOptedOut =
        ((prefRow as { email_order_completed?: boolean } | null)?.email_order_completed ?? true) ===
        false;
    }
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
    // Both notices below state the counts ("2 of 5 provided"). Without the
    // line totals they are skipped (the read failure is reported above)
    // rather than sent with zeros.
    if (totals) {
      // AWAIT — this is the ONLY customer comms for the fork, and a fire-and-forget
      // promise can be dropped when the serverless function returns. It's internally
      // best-effort (never throws), so awaiting is safe.
      await notifyRequesterBackordered({
        organizationId: order.organization_id,
        orderId: order.id,
        requesterUserId: order.requester_user_id,
        requesterEmail: requester.email,
        requesterName: requester.name,
        appUrl: env.NEXT_PUBLIC_APP_URL,
        provided: totals.fulfilled,
        requested: totals.requested,
        owed: totals.owed,
        emailOptedOut: requesterEmailOptedOut,
      });
      // The physical SIGNER gets a transactional receipt of what they just signed
      // for — parity with the completed path, where the signer is always emailed.
      // Deduped against the requester notice — but only when that notice was
      // actually SENT: an opted-out requester who signs still gets their
      // transactional receipt (matching the completed path's semantics).
      const signerIsRequester =
        parsed.data.signerEmail.toLowerCase() === (requester.email ?? '').toLowerCase();
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
            unitsReceived: totals.fulfilled,
            unitsTotal: totals.requested,
            unitsPending: totals.owed,
            appUrl: env.NEXT_PUBLIC_APP_URL,
          });
        } catch {
          /* best-effort — receipt failure never fails the fulfillment */
        }
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
        requesterEmail: requester.email,
        requesterName: requester.name,
        appUrl: env.NEXT_PUBLIC_APP_URL,
        emailOptedOut: requesterEmailOptedOut,
        // Display-only: how many units the remainder batch carried. Null (the
        // notice omits the count) when the line totals could not be read.
        unitsShipped: totals ? Math.max(0, totals.fulfilled - priorFulfilled) : null,
      });
    }
    try {
      // Completion receipt. Honors the requester's email_order_completed opt-out
      // (computed once above); the physical signer always gets a transactional
      // receipt of the signature they just submitted.
      // Keyed by LOWERCASED address so a requester who signs her own delivery
      // but types a differently-cased address gets exactly ONE receipt — a
      // plain Set of raw strings treated "Alice@Site.org" and "alice@site.org"
      // as two people. The stored value keeps the original casing for the send.
      const recipients = new Map<string, { email: string; name: string | null }>();
      if (requester.email && !requesterEmailOptedOut) {
        recipients.set(requester.email.toLowerCase(), {
          email: requester.email,
          name: requester.name,
        });
      }
      if (!recipients.has(parsed.data.signerEmail.toLowerCase())) {
        recipients.set(parsed.data.signerEmail.toLowerCase(), {
          email: parsed.data.signerEmail,
          name: parsed.data.signerName,
        });
      }
      for (const recipient of recipients.values()) {
        await sendOrderRequestEmail({
          kind: 'completed',
          request: fullRow as Parameters<typeof sendOrderRequestEmail>[0]['request'],
          recipientEmail: recipient.email,
          recipientName: recipient.name,
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
