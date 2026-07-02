import 'server-only';

import { sendPasswordResetEmail } from '@/lib/auth/password-reset-email';
import { createAdminClient } from '@/lib/supabase/admin';

import { recordPlatformAudit } from './audit';

/**
 * Platform-admin user actions. Today: trigger a password-reset email for any
 * user on the platform. The admin never sees or sets a password — the user
 * gets a one-time recovery link, exactly like the self-serve "forgot
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

  // Mint + send via the shared helper — the SAME path the self-serve
  // forgot-password form uses (admin.generateLink → our /auth/confirm URL →
  // Resend). NOT resetPasswordForEmail: that routes through Supabase's
  // built-in mailer, capped at ~2 emails/hour project-wide, which is
  // exactly how this action failed live with "Could not send the reset
  // email" (see sendPasswordResetEmail for the full WHY).
  const sent = await sendPasswordResetEmail(email);
  if (!sent) return { ok: false, reason: 'send_failed' };

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
