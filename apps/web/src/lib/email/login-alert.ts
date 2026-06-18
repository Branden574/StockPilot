import 'server-only';

import { sendEmail } from './resend';
import { emailLogoImg } from './templates';

/** Coarse, human-readable device label from a UA string — "Chrome on macOS",
 *  "Safari on iPhone", etc. Falls back to a trimmed UA when unrecognized. */
function friendlyDevice(ua: string): string {
  const browser =
    /\bEdg\//.test(ua) ? 'Edge'
    : /\bOPR\/|\bOpera\b/.test(ua) ? 'Opera'
    : /\bChrome\//.test(ua) ? 'Chrome'
    : /\bFirefox\//.test(ua) ? 'Firefox'
    : /\bSafari\//.test(ua) && !/\bChrome\//.test(ua) ? 'Safari'
    : null;
  const os =
    /\biPhone\b/.test(ua) ? 'iPhone'
    : /\biPad\b/.test(ua) ? 'iPad'
    : /\bAndroid\b/.test(ua) ? 'Android'
    : /\bMac OS X\b|\bMacintosh\b/.test(ua) ? 'macOS'
    : /\bWindows\b/.test(ua) ? 'Windows'
    : /\bLinux\b/.test(ua) ? 'Linux'
    : null;
  if (browser && os) return `${browser} on ${os}`;
  if (os) return os;
  if (browser) return browser;
  const trimmed = ua.trim();
  return trimmed ? trimmed.slice(0, 80) : 'an unrecognized device';
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Emails a "new device signed in" alert. Best-effort: returns normally even if
 * the underlying send no-ops (dev) — callers fire it via `after()`.
 */
export async function sendNewDeviceLoginEmail(args: {
  to: string;
  userAgent: string;
  ip: string | null;
}): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://stockpilotusa.com';
  const securityUrl = `${appUrl}/dashboard/settings/security`;
  const device = esc(friendlyDevice(args.userAgent));
  const ip = args.ip && args.ip !== 'unknown' ? esc(args.ip) : 'unknown';
  const when =
    new Date().toLocaleString('en-US', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }) + ' UTC';

  const subject = 'New sign-in to your StockPilot account';
  const text = [
    'We noticed a sign-in to your StockPilot account from a device we haven’t seen before.',
    '',
    `Device:  ${friendlyDevice(args.userAgent)}`,
    `IP:      ${args.ip ?? 'unknown'}`,
    `When:    ${when}`,
    '',
    'If this was you, no action is needed.',
    `If it wasn’t, change your password and review your security settings now: ${securityUrl}`,
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;background:#f4f3ee;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#0e0f0d;">
  <div style="max-width:520px;margin:0 auto;padding:32px 24px;">
    <div style="margin-bottom:16px;">${emailLogoImg(40)}</div>
    <div style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:#8b8e85;font-weight:600;">StockPilot · Security</div>
    <h1 style="font-size:22px;line-height:1.25;margin:10px 0 4px;font-weight:600;">New sign-in detected</h1>
    <p style="font-size:15px;line-height:1.5;color:#5a5d56;margin:0 0 20px;">
      We noticed a sign-in to your StockPilot account from a device we haven’t seen before.
    </p>
    <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e7e5dd;border-radius:10px;overflow:hidden;font-size:14px;">
      <tr><td style="padding:12px 16px;color:#8b8e85;border-bottom:1px solid #f4f3ee;width:90px;">Device</td><td style="padding:12px 16px;border-bottom:1px solid #f4f3ee;">${device}</td></tr>
      <tr><td style="padding:12px 16px;color:#8b8e85;border-bottom:1px solid #f4f3ee;">IP address</td><td style="padding:12px 16px;border-bottom:1px solid #f4f3ee;font-family:ui-monospace,Menlo,monospace;">${ip}</td></tr>
      <tr><td style="padding:12px 16px;color:#8b8e85;">When</td><td style="padding:12px 16px;">${esc(when)}</td></tr>
    </table>
    <p style="font-size:14px;line-height:1.5;color:#5a5d56;margin:20px 0 16px;">
      If this was you, you can ignore this email. If it <strong>wasn’t</strong>, secure your account right away:
    </p>
    <a href="${securityUrl}" style="display:inline-block;background:#0e0f0d;color:#fafaf7;text-decoration:none;font-size:14px;font-weight:600;padding:11px 18px;border-radius:8px;">Review security settings</a>
    <p style="font-size:12px;color:#8b8e85;margin:24px 0 0;line-height:1.5;">
      You’re receiving this because new-device sign-in alerts are on for your account. We send these only the first time we see a new device, not on every sign-in.
    </p>
  </div>
</body></html>`;

  await sendEmail({ to: args.to, subject, html, text });
}
