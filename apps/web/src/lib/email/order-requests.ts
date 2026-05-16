import 'server-only';

import { sendEmail } from './resend';

import type { OrderRequestRow } from '@/server/services/order-requests';

export type OrderRequestEmailKind =
  | 'submitted'
  | 'confirm_request'
  | 'approved'
  | 'denied'
  | 'packing_slip_generated'
  | 'staged_for_delivery'
  | 'completed'
  | 'cancelled';

interface SendInput {
  kind: OrderRequestEmailKind;
  request: OrderRequestRow;
  recipientEmail: string;
  recipientName: string | null;
  appUrl: string;
  /**
   * F2: org's `public_request_token`. Required for public-link
   * requesters so the email's "View request" CTA includes `&t=…` —
   * the GET /api/v1/public/order-requests/[id] handler scopes the
   * lookup by org public_request_token and silently 404s without it.
   * Only consulted when `request.requester_user_id` is null (public
   * submission). Optional/nullable so internal callers don't have to
   * supply it.
   */
  publicRequestToken?: string | null;
  /**
   * Plaintext confirmation token. Required ONLY for `kind ===
   * 'confirm_request'` — the CTA in that email points to
   * `/r/confirm?id=<id>&t=<plaintext>`. Hashing happens server-side
   * before storage so the email is the only place the raw value
   * lives. Not used by any other kind.
   */
  confirmationToken?: string | null;
}

const SUBJECTS: Record<OrderRequestEmailKind, string> = {
  submitted: 'Your order request was submitted',
  confirm_request: 'Confirm your order request',
  approved: 'Your order request was approved',
  denied: 'Your order request was denied',
  packing_slip_generated: 'Your order is being packaged',
  staged_for_delivery: 'Your order is ready',
  completed: 'Your order was delivered',
  cancelled: 'Your order was cancelled',
};

const HEADLINES: Record<OrderRequestEmailKind, string> = {
  submitted: 'Request received',
  confirm_request: 'Confirm your order request',
  approved: 'Approved',
  denied: 'Request denied',
  packing_slip_generated: 'Now being packaged',
  staged_for_delivery: 'Ready to deliver',
  completed: 'Delivered',
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
  const {
    kind,
    request,
    recipientEmail,
    recipientName,
    appUrl,
    publicRequestToken,
    confirmationToken,
  } = input;
  // staged_for_delivery is sent for BOTH pickup and delivery rows
  // (the kind name is historical). The body already branches on
  // fulfillment_type via bodyParagraph(); subject + headline get the
  // same treatment so a pickup customer doesn't see "Ready to deliver"
  // on a row that's actually ready to pick up.
  const isPickup = request.fulfillment_type === 'pickup';
  const subject =
    kind === 'staged_for_delivery' && isPickup
      ? 'Your order is ready for pickup'
      : SUBJECTS[kind];
  const headline =
    kind === 'staged_for_delivery' && isPickup
      ? 'Ready for pickup'
      : HEADLINES[kind];
  const reasonLine =
    (kind === 'denied' || kind === 'cancelled') && request.denied_reason
      ? `<p style="color:#666;">Reason: ${escapeHtml(request.denied_reason)}</p>`
      : '';

  // F2: public-link recipients need `&t=<token>` in the track URL —
  // the GET /api/v1/public/order-requests/[id] handler scopes lookups
  // by org token and silently 404s without it. If a caller forgot to
  // pass the token, fall back to the tokenless URL so the email still
  // sends; the user lands on a clean "we couldn't find that order"
  // state and can re-enter the token on /r/track manually.
  const publicTrackUrl = publicRequestToken
    ? `${appUrl}/r/track?id=${request.id}` +
      `&email=${encodeURIComponent(recipientEmail)}` +
      `&t=${encodeURIComponent(publicRequestToken)}`
    : `${appUrl}/r/track?id=${request.id}&email=${encodeURIComponent(recipientEmail)}`;

  // confirm_request emails get a dedicated `/r/confirm` link instead
  // of the "View request" track URL — the recipient must click it to
  // promote the row from pending_confirmation to pending_approval. We
  // refuse to send if the confirmation token is missing, so an empty
  // call never produces a useless email.
  if (kind === 'confirm_request' && !confirmationToken) {
    throw new Error(
      'confirm_request email requires a confirmationToken — refusing to send empty CTA.',
    );
  }
  const confirmUrl =
    kind === 'confirm_request' && confirmationToken
      ? `${appUrl}/r/confirm?id=${request.id}&t=${encodeURIComponent(confirmationToken)}`
      : null;

  const link = confirmUrl
    ? confirmUrl
    : request.requester_user_id
      ? `${appUrl}/dashboard/orders/${request.id}`
      : publicTrackUrl;
  const ctaLabel = kind === 'confirm_request' ? 'Confirm request' : 'View request';

  const greeting = recipientName
    ? `Hi ${escapeHtml(recipientName)},`
    : 'Hello,';

  const expiryNote =
    kind === 'confirm_request'
      ? `<p style="margin:8px 0 0;color:#888;font-size:12px;">This confirmation link expires in 24 hours. If you didn't request this, you can safely ignore this email — nothing else happens until you click.</p>`
      : '';

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f6f6f6;margin:0;padding:24px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;">
    <p style="margin:0 0 8px;color:#888;font-size:12px;letter-spacing:0.05em;text-transform:uppercase;">StockPilot</p>
    <h1 style="margin:0 0 16px;font-size:22px;">${escapeHtml(headline)}</h1>
    <p style="margin:0 0 12px;font-size:14px;color:#333;">${greeting}</p>
    <p style="margin:0 0 16px;font-size:14px;color:#333;line-height:1.5;">
      ${bodyParagraph(kind, request)}
    </p>
    ${reasonLine}
    <p style="margin:24px 0;">
      <a href="${link}" style="background:#0a66ff;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">${escapeHtml(ctaLabel)}</a>
    </p>
    ${expiryNote}
    <p style="margin:24px 0 0;color:#999;font-size:11px;">
      Request ID: ${request.id}
    </p>
  </div>
</body></html>`;

  const text = `${headline}

${greeting}

${bodyParagraphPlain(kind, request)}
${request.denied_reason ? '\nReason: ' + sanitizePlainText(request.denied_reason) : ''}

${ctaLabel}: ${link}
${kind === 'confirm_request' ? '\nThis link expires in 24 hours. If you didn\'t request this, you can safely ignore this email.\n' : ''}
Request ID: ${request.id}`;

  await sendEmail({ to: recipientEmail, subject, html, text });
}

/**
 * Strip CR/LF from user-controlled text before pasting into the
 * plain-text email body. The HTML body already calls escapeHtml(); this
 * is the matching guard for the text/plain part. Without it, a denial
 * reason containing `\r\nX-Injected: foo` could in theory smuggle a
 * header into the MIME message that Resend builds. Trailing whitespace
 * is also collapsed so the email reads cleanly.
 */
function sanitizePlainText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

function bodyParagraph(
  kind: OrderRequestEmailKind,
  request?: OrderRequestRow,
): string {
  // Branch copy on fulfillment_type so a pickup-style requester doesn't
  // see "we'll let you know when it ships" and vice versa. `request` is
  // optional so legacy callers that haven't been migrated still compile;
  // missing context falls back to the delivery-flavored wording (the
  // historical default before phase 2).
  const isPickup = request?.fulfillment_type === 'pickup';
  switch (kind) {
    case 'submitted':
      return isPickup
        ? "We've received your order request. We'll email you when it's ready to pick up."
        : "We've received your order request. We'll email you when it ships.";
    case 'confirm_request':
      return "Please confirm your order request by clicking the button below. Until you confirm, your request is on hold and won't be sent to a manager for review.";
    case 'approved':
      return 'Your request was approved and stock has been reserved. Packaging will start soon.';
    case 'denied':
      return 'Your request was not approved.';
    case 'packing_slip_generated':
      return 'Your order is being packaged right now.';
    case 'staged_for_delivery':
      return isPickup
        ? 'Your order is packed and ready for pickup.'
        : 'Your order is packed and ready to head out for delivery.';
    case 'completed':
      return 'Your order was delivered. Thanks!';
    case 'cancelled':
      return 'Your order request was cancelled. Any reserved stock has been released.';
  }
}

function bodyParagraphPlain(
  kind: OrderRequestEmailKind,
  request?: OrderRequestRow,
): string {
  return bodyParagraph(kind, request).replace(/<[^>]+>/g, '');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
