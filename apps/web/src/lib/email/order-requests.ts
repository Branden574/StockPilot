import 'server-only';

import { sendEmail } from './resend';
import {
  buildPublicUnsubscribeUrl,
  normalizeUnsubscribeEmail,
} from './unsubscribe';
import { createAdminClient } from '@/lib/supabase/admin';

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
   * requesters so the email's "Track" CTA includes `&t=…` — the GET
   * /api/v1/public/order-requests/[id] handler scopes the lookup by
   * org public_request_token and silently 404s without it. Only
   * consulted when `request.requester_user_id` is null (public
   * submission). Optional/nullable so internal callers don't have
   * to supply it.
   */
  publicRequestToken?: string | null;
  /**
   * Plaintext confirmation token. Required ONLY for `kind ===
   * 'confirm_request'` — the CTA in that email points to
   * `/r/confirm?id=<id>&t=<plaintext>`. Hashing happens server-side
   * before storage so the email is the only place the raw value
   * lives.
   */
  confirmationToken?: string | null;
}

// ─── Subject + preheader ─────────────────────────────────────────────

const SUBJECT_BY_KIND: Record<OrderRequestEmailKind, (orderId: string) => string> = {
  submitted: (id) => `${id} received — we're on it`,
  confirm_request: (id) => `Confirm ${id} to send it to the warehouse`,
  approved: (id) => `${id} is approved — packing has started`,
  denied: (id) => `${id} wasn't approved`,
  packing_slip_generated: (id) => `${id} is being packaged`,
  staged_for_delivery: (id) => `${id} is ready`,
  in_transit: (id) => `${id} is on the way`,
  completed: (id) => `${id} was delivered — thanks`,
  cancelled: (id) => `${id} was cancelled`,
};

const PILL_LABEL: Record<OrderRequestEmailKind, string> = {
  submitted: 'Received',
  confirm_request: 'Action needed',
  approved: 'Approved',
  denied: 'Denied',
  packing_slip_generated: 'Packing',
  staged_for_delivery: 'Ready',
  in_transit: 'In transit',
  completed: 'Delivered',
  cancelled: 'Cancelled',
};

// Pill colors mirror the design's OK_BG/OK_FG palette. Other kinds get
// tonal variants that read against the cream paper.
const PILL_COLORS: Record<OrderRequestEmailKind, { bg: string; fg: string }> = {
  submitted: { bg: '#e6ecf2', fg: '#1f3a5f' },
  confirm_request: { bg: '#faecd8', fg: '#7a4c12' },
  approved: { bg: '#e6efe7', fg: '#2f6a4a' },
  denied: { bg: '#f3dada', fg: '#7a1f1f' },
  packing_slip_generated: { bg: '#e6ecf2', fg: '#1f3a5f' },
  staged_for_delivery: { bg: '#e6efe7', fg: '#2f6a4a' },
  in_transit: { bg: '#e6ecf2', fg: '#1f3a5f' },
  completed: { bg: '#e6efe7', fg: '#2f6a4a' },
  cancelled: { bg: '#ece9e3', fg: '#5a5853' },
};

function headlineFor(
  kind: OrderRequestEmailKind,
  orderId: string,
  isPickup: boolean,
): { lead: string; tail: string } {
  switch (kind) {
    case 'submitted':
      return { lead: `${orderId} received.`, tail: 'Manager review next.' };
    case 'confirm_request':
      return { lead: `Confirm ${orderId}.`, tail: 'One click to send it.' };
    case 'approved':
      return { lead: `${orderId} is approved.`, tail: 'Packing starts now.' };
    case 'denied':
      return { lead: `${orderId} wasn't approved.`, tail: 'No items moved.' };
    case 'packing_slip_generated':
      return { lead: `${orderId} is being packaged.`, tail: 'Almost out the door.' };
    case 'staged_for_delivery':
      return isPickup
        ? { lead: `${orderId} is ready.`, tail: 'Come pick it up.' }
        : { lead: `${orderId} is ready to ship.`, tail: 'Awaiting carrier.' };
    case 'in_transit':
      return { lead: `${orderId} is on the way.`, tail: 'Watch the dock.' };
    case 'completed':
      return { lead: `${orderId} was delivered.`, tail: 'Thank you.' };
    case 'cancelled':
      return { lead: `${orderId} was cancelled.`, tail: 'Stock released.' };
  }
}

function leadParagraph(
  kind: OrderRequestEmailKind,
  isPickup: boolean,
  name: string,
): string {
  const hi = `Hi ${name} — `;
  switch (kind) {
    case 'submitted':
      return `${hi}we've got your request and it's queued for manager review. We'll write again the moment a decision lands.`;
    case 'confirm_request':
      return `${hi}we need a quick confirmation before this request reaches a manager. The button below will set it in motion.`;
    case 'approved':
      return `${hi}we've reserved every unit on this request. You'll get another note the moment it leaves the dock.`;
    case 'denied':
      return `${hi}this request wasn't approved. No stock was moved. The reason is below — reach out if anything looks off.`;
    case 'packing_slip_generated':
      return `${hi}your order is being packaged right now. We'll write again when it's out the door.`;
    case 'staged_for_delivery':
      return isPickup
        ? `${hi}your order is packed and ready for pickup whenever you are.`
        : `${hi}your order is packed and waiting for the carrier. We'll write again once it's in transit.`;
    case 'in_transit':
      return `${hi}your order just left the dock. The next note will confirm delivery.`;
    case 'completed':
      return `${hi}your order was signed for and delivered. Thanks for working with us.`;
    case 'cancelled':
      return `${hi}your order request was cancelled. Any reserved stock has been released back to inventory.`;
  }
}

// ─── Data fetching ───────────────────────────────────────────────────

interface SummaryData {
  lineCount: number;
  unitCount: number;
  shipDate: string | null;
  shipFrom: string | null;
  shipTo: string | null;
  orderNumber: string;
}

async function fetchSummary(row: OrderRequestRow): Promise<SummaryData> {
  let admin: ReturnType<typeof createAdminClient> | null = null;
  try {
    admin = createAdminClient();
  } catch {
    // No service-role key — return a degraded summary the template
    // can still render around (counts default to 0, shipDate/ships
    // omitted by the template when null).
    return {
      lineCount: 0,
      unitCount: 0,
      shipDate: null,
      shipFrom: null,
      shipTo: null,
      orderNumber: row.id,
    };
  }

  const [linesRes, whRes, charterRes] = await Promise.all([
    admin
      .from('order_request_lines')
      .select('quantity_picked, quantity_requested')
      .eq('order_request_id', row.id),
    admin
      .from('warehouses')
      .select('name, code, address')
      .eq('id', row.warehouse_id)
      .maybeSingle(),
    row.delivery_charter_id
      ? admin
          .from('charters')
          .select('name, code')
          .eq('id', row.delivery_charter_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  type LineRow = { quantity_picked: number | null; quantity_requested: number | null };
  const lines = (linesRes.data ?? []) as LineRow[];
  const lineCount = lines.length;
  const unitCount = lines.reduce((sum, l) => {
    const qty = l.quantity_picked ?? l.quantity_requested ?? 0;
    return sum + (Number(qty) || 0);
  }, 0);

  type Wh = {
    name?: string;
    code?: string;
    address?: { city?: string; state?: string } | null;
  };
  const wh = (whRes.data ?? null) as Wh | null;
  const shipFrom = wh
    ? `${wh.code ?? wh.name ?? '—'}${wh.address?.city ? ` — ${wh.address.city}` : ''}`
    : null;

  type Ch = { name?: string; code?: string };
  const ch = (charterRes.data ?? null) as Ch | null;
  const isPickup = row.fulfillment_type === 'pickup';
  const shipTo = isPickup
    ? row.requester_name ?? 'Pickup customer'
    : ch
      ? `${ch.code ?? ch.name ?? '—'}`
      : row.requester_name ?? '—';

  const shipDateIso =
    row.packing_slip_generated_at ?? row.approved_at ?? row.created_at;
  const shipDate = shipDateIso
    ? new Date(shipDateIso).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return {
    lineCount,
    unitCount,
    shipDate,
    shipFrom,
    shipTo,
    orderNumber: row.id, // full UUID as the long reference
  };
}

// ─── URL builders ────────────────────────────────────────────────────

function buildTrackUrl(
  row: OrderRequestRow,
  appUrl: string,
  recipientEmail: string,
  publicRequestToken: string | null,
): string {
  // B2B portal customers are authenticated but have NO dashboard access — send
  // them to their portal, where their order history lives.
  if (row.source === 'portal') {
    return `${appUrl}/portal`;
  }
  if (row.requester_user_id) {
    return `${appUrl}/dashboard/orders/${row.id}`;
  }
  const base = `${appUrl}/r/track?id=${row.id}&email=${encodeURIComponent(recipientEmail)}`;
  return publicRequestToken
    ? `${base}&t=${encodeURIComponent(publicRequestToken)}`
    : base;
}

/**
 * Where the footer "Manage notifications" link and the List-Unsubscribe
 * header point.
 *
 * Signed-in requesters keep the in-app preferences page — they can log
 * in, and their per-event prefs (migration 0113) are the source of
 * truth there.
 *
 * Public-link requesters are ANONYMOUS: the dashboard page dead-ends
 * them on /signin, which broke the unsubscribe promise (and the
 * Gmail/Yahoo bulk-sender requirement). They get the PUBLIC
 * /unsubscribe route instead, signed with an HMAC of the address so
 * the link can't be forged to unsubscribe someone else — and that
 * signed URL supports the RFC 8058 one-click POST (`oneClick`). Falls
 * back to the in-app URL only when UNSUBSCRIBE_SECRET isn't configured
 * (the signer fails closed; see lib/email/unsubscribe.ts).
 */
function buildUnsubscribeUrl(
  row: OrderRequestRow,
  appUrl: string,
  recipientEmail: string,
): { url: string; oneClick: boolean } {
  const inApp = `${appUrl}/dashboard/settings/notifications?email=${encodeURIComponent(recipientEmail)}`;
  if (row.requester_user_id) {
    return { url: inApp, oneClick: false };
  }
  const publicUrl = buildPublicUnsubscribeUrl(appUrl, recipientEmail);
  return publicUrl ? { url: publicUrl, oneClick: true } : { url: inApp, oneClick: false };
}

/**
 * True when the address opted out via the public /unsubscribe page
 * (migration 0222). Fail-OPEN on infra errors — same posture as
 * OrderRequestsService.wantsEmail: silently dropping an order-status
 * email on a DB blip is worse than sending one the recipient opted out
 * of, and dev environments without a service-role key still send their
 * dry-run emails.
 */
async function isPublicEmailUnsubscribed(email: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from('public_email_unsubscribes')
      .select('email')
      .eq('email', normalizeUnsubscribeEmail(email))
      .maybeSingle();
    if (error) return false;
    return data != null;
  } catch {
    return false;
  }
}

// ─── Inline brand mark (rendered in modern clients; Outlook hides) ──

/**
 * The carved-S stencil mark from the brand sheet. ~28×28 inline SVG —
 * Gmail web/iOS/Android, Apple Mail, Outlook 365 web all render it.
 * Outlook 2007–2019 desktop strips inline SVG; the wordmark text to
 * the right preserves the brand identity in those clients.
 */
// Hosted PNG (not inline SVG): Gmail/Outlook strip <svg>, so the brand mark
// must be a real raster image at an absolute URL to render in the inbox.
// Served from apps/web/public/email-logo.png. ?v=2 cache-busts GoogleImageProxy's
// stale failure cache — see EMAIL_LOGO_URL in templates.tsx for the full story.
const BRAND_MARK_SVG = `<img src="https://stockpilotusa.com/email-logo.png?v=2" width="28" height="28" alt="StockPilot" style="display:inline-block;vertical-align:middle;margin-right:10px;width:28px;height:28px;border-radius:6px" />`;

// ─── Template ────────────────────────────────────────────────────────

interface TemplateArgs {
  kind: OrderRequestEmailKind;
  request: OrderRequestRow;
  recipientEmail: string;
  recipientName: string | null;
  summary: SummaryData;
  trackUrl: string;
  unsubscribeUrl: string;
  reasonText: string | null;
  confirmExpiryNote: string | null;
}

function renderHtml(a: TemplateArgs): string {
  const isPickup = a.request.fulfillment_type === 'pickup';
  const orderId = `WO-${a.request.id.slice(0, 8).toUpperCase()}`;
  const firstName = (a.recipientName ?? '').trim().split(/\s+/)[0] || 'there';
  const head = headlineFor(a.kind, orderId, isPickup);
  const pill = PILL_COLORS[a.kind];
  const pillLabel = PILL_LABEL[a.kind];
  const lead = leadParagraph(a.kind, isPickup, escapeHtml(firstName));

  const units = a.summary.unitCount;
  const lineCount = a.summary.lineCount;
  const unitsLabel = `${units} ${units === 1 ? 'unit' : 'units'}`;
  const linesLabel = `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`;

  const previewText = `Reserved ${unitsLabel} across ${linesLabel}. Track from your dashboard or the link inside.`;

  const showSummaryCard = a.kind !== 'denied' && a.kind !== 'cancelled' && lineCount > 0;
  const showReason = !!a.reasonText;
  const showShipDate = !!a.summary.shipDate;

  const reasonBlock = showReason
    ? `
    <tr><td class="px" style="padding:0 36px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid rgba(122,31,31,0.20);background:#f3dada;border-radius:6px">
        <tr><td style="padding:14px 16px">
          <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:#7a1f1f;font-weight:600;margin-bottom:6px">Reason</div>
          <div style="font-size:13px;line-height:1.55;color:#5a1414">${escapeHtml(a.reasonText ?? '')}</div>
        </td></tr>
      </table>
    </td></tr>`
    : '';

  const summaryCard = showSummaryCard
    ? `
    <tr><td class="px" style="padding:0 36px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="grid" style="border:1px solid rgba(12,12,14,0.12);border-radius:6px">
        <tr>
          <td width="50%" style="padding:18px 20px;vertical-align:top">
            <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:#8b887f;font-weight:500;margin-bottom:5px">Order</div>
            <div style="font-size:14px;font-weight:600;color:#0c0c0e">${escapeHtml(orderId)}</div>
            <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;color:#8b887f;margin-top:3px;word-break:break-all">${escapeHtml(a.summary.orderNumber)}</div>
          </td>
          <td width="50%" style="padding:18px 20px;vertical-align:top">
            <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:#8b887f;font-weight:500;margin-bottom:5px">Reserved</div>
            <div style="font-size:14px;font-weight:600;color:#0c0c0e">${escapeHtml(unitsLabel)} <span style="color:#8b887f;font-weight:400">· ${escapeHtml(linesLabel)}</span></div>
            ${showShipDate ? `<div style="font-size:11.5px;color:#5a5853;margin-top:3px">Ships ${escapeHtml(a.summary.shipDate ?? '')}</div>` : ''}
          </td>
        </tr>
        <tr>
          <td style="padding:0 20px 18px;vertical-align:top">
            <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:#8b887f;font-weight:500;margin-bottom:5px">From</div>
            <div style="font-size:13px;color:#2a2a2c">${escapeHtml(a.summary.shipFrom ?? '—')}</div>
          </td>
          <td style="padding:0 20px 18px;vertical-align:top">
            <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:#8b887f;font-weight:500;margin-bottom:5px">${isPickup ? 'Pickup' : 'To'}</div>
            <div style="font-size:13px;color:#2a2a2c">${escapeHtml(a.summary.shipTo ?? '—')}</div>
          </td>
        </tr>
      </table>
    </td></tr>`
    : '';

  const expiryBlock = a.confirmExpiryNote
    ? `
    <tr><td class="px" style="padding:0 36px 28px">
      <div style="font-size:11.5px;color:#8b887f;line-height:1.55">${escapeHtml(a.confirmExpiryNote)}</div>
    </td></tr>`
    : '';

  const ctaLabel = a.kind === 'confirm_request' ? 'Confirm request' : 'Track this order';
  const eyebrowRight =
    a.kind === 'confirm_request'
      ? 'Action Needed'
      : a.kind === 'denied' || a.kind === 'cancelled'
        ? 'Order Update'
        : 'Order Update';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(SUBJECT_BY_KIND[a.kind](orderId))}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Tinos:ital@0;1&display=swap" rel="stylesheet">
<!--[if mso]><style>*{font-family:Helvetica,Arial,sans-serif!important}</style><![endif]-->
<style>
  @media (max-width:620px){
    .container{width:100%!important}
    .px{padding-left:24px!important;padding-right:24px!important}
    .h1{font-size:26px!important;line-height:1.15!important}
    .grid td{display:block!important;width:100%!important;padding-right:0!important}
    .foot-row td{display:block!important;width:100%!important;text-align:left!important;padding-bottom:6px!important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#e8e5dd;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;color:#0c0c0e;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(previewText)}</div>

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e8e5dd">
<tr><td align="center" style="padding:32px 16px">

  <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#f6f4ef;border-radius:6px;overflow:hidden">

    <!-- Brand strip -->
    <tr><td class="px" style="padding:20px 36px;border-bottom:1px solid rgba(12,12,14,0.12)">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle">
          ${BRAND_MARK_SVG}<span style="font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;letter-spacing:-0.025em;color:#0c0c0e;vertical-align:middle">Stock<span style="font-weight:500;opacity:0.6">Pilot</span></span>
        </td>
        <td align="right" style="vertical-align:middle;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#8b887f">${escapeHtml(eyebrowRight)}</td>
      </tr></table>
    </td></tr>

    <!-- Hero -->
    <tr><td class="px" style="padding:36px 36px 28px">
      <div style="display:inline-block;padding:4px 10px;background:${pill.bg};border-radius:999px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${pill.fg};font-weight:600">● ${escapeHtml(pillLabel)}</div>
      <h1 class="h1" style="margin:18px 0 14px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:32px;line-height:1.1;letter-spacing:-0.03em;font-weight:500;color:#0c0c0e">
        ${escapeHtml(head.lead)}<br>
        <span style="color:#5a5853;font-family:'Tinos',Georgia,serif;font-style:italic;font-weight:400">${escapeHtml(head.tail)}</span>
      </h1>
      <p style="margin:0;font-size:14.5px;line-height:1.55;color:#2a2a2c;max-width:480px">
        ${lead}
      </p>
    </td></tr>

    ${reasonBlock}
    ${summaryCard}

    <!-- CTA -->
    <tr><td class="px" style="padding:0 36px 28px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#0c0c0e" style="border-radius:6px">
        <a href="${escapeHtml(a.trackUrl)}" style="display:inline-block;padding:12px 18px;background:#0c0c0e;color:#f6f4ef;border-radius:6px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:13.5px;font-weight:500;text-decoration:none">${escapeHtml(ctaLabel)} &rarr;</a>
      </td></tr></table>
      <div style="margin-top:14px;font-size:11.5px;color:#5a5853;line-height:1.55">
        Or paste this link into your browser:
        <span style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10.5px;color:#2a2a2c;word-break:break-all">${escapeHtml(a.trackUrl)}</span>
      </div>
    </td></tr>

    ${expiryBlock}

    <!-- Foot -->
    <tr><td class="px" style="padding:18px 36px;border-top:1px solid rgba(12,12,14,0.12);background:#eeece5">
      <div style="font-size:11px;color:#8b887f;line-height:1.6">
        You're getting this because the request linked to <span style="color:#2a2a2c;text-decoration:underline">${escapeHtml(a.recipientEmail)}</span> moved through StockPilot. <a href="${escapeHtml(a.unsubscribeUrl)}" style="color:#2a2a2c">Manage notifications</a>
      </div>
      <div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(12,12,14,0.12);font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:#8b887f">
        <table role="presentation" class="foot-row" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td>StockPilot · Inventory + Order Management</td>
          <td align="right">stockpilotusa.com</td>
        </tr></table>
      </div>
    </td></tr>

  </table>

</td></tr></table>
</body>
</html>`;
}

// ─── Plaintext fallback ──────────────────────────────────────────────

function renderText(a: TemplateArgs): string {
  const isPickup = a.request.fulfillment_type === 'pickup';
  const orderId = `WO-${a.request.id.slice(0, 8).toUpperCase()}`;
  const firstName = (a.recipientName ?? '').trim().split(/\s+/)[0] || 'there';
  const head = headlineFor(a.kind, orderId, isPickup);
  const lead = leadParagraph(a.kind, isPickup, firstName).replace(/<[^>]+>/g, '');

  const lines: string[] = [];
  lines.push(`StockPilot — ${head.lead} ${head.tail}`);
  lines.push('');
  lines.push(lead);
  if (a.reasonText) {
    lines.push('');
    lines.push(`Reason: ${sanitizePlainText(a.reasonText)}`);
  }
  if (a.summary.lineCount > 0) {
    lines.push('');
    lines.push('— Order summary —');
    lines.push(`Order: ${orderId} (${a.summary.orderNumber})`);
    const units = a.summary.unitCount;
    const lc = a.summary.lineCount;
    lines.push(
      `Reserved: ${units} ${units === 1 ? 'unit' : 'units'} across ${lc} ${lc === 1 ? 'line' : 'lines'}`,
    );
    if (a.summary.shipDate) lines.push(`Ships: ${a.summary.shipDate}`);
    if (a.summary.shipFrom) lines.push(`From: ${a.summary.shipFrom}`);
    if (a.summary.shipTo) lines.push(`${isPickup ? 'Pickup' : 'To'}: ${a.summary.shipTo}`);
  }
  lines.push('');
  const ctaLabel = a.kind === 'confirm_request' ? 'Confirm request' : 'Track this order';
  lines.push(`${ctaLabel}: ${a.trackUrl}`);
  if (a.confirmExpiryNote) {
    lines.push('');
    lines.push(a.confirmExpiryNote);
  }
  lines.push('');
  lines.push('—');
  lines.push('StockPilot · Inventory + Order Management · stockpilotusa.com');
  lines.push(`Manage notifications: ${a.unsubscribeUrl}`);
  return lines.join('\n');
}

// ─── Public entry ────────────────────────────────────────────────────

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

  if (kind === 'confirm_request' && !confirmationToken) {
    throw new Error(
      'confirm_request email requires a confirmationToken — refusing to send empty CTA.',
    );
  }

  // Public-recipient suppression list (migration 0222). Anonymous
  // requesters have no notification_preferences row, so /unsubscribe
  // clicks land in public_email_unsubscribes — honor them here, the
  // single choke point every order-request email flows through.
  // `confirm_request` is exempt on purpose: it's the double-opt-in
  // consent email the requester just triggered by submitting the form,
  // and suppressing it would silently brick their request ("check your
  // email" … nothing ever arrives); nothing further can be sent unless
  // they DO confirm. Signed-in requesters are governed by their in-app
  // prefs instead (OrderRequestsService.wantsEmail).
  if (!request.requester_user_id && kind !== 'confirm_request') {
    if (await isPublicEmailUnsubscribed(recipientEmail)) return;
  }

  const orderId = `WO-${request.id.slice(0, 8).toUpperCase()}`;
  const summary = await fetchSummary(request);

  const trackUrl =
    kind === 'confirm_request' && confirmationToken
      ? `${appUrl}/r/confirm?id=${request.id}&t=${encodeURIComponent(confirmationToken)}`
      : buildTrackUrl(request, appUrl, recipientEmail, publicRequestToken ?? null);
  const unsubscribe = buildUnsubscribeUrl(request, appUrl, recipientEmail);

  const reasonText =
    (kind === 'denied' || kind === 'cancelled') && request.denied_reason
      ? request.denied_reason
      : null;

  const confirmExpiryNote =
    kind === 'confirm_request'
      ? "This confirmation link expires in 24 hours. If you didn't request this, you can safely ignore — nothing else happens until you click."
      : null;

  const args: TemplateArgs = {
    kind,
    request,
    recipientEmail,
    recipientName,
    summary,
    trackUrl,
    unsubscribeUrl: unsubscribe.url,
    reasonText,
    confirmExpiryNote,
  };

  const html = renderHtml(args);
  const text = renderText(args);
  const subject = SUBJECT_BY_KIND[kind](orderId);

  // RFC 2369/8058 unsubscribe headers. For public recipients the signed
  // /unsubscribe URL accepts the provider's one-click POST directly, so
  // advertise `List-Unsubscribe-Post`. The in-app (signed-in) link is a
  // page behind login that ignores POSTs — advertising one-click there
  // would make Gmail POST into the void and report success, so those
  // recipients get the plain header only.
  await sendEmail({
    to: recipientEmail,
    subject,
    html,
    text,
    headers: unsubscribe.oneClick
      ? {
          'List-Unsubscribe': `<${unsubscribe.url}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : { 'List-Unsubscribe': `<${unsubscribe.url}>` },
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sanitizePlainText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
