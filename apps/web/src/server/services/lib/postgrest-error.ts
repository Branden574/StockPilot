/**
 * Server-log text for a failed PostgREST call.
 *
 * supabase-js builds `error` from the response BODY. When the body is empty (a
 * gateway answering 502 or 503 with nothing in it), `error.message` is the
 * empty string, and wrapping that in `ServiceError('internal_error', '')` left
 * `internalDetail` undefined: the log said only "An internal error occurred".
 * The status line is still on the result (`status`, `statusText`), so it is
 * used whenever the message is empty. A non-empty message is returned as it
 * is, so every existing log line and test keeps its text.
 *
 * For server logs only. `details` and `hint` can quote row values, so this
 * text never goes to a user; `ServiceError` keeps it in `internalDetail`.
 */

export type PostgrestLikeError = {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

export type PostgrestLikeStatus = {
  status?: number | null;
  statusText?: string | null;
};

export function postgrestErrorText(
  error: PostgrestLikeError,
  response: PostgrestLikeStatus = {},
): string {
  const message = (error.message ?? '').trim();
  if (message) return message;
  const parts: string[] = [];
  if (typeof response.status === 'number') {
    // status 0 is how postgrest-js reports a request that got no HTTP answer.
    parts.push(
      response.status === 0
        ? 'no HTTP response'
        : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    );
  }
  if (error.code) parts.push(`code ${error.code}`);
  if (error.details) parts.push(`details: ${error.details}`);
  if (error.hint) parts.push(`hint: ${error.hint}`);
  if (parts.length === 0) return 'PostgREST error with an empty message and no status';
  return `${parts.join(', ')} (empty error message)`;
}

/**
 * Whether a failed PostgREST call is a DEFINITE answer: the database raised
 * (a SQLSTATE such as P0001, 42501 or 55P03) or PostgREST refused (a PGRST
 * code). Either way the call's transaction did not commit. An error with
 * neither (a dropped connection, a gateway 502 or 504, a timeout) says
 * nothing about whether the statement ran and committed, and a caller that
 * must not guess (F1-5's escalation) treats it as unknown.
 */
export function isDefiniteRefusal(error: PostgrestLikeError | null | undefined): boolean {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[0-9A-Z]{5}$/.test(code) || /^PGRST\d{3}$/.test(code);
}

/**
 * Whether a failed PostgREST call was refused for a reason the same request
 * meets again, so trying it again cannot succeed (docket B82): the database
 * rejected the data (SQLSTATE class 22) or a constraint (class 23), or
 * PostgREST refused the request itself (PGRST1xx). Narrower than
 * isDefiniteRefusal on purpose: a serialization failure (40001), a deadlock
 * (40P01), a statement timeout (57014), a lost or refused connection (08xxx,
 * 53xxx) and PostgREST's own connection errors (PGRST000-003) are definite
 * answers too, but brief, and a retry is what they need. So, on this stack,
 * can class 42 and PGRST2xx/3xx be: a table or column missing while a
 * migration is pushed (42P01, PGRST202/204/205), a prepared statement under
 * transaction pooling (42P05), a credential refused while it changes
 * (PGRST300/301). They are not counted here.
 */
export function isPermanentRefusal(error: PostgrestLikeError | null | undefined): boolean {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^(22|23)[0-9A-Z]{3}$/.test(code) || /^PGRST1\d{2}$/.test(code);
}
