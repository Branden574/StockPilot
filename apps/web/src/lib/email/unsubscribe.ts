import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '@/lib/env';

/**
 * Signed public unsubscribe links for order-request emails.
 *
 * Order-request recipients are usually ANONYMOUS — public-link
 * requesters with no account — so the unsubscribe surface can't live
 * behind the dashboard login (that link dead-ended them on /signin: a
 * broken promise and a Gmail/Yahoo bulk-sender compliance gap). Each
 * email instead carries `/unsubscribe?e=<email>&t=<token>` where the
 * token is an HMAC-SHA256 of the lowercased address keyed on
 * UNSUBSCRIBE_SECRET. Possession of a valid link proves it came from an
 * email WE sent to that address, so the endpoint can't be used to
 * unsubscribe arbitrary victims.
 *
 * Fail-closed: with no secret configured, `mintUnsubscribeToken`
 * returns null (the email builder falls back to the in-app settings
 * link) and `verifyUnsubscribeToken` returns false — no token is ever
 * valid against an unkeyed HMAC.
 */

/** sha256 digest length — a valid token is exactly 64 hex chars. */
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[0-9a-f]{64}$/i;

/**
 * Canonical form used for signing, verifying, AND storage in
 * public_email_unsubscribes — one lowercased spelling everywhere so a
 * case-variant can never dodge the suppression lookup.
 */
export function normalizeUnsubscribeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hmacFor(email: string, secret: string): Buffer {
  // Domain-separated input so this MAC can never be replayed against
  // another signer that might share the secret for a different purpose.
  return createHmac('sha256', secret)
    .update(`unsubscribe:v1:${normalizeUnsubscribeEmail(email)}`)
    .digest();
}

/** Token for the address, or null when UNSUBSCRIBE_SECRET is unset. */
export function mintUnsubscribeToken(email: string): string | null {
  const secret = env.UNSUBSCRIBE_SECRET;
  if (!secret) return null;
  return hmacFor(email, secret).toString('hex');
}

/** Constant-time verification. False (fail closed) when the secret is unset. */
export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const secret = env.UNSUBSCRIBE_SECRET;
  if (!secret) return false;
  if (!TOKEN_RE.test(token)) return false;
  const provided = Buffer.from(token, 'hex');
  if (provided.length !== TOKEN_BYTES) return false;
  return timingSafeEqual(hmacFor(email, secret), provided);
}

/**
 * Full signed URL for the public unsubscribe page, or null when the
 * secret is unset (callers fall back to the in-app settings link).
 */
export function buildPublicUnsubscribeUrl(appUrl: string, email: string): string | null {
  const token = mintUnsubscribeToken(email);
  if (!token) return null;
  const normalized = normalizeUnsubscribeEmail(email);
  return `${appUrl}/unsubscribe?e=${encodeURIComponent(normalized)}&t=${token}`;
}
