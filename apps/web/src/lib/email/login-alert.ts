import 'server-only';

import { signInAlertPlaceWords } from '@/lib/auth/sign-in-alert-words';

import {
  renderSigninAlertEmail,
  renderSigninReportedEmail,
  renderSigninSignedOutEmail,
} from './es/families/security';
import { sendEmail } from './resend';

/** The organization's list of sign-in alerts (owners and admins). */
export const SIGN_IN_ALERTS_LIST_PATH = '/dashboard/settings/security/sign-ins';

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
  /** The phone's own name for itself (S5), used instead of the guess from the
   *  agent: the app's agent ("StockPilot/<build> CFNetwork/... Darwin/...")
   *  matches no case in friendlyDevice. The template escapes it. */
  deviceLabel?: string | null;
  /** The account's last new-device email until its 24-hour count starts
   *  again (lib/auth/login-device.ts). */
  lastForADay?: boolean;
  /** Where the sign-in came from (part 3): a Location row when the country is known. */
  place?: { country: string | null; city: string | null } | null;
  /** What was new (part 3). A device by default. */
  newDevice?: boolean;
  newCountry?: boolean;
  /** The signed "This was not me" link (part 3), or null when the alert's record could not be written. */
  notMeUrl?: string | null;
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
    device: args.deviceLabel?.trim() || friendlyDevice(args.userAgent),
    ip: args.ip,
    when,
    securityUrl: `${appUrl}/dashboard/settings/security`,
    resetUrl: `${appUrl}/reset`,
    appUrl,
    lastForADay: args.lastForADay === true,
    location: signInAlertPlaceWords(args.place?.country, args.place?.city),
    kind: {
      newDevice: args.newDevice ?? !args.newCountry,
      newCountry: args.newCountry === true,
    },
    notMeUrl: args.notMeUrl ?? null,
  });

  await sendEmail({
    to: args.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    from: message.from,
  });
}

/** A sign-in time as the sign-in emails print it: "Nov 20, 2026, 3:30 PM UTC". */
function whenWords(at: Date): string {
  return (
    at.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC'
  );
}

/** The answer of one send: sendEmail's, or not sent when it threw. Never throws. */
async function sendOnce(message: {
  to: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  try {
    return await sendEmail(message);
  } catch {
    return { ok: false, error: 'send_threw' };
  }
}

/**
 * Part 3: to the member, after their "This was not me". Every session of the
 * account has ended; one button, to reset the password. The device is the
 * member's own words for it (the alert's label). Hands back the send's answer
 * so the report can say when it failed. Never throws.
 */
export async function sendSignedOutEverywhereEmail(args: {
  to: string;
  firstName?: string | null;
  device: string;
  place: { country: string | null; city: string | null } | null;
  signedInAt: Date;
  appUrl?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const appUrl = args.appUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://stockpilotusa.com';
  const message = renderSigninSignedOutEmail({
    email: args.to,
    firstName: args.firstName ?? null,
    device: args.device,
    location: signInAlertPlaceWords(args.place?.country, args.place?.city),
    when: whenWords(args.signedInAt),
    resetUrl: `${appUrl}/reset`,
    appUrl,
  });
  return sendOnce({
    to: args.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    from: message.from,
  });
}

/**
 * Part 3: to one owner or admin of an organization the member belongs to,
 * after the member's "This was not me". Names the device FAMILY only, as the
 * organization's list does, never the member's own label. Hands back the
 * send's answer. Never throws.
 */
export async function sendSignInReportedEmail(args: {
  to: string;
  adminFirstName?: string | null;
  memberName: string;
  memberEmail: string;
  organizationName: string;
  deviceFamily: string;
  place: { country: string | null; city: string | null } | null;
  signedInAt: Date;
  appUrl?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const appUrl = args.appUrl || process.env.NEXT_PUBLIC_APP_URL || 'https://stockpilotusa.com';
  const message = renderSigninReportedEmail({
    adminEmail: args.to,
    adminFirstName: args.adminFirstName ?? null,
    memberName: args.memberName,
    memberEmail: args.memberEmail,
    organizationName: args.organizationName,
    deviceFamily: args.deviceFamily,
    location: signInAlertPlaceWords(args.place?.country, args.place?.city),
    when: whenWords(args.signedInAt),
    listUrl: `${appUrl}${SIGN_IN_ALERTS_LIST_PATH}`,
    appUrl,
  });
  return sendOnce({
    to: args.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
    from: message.from,
  });
}
