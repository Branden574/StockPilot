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
import { applySectionOptIns, getDigestData } from '@/server/services/digest';

export interface DigestPrefs {
  optIn?: boolean;
  lowStock?: boolean;
  openPos?: boolean;
  cycleCounts?: boolean;
}

/**
 * Update any subset of the calling user's digest preferences:
 * - master opt-in (email_digest_optin)
 * - per-section flags (digest_section_*).
 *
 * Pass only the keys you want to change. RLS only lets the user update
 * their own profile row.
 */
export async function setDigestPrefsAction(prefs: DigestPrefs) {
  const ctx = await requireOrgContext();
  const supabase = await createClient();
  const update: Record<string, boolean> = {};
  if (typeof prefs.optIn === 'boolean') update.email_digest_optin = prefs.optIn;
  if (typeof prefs.lowStock === 'boolean')
    update.digest_section_low_stock = prefs.lowStock;
  if (typeof prefs.openPos === 'boolean')
    update.digest_section_open_pos = prefs.openPos;
  if (typeof prefs.cycleCounts === 'boolean')
    update.digest_section_cycle_counts = prefs.cycleCounts;
  if (Object.keys(update).length === 0) {
    return { ok: true as const, data: { changed: 0 } };
  }
  const { error } = await supabase
    .from('user_profiles')
    .update(update)
    .eq('id', ctx.userId);
  if (error) {
    return {
      ok: false as const,
      error: { code: 'internal_error', message: error.message },
    };
  }
  return { ok: true as const, data: { changed: Object.keys(update).length } };
}

/**
 * Backwards-compat wrapper for the master toggle. Still imported by
 * older call sites; new code should call setDigestPrefsAction directly.
 */
export async function setDigestOptinAction(optIn: boolean) {
  return setDigestPrefsAction({ optIn });
}

/**
 * Send a one-shot preview of the weekly digest to the calling user's
 * email address. Honors the user's per-section opt-ins so the preview
 * matches what they'll actually receive on Monday. Bypasses the
 * empty-skip rule (so the user gets confirmation the pipeline works
 * even when nothing's flagged — template renders an "all clear" panel).
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
  const { data: profile } = await supabase
    .from('user_profiles')
    .select(
      'digest_section_low_stock, digest_section_open_pos, digest_section_cycle_counts',
    )
    .eq('id', ctx.userId)
    .maybeSingle();
  const sections = {
    lowStock: (profile as { digest_section_low_stock?: boolean } | null)
      ?.digest_section_low_stock ?? true,
    openPos: (profile as { digest_section_open_pos?: boolean } | null)
      ?.digest_section_open_pos ?? true,
    cycleCounts: (profile as { digest_section_cycle_counts?: boolean } | null)
      ?.digest_section_cycle_counts ?? true,
  };
  const fullPayload = await getDigestData(supabase, ctx.organizationId);
  const payload = applySectionOptIns(fullPayload, sections);
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
