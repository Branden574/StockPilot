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
 * A link is `/unsubscribe?m=<kind>.<user id>.<organization id>.<signature>`,
 * the signature an HMAC-SHA256, keyed on UNSUBSCRIBE_SECRET, of all three
 * parts. So a link names one member, one organization and one kind of email,
 * and changing any of them (another member, another organization, the other
 * email) breaks the signature. Possession of a valid link proves it came from
 * an email we sent that member. The organization is checked when the link is
 * used: the member must still belong to it (app/unsubscribe/route.ts).
 *
 * What a link switches off is the account's own switch on the Notifications
 * page, the one the member would turn off themselves when signed in
 * (server/services/member-email-unsubscribe.ts).
 *
 * Fail closed: with no signing value configured nothing is minted (the email
 * keeps the settings link, with no one-click header) and nothing verifies.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** sha256: a signature is exactly 32 bytes, 64 hex characters. */
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
/** Longest valid link: the longest kind, two UUIDs, the signature, three dots. */
const MAX_LINK_LENGTH = 18 + 36 + 36 + 64 + 3;

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

function macFor(claim: MemberUnsubscribeClaim, signingValue: string): Buffer {
  // Domain-separated from the address links ('unsubscribe:v1:<email>'), so a
  // signature made for one can never be presented as the other. The parts
  // cannot contain ':' (a kind from the list, two UUIDs), so the input is
  // unambiguous.
  return createHmac('sha256', signingValue)
    .update(`unsubscribe:member:v1:${claim.kind}:${claim.userId}:${claim.organizationId}`)
    .digest();
}

/** The link's `m` value, or null when UNSUBSCRIBE_SECRET is unset or the claim is not valid. */
export function mintMemberUnsubscribeToken(claim: MemberUnsubscribeClaim): string | null {
  const signingValue = env.UNSUBSCRIBE_SECRET;
  if (!signingValue) return null;
  const c = canonicalClaim(claim);
  if (!c) return null;
  return `${c.kind}.${c.userId}.${c.organizationId}.${macFor(c, signingValue).toString('hex')}`;
}

/**
 * The member, organization and kind a link names, or null for anything else:
 * a changed character, an unknown kind, a malformed link, or no signing value
 * configured. Constant-time on the signature. Never throws.
 */
export function verifyMemberUnsubscribeToken(link: string): MemberUnsubscribeClaim | null {
  const signingValue = env.UNSUBSCRIBE_SECRET;
  if (!signingValue) return null;
  if (typeof link !== 'string' || link.length === 0 || link.length > MAX_LINK_LENGTH) return null;
  const parts = link.toLowerCase().split('.');
  if (parts.length !== 4) return null;
  const [kind, userId, organizationId, signature] = parts as [string, string, string, string];
  if (!isMemberEmailKind(kind) || !SIGNATURE_RE.test(signature)) return null;
  const claim = canonicalClaim({ userId, organizationId, kind });
  if (!claim) return null;
  const expected = macFor(claim, signingValue);
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length) return null;
  return timingSafeEqual(expected, provided) ? claim : null;
}

/** The public /unsubscribe URL for the claim, or null when no link can be signed. */
export function buildMemberUnsubscribeUrl(
  appUrl: string,
  claim: MemberUnsubscribeClaim,
): string | null {
  const link = mintMemberUnsubscribeToken(claim);
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
 * configured) it keeps the settings page, with List-Unsubscribe only: that
 * page is behind sign-in and ignores a POST, so advertising one-click there
 * would let a provider POST into nothing and report success.
 */
export function memberUnsubscribeDelivery(args: {
  appUrl: string;
  settingsUrl: string;
  claim: MemberUnsubscribeClaim;
}): MemberUnsubscribeDelivery {
  const url = buildMemberUnsubscribeUrl(args.appUrl, args.claim);
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
