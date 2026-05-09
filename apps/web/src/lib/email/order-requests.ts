import 'server-only';

import { sendEmail } from './resend';

import type { OrderRequestRow } from '@/server/services/order-requests';

export type OrderRequestEmailKind =
  | 'submitted'
  | 'approved'
  | 'denied'
  | 'packaging'
  | 'ready_for_delivery'
  | 'delivered'
  | 'cancelled';

interface SendInput {
  kind: OrderRequestEmailKind;
  request: OrderRequestRow;
  recipientEmail: string;
  recipientName: string | null;
  appUrl: string;
}

const SUBJECTS: Record<OrderRequestEmailKind, string> = {
  submitted: 'Your order request was submitted',
  approved: 'Your order request was approved',
  denied: 'Your order request was denied',
  packaging: 'Your order is being packaged',
  ready_for_delivery: 'Your order is ready',
  delivered: 'Your order was delivered',
  cancelled: 'Your order was cancelled',
};

const HEADLINES: Record<OrderRequestEmailKind, string> = {
  submitted: 'Request received',
  approved: 'Approved',
  denied: 'Request denied',
  packaging: 'Now being packaged',
  ready_for_delivery: 'Ready to deliver',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

/**
 * Sends a transactional email about an order-request status change.
 *
 * v1 ships a clean, simple HTML body — title + status block + a CTA link
 * back to the request page. Public-link requesters get a `/r/<token>/track`
 * link; signed-in users get the dashboard URL. The email-templates work
 * later swaps this for richer React-Email components without changing
 * the call site.
 */
export async function sendOrderRequestEmail(input: SendInput): Promise<void> {
  const { kind, request, recipientEmail, recipientName, appUrl } = input;
  const subject = SUBJECTS[kind];
  const headline = HEADLINES[kind];
  const reasonLine =
    (kind === 'denied' || kind === 'cancelled') && request.denied_reason
      ? `<p style="color:#666;">Reason: ${escapeHtml(request.denied_reason)}</p>`
      : '';

  const link = request.requester_user_id
    ? `${appUrl}/dashboard/orders/${request.id}`
    : `${appUrl}/r/track?id=${request.id}&email=${encodeURIComponent(recipientEmail)}`;

  const greeting = recipientName
    ? `Hi ${escapeHtml(recipientName)},`
    : 'Hello,';

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f6f6f6;margin:0;padding:24px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
    <p style="margin:0 0 8px;color:#888;font-size:12px;letter-spacing:0.05em;text-transform:uppercase;">StockPilot</p>
    <h1 style="margin:0 0 16px;font-size:22px;">${escapeHtml(headline)}</h1>
    <p style="margin:0 0 12px;font-size:14px;color:#333;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#333;line-height:1.5;">
      ${bodyParagraph(kind)}
    </p>
    ${reasonLine}
    <p style="margin:24px 0;">
      <a href="${link}" style="background:#0a66ff;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">View request</a>
    </p>
    <p style="margin:24px 0 0;color:#999;font-size:11px;">
      Request ID: ${request.id}
    </p>
  </div>
</body></html>`;

  const text = `${headline}

${greeting}

${bodyParagraphPlain(kind)}
${request.denied_reason ? '\nReason: ' + request.denied_reason : ''}

View request: ${link}

Request ID: ${request.id}`;

  await sendEmail({ to: recipientEmail, subject, html, text });
}

function bodyParagraph(kind: OrderRequestEmailKind): string {
  switch (kind) {
    case 'submitted':
      return "We've received your order request. A manager will review it shortly.";
    case 'approved':
      return 'Your request was approved and stock has been reserved. Packaging will start soon.';
    case 'denied':
      return 'Your request was not approved.';
    case 'packaging':
      return 'Your order is being packaged right now.';
    case 'ready_for_delivery':
      return 'Your order is packed and ready for pickup or delivery.';
    case 'delivered':
      return 'Your order was delivered. Thanks!';
    case 'cancelled':
      return 'Your order request was cancelled. Any reserved stock has been released.';
  }
}

function bodyParagraphPlain(kind: OrderRequestEmailKind): string {
  return bodyParagraph(kind).replace(/<[^>]+>/g, '');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
