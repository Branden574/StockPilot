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
  | 'in_transit'
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
  in_transit: 'Your order is on the way',
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
  in_transit: 'On the way',
  completed: 'Delivered',
  cancelled: 'Cancelled',
};

/** Status pill color tokens — picks the visual tone of the headline. */
type StatusTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';
const TONES: Record<OrderRequestEmailKind, StatusTone> = {
  submitted: 'info',
  confirm_request: 'warning',
  approved: 'success',
  denied: 'danger',
  packing_slip_generated: 'info',
  staged_for_delivery: 'info',
  in_transit: 'info',
  completed: 'success',
  cancelled: 'neutral',
};

const TONE_COLORS: Record<StatusTone, { bg: string; fg: string; border: string }> = {
  info: { bg: '#eef2ff', fg: '#3730a3', border: '#c7d2fe' },
  success: { bg: '#ecfdf5', fg: '#065f46', border: '#a7f3d0' },
  warning: { bg: '#fff7ed', fg: '#9a3412', border: '#fed7aa' },
  danger: { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca' },
  neutral: { bg: '#f1f5f9', fg: '#334155', border: '#cbd5e1' },
};

/**
 * Sends a transactional email about an order-request status change.
 *
 * Templates are email-client-safe (table layout, inline styles, no
 * external CSS, system-font stack). Public requesters get a CTA to
 * the /r/track page AND a "Tracking details" card with the Request
 * ID + tracking key spelled out so the email survives clients that
 * strip query strings on link rewrites.
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

  const isPickup = request.fulfillment_type === 'pickup';
  const subject =
    kind === 'staged_for_delivery' && isPickup
      ? 'Your order is ready for pickup'
      : SUBJECTS[kind];
  const headline =
    kind === 'staged_for_delivery' && isPickup
      ? 'Ready for pickup'
      : HEADLINES[kind];
  const tone = TONES[kind];

  const publicTrackUrl = publicRequestToken
    ? `${appUrl}/r/track?id=${request.id}` +
      `&email=${encodeURIComponent(recipientEmail)}` +
      `&t=${encodeURIComponent(publicRequestToken)}`
    : `${appUrl}/r/track?id=${request.id}&email=${encodeURIComponent(recipientEmail)}`;

  if (kind === 'confirm_request' && !confirmationToken) {
    throw new Error(
      'confirm_request email requires a confirmationToken — refusing to send empty CTA.',
    );
  }
  const confirmUrl =
    kind === 'confirm_request' && confirmationToken
      ? `${appUrl}/r/confirm?id=${request.id}&t=${encodeURIComponent(confirmationToken)}`
      : null;

  const isPublicRequester = request.requester_user_id === null;
  const link = confirmUrl
    ? confirmUrl
    : isPublicRequester
      ? publicTrackUrl
      : `${appUrl}/dashboard/orders/${request.id}`;
  const ctaLabel = kind === 'confirm_request' ? 'Confirm request' : 'View order';

  const greeting = recipientName
    ? `Hi ${escapeHtml(recipientName.split(' ')[0] ?? recipientName)},`
    : 'Hello,';

  const html = renderHtml({
    headline,
    tone,
    greeting,
    bodyHtml: bodyParagraph(kind, request),
    reasonHtml:
      (kind === 'denied' || kind === 'cancelled') && request.denied_reason
        ? escapeHtml(request.denied_reason)
        : null,
    ctaLabel,
    ctaUrl: link,
    showTrackingCard: isPublicRequester && kind !== 'confirm_request',
    requestId: request.id,
    recipientEmail,
    trackingKey: publicRequestToken ?? null,
    trackingUrl: publicTrackUrl,
    expiryNote:
      kind === 'confirm_request'
        ? "This confirmation link expires in 24 hours. If you didn't request this, you can safely ignore this email — nothing else happens until you click."
        : null,
    appUrl,
  });

  const text = renderText({
    headline,
    greeting,
    body: bodyParagraphPlain(kind, request),
    reason:
      (kind === 'denied' || kind === 'cancelled') && request.denied_reason
        ? sanitizePlainText(request.denied_reason)
        : null,
    ctaLabel,
    ctaUrl: link,
    showTrackingCard: isPublicRequester && kind !== 'confirm_request',
    requestId: request.id,
    recipientEmail,
    trackingKey: publicRequestToken ?? null,
    trackingUrl: publicTrackUrl,
    expiryNote:
      kind === 'confirm_request'
        ? "This confirmation link expires in 24 hours. If you didn't request this, you can safely ignore this email."
        : null,
  });

  await sendEmail({ to: recipientEmail, subject, html, text });
}

// ─── HTML renderer ────────────────────────────────────────────────────

interface RenderArgs {
  headline: string;
  tone: StatusTone;
  greeting: string;
  bodyHtml: string;
  reasonHtml: string | null;
  ctaLabel: string;
  ctaUrl: string;
  showTrackingCard: boolean;
  requestId: string;
  recipientEmail: string;
  trackingKey: string | null;
  trackingUrl: string;
  expiryNote: string | null;
  appUrl: string;
}

/**
 * Email-client-safe HTML. Table-based outer layout for Outlook, inline
 * styles for everything (Gmail, Outlook, Apple Mail all strip <style>
 * tags inconsistently), system-font stack with web-safe fallbacks.
 * Preview text injected via `display:none` div so inbox previews show
 * a useful snippet instead of "Hi Branden,".
 */
function renderHtml(a: RenderArgs): string {
  const tc = TONE_COLORS[a.tone];
  const previewText = stripTags(a.bodyHtml).slice(0, 110);

  const reasonBlock = a.reasonHtml
    ? `
      <tr>
        <td style="padding:0 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:16px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;">
            <tr>
              <td style="padding:14px 16px;">
                <p style="margin:0;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#991b1b;">Reason</p>
                <p style="margin:6px 0 0;font-size:14px;line-height:1.5;color:#7f1d1d;">${a.reasonHtml}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : '';

  const trackingCard = a.showTrackingCard
    ? `
      <tr>
        <td style="padding:0 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
            <tr>
              <td style="padding:18px 20px;">
                <p style="margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">Tracking details</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="font-size:13px;line-height:1.5;color:#0f172a;">
                  <tr>
                    <td style="padding:6px 0;color:#64748b;width:120px;vertical-align:top;">Request ID</td>
                    <td style="padding:6px 0;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:12px;color:#0f172a;word-break:break-all;">${escapeHtml(a.requestId)}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#64748b;vertical-align:top;">Email</td>
                    <td style="padding:6px 0;color:#0f172a;word-break:break-all;">${escapeHtml(a.recipientEmail)}</td>
                  </tr>
                  ${
                    a.trackingKey
                      ? `<tr>
                    <td style="padding:6px 0;color:#64748b;vertical-align:top;">Tracking key</td>
                    <td style="padding:6px 0;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:12px;color:#0f172a;word-break:break-all;">${escapeHtml(a.trackingKey)}</td>
                  </tr>`
                      : ''
                  }
                </table>
                <p style="margin:14px 0 0;font-size:11.5px;color:#64748b;line-height:1.5;">
                  Save this info. If the button above doesn't work, copy these into the form at
                  <a href="${escapeHtml(a.appUrl)}/r/track" style="color:#4f46e5;text-decoration:none;">${escapeHtml(stripProtocol(a.appUrl))}/r/track</a>.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>`
    : '';

  const expiryBlock = a.expiryNote
    ? `
      <tr>
        <td style="padding:0 32px;">
          <p style="margin:18px 0 0;font-size:11.5px;color:#64748b;line-height:1.55;">${escapeHtml(a.expiryNote)}</p>
        </td>
      </tr>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>${escapeHtml(a.headline)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#0f172a;">
  <div style="display:none;max-height:0;overflow:hidden;color:transparent;font-size:1px;line-height:1px;opacity:0;">${escapeHtml(previewText)}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;box-shadow:0 1px 2px rgba(15,23,42,0.04),0 8px 24px -8px rgba(15,23,42,0.12);overflow:hidden;">
          <!-- Brand band -->
          <tr>
            <td style="padding:24px 32px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="vertical-align:middle;">
                    <span style="display:inline-block;width:28px;height:28px;border-radius:7px;background:linear-gradient(135deg,#4f46e5,#7c3aed);vertical-align:middle;"></span>
                    <span style="display:inline-block;margin-left:10px;vertical-align:middle;font-size:14px;font-weight:700;letter-spacing:-0.01em;color:#0f172a;">StockPilot</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Status pill -->
          <tr>
            <td style="padding:24px 32px 0;">
              <span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${tc.bg};color:${tc.fg};border:1px solid ${tc.border};font-size:11.5px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(a.headline)}</span>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:14px 32px 0;">
              <p style="margin:0 0 8px;font-size:15px;line-height:1.55;color:#334155;">${a.greeting}</p>
              <p style="margin:0;font-size:15.5px;line-height:1.6;color:#0f172a;">${a.bodyHtml}</p>
            </td>
          </tr>
          ${reasonBlock}
          <!-- CTA -->
          <tr>
            <td style="padding:24px 32px 4px;" align="left">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-radius:10px;background:#4f46e5;">
                    <a href="${escapeHtml(a.ctaUrl)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:0.01em;">${escapeHtml(a.ctaLabel)} →</a>
                  </td>
                </tr>
              </table>
              <p style="margin:10px 0 0;font-size:11px;color:#94a3b8;line-height:1.5;">Or paste this link in your browser:<br><span style="color:#475569;word-break:break-all;">${escapeHtml(a.ctaUrl)}</span></p>
            </td>
          </tr>
          ${trackingCard}
          ${expiryBlock}
          <!-- Divider -->
          <tr>
            <td style="padding:32px 32px 0;">
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0;">
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:18px 32px 28px;">
              <p style="margin:0;font-size:11px;line-height:1.55;color:#94a3b8;">
                You're receiving this because a request linked to <strong style="color:#64748b;font-weight:600;">${escapeHtml(a.recipientEmail)}</strong> moved through StockPilot.<br>
                StockPilot · Inventory + order management
              </p>
            </td>
          </tr>
        </table>
        <p style="margin:20px 0 0;font-size:10.5px;color:#94a3b8;">© StockPilot. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Plaintext renderer ───────────────────────────────────────────────

interface RenderTextArgs {
  headline: string;
  greeting: string;
  body: string;
  reason: string | null;
  ctaLabel: string;
  ctaUrl: string;
  showTrackingCard: boolean;
  requestId: string;
  recipientEmail: string;
  trackingKey: string | null;
  trackingUrl: string;
  expiryNote: string | null;
}

function renderText(a: RenderTextArgs): string {
  const lines: string[] = [];
  lines.push(`StockPilot — ${a.headline}`);
  lines.push('');
  lines.push(a.greeting);
  lines.push('');
  lines.push(a.body);
  if (a.reason) {
    lines.push('');
    lines.push(`Reason: ${a.reason}`);
  }
  lines.push('');
  lines.push(`${a.ctaLabel}: ${a.ctaUrl}`);
  if (a.showTrackingCard) {
    lines.push('');
    lines.push('— Tracking details —');
    lines.push(`Request ID: ${a.requestId}`);
    lines.push(`Email: ${a.recipientEmail}`);
    if (a.trackingKey) lines.push(`Tracking key: ${a.trackingKey}`);
  }
  if (a.expiryNote) {
    lines.push('');
    lines.push(a.expiryNote);
  }
  lines.push('');
  lines.push('—');
  lines.push('StockPilot · Inventory + order management');
  return lines.join('\n');
}

function sanitizePlainText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

function bodyParagraph(
  kind: OrderRequestEmailKind,
  request?: OrderRequestRow,
): string {
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
    case 'in_transit':
      return "Your order is now in transit. We'll email you again when it's delivered.";
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

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function stripProtocol(s: string): string {
  return s.replace(/^https?:\/\//, '');
}
