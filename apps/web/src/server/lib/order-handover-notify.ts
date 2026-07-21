import 'server-only';

import { assertEmailWeight } from '@/lib/email/es/components';
import {
  FULFILLMENT_ORDERS_FROM,
  buildPrefEmailDelivery,
  buildViaStockPilotFrom,
  renderBackorderShippedEmail,
  renderPartialFulfilledEmail,
  renderPartialReceiptEmail,
} from '@/lib/email/es/families/fulfillment';
import { sendEmail } from '@/lib/email/resend';
import { createAdminClient } from '@/lib/supabase/admin';

import { createNotification } from '@/server/services/notifications';

import type { FulfillmentLineItem } from '@/lib/email/es/families/fulfillment';

/**
 * Requester notifications for the two backorder hand-over outcomes. Shared by
 * BOTH signature paths — the public sign route (digital) and
 * OrderRequestsService.confirmPhysicalSignature (paper) — so a partial
 * hand-over notifies identically no matter how the signature was captured.
 * Everything here is best-effort: a notification failure must never fail the
 * fulfillment, so every function swallows its own errors.
 *
 * Emails render through the es fulfillment family (Unit E5). The trigger,
 * suppression, and preference semantics are UNCHANGED: the
 * `email_order_completed` opt-out computed by the callers is honored via the
 * same `requesterEmail && !emailOptedOut` gate as before.
 */

/** Short "Apr 29"-style date for stat cards / delivery lines. */
function shortDate(d: Date = new Date()): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Per-line items for the partial/receipt tables — best-effort admin read
 * (the templates render without the table when this comes back empty).
 */
export async function fetchOrderLineItems(orderId: string): Promise<FulfillmentLineItem[]> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from('order_request_lines')
      .select('quantity_requested, quantity_fulfilled, inventory_items(name, sku)')
      .eq('order_request_id', orderId);
    type Row = {
      quantity_requested: number | null;
      quantity_fulfilled: number | null;
      inventory_items:
        | { name: string | null; sku: string | null }
        | { name: string | null; sku: string | null }[]
        | null;
    };
    return ((data ?? []) as Row[]).map((r) => {
      const item = Array.isArray(r.inventory_items) ? r.inventory_items[0] : r.inventory_items;
      return {
        name: item?.name ?? 'Item',
        sku: item?.sku ?? null,
        qtyRequested: Number(r.quantity_requested) || 0,
        qtyFulfilled: Number(r.quantity_fulfilled) || 0,
      };
    });
  } catch {
    return [];
  }
}

/** Org display name for the signer receipt's via-StockPilot sender (best-effort). */
async function fetchOrgName(organizationId: string): Promise<string | null> {
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from('organizations')
      .select('name')
      .eq('id', organizationId)
      .maybeSingle();
    return (data as { name?: string | null } | null)?.name ?? null;
  } catch {
    return null;
  }
}

/** Partial hand-over (order → backordered): in-app+push, plus email unless opted out. */
export async function notifyRequesterBackordered(args: {
  organizationId: string;
  orderId: string;
  requesterUserId: string | null;
  requesterEmail: string | null;
  requesterName: string | null;
  appUrl: string;
  provided: number;
  requested: number;
  owed: number;
  emailOptedOut: boolean;
}): Promise<void> {
  const orderNo = args.orderId.slice(0, 8).toUpperCase();
  const link = `${args.appUrl.replace(/\/+$/, '')}/dashboard/orders/${args.orderId}`;
  const title = `Order #${orderNo}: partially fulfilled`;
  const body = `${args.provided} of ${args.requested} provided — ${args.owed} backordered. We'll ship the rest when stock arrives.`;
  try {
    if (args.requesterUserId) {
      await createNotification({
        organizationId: args.organizationId,
        userId: args.requesterUserId,
        type: 'order_backordered',
        title,
        body,
        link,
        metadata: {
          orderId: args.orderId,
          provided: args.provided,
          requested: args.requested,
          owed: args.owed,
        },
      });
    }
    if (args.requesterEmail && !args.emailOptedOut) {
      const delivery = buildPrefEmailDelivery({
        appUrl: args.appUrl,
        recipientEmail: args.requesterEmail,
        isAccountHolder: Boolean(args.requesterUserId),
      });
      const items = await fetchOrderLineItems(args.orderId);
      const rendered = renderPartialFulfilledEmail({
        orderNumber: `#${orderNo}`,
        recipientFirstName: args.requesterName,
        recipientEmail: args.requesterEmail,
        delivered: args.provided,
        requested: args.requested,
        backordered: args.owed,
        deliveredOn: shortDate(),
        items,
        orderUrl: link,
        urls: delivery.urls,
      });
      assertEmailWeight(rendered.html);
      await sendEmail({
        to: args.requesterEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        from: FULFILLMENT_ORDERS_FROM,
        headers: delivery.headers,
      });
    }
  } catch {
    /* best-effort — never fail the fulfillment on a notification error */
  }
}

/** A previously-backordered order finally completed (remainder shipped). */
export async function notifyRequesterBackorderShipped(args: {
  organizationId: string;
  orderId: string;
  requesterUserId: string | null;
  requesterEmail: string | null;
  requesterName: string | null;
  appUrl: string;
  emailOptedOut: boolean;
  /**
   * How many units the remainder batch carried (callers already know
   * totalFulfilled − priorFulfilled). Optional/additive — display only.
   */
  unitsShipped?: number | null;
}): Promise<void> {
  const orderNo = args.orderId.slice(0, 8).toUpperCase();
  const link = `${args.appUrl.replace(/\/+$/, '')}/dashboard/orders/${args.orderId}`;
  const title = `Order #${orderNo}: backordered items shipped`;
  const body = 'The remaining items on your order have shipped — it is now fully fulfilled.';
  try {
    if (args.requesterUserId) {
      await createNotification({
        organizationId: args.organizationId,
        userId: args.requesterUserId,
        type: 'order_backorder_shipped',
        title,
        body,
        link,
        metadata: { orderId: args.orderId },
      });
    }
    if (args.requesterEmail && !args.emailOptedOut) {
      const delivery = buildPrefEmailDelivery({
        appUrl: args.appUrl,
        recipientEmail: args.requesterEmail,
        isAccountHolder: Boolean(args.requesterUserId),
      });
      const rendered = renderBackorderShippedEmail({
        orderNumber: `#${orderNo}`,
        recipientFirstName: args.requesterName,
        recipientEmail: args.requesterEmail,
        unitsShipped: args.unitsShipped ?? null,
        trackUrl: link,
        urls: delivery.urls,
      });
      assertEmailWeight(rendered.html);
      await sendEmail({
        to: args.requesterEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        from: FULFILLMENT_ORDERS_FROM,
        headers: delivery.headers,
      });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Transactional receipt for the SIGNER of a partial delivery (may be
 * neither the requester nor a StockPilot user). External-recipient
 * treatment: receipt language, zero jargon, explainer footer, NO
 * unsubscribe (one-time transactional record), display-from
 * "<supplier> via StockPilot". Best-effort like everything here.
 */
export async function sendPartialReceiptEmail(args: {
  organizationId: string;
  orderId: string;
  to: string;
  signerName: string;
  unitsReceived: number;
  unitsTotal: number;
  unitsPending: number;
  appUrl: string;
}): Promise<void> {
  const orderNo = args.orderId.slice(0, 8).toUpperCase();
  const signedAt = new Date().toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  });
  const [orgName, items] = await Promise.all([
    fetchOrgName(args.organizationId),
    fetchOrderLineItems(args.orderId),
  ]);
  const rendered = renderPartialReceiptEmail({
    orderNumber: `#${orderNo}`,
    supplierName: orgName,
    signerName: args.signerName,
    signedAt,
    unitsReceived: args.unitsReceived,
    unitsTotal: args.unitsTotal,
    unitsPending: args.unitsPending,
    items,
    appUrl: args.appUrl,
  });
  assertEmailWeight(rendered.html);
  await sendEmail({
    to: args.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    from: buildViaStockPilotFrom(orgName),
  });
}
