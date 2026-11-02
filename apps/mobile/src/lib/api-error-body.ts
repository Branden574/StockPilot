/**
 * Reading a refused request's body, and the sentence for a status, shared by
 * api() and the AI chat (lib/ai-chat.ts), which posts with fetch itself to
 * read the route's stream. One copy, so the two never read a refusal two ways
 * (recurring pattern 26). api-errors.test.ts runs both.
 *
 * Dependency-free on purpose: no React Native or Expo import, so it loads
 * under vitest, and under the tests that mock ./api.
 */

export interface ErrorBody {
  /** The body's `message`, when it is text. Shown to a person. */
  message: string | null;
  /**
   * The body's `error`, when it is text: a machine code on most routes, so
   * never a sentence for a person (ApiError.code says why).
   */
  code: string | undefined;
  /** The body's `details`, uninspected: its shape is the caller's business. */
  details: unknown;
}

/**
 * The parts of our JSON error shape, `{ error, message, details }`.
 *
 * NEVER the raw body. Anything that does not reach a route handler (a 404
 * from the framework, an edge or bot challenge, a proxy error page) answers
 * with an HTML document, which was put on screen where a sentence belonged
 * (the staging screen, simulator 2026-07-22). A body is read only when it
 * parses as our JSON; anything else reads as nothing.
 */
export function readErrorBody(raw: string): ErrorBody {
  let message: string | null = null;
  let code: string | undefined;
  let details: unknown;
  if (raw.trimStart().startsWith('{')) {
    try {
      const body = JSON.parse(raw) as {
        message?: unknown;
        error?: unknown;
        details?: unknown;
      };
      message = typeof body.message === 'string' ? body.message : null;
      code = typeof body.error === 'string' ? body.error : undefined;
      details = body.details;
    } catch {
      message = null;
    }
  }
  return { message, code, details };
}

/** What to say when the body said nothing a person can act on. */
export function statusSentence(status: number): string {
  return status === 401 || status === 403
    ? 'You do not have access to that.'
    : status === 404
      ? 'That is not available on this version of the app. Update the app and try again.'
      : status >= 500
        ? 'The server had a problem. Try again in a moment.'
        : `Request failed (${status}).`;
}
