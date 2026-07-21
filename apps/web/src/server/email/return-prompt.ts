import { formatOrderNumber } from '@stockpilot/core';
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { assertEmailWeight } from '@/lib/email/es/components';
import {
  FULFILLMENT_ORDERS_FROM,
  buildPrefEmailDelivery,
  renderReturnPromptEmail,
} from '@/lib/email/es/families/fulfillment';
import { sendEmail } from '@/lib/email/resend';
import { reportError } from '@/lib/error-reporter';

/**
 * The one-time "Need to return anything from your order?" prompt (returns-
 * access Unit A). Extracted from the digital sign route so EVERY app-side
 * path that lands an order in the terminal fulfilled state 'completed' —
 * digital signature, physical (paper) signature, and close-partial — sends
 * the requester the same self-service return link, exactly once.
 *
 * TWO-STAGE FLOW — mint, then maybe email. This helper is the ONLY
 * return_token mint site, and the token also powers the requester's
 * "Request a return" link on their own /dashboard/orders/[id] page (and the
 * public tracking page). So the MINT is gated only on the STRUCTURAL
 * qualifiers — an order without a requester_email (staff-created internal
 * orders have none by construction) still gets its token:
 *   • the order's status is 'completed' (the only terminal FULFILLED state —
 *     backordered/cancelled/denied never mint or prompt);
 *   • the org has the off-by-default `returns` module enabled (the public
 *     portal 404s without it);
 *   • at least one unit was actually fulfilled (a zero-fulfilled completion
 *     has nothing to return).
 * The EMAIL then additionally requires:
 *   • a requester_email on file;
 *   • `return_prompt_sent_at` (0278) still NULL (marker = email sent; an
 *     email-less completion leaves it untouched, so if an email is added
 *     later a subsequent completion path can still prompt once).
 *
 * RACE POSTURE — at-most-once. The marker is claimed FIRST via a guarded
 * update (`.is('return_prompt_sent_at', null).select(...)`): of any number of
 * concurrent completion paths (sign route + a replay, sign + close-partial),
 * exactly one wins that update and only the winner sends. If the send then
 * fails, the marker deliberately stays set — we prefer a missed email over a
 * duplicate (the same link is reachable from the public tracking page and the
 * requester's order detail, so a lost email is recoverable; a double prompt
 * is just spam). The `return_token` mint is likewise guarded
 * (`.is('return_token', null)`) so a replay never rotates an issued token —
 * links already emailed keep working.
 *
 * BEST-EFFORT: never throws. Callers fire it AFTER the successful transition
 * (audit()/notification pattern) and a failure here must never fail the
 * fulfillment.
 */
export type ReturnPromptResult =
  | { sent: true }
  | {
      sent: false;
      reason:
        | 'order_not_found'
        | 'not_completed'
        | 'no_requester_email'
        | 'already_sent'
        | 'module_disabled'
        | 'zero_fulfilled'
        | 'no_token'
        | 'lost_race'
        | 'send_failed'
        | 'error';
    };

export async function maybeSendReturnPrompt(
  admin: SupabaseClient,
  orderId: string,
  opts: { appUrl: string },
): Promise<ReturnPromptResult> {
  try {
    // NOTE (Unit E5): `order_number` + `requester_user_id` are read-only
    // additions for the es template render (display handle + the correct
    // unsubscribe-link flavor). The guards, guarded updates, and their
    // ordering below are UNCHANGED.
    const { data: row } = await admin
      .from('order_requests')
      .select(
        'id, organization_id, status, requester_email, requester_name, requester_user_id, order_number, return_token, return_prompt_sent_at',
      )
      .eq('id', orderId)
      .maybeSingle();
    if (!row) return { sent: false, reason: 'order_not_found' };
    const order = row as {
      id: string;
      organization_id: string;
      status: string;
      requester_email: string | null;
      requester_name: string | null;
      requester_user_id: string | null;
      order_number: number | null;
      return_token: string | null;
      return_prompt_sent_at: string | null;
    };

    if (order.status !== 'completed') return { sent: false, reason: 'not_completed' };

    // Off-by-default module — the portal 404s without it (never email a dead
    // link). Mirrors the direct organization_modules check the anonymous
    // surfaces use (no ServiceContext on service-role paths).
    const { data: modRow } = await admin
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', order.organization_id)
      .eq('module_id', 'returns')
      .eq('enabled', true)
      .maybeSingle();
    if (!modRow) return { sent: false, reason: 'module_disabled' };

    // Nothing was handed over → nothing to return → no prompt. (A close-
    // partial completion still has the earlier batch's fulfilled units.)
    const { data: lines } = await admin
      .from('order_request_lines')
      .select('quantity_fulfilled')
      .eq('order_request_id', order.id);
    const totalFulfilled = ((lines ?? []) as { quantity_fulfilled: number | null }[]).reduce(
      (s, l) => s + (Number(l.quantity_fulfilled) || 0),
      0,
    );
    if (totalFulfilled <= 0) return { sent: false, reason: 'zero_fulfilled' };

    // Ensure the per-order return token (0156) exists. The mint happens for
    // EVERY structurally-qualifying completion — BEFORE any email-specific
    // guard — because the token also drives the requester's dashboard
    // "Request a return" link (orders with no requester_email still get one).
    // Guarded mint: only while still NULL, so a concurrent completion never
    // rotates a token that may already be in someone's inbox.
    let token = order.return_token;
    if (!token) {
      const minted = crypto.randomUUID();
      const { data: tokened } = await admin
        .from('order_requests')
        .update({ return_token: minted })
        .eq('id', order.id)
        .is('return_token', null)
        .select('return_token')
        .maybeSingle();
      if (tokened) {
        token = (tokened as { return_token: string | null }).return_token ?? minted;
      } else {
        // Lost the mint race — another path minted first; read theirs.
        const { data: reread } = await admin
          .from('order_requests')
          .select('return_token')
          .eq('id', order.id)
          .maybeSingle();
        token = (reread as { return_token: string | null } | null)?.return_token ?? null;
      }
    }
    if (!token) return { sent: false, reason: 'no_token' };

    // ── Email-specific guards — from here down we decide only whether the
    // EMAIL sends; the token above is already minted either way. ──
    if (!order.requester_email) return { sent: false, reason: 'no_requester_email' };
    // Cheap pre-check; the guarded update below is the authoritative gate.
    if (order.return_prompt_sent_at) return { sent: false, reason: 'already_sent' };

    // Claim the send BEFORE sending — only the winner of this guarded update
    // proceeds (at-most-once; see the race-posture note above).
    const { data: claimed } = await admin
      .from('order_requests')
      .update({ return_prompt_sent_at: new Date().toISOString() })
      .eq('id', order.id)
      .is('return_prompt_sent_at', null)
      .select('id')
      .maybeSingle();
    if (!claimed) return { sent: false, reason: 'lost_race' };

    try {
      await sendReturnPromptEmail({
        to: order.requester_email,
        recipientName: order.requester_name,
        appUrl: opts.appUrl,
        token,
        orderNumber:
          formatOrderNumber(order.order_number) ?? `#${order.id.slice(0, 8).toUpperCase()}`,
        isAccountHolder: Boolean(order.requester_user_id),
      });
    } catch (e) {
      // Marker stays set (at-most-once). Report so a systemic send failure
      // is visible, but never fail the caller's transition.
      await reportError(e, {
        tag: 'orders.return-prompt.send',
        extra: { orderId: order.id },
      });
      return { sent: false, reason: 'send_failed' };
    }
    return { sent: true };
  } catch (e) {
    try {
      await reportError(e, { tag: 'orders.return-prompt', extra: { orderId } });
    } catch {
      /* reporting is itself best-effort */
    }
    return { sent: false, reason: 'error' };
  }
}

/**
 * The es `return-prompt` email (fulfillment family, Unit E5): reverse-route
 * motion, preference footer + List-Unsubscribe headers, registry-verbatim
 * subject ('Need to return anything from your order?' — the registry's
 * `rec:` refined subject stays a comment awaiting product sign-off). Only
 * the RENDERING changed here; the mint/marker flow above is untouched.
 */
async function sendReturnPromptEmail(args: {
  to: string;
  recipientName: string | null;
  appUrl: string;
  token: string;
  orderNumber: string;
  isAccountHolder: boolean;
}): Promise<void> {
  const base = args.appUrl.replace(/\/+$/, '');
  const url = `${base}/returns/request/${args.token}`;
  const delivery = buildPrefEmailDelivery({
    appUrl: base,
    recipientEmail: args.to,
    isAccountHolder: args.isAccountHolder,
  });
  // The prompt fires at completion, so "delivered" is now.
  const deliveredOn = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  const rendered = renderReturnPromptEmail({
    orderNumber: args.orderNumber,
    recipientFirstName: args.recipientName,
    recipientEmail: args.to,
    deliveredOn,
    startUrl: url,
    urls: delivery.urls,
  });
  assertEmailWeight(rendered.html);
  await sendEmail({
    to: args.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: FULFILLMENT_ORDERS_FROM,
    headers: delivery.headers,
  });
}
