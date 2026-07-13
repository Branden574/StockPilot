import 'server-only';

import { sendEmail } from './resend';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Rental notification emails — best-effort, external-borrower facing.
 *
 * Each exported function is `Promise<void>` and NEVER throws or rejects:
 * the whole body is wrapped in try/catch so an email failure can't break
 * rental checkout/return or a cron sweep. Failures log a `console.warn`
 * and return.
 *
 * These run server-side from the rental service / cron with the
 * service-role client (the `rentals` + org tables carry RLS), so we use
 * `createAdminClient()` rather than a user-scoped client.
 */

// ─── Row shapes ──────────────────────────────────────────────────────

interface RentalRow {
  id: string;
  organization_id: string;
  borrower_name: string | null;
  borrower_email: string | null;
  expected_return_at: string | null;
  returned_at: string | null;
  warehouse_id: string | null;
  status: string | null;
}

interface RentalLineItem {
  name: string;
  quantity: number;
}

// ─── Brand mark (mirrors order-requests.ts) ──────────────────────────

// Hosted PNG (not inline SVG): Gmail/Outlook strip <svg>, so the brand
// mark must be a real raster image at an absolute URL to render in the
// inbox. Served from apps/web/public/email-logo.png. ?v=2 cache-busts
// GoogleImageProxy's stale failure cache.
const BRAND_MARK_IMG = `<img src="https://stockpilotusa.com/email-logo.png?v=2" width="28" height="28" alt="StockPilot" style="display:inline-block;vertical-align:middle;margin-right:10px;width:28px;height:28px;border-radius:6px" />`;

// ─── Email kinds ─────────────────────────────────────────────────────

type RentalEmailKind = 'checkout' | 'returned' | 'overdue';

interface KindConfig {
  subject: string;
  pillLabel: string;
  pill: { bg: string; fg: string };
  eyebrow: string;
  headLead: string;
  headTail: string;
}

// Pill colors mirror the order-requests palette (tonal variants against
// the cream paper); overdue gets the red "denied" tone.
const KIND: Record<RentalEmailKind, KindConfig> = {
  checkout: {
    subject: 'Your rental is checked out',
    pillLabel: 'Checked out',
    pill: { bg: '#e6efe7', fg: '#2f6a4a' },
    eyebrow: 'Rental Confirmation',
    headLead: 'Your rental is confirmed.',
    headTail: 'Everything is on its way to you.',
  },
  returned: {
    subject: 'Thanks — your rental has been returned',
    pillLabel: 'Returned',
    pill: { bg: '#e6efe7', fg: '#2f6a4a' },
    eyebrow: 'Rental Update',
    headLead: 'Thanks — items received.',
    headTail: 'Your rental is all wrapped up.',
  },
  overdue: {
    subject: 'Reminder: your rental is overdue',
    pillLabel: 'Overdue',
    pill: { bg: '#f3dada', fg: '#7a1f1f' },
    eyebrow: 'Rental Reminder',
    headTail: 'A quick nudge to return it.',
    headLead: 'Your rental is past due.',
  },
};

// ─── Template ────────────────────────────────────────────────────────

interface TemplateArgs {
  kind: RentalEmailKind;
  firstName: string;
  borrowerEmail: string;
  orgName: string;
  warehouseName: string;
  items: RentalLineItem[];
  expectedReturnLabel: string | null;
}

function renderHtml(a: TemplateArgs): string {
  const cfg = KIND[a.kind];
  const returnLabel = a.expectedReturnLabel ?? '—';

  const bodyParagraph = leadParagraph(a.kind, a.firstName, returnLabel);
  const previewText = previewFor(a.kind, returnLabel);

  const itemRows = a.items
    .map((it, idx) => {
      const border =
        idx === 0 ? '' : 'border-top:1px solid rgba(12,12,14,0.08);';
      return `
          <tr><td style="padding:${idx === 0 ? '0' : '10px'} 0 10px;${border}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="font-size:13.5px;color:#2a2a2c;vertical-align:top">${escapeHtml(it.name)}</td>
              <td align="right" style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12.5px;color:#5a5853;vertical-align:top;white-space:nowrap">×&nbsp;${escapeHtml(String(it.quantity))}</td>
            </tr></table>
          </td></tr>`;
    })
    .join('');

  const summaryCard =
    a.items.length > 0
      ? `
    <tr><td class="px" style="padding:0 36px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid rgba(12,12,14,0.12);border-radius:6px">
        <tr><td style="padding:18px 20px 8px">
          <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:#8b887f;font-weight:500;margin-bottom:10px">Items</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${itemRows}</table>
        </td></tr>
        <tr><td style="padding:0 20px 18px">
          <table role="presentation" class="grid" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid rgba(12,12,14,0.12);margin-top:4px"><tr>
            <td width="50%" style="padding:14px 0 0;vertical-align:top">
              <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:#8b887f;font-weight:500;margin-bottom:5px">Expected return</div>
              <div style="font-size:13.5px;font-weight:600;color:#0c0c0e">${escapeHtml(returnLabel)}</div>
            </td>
            <td width="50%" style="padding:14px 0 0;vertical-align:top">
              <div style="font-family:'JetBrains Mono',ui-monospace,monospace;font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:#8b887f;font-weight:500;margin-bottom:5px">From</div>
              <div style="font-size:13px;color:#2a2a2c">${escapeHtml(a.warehouseName)}</div>
            </td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(cfg.subject)}</title>
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
          ${BRAND_MARK_IMG}<span style="font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;letter-spacing:-0.025em;color:#0c0c0e;vertical-align:middle">Stock<span style="font-weight:500;opacity:0.6">Pilot</span></span>
        </td>
        <td align="right" style="vertical-align:middle;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:#8b887f">${escapeHtml(cfg.eyebrow)}</td>
      </tr></table>
    </td></tr>

    <!-- Hero -->
    <tr><td class="px" style="padding:36px 36px 28px">
      <div style="display:inline-block;padding:4px 10px;background:${cfg.pill.bg};border-radius:999px;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${cfg.pill.fg};font-weight:600">● ${escapeHtml(cfg.pillLabel)}</div>
      <h1 class="h1" style="margin:18px 0 14px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:32px;line-height:1.1;letter-spacing:-0.03em;font-weight:500;color:#0c0c0e">
        ${escapeHtml(cfg.headLead)}<br>
        <span style="color:#5a5853;font-family:'Tinos',Georgia,serif;font-style:italic;font-weight:400">${escapeHtml(cfg.headTail)}</span>
      </h1>
      <p style="margin:0;font-size:14.5px;line-height:1.55;color:#2a2a2c;max-width:480px">
        ${bodyParagraph}
      </p>
    </td></tr>

    ${summaryCard}

    <!-- Foot -->
    <tr><td class="px" style="padding:18px 36px;border-top:1px solid rgba(12,12,14,0.12);background:#eeece5">
      <div style="font-size:11px;color:#8b887f;line-height:1.6">
        You're getting this because a rental from <span style="color:#2a2a2c">${escapeHtml(a.orgName)}</span> is linked to <span style="color:#2a2a2c;text-decoration:underline">${escapeHtml(a.borrowerEmail)}</span>.
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

function renderText(a: TemplateArgs): string {
  const cfg = KIND[a.kind];
  const returnLabel = a.expectedReturnLabel ?? '—';
  const lead = leadParagraph(a.kind, a.firstName, returnLabel).replace(
    /<[^>]+>/g,
    '',
  );

  const lines: string[] = [];
  lines.push(`StockPilot — ${cfg.headLead} ${cfg.headTail}`);
  lines.push('');
  lines.push(lead);
  if (a.items.length > 0) {
    lines.push('');
    lines.push('— Items —');
    for (const it of a.items) {
      lines.push(`${it.name} × ${it.quantity}`);
    }
    lines.push('');
    lines.push(`Expected return: ${returnLabel}`);
    lines.push(`From: ${a.warehouseName}`);
  }
  lines.push('');
  lines.push('—');
  lines.push('StockPilot · Inventory + Order Management · stockpilotusa.com');
  lines.push(`Rental from ${a.orgName}`);
  return lines.join('\n');
}

function leadParagraph(
  kind: RentalEmailKind,
  name: string,
  returnLabel: string,
): string {
  const hi = `Hi ${escapeHtml(name)} — `;
  switch (kind) {
    case 'checkout':
      return `${hi}your rental is checked out and ready to use. The items you borrowed are listed below. Please return them by ${escapeHtml(returnLabel)}.`;
    case 'returned':
      return `${hi}thanks — we've received your rental and everything is back in inventory. There's nothing more you need to do.`;
    case 'overdue':
      return `${hi}this is a friendly reminder that your rental was due back on ${escapeHtml(returnLabel)}. Please return the items below as soon as you can.`;
  }
}

function previewFor(kind: RentalEmailKind, returnLabel: string): string {
  switch (kind) {
    case 'checkout':
      return `Your rental is confirmed. Please return by ${returnLabel}.`;
    case 'returned':
      return `We've received your rental — nothing more to do. Thank you.`;
    case 'overdue':
      return `Your rental was due back on ${returnLabel}. Please return the items.`;
  }
}

// ─── Data fetching ───────────────────────────────────────────────────

function formatReturnDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

async function loadRentalContext(
  rentalId: string,
): Promise<TemplateArgs | null> {
  const admin = createAdminClient();

  const { data: rental, error: rentalErr } = await admin
    .from('rentals')
    .select(
      'id, organization_id, borrower_name, borrower_email, expected_return_at, returned_at, warehouse_id, status',
    )
    .eq('id', rentalId)
    .maybeSingle();

  if (rentalErr) {
    console.warn('[rental-email] failed to load rental', rentalId, rentalErr.message);
    return null;
  }
  if (!rental) {
    console.warn('[rental-email] rental not found', rentalId);
    return null;
  }

  const row = rental as RentalRow;

  const email = (row.borrower_email ?? '').trim();
  if (!email) {
    // Normal: many rentals have no borrower email. Nothing to send.
    return null;
  }

  // Lines joined to inventory_items for the display name. Best-effort:
  // an empty/failed lines fetch still yields a valid (item-less) email.
  const { data: lineRows } = await admin
    .from('rental_lines')
    .select('item_id, quantity, inventory_items(name)')
    .eq('rental_id', rentalId);

  type RawLine = {
    item_id: string | null;
    quantity: number | null;
    inventory_items:
      | { name: string | null }
      | { name: string | null }[]
      | null;
  };
  const items: RentalLineItem[] = ((lineRows ?? []) as RawLine[]).map((l) => {
    const rel = l.inventory_items;
    const nameFromRel = Array.isArray(rel) ? rel[0]?.name : rel?.name;
    return {
      name: (nameFromRel ?? 'Item').trim() || 'Item',
      quantity: Number(l.quantity ?? 0) || 0,
    };
  });

  // Org + warehouse names, best-effort with '—' fallback.
  const [orgRes, whRes] = await Promise.all([
    admin
      .from('organizations')
      .select('name')
      .eq('id', row.organization_id)
      .maybeSingle(),
    row.warehouse_id
      ? admin
          .from('warehouses')
          .select('name')
          .eq('id', row.warehouse_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const orgName =
    ((orgRes.data as { name?: string | null } | null)?.name ?? '').trim() || '—';
  const warehouseName =
    ((whRes.data as { name?: string | null } | null)?.name ?? '').trim() || '—';

  const firstName = (row.borrower_name ?? '').trim().split(/\s+/)[0] || 'there';

  return {
    kind: 'checkout', // overwritten by caller
    firstName,
    borrowerEmail: email,
    orgName,
    warehouseName,
    items,
    expectedReturnLabel: formatReturnDate(row.expected_return_at),
  };
}

async function sendRentalEmail(
  rentalId: string,
  kind: RentalEmailKind,
): Promise<void> {
  try {
    const ctx = await loadRentalContext(rentalId);
    if (!ctx) return;

    const args: TemplateArgs = { ...ctx, kind };
    await sendEmail({
      to: args.borrowerEmail,
      subject: KIND[kind].subject,
      html: renderHtml(args),
      text: renderText(args),
    });
  } catch (err) {
    // Best-effort: an email failure must never break rental
    // checkout/return or a cron sweep.
    console.warn(
      `[rental-email] ${kind} email failed for rental ${rentalId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── Public entry points ─────────────────────────────────────────────

/** Confirmation sent when a rental is checked out. Best-effort; never throws. */
export async function sendRentalCheckoutEmail(rentalId: string): Promise<void> {
  await sendRentalEmail(rentalId, 'checkout');
}

/** Thank-you sent when a rental is marked returned. Best-effort; never throws. */
export async function sendRentalReturnedEmail(rentalId: string): Promise<void> {
  await sendRentalEmail(rentalId, 'returned');
}

/** Reminder that a rental is past its expected return date. Best-effort; never throws. */
export async function sendRentalOverdueEmail(rentalId: string): Promise<void> {
  await sendRentalEmail(rentalId, 'overdue');
}

// ─── Helpers ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
