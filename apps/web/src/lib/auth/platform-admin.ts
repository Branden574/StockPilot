import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { env } from '@/lib/env';
import { SESSION_HEADER_USER_EMAIL } from '@/lib/supabase/middleware';
import { createClient } from '@/lib/supabase/server';

import { stepUpOwed } from '@stockpilot/core';

import { requireSession, type ServerSession } from './session';
import { readVerifiedSessionClaimsOf, type VerifiedSessionClaims } from './verified-claims';

/**
 * Platform-admin gate. Distinct from org-scoped roles (owner/admin/manager) —
 * a platform admin operates ABOVE any single org (the Super-Admin Console).
 *
 * The allowlist lives in the STOCKPILOT_PLATFORM_ADMIN_EMAILS env var as
 * a comma-separated list of lowercased emails. Empty / unset == no
 * platform admins (locked down by default). Kept as a DEPLOY-TIME allowlist
 * on purpose: no DB write can ever escalate an account to god-mode.
 */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const allowlist = env.STOCKPILOT_PLATFORM_ADMIN_EMAILS;
  if (!allowlist) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return allowlist.split(',').includes(normalized);
}

/** The verified auth user of a request: who it is, and the factors GoTrue lists for it. */
interface VerifiedUser {
  id: string;
  email: string | null;
  /** GoTrue's own list for this user, from the same answer that named it. */
  factors: ReadonlyArray<{ status?: string | null }>;
}

/**
 * The VERIFIED auth user of the current request (auth.getUser() validates the
 * session against the auth server): its id with its email, so the gates below
 * can hold the AAL2 claims to the same account whose email is allowlisted, and
 * its factors, so they can tell whether that account has an authenticator
 * without a second round trip. Cached per render, shared with getVerifiedEmail.
 */
const getVerifiedUser = cache(async (): Promise<VerifiedUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null, factors: data.user.factors ?? [] };
});

/**
 * The VERIFIED auth email for the current request — read straight from the
 * Supabase Auth session (auth.getUser() validates against the auth server),
 * NOT from the `user_profiles.email` column.
 *
 * SECURITY: this distinction is load-bearing. RLS lets a user UPDATE their own
 * `user_profiles` row, so `session.email` (sourced from that column) is
 * attacker-controlled and MUST NOT be used for authorization — doing so let
 * any member rewrite their profile email to an allowlisted address and gain
 * god-mode. The allowlist check is gated on THIS function only. Cached per
 * render so repeated gate checks share one round-trip.
 */
export const getVerifiedEmail = cache(
  async (): Promise<string | null> => (await getVerifiedUser())?.email ?? null,
);

/**
 * Whether the current request is an allowlisted admin's: the VERIFIED auth
 * email is on the allowlist, and the session does not still owe that
 * account's authenticator code (owesStepUp below). The gate of the two
 * platform pages under /dashboard/admin, of the support-ticket triage action
 * and of "stop acting as", and what shows the platform links and the
 * impersonation banner.
 */
export async function currentUserIsPlatformAdmin(): Promise<boolean> {
  const admin = await verifiedPlatformAdmin();
  return admin !== null && !(await owesStepUp(admin));
}

/** The verified user when its email is on the allowlist, else null. */
async function verifiedPlatformAdmin(): Promise<VerifiedUser | null> {
  const user = await getVerifiedUser();
  return user && isPlatformAdmin(user.email) ? user : null;
}

/**
 * LINK-VISIBILITY-ONLY variant of {@link currentUserIsPlatformAdmin} that
 * reads the middleware-verified email header instead of making a second
 * GoTrue round-trip (perf plan 2026-07-02 P1d / orders-new plan P6).
 *
 * TRUST CHAIN (security-reviewed, keep this comment in sync with
 * `src/lib/supabase/middleware.ts` + `src/proxy.ts`):
 *   1. The proxy matcher covers every /dashboard and /platform route, so
 *      no request reaches those layouts without `updateSession()` running.
 *   2. `updateSession()` sets `x-stockpilot-user-email` ONLY after
 *      cryptographically verifying the session (`auth.getClaims()` local
 *      ES256 verify, with an `auth.getUser()` network fallback), and
 *      unconditionally DELETES it otherwise — a client-supplied header can
 *      never survive.
 *   3. This is the exact trust level the entire org context already rides:
 *      `session.ts` sources the user id from the sibling
 *      `x-stockpilot-user-id` header.
 *
 * SCOPE: use this ONLY for cosmetic gating (the "Platform admin" link in
 * the dashboard account menu). Every real platform-admin gate —
 * `requirePlatformAdmin()` (pages) and `checkPlatformAdmin()` (actions) —
 * MUST keep the live `auth.getUser()` + AAL2 (+ fresh step-up) checks.
 */
export async function currentUserIsPlatformAdminFromRequestHeader(): Promise<boolean> {
  const h = await headers();
  return isPlatformAdmin(h.get(SESSION_HEADER_USER_EMAIL));
}

/**
 * The current session's claims, its access token verified (a local ES256
 * check, no Auth round trip; see lib/auth/verified-claims), or null, and only
 * as the session of `adminId`, the account whose verified email passed the
 * allowlist.
 *
 * The AAL2 and step-up checks below read `aal` and `amr` from THESE claims.
 * They used to read them from the cookie unchecked:
 * getAuthenticatorAssuranceLevel() decoded the stored token and read its
 * stored user object (auth-js logs that as insecure on a server client), and
 * the step-up read getSession()'s token and decoded `amr` from it. A cookie
 * whose token does not verify now reads as no session: not AAL2, no step-up.
 *
 * WHY THE ACCOUNT MUST MATCH (S43a review round 1). This read loads the cookie
 * session on a new client, after getVerifiedUser() loaded it on another, and a
 * load refreshes the session with the cookie's own refresh token when the
 * cookie's own `expires_at` says so. Both fields are the sender's to write: the
 * admin's password alone (an aal1 token) beside the refresh token of ANY
 * account with its own authenticator passed the fresh step-up with that other
 * account's claims. Claims of another account are null here.
 */
async function currentVerifiedClaims(adminId: string): Promise<VerifiedSessionClaims | null> {
  return readVerifiedSessionClaimsOf(await createClient(), adminId);
}

/**
 * Does the allowlisted account's session still owe its authenticator code?
 * The one rule (stepUpOwed in @stockpilot/core) that requireOrgContext() and
 * the API context apply to a member: an account with a verified factor counts
 * only on a session at aal2. An allowlisted account with no authenticator owes
 * nothing here; the console itself (requirePlatformAdmin) and every dangerous
 * action (requireStepUp) ask for aal2 outright.
 *
 * The factors are those of the getUser() answer that named the account, and
 * the level is read only when one of them is verified: a local signature
 * check, held to this same account (currentVerifiedClaims).
 */
async function owesStepUp(admin: VerifiedUser): Promise<boolean> {
  if (!stepUpOwed(admin.factors, null)) return false;
  return stepUpOwed(admin.factors, (await currentVerifiedClaims(admin.id))?.aal);
}

/**
 * Dangerous god-mode actions require an MFA assertion no older than this. A full
 * sign-in (which runs the MFA challenge) refreshes it; an AAL2 session whose
 * TOTP was asserted longer ago must re-authenticate. (#8 — "fresh step-up")
 */
const STEP_UP_MAX_AGE_SECONDS = 15 * 60;

/**
 * Pure: seconds since the most recent SECOND-FACTOR (totp/mfa) assertion in a
 * verified token's `amr` claim, relative to `nowSec`; null when it can't be
 * determined (no claim, no MFA entry, malformed). `amr` timestamps reflect when
 * the factor was ACTUALLY asserted and are NOT bumped by token refresh, so this
 * is true step-up freshness rather than "ever reached AAL2". Exported for tests.
 */
export function mfaAssertionAgeFromAmr(amr: unknown, nowSec: number): number | null {
  if (!Array.isArray(amr)) return null;
  const ts = (amr as Array<{ method?: unknown; timestamp?: unknown } | null>)
    .filter(
      (e) => e && (e.method === 'totp' || e.method === 'mfa') && typeof e.timestamp === 'number',
    )
    .map((e) => e!.timestamp as number);
  if (ts.length === 0) return null;
  return nowSec - Math.max(...ts);
}

/**
 * Whether the session's MFA step-up is FRESH (asserted within
 * STEP_UP_MAX_AGE_SECONDS). Fail-closed: no verified claims, or an unknown or
 * stale age, returns false, so the caller must re-authenticate. This is what
 * makes the dangerous-action gate a *fresh* step-up rather than "the session
 * reached AAL2 at some point".
 */
function stepUpIsFresh(claims: VerifiedSessionClaims | null): boolean {
  if (!claims) return false;
  const age = mfaAssertionAgeFromAmr(claims.amr, Math.floor(Date.now() / 1000));
  return age !== null && age <= STEP_UP_MAX_AGE_SECONDS;
}

/**
 * Hard gate for every `/platform` page and god-mode read. Requires:
 *   1. a signed-in session,
 *   2. the VERIFIED auth email on the platform-admin allowlist,
 *   3. the current session at AAL2 (MFA satisfied).
 *
 * Any failure → 404 (NOT 403): the console's very existence is never
 * revealed to anyone who isn't a verified platform admin. Returns the
 * session for convenience.
 */
export async function requirePlatformAdmin(): Promise<ServerSession> {
  const session = await requireSession();
  const admin = await verifiedPlatformAdmin();
  if (!admin) notFound();
  if ((await currentVerifiedClaims(admin.id))?.aal !== 'aal2') notFound();
  return session;
}

/**
 * Result of the lighter, throwing check used by SERVER ACTIONS (where a
 * 404 isn't appropriate — actions return ActionResult). Callers map the
 * reason to a clean error.
 */
export type PlatformAdminCheck =
  | { ok: true; session: ServerSession }
  | { ok: false; reason: 'forbidden' | 'aal2_required' };

/**
 * Action-layer equivalent of requirePlatformAdmin. Use at the top of every
 * platform-admin server action. `requireStepUp` adds the fresh-AAL2
 * requirement for the dangerous actions (act-as, billing changes,
 * provisioning). Without it, an allowlisted account that has an authenticator
 * is still refused (`aal2_required`) until its session has entered the code.
 */
export async function checkPlatformAdmin(
  opts: { requireStepUp?: boolean } = {},
): Promise<PlatformAdminCheck> {
  const session = await requireSession();
  const admin = await verifiedPlatformAdmin();
  if (!admin) return { ok: false, reason: 'forbidden' };
  if (opts.requireStepUp) {
    // Dangerous actions need a FRESH step-up: AAL2 must be present AND the MFA
    // assertion recent (not just "reached AAL2 at login hours ago"). A stale
    // step-up returns aal2_required; re-authenticating refreshes it. Both are
    // read from ONE verified set of claims, the allowlisted account's own.
    const claims = await currentVerifiedClaims(admin.id);
    if (claims?.aal !== 'aal2') return { ok: false, reason: 'aal2_required' };
    if (!stepUpIsFresh(claims)) return { ok: false, reason: 'aal2_required' };
  } else if (await owesStepUp(admin)) {
    return { ok: false, reason: 'aal2_required' };
  }
  return { ok: true, session };
}
