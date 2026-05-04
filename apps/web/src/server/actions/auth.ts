'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { env } from '@/lib/env';
import { createClient } from '@/lib/supabase/server';
import { REMEMBER_SESSION_COOKIE, rememberPreferenceOptions } from '@/lib/supabase/session-cookies';

import {
  completePasswordResetSchema,
  err,
  ok,
  requestPasswordResetSchema,
  signInSchema,
  type ActionResult,
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

  return ok({ next: '/dashboard' });
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
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
