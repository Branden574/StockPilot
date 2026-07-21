/**
 * Public StockPilot logo for email headers. A hosted PNG on our own domain —
 * email clients (Gmail/Outlook) strip inline <svg>, so the brand mark in an
 * email MUST be a real raster image at an absolute URL. Served from
 * apps/web/public/email-logo.png.
 */
// ?v=2 cache-busts Google's image proxy: GoogleImageProxy cached a failure for
// the bare URL when the logo first shipped (2026-06-18) and kept serving the
// broken state long after the file itself served fine — the proxy caches
// per-URL, failures included. Bump the version if it ever breaks again.
export const EMAIL_LOGO_URL = 'https://stockpilotusa.com/email-logo.png?v=2';
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
// The weekly digest moved to the redesigned email system:
// lib/email/es/families/digest.ts (renderWeeklyDigestHtml / weeklyDigestText /
// weeklyDigestSubject). This file keeps the remaining classic-layout emails
// (invites, password reset) until their families migrate.
// ---------------------------------------------------------------------------
