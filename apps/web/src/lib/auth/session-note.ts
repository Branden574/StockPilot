import 'server-only';

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { bearerTokenFrom } from '@/lib/auth/cross-site-request';
import { readVerifiedTokenClaims, type VerifiedSessionClaims } from '@/lib/auth/verified-claims';
import { clientIpForRecord } from '@/lib/client-ip';

/**
 * What the phone's sign-in and sign-out notes share (S5: POST
 * /api/v1/auth/signed-in and /api/v1/auth/signed-out).
 *
 * The phone signs in and out against the Auth server directly, so the server
 * never saw either: no user.signed_in or user.signed_out row, no new-device
 * email, and the account's other devices were not told of a sign-out. The
 * phone now tells the server, with its bearer token.
 */

/**
 * The verified claims of the request's bearer token, for the account the
 * request authenticated as, or null.
 *
 * Bearer only: a cookie session is the web's, which writes its own rows
 * (server/actions/auth.ts), and must not be able to write a phone's. The
 * claims are read from the token itself (signature, expiry, then the Auth
 * server only when that cannot be checked), never from a stored session, and
 * must name the user withApiContext resolved.
 */
export async function verifiedBearerClaims(
  req: Request,
  ctx: { userId: string; supabase: Pick<SupabaseClient, 'auth'> },
): Promise<VerifiedSessionClaims | null> {
  const bearer = bearerTokenFrom(req);
  if (!bearer) return null;
  const claims = await readVerifiedTokenClaims(ctx.supabase, bearer);
  if (!claims || claims.userId !== ctx.userId) return null;
  return claims;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The session's reference in an Audit log row: the first 16 hex characters of
 * its id's SHA-256, never the id. Managers read audit_logs (0272), and a live
 * session id is what "sign out this device" acts on. Enough to match a
 * sign-in to its sign-out, nothing to act on.
 */
export function sessionRef(sessionId: string): string {
  return sha256(sessionId).slice(0, 16);
}

/**
 * The rate-limit key that writes a session's row once: `auth-note:in:` for
 * the sign-in note, `auth-note:out:` for the sign-out note, then the full hash
 * of the session id (the bucket table never holds the id).
 */
export function sessionNoteKey(note: 'in' | 'out', sessionId: string): string {
  return `auth-note:${note}:${sha256(sessionId)}`;
}

/** The per-account bucket: 30 notes an hour. */
export function accountNoteKey(userId: string): string {
  return `auth-note:user:${userId}`;
}

export const ACCOUNT_NOTE_LIMIT = 30;
export const ACCOUNT_NOTE_WINDOW_MS = 60 * 60_000;
/** A session's row is written once; a day covers any retry the phone makes. */
export const SESSION_NOTE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The caller's address for the device row and the new-device email, by the
 * one rule (lib/client-ip.ts: x-forwarded-for only on Vercel), or null when
 * it is not an IP literal.
 */
export function requestIp(req: Request): string | null {
  return clientIpForRecord(req.headers);
}
