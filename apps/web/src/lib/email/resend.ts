import 'server-only';

import { env } from '@/lib/env';

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Sends transactional email via Resend if RESEND_API_KEY is set.
 * If not, logs to console and returns ok=true so dev flows still work
 * end-to-end even before email is wired up.
 */
export async function sendEmail({ to, subject, html, text }: SendEmailInput): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    console.info('[email] (dry-run, no RESEND_API_KEY) →', { to, subject });
    console.info('[email] Body:\n', text ?? html);
    return { ok: true, id: 'dryrun' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL,
        to,
        subject,
        html,
        text,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('[email] Resend error', res.status, body);
      return { ok: false, error: body };
    }

    const data = (await res.json()) as { id?: string };
    return { ok: true, id: data.id };
  } catch (e) {
    console.error('[email] Resend threw', e);
    return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
  }
}
