import { isIP } from 'node:net';

import { revalidateTag } from 'next/cache';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { withApiContext } from '@/lib/auth/api-context';
import { sendOrderRequestEmail } from '@/lib/email/order-requests';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { sha256Hex } from '@/lib/token-hash';
import { maybeSendReturnPrompt } from '@/server/email/return-prompt';
import {
  notifyRequesterBackordered,
  notifyRequesterBackorderShipped,
  sendPartialReceiptEmail,
} from '@/server/lib/order-handover-notify';
import {
  isHandOverEntitled,
  LINK_SIGN_LIMIT_PER_HOUR,
  MEMBER_SIGN_LIMIT_PER_HOUR,
  resolveSignatureToken,
  SIGNATURE_TOKEN_RE,
  type SignatureTokenVia,
} from '@/server/lib/order-secrets';
import { insertAuditRowReported } from '@/server/services/audit';
import { mfaGateError, type ServiceContext } from '@/server/services/context';
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
  token: z.string().regex(SIGNATURE_TOKEN_RE),
  signerName: z.string().trim().min(1).max(120),
  signerEmail: z.string().trim().email().max(254),
  signatureDataUrl: z
    .string()
    .min(64)
    .max(500_000)
    .regex(DATA_URL_RE, 'Invalid signature image'),
});

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * THE one answer for a token this route will not act on: unknown, cleared,
 * or a digest presented without an entitled session (no session, another
 * organization, a viewer, a disabled account). Byte-identical in every case,
 * so the answer never says which.
 */
const NOT_FOUND_BODY = {
  ok: false,
  error: { code: 'not_found', message: 'This signature link is invalid or expired.' },
} as const;

function notFound() {
  return NextResponse.json(NOT_FOUND_BODY, { status: 404 });
}

function rateLimited() {
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

/** The order columns the route reads before the hand-over. */
const ORDER_COLUMNS =
  'id, organization_id, warehouse_id, requester_user_id, requester_name, requester_email, ' +
  'fulfillment_type, assigned_delivery_user_id';

interface SignOrderRow {
  id: string;
  organization_id: string;
  warehouse_id: string | null;
  requester_user_id: string | null;
  requester_name: string | null;
  requester_email: string | null;
  fulfillment_type: 'pickup' | 'delivery';
  assigned_delivery_user_id: string | null;
}

/**
 * The IP for the hand-over's audit row: the first x-forwarded-for hop, else
 * x-real-ip, as every other audit row takes it (server/services/audit.ts),
 * and only when it is an IP literal. audit_logs.ip is inet: a value such as
 * the rate-limit helper's "unknown" bucket fails the insert (22P02) and the
 * row, and with it the timeline's "Signature collected", is lost.
 */
function auditIp(req: Request): string | null {
  const raw = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip')?.trim() || null;
  return raw && isIP(raw) ? raw : null;
}

/**
 * The caller's context IN THE ORDER'S ORGANIZATION (bearer or cookie), or
 * null. The organization header is set to the order's: withApiContext then
 * verifies an accepted membership there, so a member of several
 * organizations is judged where the order lives, and anyone else gets null.
 * A context that cannot be built (an unreadable account status) is also null:
 * the caller answers the one not-found, never a different status.
 */
async function memberContextFor(req: Request, organizationId: string): Promise<ServiceContext | null> {
  try {
    const headers = new Headers(req.headers);
    headers.set('x-organization-id', organizationId);
    return await withApiContext(new Request(req.url, { method: 'GET', headers }));
  } catch (e) {
    void reportError(e, { tag: 'orders.sign.member_context', level: 'warning' });
    return null;
  }
}

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

  // Which order, and by what right (migration 0389, server/lib/order-secrets):
  //   link        sha256(presented) is the order's column: the raw token of a
  //               printed QR or the panel's link. No session needed, as before.
  //   legacy_link the presented value IS the column and no side token hashes
  //               to it: a raw token minted before 0389 (until slice C).
  //   member      the presented value IS the column and is a DIGEST, which
  //               every member can read. It completes the hand-over only for
  //               a signed-in member of the order's organization who may hand
  //               it over today: effective orders:approve (the web panel's
  //               gate, and the permission the phone's manager rank carries)
  //               or the order's assigned driver. Installed phones post the
  //               column with their bearer, so they keep working unchanged.
  // Every refusal is the same 404 an unknown token gets.
  //
  // The limits are applied AFTER the match, each keyed to whoever can reach
  // it, so nobody can use up someone else's (desk check F3):
  //   - a link (link or legacy_link) counts against its token: 10 an hour,
  //     keyed by sha256(presented). Only a holder of that value (the printed
  //     QR, the panel's link) can fill it. Closed mode: a DB outage denies
  //     rather than unlocks unlimited submissions on a public endpoint. The
  //     key is the hash, never the token: rate_limit_buckets persists its
  //     keys, and a raw token there is a credential at rest (the 0330
  //     posture).
  //   - the member path never touches a per-token bucket. Every member reads
  //     the digest, so a token-keyed bucket would let a viewer post it ten
  //     times and lock every installed phone's Collect signature out of that
  //     order for an hour. An entitled member counts against their OWN
  //     bucket (60 an hour); a refusal counts against nothing and is the one
  //     404, so no refusal changes what anyone else gets.
  const match = await resolveSignatureToken<SignOrderRow>(
    admin,
    parsed.data.token,
    ORDER_COLUMNS,
  );
  if (!match) return notFound();
  const order = match.order;
  const via: SignatureTokenVia = match.via;
  let memberUserId: string | null = null;
  if (via !== 'member') {
    const rl = await checkRateLimit(
      `order-sign:${sha256Hex(parsed.data.token)}`,
      LINK_SIGN_LIMIT_PER_HOUR,
      ONE_HOUR_MS,
      'closed',
    );
    if (!rl.allowed) return rateLimited();
  } else {
    const ctx = await memberContextFor(req, order.organization_id);
    if (!ctx || ctx.organizationId !== order.organization_id || !isHandOverEntitled(ctx, order)) {
      return notFound();
    }
    // An entitled member already reads this order, so telling them to step up
    // discloses nothing (R3); everyone else got the 404 above.
    if (ctx.mfaRequired && !ctx.mfaSatisfied) {
      const gate = mfaGateError(ctx);
      const reason = (gate.details?.reason as string | undefined) ?? 'aal2_required';
      return NextResponse.json(
        {
          ok: false,
          error: { code: reason, message: gate.message },
          message: gate.message,
          details: { reason },
        },
        { status: 403 },
      );
    }
    const memberLimit = await checkRateLimit(
      `order-sign:member:${ctx.userId}`,
      MEMBER_SIGN_LIMIT_PER_HOUR,
      ONE_HOUR_MS,
      'closed',
    );
    if (!memberLimit.allowed) return rateLimited();
    memberUserId = ctx.userId;
  }

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
    // The column value (the digest for a link or a member, the raw value for
    // a legacy link): the frozen body compares the column with it.
    p_signature_token: match.columnToken,
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

  // Every digital hand-over is on the order's timeline (it was not before
  // 0389). Who: the member on the member path; nobody signed in on a link.
  // Never the token. Written before any read below can return early.
  await insertAuditRowReported({
    organization_id: order.organization_id,
    user_id: memberUserId,
    event: 'order.signature_collected',
    ip: auditIp(req),
    user_agent: req.headers.get('user-agent'),
    metadata: {
      entity_type: 'order_request',
      entity_id: order.id,
      warehouse_id: order.warehouse_id ?? null,
      before: null,
      after: null,
      reason: null,
      signatureMethod: 'digital',
      via,
    },
  });

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

  // Line totals for the notices. Retried once, like the status read. A read
  // that still fails leaves them null (not 0), and every notice that would
  // print them is sent without them or skipped: "0 of 0 provided" is a wrong
  // statement, not a degraded one.
  const readLineTotals = () =>
    admin
      .from('order_request_lines')
      .select('quantity_requested, quantity_fulfilled')
      .eq('order_request_id', order.id);
  let totalsRead = await readLineTotals();
  if (totalsRead.error) totalsRead = await readLineTotals();
  const { data: aggLines, error: aggErr } = totalsRead;
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
    // AWAIT — this is the ONLY customer comms for the fork, and a fire-and-forget
    // promise can be dropped when the serverless function returns. It's internally
    // best-effort (never throws), so awaiting is safe.
    // Sent with or without the line totals: the requester must hear that the
    // order is backordered even when the counts could not be read (the read
    // failure is reported above). Without them the notice carries no numbers.
    await notifyRequesterBackordered({
      organizationId: order.organization_id,
      orderId: order.id,
      requesterUserId: order.requester_user_id,
      requesterEmail: requester.email,
      requesterName: requester.name,
      appUrl: env.NEXT_PUBLIC_APP_URL,
      provided: totals?.fulfilled ?? null,
      requested: totals?.requested ?? null,
      owed: totals?.owed ?? null,
      emailOptedOut: requesterEmailOptedOut,
    });
    // The signer's receipt below IS its counts ("received 2 of 5"), so it is
    // skipped without them rather than sent with zeros.
    if (totals) {
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
