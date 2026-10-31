import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '@/lib/env';

/**
 * Signed one-click unsubscribe links for the emails StockPilot sends to
 * MEMBERS: the weekly digest (and its preview) and the schedule reminders.
 *
 * Those emails used to point List-Unsubscribe and the footer's Unsubscribe at
 * the Notifications settings page, which is behind sign-in: a member reading
 * the email on their phone, signed out, met the sign-in page, and Gmail and
 * Yahoo, which POST to the link (RFC 8058) and expect the POST alone to
 * unsubscribe, could not use it at all. The order emails' public /unsubscribe
 * page (lib/email/unsubscribe.ts) already solved this for addresses; this is
 * the same page, the same signing value (UNSUBSCRIBE_SECRET) and the same
 * GET-shows / POST-changes split, for a member.
 *
 * A link is
 * `/unsubscribe?m=<kind>.<user id>.<organization id>.<issue day>.<signature>`:
 * the issue day is the UTC calendar day the email was built (YYYYMMDD), and
 * the signature an HMAC-SHA256, keyed on UNSUBSCRIBE_SECRET, of all four
 * parts. So a link names one member, one organization, one kind of email and
 * one day, and changing any of them (another member, another organization,
 * the other email, a later day) breaks the signature. Possession of a valid
 * link proves it came from an email we sent that member. The organization is
 * checked when the link is used: the member must still belong to it
 * (app/unsubscribe/route.ts).
 *
 * A link works for MEMBER_UNSUBSCRIBE_MAX_AGE_DAYS (90) days after its issue
 * day, then it is expired (the US CAN-SPAM rule needs an opt-out link to work
 * for at least 30 days after sending; 90 gives margin). A link that leaked (a
 * forwarded email, a mail gateway's link store, browser history, a request
 * log) so stops working instead of switching the member's email off for as
 * long as they stay in the workspace. Every email carries a fresh link, so a
 * member who wants out uses the newest one. A day that is missing, malformed,
 * not a real date or after today is refused like a forged link: only our own
 * signer writes the day, so none of those can come from an email we sent.
 *
 * What a link switches off is the account's own switch on the Notifications
 * page, the one the member would turn off themselves when signed in
 * (server/services/member-email-unsubscribe.ts).
 *
 * Fail closed: with no signing value configured, or no usable clock, nothing
 * is minted (the email keeps the settings link, with no one-click header);
 * with no signing value nothing verifies.
 */

/** The member emails a link can switch off. */
export const MEMBER_EMAIL_KINDS = ['weekly_digest', 'schedule_reminders'] as const;
export type MemberEmailKind = (typeof MEMBER_EMAIL_KINDS)[number];

/** Who and what a verified link names. */
export interface MemberUnsubscribeClaim {
  userId: string;
  organizationId: string;
  kind: MemberEmailKind;
}

/**
 * What verifying a link found:
 *   valid    a link we signed, inside its 90 days: the member, organization
 *            and kind it names;
 *   expired  a link we signed whose 90 days are over: only its kind, for the
 *            "too old" page. Nothing about the account is looked up;
 *   invalid  anything else: a changed character, an unknown kind, a missing,
 *            malformed, impossible or future day, a malformed link, or no
 *            signing value configured.
 */
export type MemberUnsubscribeVerdict =
  | { status: 'valid'; claim: MemberUnsubscribeClaim }
  | { status: 'expired'; kind: MemberEmailKind }
  | { status: 'invalid' };

/** Days a link works after the UTC day its email was built (day 0). */
export const MEMBER_UNSUBSCRIBE_MAX_AGE_DAYS = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** sha256: a signature is exactly 32 bytes, 64 hex characters. */
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
/** The issue day: a UTC calendar date, YYYYMMDD. */
const DAY_RE = /^[0-9]{8}$/;
/**
 * Longest valid link: the longest kind, two UUIDs, the issue day, the
 * signature, four dots.
 */
const MAX_LINK_LENGTH = 18 + 36 + 36 + 8 + 64 + 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID: MemberUnsubscribeVerdict = Object.freeze({ status: 'invalid' as const });

function isMemberEmailKind(value: string): value is MemberEmailKind {
  return (MEMBER_EMAIL_KINDS as readonly string[]).includes(value);
}

/** The claim in its one signed spelling (ids lowercased), or null when any part is not valid. */
function canonicalClaim(claim: MemberUnsubscribeClaim): MemberUnsubscribeClaim | null {
  const userId = typeof claim.userId === 'string' ? claim.userId.toLowerCase() : '';
  const organizationId =
    typeof claim.organizationId === 'string' ? claim.organizationId.toLowerCase() : '';
  if (!isMemberEmailKind(claim.kind) || !UUID_RE.test(userId) || !UUID_RE.test(organizationId)) {
    return null;
  }
  return { userId, organizationId, kind: claim.kind };
}

/** Whole days since 1970-01-01 in UTC for a time, or null when it is not a usable time. */
function utcDayNumber(at: Date): number | null {
  const ms = at instanceof Date ? at.getTime() : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : null;
}

/** The UTC calendar day of a time as YYYYMMDD, or null outside the years 1000 to 9999. */
function issueDayOf(at: Date): string | null {
  if (utcDayNumber(at) === null) return null;
  const year = at.getUTCFullYear();
  if (year < 1000 || year > 9999) return null;
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  const day = String(at.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * The day number (as utcDayNumber) of a YYYYMMDD issue day, or null when it is
 * not a real calendar date from the year 1000 on (Feb 30, month 13, day 0).
 */
function dayNumberOf(issueDay: string): number | null {
  if (!DAY_RE.test(issueDay)) return null;
  const year = Number(issueDay.slice(0, 4));
  const month = Number(issueDay.slice(4, 6));
  const day = Number(issueDay.slice(6, 8));
  if (year < 1000) return null;
  const at = new Date(Date.UTC(year, month - 1, day));
  // Date.UTC rolls an impossible date over (Feb 30 is Mar 2); a real one
  // comes back unchanged.
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }
  return utcDayNumber(at);
}

function macFor(claim: MemberUnsubscribeClaim, issueDay: string, signingValue: string): Buffer {
  // Domain-separated from the address links ('unsubscribe:v1:<email>'), so a
  // signature made for one can never be presented as the other; v2 because
  // the issue day joined the signed parts (no v1 link was ever mailed). The
  // parts cannot contain ':' (a kind from the list, two UUIDs, eight digits),
  // so the input is unambiguous.
  return createHmac('sha256', signingValue)
    .update(
      `unsubscribe:member:v2:${claim.kind}:${claim.userId}:${claim.organizationId}:${issueDay}`,
    )
    .digest();
}

/**
 * The link's `m` value, dated with the UTC day of `issuedAt` (when the email
 * is built), or null when UNSUBSCRIBE_SECRET is unset, the claim is not
 * valid or `issuedAt` is not a usable time.
 */
export function mintMemberUnsubscribeToken(
  claim: MemberUnsubscribeClaim,
  issuedAt: Date,
): string | null {
  const signingValue = env.UNSUBSCRIBE_SECRET;
  if (!signingValue) return null;
  const c = canonicalClaim(claim);
  const issueDay = issueDayOf(issuedAt);
  if (!c || !issueDay) return null;
  const signature = macFor(c, issueDay, signingValue).toString('hex');
  return `${c.kind}.${c.userId}.${c.organizationId}.${issueDay}.${signature}`;
}

/**
 * What a link is (see MemberUnsubscribeVerdict), judged at `now`. The
 * signature is checked first, in constant time, so only a link we signed can
 * be told apart from a forged one: an expired link is reported as expired
 * only when its signature is correct, and every other refusal is the same
 * 'invalid'. Never throws, and reads nothing.
 */
export function verifyMemberUnsubscribeToken(
  link: string,
  now: Date = new Date(),
): MemberUnsubscribeVerdict {
  const signingValue = env.UNSUBSCRIBE_SECRET;
  if (!signingValue) return INVALID;
  if (typeof link !== 'string' || link.length === 0 || link.length > MAX_LINK_LENGTH) {
    return INVALID;
  }
  const parts = link.toLowerCase().split('.');
  if (parts.length !== 5) return INVALID;
  const [kind, userId, organizationId, issueDay, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!isMemberEmailKind(kind) || !DAY_RE.test(issueDay) || !SIGNATURE_RE.test(signature)) {
    return INVALID;
  }
  const claim = canonicalClaim({ userId, organizationId, kind });
  if (!claim) return INVALID;
  const expected = macFor(claim, issueDay, signingValue);
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
    return INVALID;
  }

  // Signed by us from here on. Our signer only writes a real day that has
  // already begun, so anything else is refused, never trusted.
  const issued = dayNumberOf(issueDay);
  const today = utcDayNumber(now);
  if (issued === null || today === null || issued > today) return INVALID;
  if (today - issued > MEMBER_UNSUBSCRIBE_MAX_AGE_DAYS) {
    return { status: 'expired', kind: claim.kind };
  }
  return { status: 'valid', claim };
}

/** The public /unsubscribe URL for the claim, or null when no link can be signed. */
export function buildMemberUnsubscribeUrl(
  appUrl: string,
  claim: MemberUnsubscribeClaim,
  issuedAt: Date,
): string | null {
  const link = mintMemberUnsubscribeToken(claim, issuedAt);
  if (!link) return null;
  return `${appUrl.replace(/\/+$/, '')}/unsubscribe?m=${link}`;
}

export interface MemberUnsubscribeDelivery {
  /** Where the footer's Unsubscribe link (and the text part's line) points. */
  url: string;
  /** True when `url` is the signed link, which accepts the one-click POST. */
  oneClick: boolean;
  /** RFC 2369 / 8058 headers for sendEmail. */
  headers: Record<string, string>;
}

/**
 * The unsubscribe link and headers for one member email. With a signed link
 * the message advertises RFC 8058 one-click (List-Unsubscribe-Post), which
 * /unsubscribe honours on the provider's POST. Without one (no signing value
 * configured, or no usable clock) it keeps the settings page, with
 * List-Unsubscribe only: that page is behind sign-in and ignores a POST, so
 * advertising one-click there would let a provider POST into nothing and
 * report success.
 */
export function memberUnsubscribeDelivery(args: {
  appUrl: string;
  settingsUrl: string;
  claim: MemberUnsubscribeClaim;
  /** When the email is built: its link is dated with this UTC day. */
  issuedAt: Date;
}): MemberUnsubscribeDelivery {
  const url = buildMemberUnsubscribeUrl(args.appUrl, args.claim, args.issuedAt);
  if (!url) {
    return {
      url: args.settingsUrl,
      oneClick: false,
      headers: { 'List-Unsubscribe': `<${args.settingsUrl}>` },
    };
  }
  return {
    url,
    oneClick: true,
    headers: {
      'List-Unsubscribe': `<${url}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
