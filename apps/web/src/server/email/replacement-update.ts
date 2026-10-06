import { formatOrderNumber } from '@stockpilot/core';
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { reportError } from '@/lib/error-reporter';
import { resolveReturnToken } from '@/server/lib/order-secrets';

import { sendReturnUpdateEmail, type ReturnUpdateEmailEvent } from './return-update';

/**
 * The exchange replacement order's emails (returns RX-2, plan 3.6.7 and 3.6.8,
 * judge A-3 and X-4).
 *
 * A replacement order is created and approved by its RMA's functions, so the
 * ordinary order emails would say the wrong thing ("We received your order",
 * "Your order was approved") or link a tracker no replacement has: no track
 * token is minted for one, and a /r/track link without a token is a dead end.
 * So every order email for a replacement goes through here instead
 * (`sendOrderRequestEmail` hands it over, the single choke point):
 *
 *   received, confirm, approved, denied, cancelled, packing  never sent (the
 *       RMA's own message covers the approval and the cancel; picking is
 *       internal)
 *   staged for delivery   "Your replacement is ready. Ready for delivery."
 *   in transit            "Your replacement is on the way."
 *   backordered           "Part of your replacement was handed over. The rest
 *       will follow." (the hand-over notices hand it over; their in-app
 *       notice is the notify trigger's reworded ping instead)
 *   completed             to the requester: nothing here (the return prompt's
 *       replacement branch is the one completion email, carrying the
 *       replacement's own return link, at most once); to anyone else who
 *       signed: "The exchange replacement was handed over. Thank you for
 *       signing for it.", without a link (the RMA token page opens the
 *       requester's return) and never "your exchange" (review P14: it said
 *       "Your exchange is complete ... you can start a return from here"
 *       with no button, to a third party)
 *
 * LINKS (A-3): a member requester opens the replacement order in the app
 * ("View your replacement", review P14); a B2B portal requester opens
 * /portal; an email-only requester opens the RMA's token page they already
 * hold (the ORIGINAL order's return link); both keep "View your return". A
 * link is never built from a missing token: without one the email has no
 * button.
 *
 * Words: the return-update family (core's requester words): no reason, rack,
 * quantity on record or staff name.
 */

export interface ReplacementEmailOrder {
  id: string;
  source: string;
  requester_user_id: string | null;
  requester_email?: string | null;
  replacement_for_return_id?: string | null;
}

export interface ReplacementEmailFacts {
  returnId: string;
  returnNumber: string | null;
  returnStatus: string | null;
  originalOrderId: string | null;
  originalOrderNumber: number | null;
}

/** The RMA facts a replacement email names (service role). Null when unreadable. */
export async function loadReplacementEmailFacts(
  admin: SupabaseClient,
  returnId: string,
): Promise<ReplacementEmailFacts | null> {
  try {
    const { data, error } = await admin
      .from('returns')
      .select('id, return_number, status, order_request_id, order_request:order_requests!order_request_id (order_number)')
      .eq('id', returnId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as {
      id: string;
      return_number: string | null;
      status: string | null;
      order_request_id: string | null;
      order_request?: { order_number: number | null } | Array<{ order_number: number | null }> | null;
    };
    const original = Array.isArray(row.order_request) ? (row.order_request[0] ?? null) : (row.order_request ?? null);
    return {
      returnId: row.id,
      returnNumber: row.return_number,
      returnStatus: row.status,
      originalOrderId: row.order_request_id,
      originalOrderNumber: original?.order_number ?? null,
    };
  } catch {
    return null;
  }
}

/** What the requester's button opens (see LINKS above): one rule for the URL and its words. */
export function replacementLinkTarget(
  order: Pick<ReplacementEmailOrder, 'source' | 'requester_user_id'>,
): 'portal' | 'replacement_order' | 'return_page' {
  if (order.source === 'portal') return 'portal';
  if (order.requester_user_id) return 'replacement_order';
  return 'return_page';
}

/** A member's button opens the replacement order, so it says so (review P14). */
const REPLACEMENT_ORDER_CTA = 'View your replacement';

/** The button's words; null keeps the registry's "View your return". */
export function replacementCtaLabel(order: Pick<ReplacementEmailOrder, 'source' | 'requester_user_id'>): string | null {
  return replacementLinkTarget(order) === 'replacement_order' ? REPLACEMENT_ORDER_CTA : null;
}

/** Where the requester's button goes (see LINKS above). */
export async function replacementViewUrl(
  admin: SupabaseClient,
  order: ReplacementEmailOrder,
  facts: ReplacementEmailFacts,
  appUrl: string,
): Promise<string | null> {
  const base = appUrl.replace(/\/+$/, '');
  const target = replacementLinkTarget(order);
  if (target === 'portal') return `${base}/portal`;
  if (target === 'replacement_order') return `${base}/dashboard/orders/${order.id}`;
  if (!facts.originalOrderId) return null;
  let token: string | null = null;
  try {
    token = await resolveReturnToken(admin, facts.originalOrderId);
  } catch {
    token = null;
  }
  return token ? `${base}/returns/request/${token}` : null;
}

/**
 * The order email kinds a replacement order sends, reworded; null = never
 * sent. The completion is never sent to the requester from here (the return
 * prompt's replacement branch is their one completion email); anyone else
 * who signed gets the receipt of the hand-over, whatever the RMA's status.
 */
export function replacementEventForOrderEmail(
  kind: string,
  recipient: { toRequester: boolean },
): ReturnUpdateEmailEvent | null {
  switch (kind) {
    case 'staged_for_delivery':
      return 'replacement_ready_delivery';
    case 'in_transit':
      return 'replacement_on_the_way';
    case 'backordered':
      return 'replacement_partly_handed_over';
    case 'completed':
      return recipient.toRequester ? null : 'replacement_signed_for';
    default:
      return null;
  }
}

/** The requester's own address (the row's, else the member's profile). */
async function requesterAddress(admin: SupabaseClient, order: ReplacementEmailOrder): Promise<string | null> {
  if (order.requester_email) return order.requester_email;
  if (!order.requester_user_id) return null;
  try {
    const { data } = await admin.from('user_profiles').select('email').eq('id', order.requester_user_id).maybeSingle();
    return ((data as { email?: string | null } | null)?.email ?? null) || null;
  } catch {
    return null;
  }
}

export type ReplacementOrderEmailOutcome = 'sent' | 'skipped' | 'failed';

/**
 * One order email for a replacement order (see the module header). Never
 * throws.
 */
export async function sendReplacementOrderEmail(
  admin: SupabaseClient,
  args: {
    order: ReplacementEmailOrder;
    kind: string;
    to: string;
    recipientName: string | null;
    appUrl: string;
  },
): Promise<ReplacementOrderEmailOutcome> {
  try {
    const returnId = args.order.replacement_for_return_id;
    if (!returnId) return 'skipped';
    const facts = await loadReplacementEmailFacts(admin, returnId);
    if (!facts) return 'skipped';
    const own = await requesterAddress(admin, args.order);
    const toRequester = own !== null && own.trim().toLowerCase() === args.to.trim().toLowerCase();
    // The requester's completion email is the return prompt's replacement
    // branch (one email, with the replacement's own return link): the
    // completion answers null for them here.
    const event = replacementEventForOrderEmail(args.kind, { toRequester });
    if (!event) return 'skipped';
    // Only the requester gets a link: the RMA token page opens their return,
    // so a signer who is someone else gets the receipt without a button.
    const viewUrl = toRequester ? await replacementViewUrl(admin, args.order, facts, args.appUrl) : null;
    const result = await sendReturnUpdateEmail(admin, {
      event,
      to: args.to,
      recipientName: args.recipientName,
      returnNumber: facts.returnNumber,
      orderNumber: formatOrderNumber(facts.originalOrderNumber),
      isAccountHolder: Boolean(args.order.requester_user_id),
      viewUrl,
      appUrl: args.appUrl,
      ctaLabel: viewUrl ? replacementCtaLabel(args.order) : null,
    });
    return result.sent ? 'sent' : result.reason === 'suppressed' ? 'skipped' : 'failed';
  } catch (e) {
    try {
      await reportError(e, { tag: 'returns.replacement_email', extra: { orderId: args.order.id, kind: args.kind } });
    } catch {
      /* reporting is itself best-effort */
    }
    return 'failed';
  }
}

/**
 * The RMA an order is the exchange replacement for, and the order's source,
 * read by id with the service role (for callers that hold only the order
 * id). Null for an ordinary order and when the read fails (the ordinary
 * notice then goes out, as before this slice).
 */
export async function replacementOrderFor(
  admin: SupabaseClient,
  orderId: string,
): Promise<{ returnId: string; source: string } | null> {
  try {
    const { data, error } = await admin
      .from('order_requests')
      .select('replacement_for_return_id, source')
      .eq('id', orderId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { replacement_for_return_id?: string | null; source?: string | null };
    return row.replacement_for_return_id ? { returnId: row.replacement_for_return_id, source: row.source ?? 'internal' } : null;
  } catch {
    return null;
  }
}
