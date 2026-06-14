import 'server-only';

import { cache } from 'react';
import { notFound } from 'next/navigation';

import { env } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';

import { requireSession, type ServerSession } from './session';

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
 * Whether the current session is at AAL2 (the user has completed an MFA
 * challenge this session). Returns false when there's no factor or the
 * check fails — fail-closed.
 */
async function currentSessionIsAal2(): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return false;
  return data.currentLevel === 'aal2';
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
  if (!(await currentSessionIsAal2())) notFound();
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
  if (opts.requireStepUp && !(await currentSessionIsAal2())) {
    return { ok: false, reason: 'aal2_required' };
  }
  return { ok: true, session };
}
