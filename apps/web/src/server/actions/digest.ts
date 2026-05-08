'use server';

import { requireOrgContext } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { sendEmail } from '@/lib/email/resend';
import {
  weeklyDigestHtml,
  weeklyDigestSubject,
  weeklyDigestText,
} from '@/lib/email/templates';
import { createClient } from '@/lib/supabase/server';
import { getDigestData } from '@/server/services/digest';

/**
 * Toggle the calling user's email_digest_optin flag. Returns the new
 * value. Server-side action so the column update goes through the
 * authenticated client (RLS will only let the user update their own
 * profile row).
 */
export async function setDigestOptinAction(optIn: boolean) {
  const ctx = await requireOrgContext();
  const supabase = await createClient();
  const { error } = await supabase
    .from('user_profiles')
    .update({ email_digest_optin: optIn })
    .eq('id', ctx.userId);
  if (error) {
    return { ok: false as const, error: { code: 'internal_error', message: error.message } };
  }
  return { ok: true as const, data: { optIn } };
}

/**
 * Send a one-shot preview of the weekly digest to the calling user's
 * email address. Bypasses the empty-skip rule the cron uses (so the
 * user gets confirmation that the pipeline works even when there's
 * nothing to flag — the template renders an "all clear" panel).
 */
export async function sendDigestPreviewAction() {
  const ctx = await requireOrgContext();
  if (!ctx.email) {
    return {
      ok: false as const,
      error: { code: 'validation_error', message: 'Your account has no email on file.' },
    };
  }
  const supabase = await createClient();
  const payload = await getDigestData(supabase, ctx.organizationId);
  const appUrl = (env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  const settingsUrl = `${appUrl}/dashboard/settings/notifications`;
  const opts = {
    orgName: ctx.organizationName,
    appUrl,
    settingsUrl,
  };
  const subject = `[Preview] ${weeklyDigestSubject()}`;
  const html = weeklyDigestHtml(payload, opts);
  const text = weeklyDigestText(payload, opts);
  const res = await sendEmail({ to: ctx.email, subject, html, text });
  if (!res.ok) {
    return {
      ok: false as const,
      error: { code: 'internal_error', message: res.error ?? 'Send failed' },
    };
  }
  return { ok: true as const, data: { sentTo: ctx.email } };
}
