import 'server-only';

import { env } from '@/lib/env';

export interface EmailAttachment {
  /** Filename as it should appear in the recipient's mail client. */
  filename: string;
  /** Base64-encoded file contents (no `data:` prefix). */
  content: string;
}

interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
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
 *
 * `to` accepts a string or an array of addresses; the Resend API handles
 * both natively. `attachments` is forwarded as-is in the JSON body (Resend
 * expects `{ filename, content }` with base64 content).
 */
export async function sendEmail({
  to,
  subject,
  html,
  text,
  attachments,
}: SendEmailInput): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    // Dry-run logging on staging / dev. Don't log the body — the
    // body contains recipient PII (full name, request lines, denial
    // reasons) and any log drain configured on the deployment would
    // otherwise capture it. The `to` and `subject` are sufficient for
    // dev observability.
    console.info('[email] (dry-run, no RESEND_API_KEY) →', {
      to,
      subject,
      attachmentCount: attachments?.length ?? 0,
    });
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
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
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
