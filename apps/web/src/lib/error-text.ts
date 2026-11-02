/**
 * The text an error report carries for a value that is not an Error (docket
 * C21). One rule for the reporter (error-reporter-core.ts), rawErrorText
 * (server/services/lib/fetch-by-ids.ts) and API routes' internalErrorResponse
 * (server/lib/api-error-response.ts). Also the message the reporter gives an
 * internal error (reportedMessage, below).
 *
 * supabase-js hands back a failed call's `error` as a plain object
 * (postgrest-js builds it from the response body, or from the fetch failure
 * when no answer came); it throws an Error only after .throwOnError(), which
 * nothing here calls. String() of that object is "[object Object]", so the
 * alert and the log line lost the database's reason and code.
 *
 * Kept: the message, a `code` that is a short token, any `hint` (migrations
 * raise hints as codes or fixed sentences, and Postgres and PostgREST hints
 * name objects and give advice), and, for postgrest-js's own shape for a
 * request that got no answer (code ''), the first "Caused by:" line of
 * `details`, which the library builds from the fetch error (never the cause's
 * stack below it).
 *
 * Never kept: a server error's `details`. A unique or check violation quotes
 * the row's values there ("Key (email)=(...) already exists.", "Failing row
 * contains (...)"), and the RPCs receive names, emails, phone numbers and
 * signature images. The message already names the constraint or column.
 *
 * Each piece is redacted (redact-urls.ts) BEFORE it is cut to length, so a cut
 * can never leave part of a credential that redaction would no longer match.
 *
 * Isomorphic, no directive: the core reaches browser bundles through the error
 * boundaries and the browser Supabase client's URL guard. Imports only
 * redact-urls.ts, so every module that reports can use it, including the many
 * tests that mock '@/lib/error-reporter' with reportError alone.
 */

import { redactTokens } from './redact-urls';

const MESSAGE_MAX = 500;
const PART_MAX = 200;
const CODE_RE = /^[A-Za-z0-9_]{1,32}$/;
const CAUSE_PREFIX = 'Caused by: ';

/** The text for a value that has neither a message nor a text of its own. */
export const NO_MESSAGE_TEXT = 'Non-Error object with no message';

/** Redact first, then cut: a cut can never leave part of a credential behind. */
function clip(text: string, max: number): string {
  const redacted = redactTokens(text);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

/** postgrest-js's network-failure details: the first "Caused by:" line only. */
function causeOf(details: unknown): string | null {
  if (typeof details !== 'string') return null;
  const line = details.split('\n').find((l) => l.startsWith(CAUSE_PREFIX));
  const cause = line?.slice(CAUSE_PREFIX.length).trim();
  return cause ? cause : null;
}

/**
 * The text for anything that is not an Error. An object with a string
 * `message` gives the message, then its code, hint and network cause in
 * parentheses; any other object its own String() when that is not "[object
 * Object]", else NO_MESSAGE_TEXT with up to ten of its keys; anything else its
 * String(). Never throws (String() of an object with no prototype does).
 */
export function nonErrorText(value: unknown): string {
  try {
    if (value !== null && typeof value === 'object') {
      const { message, code, hint, details } = value as Record<string, unknown>;
      if (typeof message === 'string') {
        const parts: string[] = [];
        if (typeof code === 'string' && CODE_RE.test(code)) parts.push(`code ${code}`);
        if (typeof hint === 'string' && hint.trim()) {
          parts.push(`hint: ${clip(hint.trim(), PART_MAX)}`);
        }
        if (code === '') {
          const cause = causeOf(details);
          if (cause) parts.push(`cause: ${clip(cause, PART_MAX)}`);
        }
        const text = message.trim() ? clip(message.trim(), MESSAGE_MAX) : '(empty error message)';
        return parts.length ? `${text} (${parts.join('; ')})` : text;
      }
      let plain: string | null = null;
      try {
        plain = String(value);
      } catch {
        plain = null;
      }
      if (plain && plain !== '[object Object]') return clip(plain, MESSAGE_MAX);
      const keys = Object.keys(value).slice(0, 10);
      return keys.length ? `${NO_MESSAGE_TEXT} (keys: ${keys.join(', ')})` : NO_MESSAGE_TEXT;
    }
    return clip(String(value), MESSAGE_MAX);
  } catch {
    return NO_MESSAGE_TEXT;
  }
}

/** An Error as it is; anything else as a new Error with nonErrorText's text. */
export function asReportableError(value: unknown): Error {
  return value instanceof Error ? value : new Error(nonErrorText(value));
}

/**
 * The message a report carries for an Error. A ServiceError('internal_error')
 * says only "An internal error occurred. Please try again." and keeps the
 * database's text in `internalDetail`, retained server-side for logging (S13):
 * that text, redacted and cut to 500 characters. Read by its shape, because
 * this module is isomorphic and cannot import server/services/context.ts; only
 * ServiceError has the field. Any other Error: its message.
 */
export function reportedMessage(error: Error): string {
  const detail = (error as { internalDetail?: unknown }).internalDetail;
  return typeof detail === 'string' && detail.trim()
    ? clip(detail.trim(), MESSAGE_MAX)
    : error.message;
}
