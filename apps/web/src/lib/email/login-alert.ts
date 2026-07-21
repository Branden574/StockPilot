import 'server-only';

import { renderSigninAlertEmail } from './es/families/security';
import { sendEmail } from './resend';

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

/**
 * Emails a "new device signed in" alert via the es security family
 * template. Best-effort: returns normally even if the underlying send
 * no-ops (dev) — callers fire it via `after()`.
 *
 * NOTE (registry flag): the previous copy claimed sign-in alerts "are on
 * for your account" as if they were a manageable preference — no such
 * preference exists. The redesigned copy states the truth (alerts always
 * send for new devices) and must NOT reintroduce the claim.
 */
export async function sendNewDeviceLoginEmail(args: {
  to: string;
  userAgent: string;
  ip: string | null;
}): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://stockpilotusa.com';
  const when =
    new Date().toLocaleString('en-US', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      timeStyle: 'short',
    }) + ' UTC';

  const message = renderSigninAlertEmail({
    email: args.to,
    device: friendlyDevice(args.userAgent),
    ip: args.ip,
    when,
    securityUrl: `${appUrl}/dashboard/settings/security`,
    resetUrl: `${appUrl}/reset`,
    appUrl,
  });

  await sendEmail({
    to: args.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    from: message.from,
  });
}
