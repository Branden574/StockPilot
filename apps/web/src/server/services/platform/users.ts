import 'server-only';

import { env } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

import { recordPlatformAudit } from './audit';

/**
 * Platform-admin user actions. Today: trigger a password-reset email for any
 * user on the platform. The admin never sees or sets a password — Supabase
 * emails the user a recovery link, exactly like the self-serve "forgot
 * password" flow, just initiated by the operator.
 *
 * The CALLER must have passed the platform-admin gate (and step-up where
 * required); these functions assume it and take the actor identity for audit.
 */

export interface SendPasswordResetInput {
  targetUserId: string;
  actorUserId: string;
  actorEmail: string;
}

export type SendPasswordResetResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'not_found' | 'no_email' | 'send_failed' };

export async function sendPasswordResetForUser(
  input: SendPasswordResetInput,
): Promise<SendPasswordResetResult> {
  const admin = createAdminClient();

  // Look up the target's email via the admin client (the user may be in a
  // different org, so RLS would hide them from the operator's own client).
  const { data: profile, error } = await admin
    .from('user_profiles')
    .select('id, email')
    .eq('id', input.targetUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!profile) return { ok: false, reason: 'not_found' };
  const email = (profile as { email: string | null }).email;
  if (!email) return { ok: false, reason: 'no_email' };

  // Send the recovery email through the configured mailer — same call the
  // self-serve flow uses. resetPasswordForEmail takes an explicit address, so
  // the caller's session is irrelevant; we use the server client for it.
  const supabase = await createClient();
  const { error: sendErr } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/reset/complete`,
  });
  if (sendErr) return { ok: false, reason: 'send_failed' };

  await recordPlatformAudit({
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    action: 'password_reset_sent',
    targetUserId: input.targetUserId,
    // email recorded for the operator trail; not a secret.
    detail: { email },
  });

  return { ok: true, email };
}
