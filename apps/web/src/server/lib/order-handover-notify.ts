import 'server-only';

import { sendEmail } from '@/lib/email/resend';

import { createNotification } from '@/server/services/notifications';

/**
 * Requester notifications for the two backorder hand-over outcomes. Shared by
 * BOTH signature paths — the public sign route (digital) and
 * OrderRequestsService.confirmPhysicalSignature (paper) — so a partial
 * hand-over notifies identically no matter how the signature was captured.
 * Everything here is best-effort: a notification failure must never fail the
 * fulfillment, so every function swallows its own errors.
 */

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
      await sendBackorderEmail({
        to: args.requesterEmail,
        recipientName: args.requesterName,
        subject: title,
        message:
          `${args.provided} of ${args.requested} items from your order have been fulfilled. ` +
          `The remaining ${args.owed} are backordered and will ship as soon as they're back in stock.`,
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
      await sendBackorderEmail({
        to: args.requesterEmail,
        recipientName: args.requesterName,
        subject: title,
        message:
          'Good news — the backordered items on your order have now shipped, ' +
          'so your order is complete.',
      });
    }
  } catch {
    /* best-effort */
  }
}

/** Bare transactional email for the backorder notices (no template coupling). */
export async function sendBackorderEmail(args: {
  to: string;
  recipientName: string | null;
  subject: string;
  message: string;
}): Promise<void> {
  const firstName = args.recipientName?.split(' ')[0] ?? 'there';
  const safeName = escapeHtml(firstName);
  const safeMsg = escapeHtml(args.message);
  await sendEmail({
    to: args.to,
    subject: args.subject,
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;color:#111">` +
      `<p>Hi ${safeName},</p>` +
      `<p>${safeMsg}</p>` +
      `<p style="color:#666;font-size:12px">You're receiving this because you placed an order with us.</p>` +
      `</div>`,
    text: `Hi ${firstName},\n\n${args.message}`,
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
