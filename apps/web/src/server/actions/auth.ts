'use server';

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { env } from '@/lib/env';
import { checkRateLimit } from '@/lib/rate-limit';
import { audit } from '@/server/services/audit';
import { createClient } from '@/lib/supabase/server';
import { REMEMBER_SESSION_COOKIE, rememberPreferenceOptions } from '@/lib/supabase/session-cookies';

import {
  changePasswordSchema,
  completePasswordResetSchema,
  err,
  ok,
  requestPasswordResetSchema,
  signInSchema,
  type ActionResult,
  type ChangePasswordInput,
  type CompletePasswordResetInput,
  type Database,
  type RequestPasswordResetInput,
  type SignInInput,
  type SignUpInput,
} from '@stockpilot/core';

/**
 * Best-effort client-IP extraction from request headers. Used as a
 * secondary rate-limit key on unauthenticated flows so an attacker can't
 * fan out across many email addresses from one host. `next/headers` is
 * async in Next 16.
 */
async function getClientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip') ??
    'unknown'
  );
}

/**
 * Public self-signup is disabled — this is an internal-company tool.
 * Account creation happens via the invite-acceptance flow only.
 *
 * The function is kept exported (rather than deleted) so the existing
 * /signup page can render a "request access from your admin" notice
 * without import errors during the migration. Returns a forbidden error
 * if anything actually invokes it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function signUpAction(
  _input: SignUpInput,
): Promise<ActionResult<{ requiresEmailConfirm: boolean }>> {
  return err(
    'forbidden',
    'Public sign-up is disabled. Ask your administrator to send you an invite.',
  );
}

export async function signInAction(input: SignInInput): Promise<ActionResult<{ next: string }>> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  // Rate-limit dual-keyed on email AND IP. 5/min/email blocks single-
  // account brute force; 30/min/ip stops a single host from fanning out
  // across many email addresses. Both gates run 'closed' — a DB outage
  // must NOT unlock unlimited attempts on the unauthenticated front
  // door. Return the typed `rate_limited` error (don't throw) so the
  // sign-in form can toast a clean message.
  const emailKey = parsed.data.email.toLowerCase();
  const ip = await getClientIp();
  const emailRl = await checkRateLimit(`signin:${emailKey}`, 5, 60_000, 'closed');
  if (!emailRl.allowed) {
    return err('rate_limited', 'Too many sign-in attempts. Try again in a minute.');
  }
  const ipRl = await checkRateLimit(`signin-ip:${ip}`, 30, 60_000, 'closed');
  if (!ipRl.allowed) {
    return err('rate_limited', 'Too many sign-in attempts. Try again in a minute.');
  }

  const supabase = await createClient({ rememberSession: parsed.data.rememberMe });
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) return err('unauthenticated', 'Invalid email or password');

  const cookieStore = await cookies();
  cookieStore.set(
    REMEMBER_SESSION_COOKIE,
    parsed.data.rememberMe ? '1' : '0',
    rememberPreferenceOptions(parsed.data.rememberMe),
  );

  // If the user has any verified MFA factors, the password sign-in only
  // brings them to AAL1. They must complete the TOTP challenge to reach
  // AAL2 and access the dashboard.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.currentLevel === 'aal1' && aal.nextLevel === 'aal2') {
    return ok({ next: '/signin/mfa' });
  }

  return ok({ next: '/dashboard' });
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  // scope: 'global' revokes ALL refresh tokens for the user across
  // every device + tab. Default ('local') only kills the calling
  // tab's token, leaving other browser tabs and the mobile app
  // alive until natural expiry (~1h). For an internal enterprise
  // tool, "Sign out" should mean "log me out everywhere."
  await supabase.auth.signOut({ scope: 'global' });
  const cookieStore = await cookies();
  cookieStore.delete(REMEMBER_SESSION_COOKIE);
  redirect('/');
}

export async function requestPasswordResetAction(
  input: RequestPasswordResetInput,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = requestPasswordResetSchema.safeParse(input);
  if (!parsed.success) return err('validation_error', 'Invalid email');

  // 3 requests / 15 min / email. Closed mode — a DB outage must NOT
  // unlock unlimited reset-email blasts (which would spam the user
  // and burn through Resend quota). Same generic ok() return on rate
  // hit to keep account-enumeration resistance.
  const emailKey = parsed.data.email.toLowerCase();
  const rl = await checkRateLimit(`pwreset-req:${emailKey}`, 3, 15 * 60_000, 'closed');
  if (!rl.allowed) {
    return ok({ ok: true });
  }

  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/reset/complete`,
  });
  // Always return ok to avoid account enumeration.
  return ok({ ok: true });
}

export async function completePasswordResetAction(
  input: CompletePasswordResetInput,
): Promise<ActionResult<{ next: string }>> {
  const parsed = completePasswordResetSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  // 5 completes / 15 min / ip. Closed mode — the user is briefly
  // authenticated by the recovery token at this point, but the
  // endpoint is still effectively unauthenticated front door.
  const ip = await getClientIp();
  const rl = await checkRateLimit(`pwreset-complete:${ip}`, 5, 15 * 60_000, 'closed');
  if (!rl.allowed) {
    return err('rate_limited', 'Too many attempts. Try again in a few minutes.');
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return err('internal_error', error.message);
  return ok({ next: '/dashboard' });
}

/**
 * Change the signed-in user's password. Re-authenticates with the current
 * password before applying the new one.
 *
 * Why we DON'T call signInWithPassword on the SSR client to verify the
 * current password: that rotates the cookie session, and a fresh
 * password-only sign-in is AAL1 even if the user was at AAL2. For
 * MFA-enabled accounts Supabase requires AAL2 on the calling session
 * to update the password, so the subsequent updateUser() fails with
 * "AAL2 session is required to update email or password when MFA is
 * enabled." The fix: verify the current password against an isolated,
 * in-memory-only Supabase client so the user's actual session is left
 * untouched (and stays at AAL2 if they have MFA).
 */
export async function changePasswordAction(
  input: ChangePasswordInput,
): Promise<ActionResult<{ ok: true }>> {
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return err('validation_error', parsed.error.issues[0]?.message ?? 'Invalid input');
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return err('unauthenticated', 'Sign in required');
  }

  // 5 attempts / 15 min / user. Closed mode — prevents an authenticated
  // attacker (or stolen-session scenario) from brute-forcing the
  // currentPassword check.
  const rl = await checkRateLimit(`pwchange:${user.id}`, 5, 15 * 60_000, 'closed');
  if (!rl.allowed) {
    return err('rate_limited', 'Too many password-change attempts. Try again in a few minutes.');
  }

  // Side-channel password check — does NOT persist a session anywhere.
  const checkClient = createSupabaseClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
  const { error: pwError } = await checkClient.auth.signInWithPassword({
    email: user.email,
    password: parsed.data.currentPassword,
  });
  if (pwError) {
    return err('forbidden', 'Current password is incorrect');
  }

  // For MFA-enabled accounts, Supabase requires AAL2 on the SSR session
  // to update the password. Surface a clearer error than the generic
  // updateUser() one if the user's session somehow isn't at AAL2.
  const { data: factorsData } = await supabase.auth.mfa.listFactors();
  const hasVerifiedMfa = (factorsData?.totp ?? []).some(
    (f) => f.status === 'verified',
  );
  if (hasVerifiedMfa) {
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== 'aal2') {
      return err(
        'forbidden',
        'Complete the MFA challenge before changing your password. Sign out and sign back in to step up.',
      );
    }
  }

  const { error: updateError } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  });
  if (updateError) return err('internal_error', updateError.message);

  await audit({
    event: 'user.password.changed',
    entityType: 'user',
    entityId: user.id,
  });

  return ok({ ok: true });
}
