import { stepUpOwed } from '@stockpilot/core';

/**
 * DOES THIS SESSION STILL OWE ITS AUTHENTICATOR CODE? Answered from the
 * session itself: the access token's own assurance level and the factors the
 * session's user carries. No request, no auth lock, no storage read, so the
 * answer is there in the same render the session arrives in, online or not.
 *
 * The rule is core's stepUpOwed (the one the server refuses by): owed when the
 * account has a verified factor of any type and the token is not aal2. This
 * module only reads the two inputs out of what the phone holds:
 *   - the level is the `aal` claim of the access token. A token that cannot be
 *     decoded, or carries no level, is not aal2;
 *   - the factors are the ones on the session's user, which auth-js stores
 *     with the session and replaces at every sign-in, token refresh and
 *     verified code (auth-storage.ts: one entry, user included).
 *
 * An expired token is decoded like any other: the level a session reached does
 * not lapse with the token, so a phone that entered its code keeps working
 * offline.
 *
 * PURE: no react-native, no supabase client. auth-context.tsx (the gate),
 * auth-storage.ts (the outbox hold) and mfa-reconcile.ts answer through here.
 * Push registration keeps its own read of the same two inputs, made at the
 * last moment before it writes (use-push-notifications.ts
 * owesAuthenticatorCode), and so does the first-paint appearance read
 * (appearance/account.ts peekSignedInUser); code-gate-wiring.test.ts lists
 * every place the phone decides this.
 */

/** A factor as GoTrue lists it on a user. Only these three fields are read. */
export interface FactorLike {
  readonly id?: string | null;
  readonly status?: string | null;
  readonly factor_type?: string | null;
}

/** The user of a session, or the one getUser() answers. */
export interface UserLike {
  readonly id?: string | null;
  readonly factors?: readonly (FactorLike | null | undefined)[] | null;
}

/** The part of a session this module reads. */
export interface SessionLike {
  readonly access_token?: string | null;
  readonly user?: UserLike | null;
}

/**
 * The payload of a JWT, or null when the value is not one. Decoding only: the
 * signature is the server's to check, and every request is still judged there.
 * RN-safe (atob, no Node Buffer); unicode claims survive.
 */
export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const seg = token.split('.')[1];
  if (!seg) return null;
  try {
    const json = decodeURIComponent(
      atob(seg.replace(/-/g, '+').replace(/_/g, '/'))
        .split('')
        .map((ch) => '%' + ('00' + ch.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The assurance level an access token carries, or null when it names none. */
export function tokenAal(token: string | null | undefined): string | null {
  const aal = decodeJwtPayload(token)?.aal;
  return typeof aal === 'string' && aal.length > 0 ? aal : null;
}

/**
 * Whether this session owes its authenticator code. No session owes nothing:
 * nobody is signed in, and the sign-in screen is what shows.
 */
export function stepUpOwedFor(session: SessionLike | null | undefined): boolean {
  if (!session) return false;
  return stepUpOwed(session.user?.factors, tokenAal(session.access_token));
}

/**
 * The gate RootGate reads: the session owes its code by what it carries, or
 * the server's own list said so for this account while the session's copy
 * could not be brought up to date (`forcedFor`, mfa-reconcile.ts). A session
 * already at aal2 is never asked again, whatever was noted: it entered its
 * code.
 */
export function codeGateUp(
  session: SessionLike | null | undefined,
  forcedFor: string | null | undefined,
): boolean {
  if (!session) return false;
  if (stepUpOwedFor(session)) return true;
  const userId = session.user?.id;
  if (!forcedFor || !userId || forcedFor !== userId) return false;
  return tokenAal(session.access_token) !== 'aal2';
}

/** The id of the user's verified authenticator-app (TOTP) factor, or null. */
export function verifiedTotpFactorId(user: UserLike | null | undefined): string | null {
  for (const factor of user?.factors ?? []) {
    if (factor?.status !== 'verified' || factor.factor_type !== 'totp') continue;
    if (typeof factor.id === 'string' && factor.id.length > 0) return factor.id;
  }
  return null;
}

/**
 * The same answer for the session as it is stored on the device (the JSON
 * auth-js persists), for code that must not wait on the auth lock: the outbox
 * (auth-storage.ts). A value that cannot be read as a session (missing,
 * mid-rewrite, not JSON) owes it: what cannot be read is not sent on a guess.
 */
export function stepUpOwedFromStored(raw: string | null | undefined): boolean {
  if (!raw) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true;
  const stored = parsed as Record<string, unknown>;
  const user = stored.user;
  if (typeof user !== 'object' || user === null || Array.isArray(user)) return true;
  const factors = (user as Record<string, unknown>).factors;
  // GoTrue leaves `factors` out for an account with none. Anything else in its
  // place cannot be read as a list, so it is not read as "none".
  if (factors !== undefined && factors !== null && !Array.isArray(factors)) return true;
  const token = typeof stored.access_token === 'string' ? stored.access_token : null;
  return stepUpOwed(factors as UserLike['factors'], tokenAal(token));
}

/**
 * The session's copy of the user against the user the server just answered
 * with (a getUser() the app made anyway).
 *
 * 'refresh' when the two disagree about whether THIS session, at its own
 * level, owes a code: an authenticator turned on elsewhere since the session
 * was stored, or one removed (a reset, a recovery code). A token refresh
 * replaces the stored user, so the gate and the outbox hold then agree with
 * the server. 'none' when they agree, when either is missing, and when the
 * answer is about another account. A session at aal2 never disagrees: it owes
 * nothing whatever factors are added.
 */
export function reconcileStepUp(
  session: SessionLike | null | undefined,
  liveUser: UserLike | null | undefined,
): 'refresh' | 'none' {
  if (!session || !liveUser) return 'none';
  const sessionUserId = session.user?.id;
  if (!sessionUserId || liveUser.id !== sessionUserId) return 'none';
  const stored = stepUpOwedFor(session);
  const live = stepUpOwed(liveUser.factors, tokenAal(session.access_token));
  return stored === live ? 'none' : 'refresh';
}
