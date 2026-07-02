import 'server-only';

import { sendEmail } from '@/lib/email/resend';
import { passwordResetEmailHtml, passwordResetEmailText } from '@/lib/email/templates';
import { env } from '@/lib/env';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Mints a one-time recovery link for `email` and delivers it through the
 * app's own Resend transport. Shared by every reset-sending surface (the
 * public forgot-password form, the org-admin Team action, the platform
 * super-admin console) so there is exactly ONE way a reset email leaves
 * this app.
 *
 * The link is minted server-side via admin.generateLink — NOT
 * supabase.auth.resetPasswordForEmail. That call routes through Supabase's
 * BUILT-IN mailer, which is capped at a couple of emails per hour
 * project-wide; observed live 2026-07-02: POST /recover → 429
 * over_email_send_rate_limit while the UI reported success, so reset
 * emails silently never arrived. admin.generateLink() creates the same
 * one-time recovery link without sending anything.
 *
 * Returns true only when the link was minted AND Resend accepted the
 * message; false for every failure (unknown email, link error, send
 * error). Failures never throw — each CALLER owns the disclosure policy
 * (the public form swallows the result for account-enumeration
 * resistance; admin surfaces show the real failure).
 */
export async function sendPasswordResetEmail(email: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data, error: linkError } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: {
        redirectTo: `${env.NEXT_PUBLIC_APP_URL}/auth/callback?next=/reset/complete`,
      },
    });
    // Email OUR /auth/confirm URL carrying the hashed token — NOT the
    // action_link. action_link runs through Supabase's /auth/v1/verify,
    // which hands the session back in the URL FRAGMENT; the server-side
    // /auth/callback never sees it and bounced users to /signin.
    // /auth/confirm verifies the hash server-side (verifyOtp) and lands
    // the user on /reset/complete with cookies set.
    const hashedToken = data?.properties?.hashed_token;
    const resetUrl = hashedToken
      ? `${env.NEXT_PUBLIC_APP_URL}/auth/confirm?token_hash=${encodeURIComponent(hashedToken)}&type=recovery&next=${encodeURIComponent('/reset/complete')}`
      : (data?.properties?.action_link ?? null);
    if (linkError || !resetUrl) return false;

    const sent = await sendEmail({
      to: email,
      subject: 'Reset your StockPilot password',
      html: passwordResetEmailHtml({ resetUrl }),
      text: passwordResetEmailText({ resetUrl }),
    });
    return sent.ok;
  } catch (e) {
    void reportError(e, { tag: 'auth.password_reset_send_failed', level: 'warning' });
    return false;
  }
}
