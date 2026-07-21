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
  /**
   * RFC-5322 sender ("Name <addr>"). Defaults to RESEND_FROM_EMAIL.
   * The es registry senders (security@/orders@/rentals@/... on
   * stockpilotusa.com) ride the same domain-verified Resend config —
   * Resend accepts any sender on the verified domain.
   */
  from?: string;
  /**
   * Explicit Reply-To, forwarded as Resend's `reply_to` field. When
   * set, it REPLACES the default Reply-To header this module would
   * otherwise inject (e.g. support-ticket notifications set it to the
   * customer's address so a direct reply starts the thread).
   */
  replyTo?: string | string[];
  /**
   * Extra RFC-822 headers to attach to the message. Resend forwards
   * these to the recipient verbatim. Common uses:
   *   - `List-Unsubscribe`: `<https://app.example/api/unsubscribe?...>`
   *   - `List-Unsubscribe-Post`: `List-Unsubscribe=One-Click`
   * Keep header names valid (token chars only) and values short — Resend
   * rejects very long header values.
   */
  headers?: Record<string, string>;
}

interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Pull the bare email address out of an RFC-5322 `Name <addr>` value,
 * or pass through a bare address. Used for the Reply-To default.
 */
function extractAddress(fromValue: string | null | undefined): string | null {
  if (!fromValue) return null;
  const match = fromValue.match(/<([^>]+)>/);
  if (match && match[1]) return match[1].trim();
  const bare = fromValue.trim();
  return bare.includes('@') ? bare : null;
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
  from,
  replyTo,
  headers,
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
    const effectiveFrom = from ?? env.RESEND_FROM_EMAIL;

    // Reply-To is a small but real deliverability signal — Microsoft 365
    // and Google Workspace both score messages slightly higher when
    // Reply-To is set to a deliverable address on the sending domain.
    // Precedence: an explicit `replyTo` option wins (sent as Resend's
    // reply_to field, no header injected); otherwise a caller-supplied
    // Reply-To header wins; otherwise we default the header to the
    // effective from address, extracted out of "Name <email>" if
    // present. Tests / dev envs without a real FROM just skip it.
    const finalHeaders: Record<string, string> = { ...(headers ?? {}) };
    if (!replyTo) {
      const fromAddress = extractAddress(effectiveFrom);
      if (fromAddress && !finalHeaders['Reply-To'] && !finalHeaders['reply-to']) {
        finalHeaders['Reply-To'] = fromAddress;
      }
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: effectiveFrom,
        to,
        subject,
        html,
        text,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(Object.keys(finalHeaders).length > 0 ? { headers: finalHeaders } : {}),
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
