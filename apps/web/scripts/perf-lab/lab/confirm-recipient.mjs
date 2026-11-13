// LOCAL LAB ONLY. A plain-JavaScript copy of the app's confirmation-link
// signer (src/lib/auth/confirm-recipient.ts, docket S25), for trace-nav.mjs,
// which plain node runs and so cannot import the TypeScript original.
// src/lib/auth/confirm-recipient.test.ts holds this copy to the app's
// known-answer vector, so the two cannot drift apart unnoticed.
//
// `r` names the account a /auth/confirm link is for. The app checks it on
// the page and on the press, so a lab sign-in link must carry it, signed with
// exactly the service key the app under test reads.
import { createHmac } from 'node:crypto';

const TYPES = new Set(['recovery', 'invite', 'magiclink', 'email_change']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_HASH_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The `r` value for one link, or null when it cannot be signed.
 * @param {string} serviceRoleKey the stack's service key (never printed)
 * @param {{ type: string, tokenHash: string, userId: string, issued: number }} claim
 * @returns {string | null}
 */
export function signConfirmRecipient(serviceRoleKey, claim) {
  const key = typeof serviceRoleKey === 'string' ? serviceRoleKey.trim() : '';
  const userId = typeof claim?.userId === 'string' ? claim.userId.toLowerCase() : '';
  const { type, tokenHash, issued } = claim ?? {};
  if (
    !key ||
    !TYPES.has(type) ||
    typeof tokenHash !== 'string' ||
    !TOKEN_HASH_RE.test(tokenHash) ||
    !UUID_RE.test(userId) ||
    !Number.isSafeInteger(issued) ||
    issued <= 0 ||
    String(issued).length > 12
  ) {
    return null;
  }
  const recipientKey = createHmac('sha256', key)
    .update('stockpilot:auth-confirm-recipient-key:v1')
    .digest();
  const tag = createHmac('sha256', recipientKey)
    .update(`auth-confirm:recipient:v1:${type}:${tokenHash}:${userId}:${issued}`)
    .digest('base64url');
  return `v1.${userId}.${issued}.${tag}`;
}
