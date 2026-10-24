import 'server-only';

import { cache } from 'react';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { env } from '@/lib/env';
import { SESSION_HEADER_USER_EMAIL } from '@/lib/supabase/middleware';
import { createClient } from '@/lib/supabase/server';

import { requireSession, type ServerSession } from './session';
import { readVerifiedSessionClaims, type VerifiedSessionClaims } from './verified-claims';

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
export const getVerifiedEmail = cache(async (): Promise<string | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  return data.user.email ?? null;
});

/** Whether the current request's VERIFIED auth email is an allowlisted admin. */
export async function currentUserIsPlatformAdmin(): Promise<boolean> {
  return isPlatformAdmin(await getVerifiedEmail());
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
 * check, no Auth round trip; see lib/auth/verified-claims), or null.
 *
 * The AAL2 and step-up checks below read `aal` and `amr` from THESE claims.
 * They used to read them from the cookie unchecked:
 * getAuthenticatorAssuranceLevel() decoded the stored token and read its
 * stored user object (auth-js logs that as insecure on a server client), and
 * the step-up read getSession()'s token and decoded `amr` from it. A cookie
 * whose token does not verify now reads as no session: not AAL2, no step-up.
 */
async function currentVerifiedClaims(): Promise<VerifiedSessionClaims | null> {
  return readVerifiedSessionClaims(await createClient());
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
  if (!(await currentUserIsPlatformAdmin())) notFound();
  if ((await currentVerifiedClaims())?.aal !== 'aal2') notFound();
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
 * provisioning).
 */
export async function checkPlatformAdmin(
  opts: { requireStepUp?: boolean } = {},
): Promise<PlatformAdminCheck> {
  const session = await requireSession();
  if (!(await currentUserIsPlatformAdmin())) return { ok: false, reason: 'forbidden' };
  if (opts.requireStepUp) {
    // Dangerous actions need a FRESH step-up: AAL2 must be present AND the MFA
    // assertion recent (not just "reached AAL2 at login hours ago"). A stale
    // step-up returns aal2_required; re-authenticating refreshes it. Both are
    // read from ONE verified set of claims.
    const claims = await currentVerifiedClaims();
    if (claims?.aal !== 'aal2') return { ok: false, reason: 'aal2_required' };
    if (!stepUpIsFresh(claims)) return { ok: false, reason: 'aal2_required' };
  }
  return { ok: true, session };
}
