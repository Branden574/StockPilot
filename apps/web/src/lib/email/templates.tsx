import type { DigestPayload } from '@/server/services/digest';

/**
 * Public StockPilot logo for email headers. A hosted PNG on our own domain —
 * email clients (Gmail/Outlook) strip inline <svg>, so the brand mark in an
 * email MUST be a real raster image at an absolute URL. Served from
 * apps/web/public/email-logo.png.
 */
export const EMAIL_LOGO_URL = 'https://stockpilotusa.com/email-logo.png';
export function emailLogoImg(size = 28): string {
  const r = Math.round(size * 0.22);
  return `<img src="${EMAIL_LOGO_URL}" width="${size}" height="${size}" alt="StockPilot" style="display:inline-block;vertical-align:middle;width:${size}px;height:${size}px;border-radius:${r}px;" />`;
}

interface InviteEmailParams {
  organizationName: string;
  inviterName: string;
  acceptUrl: string;
}

export function inviteEmailHtml({ organizationName, inviterName, acceptUrl }: InviteEmailParams): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:white;border-radius:12px;padding:40px;">
    <div style="display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:18px;margin-bottom:24px;">
      ${emailLogoImg(28)}
      StockPilot
    </div>
    <h1 style="font-size:24px;margin:0 0 12px;">${escapeHtml(inviterName)} invited you to <strong>${escapeHtml(organizationName)}</strong></h1>
    <p style="color:#52525b;line-height:1.6;margin:0 0 24px;">
      Join the team to track inventory, scan barcodes, and reorder before you run out.
    </p>
    <a href="${acceptUrl}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#6366f1);color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">
      Accept invite
    </a>
    <p style="color:#71717a;font-size:13px;margin-top:32px;">
      Or paste this link in your browser:<br>
      <span style="color:#3f3f46;word-break:break-all;">${acceptUrl}</span>
    </p>
    <p style="color:#a1a1aa;font-size:12px;margin-top:32px;border-top:1px solid #e4e4e7;padding-top:16px;">
      This invite expires in 7 days. If you weren't expecting this, you can safely ignore it.
    </p>
  </div>
</body></html>`;
}

export function inviteEmailText({ organizationName, inviterName, acceptUrl }: InviteEmailParams): string {
  return `${inviterName} invited you to ${organizationName} on StockPilot.

Accept the invite: ${acceptUrl}

This link expires in 7 days. If you weren't expecting this, ignore it.`;
}

interface PasswordResetEmailParams {
  resetUrl: string;
}

export function passwordResetEmailHtml({ resetUrl }: PasswordResetEmailParams): string {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:white;border-radius:12px;padding:40px;">
    <div style="display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:18px;margin-bottom:24px;">
      ${emailLogoImg(28)}
      StockPilot
    </div>
    <h1 style="font-size:24px;margin:0 0 12px;">Reset your password</h1>
    <p style="color:#52525b;line-height:1.6;margin:0 0 24px;">
      Someone (hopefully you) asked to reset the password for this StockPilot account.
      Click the button below to choose a new one.
    </p>
    <a href="${resetUrl}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#6366f1);color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">
      Set a new password
    </a>
    <p style="color:#71717a;font-size:13px;margin-top:32px;">
      Or paste this link in your browser:<br>
      <span style="color:#3f3f46;word-break:break-all;">${resetUrl}</span>
    </p>
    <p style="color:#a1a1aa;font-size:12px;margin-top:32px;border-top:1px solid #e4e4e7;padding-top:16px;">
      This link expires in 1 hour and can be used once. If you didn't ask for a reset,
      you can safely ignore this email — your password is unchanged.
    </p>
  </div>
</body></html>`;
}

export function passwordResetEmailText({ resetUrl }: PasswordResetEmailParams): string {
  return `Reset your StockPilot password.

Set a new password: ${resetUrl}

This link expires in 1 hour and can be used once. If you didn't ask for a reset, ignore this email — your password is unchanged.`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ---------------------------------------------------------------------------
// Weekly inventory digest. See docs/superpowers/specs/2026-05-08-weekly-email-digest-design.md
// ---------------------------------------------------------------------------

interface DigestEmailOpts {
  orgName: string;
  appUrl: string;
  settingsUrl: string;
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

export function weeklyDigestSubject(now: Date = new Date()): string {
  // Accept an explicit `now` so callers can lock the subject to the
  // cron-start time even if rendering individual emails takes a long
  // time. Default to the current wall clock for preview / one-shot use.
  return `StockPilot weekly digest — ${DATE_FMT.format(now)}`;
}

export function weeklyDigestHtml(payload: DigestPayload, opts: DigestEmailOpts): string {
  const { orgName, appUrl, settingsUrl } = opts;
  const lowStockHtml = renderLowStockHtml(payload.lowStock, appUrl);
  const posHtml = renderOpenPosHtml(payload.openPos, appUrl);
  const ccsHtml = renderCcsHtml(payload.openCycleCounts, appUrl);

  // If everything's empty (preview-mode), show a friendly all-clear panel.
  const allClear =
    payload.lowStock.length === 0 &&
    payload.openPos.length === 0 &&
    payload.openCycleCounts.length === 0;

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,sans-serif;">
  <div style="max-width:640px;margin:40px auto;background:white;border-radius:12px;padding:40px;">
    <div style="display:inline-flex;align-items:center;gap:8px;font-weight:600;font-size:18px;margin-bottom:24px;">
      ${emailLogoImg(28)}
      StockPilot
    </div>
    <h1 style="font-size:24px;margin:0 0 4px;">Weekly digest</h1>
    <p style="color:#52525b;margin:0 0 24px;">${escapeHtml(orgName)} · ${escapeHtml(DATE_FMT.format(new Date()))}</p>
    ${allClear ? renderAllClear() : `${lowStockHtml}${posHtml}${ccsHtml}`}
    <p style="color:#a1a1aa;font-size:12px;margin-top:32px;border-top:1px solid #e4e4e7;padding-top:16px;">
      You're receiving this because you opted in to the weekly digest.
      <a href="${settingsUrl}" style="color:#52525b;">Manage preferences</a>.
    </p>
  </div>
</body></html>`;
}

export function weeklyDigestText(payload: DigestPayload, opts: DigestEmailOpts): string {
  const { orgName, appUrl, settingsUrl } = opts;
  const date = DATE_FMT.format(new Date());
  const blocks: string[] = [`StockPilot weekly digest`, `${orgName} · ${date}`, ''];

  if (payload.lowStock.length > 0) {
    blocks.push('LOW / OUT OF STOCK');
    for (const group of payload.lowStock) {
      blocks.push(`  ${group.warehouseName}`);
      for (const it of group.items) {
        blocks.push(
          `    ${it.sku.padEnd(16, ' ')} ${it.name}  (qty ${it.qty}, reorder at ${it.reorderPoint})`,
        );
      }
    }
    blocks.push(`  → ${appUrl}/dashboard/inventory?stock=low&type=all`, '');
  }
  if (payload.openPos.length > 0) {
    blocks.push('OPEN PURCHASE ORDERS');
    for (const po of payload.openPos) {
      const overdue = po.isOverdue ? ' [OVERDUE]' : '';
      const exp = po.expectedAt
        ? new Date(po.expectedAt).toLocaleDateString('en-US')
        : 'no date';
      blocks.push(
        `  ${po.poNumber}  ${po.supplierName ?? 'No supplier'}  expected ${exp}${overdue}`,
      );
    }
    blocks.push(`  → ${appUrl}/dashboard/purchase-orders`, '');
  }
  if (payload.openCycleCounts.length > 0) {
    blocks.push('CYCLE COUNTS IN PROGRESS');
    for (const cc of payload.openCycleCounts) {
      const started = new Date(cc.startedAt).toLocaleDateString('en-US');
      const wh = cc.warehouseName ?? 'Unassigned';
      const pct =
        cc.totalLines > 0
          ? `${Math.round((cc.countedLines / cc.totalLines) * 100)}%`
          : '—';
      blocks.push(
        `  ${started} · ${wh} · ${cc.countedLines}/${cc.totalLines} counted (${pct})`,
      );
    }
    blocks.push(`  → ${appUrl}/dashboard/cycle-counts`, '');
  }
  blocks.push(`Manage preferences: ${settingsUrl}`);
  return blocks.join('\n');
}

function renderAllClear() {
  return `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:24px;">
    <div style="font-weight:600;color:#166534;margin-bottom:4px;">Nothing to flag this week ✓</div>
    <div style="color:#166534;font-size:13px;line-height:1.6;">
      No items below reorder, no open POs, no cycle counts in progress. Quiet shift.
    </div>
  </div>`;
}

function renderLowStockHtml(groups: DigestPayload['lowStock'], appUrl: string): string {
  if (groups.length === 0) return '';
  const groupHtml = groups
    .map((g) => {
      const rows = g.items
        .map(
          (it) => `<tr>
            <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:12px;color:#3f3f46;">${escapeHtml(it.sku)}</td>
            <td style="padding:6px 12px 6px 0;color:#18181b;">${escapeHtml(it.name)}</td>
            <td style="padding:6px 12px 6px 0;text-align:right;font-family:monospace;font-variant-numeric:tabular-nums;color:${it.qty <= 0 ? '#dc2626' : '#b45309'};">${it.qty}</td>
            <td style="padding:6px 0;text-align:right;font-family:monospace;font-variant-numeric:tabular-nums;color:#71717a;">${it.reorderPoint}</td>
          </tr>`,
        )
        .join('');
      return `<div style="margin-bottom:16px;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#71717a;font-weight:600;margin-bottom:4px;">${escapeHtml(g.warehouseName)}</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid #e4e4e7;">
              <th style="text-align:left;padding:6px 12px 6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">SKU</th>
              <th style="text-align:left;padding:6px 12px 6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Item</th>
              <th style="text-align:right;padding:6px 12px 6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">On hand</th>
              <th style="text-align:right;padding:6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Reorder at</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .join('');
  return `<section style="margin-bottom:32px;">
    <h2 style="font-size:16px;margin:0 0 12px;">Low / out of stock</h2>
    ${groupHtml}
    <a href="${appUrl}/dashboard/inventory?stock=low&type=all" style="font-size:13px;color:#3b82f6;">Review all low-stock items →</a>
  </section>`;
}

function renderOpenPosHtml(pos: DigestPayload['openPos'], appUrl: string): string {
  if (pos.length === 0) return '';
  const rows = pos
    .map((po) => {
      const exp = po.expectedAt
        ? new Date(po.expectedAt).toLocaleDateString('en-US')
        : '—';
      const overdueChip = po.isOverdue
        ? `<span style="display:inline-block;background:#fee2e2;color:#991b1b;font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;margin-left:8px;">OVERDUE</span>`
        : '';
      return `<tr>
        <td style="padding:6px 12px 6px 0;font-family:monospace;font-size:12px;color:#3f3f46;">${escapeHtml(po.poNumber)}</td>
        <td style="padding:6px 12px 6px 0;color:#18181b;">${escapeHtml(po.supplierName ?? 'No supplier')}</td>
        <td style="padding:6px 12px 6px 0;color:#71717a;">${escapeHtml(po.status.replace(/_/g, ' '))}</td>
        <td style="padding:6px 0;color:#52525b;">${escapeHtml(exp)}${overdueChip}</td>
      </tr>`;
    })
    .join('');
  return `<section style="margin-bottom:32px;">
    <h2 style="font-size:16px;margin:0 0 12px;">Open purchase orders</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="border-bottom:1px solid #e4e4e7;">
          <th style="text-align:left;padding:6px 12px 6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">PO</th>
          <th style="text-align:left;padding:6px 12px 6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Supplier</th>
          <th style="text-align:left;padding:6px 12px 6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Status</th>
          <th style="text-align:left;padding:6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Expected</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <a href="${appUrl}/dashboard/purchase-orders" style="display:inline-block;margin-top:8px;font-size:13px;color:#3b82f6;">View all purchase orders →</a>
  </section>`;
}

function renderCcsHtml(ccs: DigestPayload['openCycleCounts'], appUrl: string): string {
  if (ccs.length === 0) return '';
  const rows = ccs
    .map((cc) => {
      const started = new Date(cc.startedAt).toLocaleDateString('en-US');
      const pct =
        cc.totalLines > 0
          ? `${Math.round((cc.countedLines / cc.totalLines) * 100)}%`
          : '—';
      return `<tr>
        <td style="padding:6px 12px 6px 0;color:#52525b;font-size:12px;">${escapeHtml(started)}</td>
        <td style="padding:6px 12px 6px 0;color:#18181b;">${escapeHtml(cc.warehouseName ?? 'Unassigned')}</td>
        <td style="padding:6px 12px 6px 0;color:#52525b;font-family:monospace;font-variant-numeric:tabular-nums;">${cc.countedLines}/${cc.totalLines}</td>
        <td style="padding:6px 0;color:#52525b;font-family:monospace;font-variant-numeric:tabular-nums;">${pct}</td>
      </tr>`;
    })
    .join('');
  return `<section style="margin-bottom:32px;">
    <h2 style="font-size:16px;margin:0 0 12px;">Cycle counts in progress</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="border-bottom:1px solid #e4e4e7;">
          <th style="text-align:left;padding:6px 12px 6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Started</th>
          <th style="text-align:left;padding:6px 12px 6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Warehouse</th>
          <th style="text-align:left;padding:6px 12px 6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Counted</th>
          <th style="text-align:left;padding:6px 0;font-size:10px;color:#a1a1aa;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Progress</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <a href="${appUrl}/dashboard/cycle-counts" style="display:inline-block;margin-top:8px;font-size:13px;color:#3b82f6;">Open cycle counts →</a>
  </section>`;
}
