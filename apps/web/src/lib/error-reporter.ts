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
 *
 * CREDENTIAL REDACTION (security wave E, MED-1): every string that leaves
 * this module — the console line AND the webhook body — goes through
 * `redactTokens` first. Callers cannot be relied on to sanitize, because the
 * leak is usually indirect: a failed `fetch`/`undici`/`next-image` request
 * embeds the full URL (Supabase signed URL with its `?token=<jwt>`, an
 * `/m/<token>` share link) in `error.message` and `error.stack`, and both
 * were previously shipped verbatim. GC 27 — never log a share token or a
 * signed URL.
 */

import { redactTokens, redactTokensDeep } from './redact-urls';

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
 * Next.js implements redirect()/notFound() by THROWING marker errors whose
 * `digest` names the intent (e.g. "NEXT_REDIRECT;push;/signin;307;"). They
 * are control flow, not failures — a catch block that funnels everything
 * into reportError would page the alerts channel every time a signed-out
 * session hits a guarded route (exactly the 2026-07-07 "audit.write_failed"
 * / "inventory.export" false alarms). Callers that can should
 * `unstable_rethrow(e)` before reporting; this filter is the backstop.
 */
export function isNextControlFlowError(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return (
    typeof digest === 'string' &&
    (digest.startsWith('NEXT_REDIRECT') ||
      digest === 'NEXT_NOT_FOUND' ||
      digest.startsWith('NEXT_HTTP_ERROR_FALLBACK') ||
      digest.startsWith('BAILOUT_TO_CLIENT_SIDE_RENDERING'))
  );
}

/**
 * Reports an error. Always console.errors; additionally posts to the
 * webhook if configured. Best-effort — never throws to the caller.
 */
export async function reportError(
  err: unknown,
  context: ErrorContext,
): Promise<void> {
  if (isNextControlFlowError(err)) {
    // One quiet line for traceability; no console.error, no webhook.
    console.info(
      `[error-reporter] skipped control-flow ${(err as { digest?: string }).digest} at ${context.tag}`,
    );
    return;
  }
  const error = err instanceof Error ? err : new Error(String(err));
  const payload: ReportPayload = {
    ts: new Date().toISOString(),
    env: getEnv(),
    app: 'stockpilot-web',
    tag: context.tag,
    level: context.level ?? 'error',
    // MED-1: message/stack routinely carry the URL of whatever request
    // failed. Redact before the value is stored on the payload at all, so
    // there is no un-redacted copy for a later edit to accidentally ship.
    message: redactTokens(error.message),
    stack: error.stack ? redactTokens(error.stack) : null,
    digest: (error as Error & { digest?: string }).digest ?? null,
    extra: redactTokensDeep({
      organizationId: context.organizationId ?? null,
      userIdHash: context.userIdHash ?? null,
      ...(context.extra ?? {}),
    }) as Record<string, unknown>,
  };

  // Always log so we don't lose the trace even when the webhook fails.
  // The redacted message + stack, never the raw Error: console.error(err)
  // prints `err.stack`, which is exactly where a signed URL hides.
  console.error(
    `[error] ${context.tag}`,
    payload.message,
    payload.stack ?? '',
    payload.extra,
  );

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
          `*${payload.level.toUpperCase()} — ${payload.tag}* (${payload.env})\n` +
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
