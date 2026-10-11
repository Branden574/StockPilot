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
import { normalizeUnsubscribeEmail } from '@/lib/email/unsubscribe';
import { reportError } from '@/lib/error-reporter';

import { loadReplacementEmailFacts } from './replacement-update';
import { sendReturnUpdateEmail } from './return-update';

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
 *   • a requester who has not deleted their account (A3: a deleted requester
 *     is never emailed again, not even at the address the order kept);
 *   • a requester_email on file;
 *   • `return_prompt_sent_at` (0278) still NULL (marker = email sent; an
 *     email-less completion leaves it untouched, so if an email is added
 *     later a subsequent completion path can still prompt once);
 *   • for a PUBLIC (account-less) requester, no recorded opt-out in
 *     public_email_unsubscribes — see the suppression note at the guard.
 *
 * RACE POSTURE — at-most-once. The marker is claimed FIRST via a guarded
 * update (`.is('return_prompt_sent_at', null).select(...)`): of any number of
 * concurrent completion paths (sign route + a replay, sign + close-partial),
 * exactly one wins that update and only the winner sends. If the send then
 * fails, the marker deliberately stays set — we prefer a missed email over a
 * duplicate (the same link is reachable from the public tracking page and the
 * requester's order detail, so a lost email is recoverable; a double prompt
 * is just spam). The return-token mint never rotates an issued token either:
 * since migration 0389 it is one call, `order_return_token_ensure` (service
 * role only), which keeps a token already in `order_request_secrets`, else
 * moves the token already in `order_requests.return_token` (it may be in an
 * inbox) unchanged, else mints one, atomically. The raw token is no longer
 * written to the order row every member reads.
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
        | 'requester_deleted'
        | 'no_requester_email'
        | 'already_sent'
        | 'suppressed'
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
    //
    // Each guard read below binds its error: a failed read used to look like
    // "no order", "module off" or "nothing fulfilled" and skip silently. It
    // now reports and stops with reason 'error', before any token is minted.
    const { data: row, error: rowErr } = await admin
      .from('order_requests')
      .select(
        'id, organization_id, status, source, requester_email, requester_name, requester_user_id, requester_deleted_at, order_number, return_prompt_sent_at, replacement_for_return_id',
      )
      .eq('id', orderId)
      .maybeSingle();
    if (rowErr) return await readFailed(rowErr, 'orders.return-prompt.order_read', orderId);
    if (!row) return { sent: false, reason: 'order_not_found' };
    const order = row as {
      id: string;
      organization_id: string;
      status: string;
      requester_email: string | null;
      requester_name: string | null;
      requester_user_id: string | null;
      requester_deleted_at: string | null;
      order_number: number | null;
      return_prompt_sent_at: string | null;
      source?: string | null;
      replacement_for_return_id?: string | null;
    };

    if (order.status !== 'completed') return { sent: false, reason: 'not_completed' };

    // Off-by-default module — the portal 404s without it (never email a dead
    // link). Mirrors the direct organization_modules check the anonymous
    // surfaces use (no ServiceContext on service-role paths).
    const { data: modRow, error: modErr } = await admin
      .from('organization_modules')
      .select('module_id')
      .eq('organization_id', order.organization_id)
      .eq('module_id', 'returns')
      .eq('enabled', true)
      .maybeSingle();
    if (modErr) return await readFailed(modErr, 'orders.return-prompt.module_read', orderId);
    if (!modRow) return { sent: false, reason: 'module_disabled' };

    // Nothing was handed over → nothing to return → no prompt. (A close-
    // partial completion still has the earlier batch's fulfilled units.)
    const { data: lines, error: linesErr } = await admin
      .from('order_request_lines')
      .select('quantity_requested, quantity_fulfilled')
      .eq('order_request_id', order.id);
    if (linesErr) return await readFailed(linesErr, 'orders.return-prompt.lines_read', orderId);
    const lineRows = (lines ?? []) as { quantity_requested?: number | null; quantity_fulfilled: number | null }[];
    const totalFulfilled = lineRows.reduce((s, l) => s + (Number(l.quantity_fulfilled) || 0), 0);
    if (totalFulfilled <= 0) return { sent: false, reason: 'zero_fulfilled' };
    // Completed with part of it never sent (closed as delivered-partial): the
    // notify trigger's rule (0396), a line asked for more than was handed over.
    const partNeverSent = lineRows.some(
      (l) => (Number(l.quantity_requested) || 0) > (Number(l.quantity_fulfilled) || 0),
    );

    // Ensure the per-order return token (0156) exists. The mint happens for
    // EVERY structurally-qualifying completion — BEFORE any email-specific
    // guard — because the token also drives the requester's dashboard
    // "Request a return" link (orders with no requester_email still get one).
    // order_return_token_ensure (0389) is atomic and never rotates: two
    // concurrent completions get the same token, and a token minted before
    // 0389 (in the order column, perhaps already emailed) is kept as it is.
    const { data: ensured, error: ensureErr } = await admin.rpc('order_return_token_ensure', {
      p_order_id: order.id,
    });
    if (ensureErr) {
      return await readFailed(ensureErr, 'orders.return-prompt.token_ensure', orderId);
    }
    const token = typeof ensured === 'string' && ensured.length > 0 ? ensured : null;
    if (!token) return { sent: false, reason: 'no_token' };

    // ── Email-specific guards — from here down we decide only whether the
    // EMAIL sends; the token above is already minted either way. ──
    if (order.requester_deleted_at) return { sent: false, reason: 'requester_deleted' };
    if (!order.requester_email) return { sent: false, reason: 'no_requester_email' };
    // Cheap pre-check; the guarded update below is the authoritative gate.
    if (order.return_prompt_sent_at) return { sent: false, reason: 'already_sent' };

    // SP-076 — HONOR THE ONE-CLICK UNSUBSCRIBE WE OURSELVES ADVERTISE.
    // For a public (account-less) requester this email ships RFC 8058
    // headers (buildPrefEmailDelivery → 'List-Unsubscribe-Post:
    // List-Unsubscribe=One-Click'), and the /unsubscribe POST records the
    // opt-out in public_email_unsubscribes (0222) while promising "you'll
    // no longer get emails when your order requests change status". Until
    // now nothing on this path read that table — a requester who clicked
    // Unsubscribe on the 'approved' email still got the return prompt at
    // completion, re-advertising one-click each time. Mail sent after a
    // recorded one-click opt-out is a complaint signal against orders@
    // under the Gmail/Yahoo bulk-sender rules.
    //
    // Mirrors the order-request choke point exactly (lib/email/
    // order-requests.ts sendOrderRequestEmail): the list governs PUBLIC
    // recipients only — signed-in requesters have notification prefs
    // instead, and their footer link is the in-app settings page (no
    // one-click header), so a stray public row must not mute their mail.
    //
    // Placed AFTER the cheap marker pre-check (no lookup for an order
    // already prompted) and BEFORE the guarded claim below, so a
    // suppressed address never BURNS the one-shot 0278 marker: suppression
    // is a property of the ADDRESS, so if it is ever lifted the requester
    // can still be prompted once.
    if (
      !order.requester_user_id &&
      (await isPublicAddressUnsubscribed(admin, order.requester_email))
    ) {
      return { sent: false, reason: 'suppressed' };
    }

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
      if (order.replacement_for_return_id) {
        // Returns RX-2 (X-4): an exchange replacement's completion email is
        // "Your exchange is complete" (or "Your replacement was handed over"
        // while the RMA is still open), carrying the replacement's OWN return
        // link minted above. The ordinary order emails skip a replacement's
        // completion for the requester, so this is the one email. Closed
        // with part never sent, it says so (review P14): "Your replacement
        // order was closed." The words come from the order's own lines, not
        // from the caller: the sign route, the paper signature and the order
        // page's close-partial (which the database now refuses for a
        // replacement). An RMA cancel that closes a part-handed-over
        // replacement (cancel_return's hook) does not call this today; a
        // caller that does gets the same words.
        const sent = await sendReplacementCompletionEmail(admin, {
          returnId: order.replacement_for_return_id,
          to: order.requester_email,
          recipientName: order.requester_name,
          appUrl: opts.appUrl,
          token,
          isAccountHolder: Boolean(order.requester_user_id),
          partNeverSent,
        });
        if (!sent) return { sent: false, reason: 'send_failed' };
        return { sent: true };
      }
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
 * A guard read failed: report it the way the catch-all above does (reporting
 * is itself best-effort) and stop with reason 'error'. Nothing has been
 * written at any of the call sites.
 */
async function readFailed(
  error: unknown,
  tag: string,
  orderId: string,
): Promise<ReturnPromptResult> {
  try {
    await reportError(error, { tag, extra: { orderId } });
  } catch {
    /* reporting is itself best-effort */
  }
  return { sent: false, reason: 'error' };
}

/**
 * True when this address recorded a public one-click opt-out (mig 0222).
 *
 * Reads through the SERVICE-ROLE client the caller already handed us (this
 * runs on service-role completion paths with no ServiceContext, exactly like
 * the organization_modules check above) rather than minting another admin
 * client.
 *
 * FAILS CLOSED: an unreadable list counts as unsubscribed. This email is a
 * prompt, not a receipt, and it advertises one-click unsubscribe; mailing an
 * address that opted out is a complaint signal against orders@ (Gmail/Yahoo
 * bulk-sender rules) and breaks a promise we made, while a skipped prompt is
 * recoverable (the same link is on the tracking page and the requester's
 * order detail) and, because the skip happens before the 0278 marker is
 * claimed, a later completion path can still prompt once. This used to fail
 * open, like the order-request choke point's isPublicEmailUnsubscribed.
 *
 * The lookup uses normalizeUnsubscribeEmail — the same canonical lowercased
 * spelling /unsubscribe stores — so a case-variant address can never dodge
 * the list.
 */
async function isPublicAddressUnsubscribed(
  admin: SupabaseClient,
  email: string,
): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from('public_email_unsubscribes')
      .select('email')
      .eq('email', normalizeUnsubscribeEmail(email))
      .maybeSingle();
    if (error) {
      await reportUnsubscribeReadFailure(error);
      return true;
    }
    return data != null;
  } catch (e) {
    await reportUnsubscribeReadFailure(e);
    return true;
  }
}

async function reportUnsubscribeReadFailure(error: unknown): Promise<void> {
  try {
    await reportError(error, { tag: 'orders.return-prompt.unsubscribe_read', level: 'warning' });
  } catch {
    /* reporting is itself best-effort */
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

/** The replacement completion email's button (it opens the replacement's own return page). */
const REPLACEMENT_RETURN_CTA = 'Start a return';

/**
 * Returns RX-2 (X-4): the replacement's completion email through the return-
 * update family, the button opening the replacement's own return page. True
 * when sent (a recorded public opt-out also answers true: nothing to retry).
 * Part never sent comes first (the order's own news, whatever the RMA's
 * status), then a closed RMA's "Your exchange is complete", else "Your
 * replacement was handed over".
 */
async function sendReplacementCompletionEmail(
  admin: SupabaseClient,
  args: {
    returnId: string;
    to: string;
    recipientName: string | null;
    appUrl: string;
    token: string;
    isAccountHolder: boolean;
    partNeverSent: boolean;
  },
): Promise<boolean> {
  const facts = await loadReplacementEmailFacts(admin, args.returnId);
  const base = args.appUrl.replace(/\/+$/, '');
  const result = await sendReturnUpdateEmail(admin, {
    event: args.partNeverSent
      ? 'replacement_closed_partial'
      : facts?.returnStatus === 'closed'
        ? 'exchange_complete'
        : 'replacement_handed_over',
    to: args.to,
    recipientName: args.recipientName,
    returnNumber: facts?.returnNumber ?? null,
    orderNumber: formatOrderNumber(facts?.originalOrderNumber ?? null),
    isAccountHolder: args.isAccountHolder,
    viewUrl: `${base}/returns/request/${args.token}`,
    appUrl: args.appUrl,
    ctaLabel: REPLACEMENT_RETURN_CTA,
  });
  return result.sent || result.reason === 'suppressed';
}
