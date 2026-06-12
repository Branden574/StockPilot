/**
 * Minimal vendor-agnostic error reporter. Posts a structured payload to
 * ERROR_WEBHOOK_URL (Slack incoming webhook, a custom endpoint, etc.) when
 * configured; otherwise falls back to console.error. Drop-in compatible
 * with future Sentry adoption — wherever Sentry.captureException would
 * go, call reportError() and replace the implementation later.
 *
 * Designed for:
 *   • Server: action errors, RPC failures, unexpected exceptions
 *   • Client: errors caught in error boundaries
 *
 * No PII fields by convention — pass only the error + a tag/context map
 * you'd be comfortable seeing in a generic webhook.
 */

export interface ErrorContext {
  /** Where the error happened, e.g. "po-imports.approve" */
  tag: string;
  /** Free-form key/value extras. Keep small + non-PII. */
  extra?: Record<string, string | number | boolean | null | undefined>;
  /** Sentry-style severity. */
  level?: 'error' | 'warning' | 'info';
  /** Hashed/anon user identifier if available. */
  userIdHash?: string | null;
  /** Org id if available. */
  organizationId?: string | null;
}

interface ReportPayload {
  ts: string;
  env: string;
  app: 'stockpilot-web';
  tag: string;
  level: 'error' | 'warning' | 'info';
  message: string;
  stack: string | null;
  digest: string | null;
  extra: Record<string, unknown>;
}

function getWebhookUrl(): string | null {
  if (typeof process === 'undefined') return null;
  return process.env.ERROR_WEBHOOK_URL || null;
}

function getEnv(): string {
  if (typeof process !== 'undefined' && process.env.VERCEL_ENV) {
    return process.env.VERCEL_ENV;
  }
  if (typeof process !== 'undefined' && process.env.NODE_ENV) {
    return process.env.NODE_ENV;
  }
  return 'unknown';
}

/**
 * Reports an error. Always console.errors; additionally posts to the
 * webhook if configured. Best-effort — never throws to the caller.
 */
export async function reportError(
  err: unknown,
  context: ErrorContext,
): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  const payload: ReportPayload = {
    ts: new Date().toISOString(),
    env: getEnv(),
    app: 'stockpilot-web',
    tag: context.tag,
    level: context.level ?? 'error',
    message: error.message,
    stack: error.stack ?? null,
    digest: (error as Error & { digest?: string }).digest ?? null,
    extra: {
      organizationId: context.organizationId ?? null,
      userIdHash: context.userIdHash ?? null,
      ...(context.extra ?? {}),
    },
  };

  // Always log so we don't lose the trace even when the webhook fails.
  console.error(`[error] ${context.tag}`, error, payload.extra);

  const url = getWebhookUrl();
  if (!url) return;

  // Slack/Teams incoming webhooks reject arbitrary JSON (Slack 400s on
  // unknown fields) — they want `{text}`. Detect them so pointing
  // ERROR_WEBHOOK_URL at a #alerts channel "just works"; any other endpoint
  // gets the full structured payload.
  const isChatWebhook =
    url.includes('hooks.slack.com') || url.includes('webhook.office.com');
  const body = isChatWebhook
    ? JSON.stringify({
        text:
          `*🔥 ${payload.level.toUpperCase()} — ${payload.tag}* (${payload.env})\n` +
          `${payload.message}` +
          (payload.digest ? `\ndigest: \`${payload.digest}\`` : '') +
          (payload.stack ? `\n\`\`\`${payload.stack.slice(0, 1500)}\`\`\`` : ''),
      })
    : JSON.stringify(payload);

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // Don't keep the request alive past 2s so a slow webhook doesn't
      // block the Edge runtime / SSR rendering pipeline.
      signal: AbortSignal.timeout(2000),
    });
  } catch (postErr) {
    console.error('[error-reporter] webhook post failed', postErr);
  }
}
