'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { env } from '@/lib/env';
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
  type RequestPasswordResetInput,
  type SignInInput,
  type SignUpInput,
} from '@stockpilot/core';

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
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) return err('internal_error', error.message);
  return ok({ next: '/dashboard' });
}

/**
 * Change the signed-in user's password. Requires re-authentication with the
 * current password before applying the new one — Supabase's updateUser does
 * not validate the existing credential on its own, so we re-check it via
 * signInWithPassword. On the SSR client this validates the credential
 * against the current session without disrupting it.
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

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: parsed.data.currentPassword,
  });
  if (signInError) {
    return err('forbidden', 'Current password is incorrect');
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
