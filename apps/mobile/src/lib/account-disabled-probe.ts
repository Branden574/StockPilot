/**
 * Deciding "am I disabled?" from a client, given that the server refuses to say.
 *
 * /api/v1 answers a disabled caller with the same uniform 401 an anonymous
 * caller gets, on purpose. So a 401 is only a PROMPT to ask GoTrue directly
 * (supabase.auth.getUser()), and only GoTrue's structured `user_banned` code is
 * accepted as proof. Anything else — an offline device, a transient 500 —
 * resolves to 'unknown' or 'unavailable' and never to 'disabled', because
 * showing the disabled screen to a working account is worse than showing it
 * late.
 *
 * THE FOURTH ANSWER, and the one the first cut of this module was missing.
 * A platform disable REVOKES the user's sessions, so by the time any device
 * probes, its own `auth.sessions` row is gone and GoTrue answers
 * `session_not_found` — or, once the access token lapses and gotrue-js tries to
 * refresh, `refresh_token_not_found`, because `auth.refresh_tokens.session_id`
 * cascades on that delete. `user_banned` is therefore UNREACHABLE on this path,
 * by construction, and folding these codes into 'unknown' ("change nothing")
 * meant the app kept a dead session and drifted to the marketing screen with
 * the disabled state never detected at all.
 *
 * 'signed-out' is a definite answer to a DIFFERENT question: your session is
 * gone. It says nothing about the account — an ordinary sign-out-everywhere
 * from another device produces exactly the same code — so it justifies a local
 * sign-out and the sign-in screen, and nothing more. The truth is available one
 * step later: GoTrue answers `user_banned` to a disabled user's password grant
 * even though it will not answer their probe.
 */

export type AuthProbeResult = 'disabled' | 'active' | 'signed-out' | 'unknown' | 'unavailable';

/**
 * GoTrue's structured codes for "the session behind this token is gone".
 *
 * Codes only, never free text: GoTrue's sentences are not ours and change
 * between releases. `session_expired` is included because it is the same
 * outcome reached by a different route (a session that aged out rather than one
 * that was deleted), and the response — sign out, ask for a sign-in — is
 * identical.
 */
const SESSION_GONE_CODES = new Set([
  'session_not_found',
  'session_expired',
  'refresh_token_not_found',
]);

/** Whether a failed request justifies spending one getUser() round trip. */
export function shouldProbeAfterFailure(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 401;
}

/**
 * Classifies a supabase.auth.getUser() result.
 *
 * 'unavailable' is the mobile twin of the web guard's `unreadable` status: the
 * identity server was reached and answered with its own failure, so the account
 * status is UNKNOWN-and-the-server's-fault. It denies, but it is worded as
 * transient — never with the disabled copy.
 */
export function classifyAuthProbe(
  res:
    | {
        data?: { user?: unknown } | null;
        // `message` is accepted so a real AuthError type-checks, and is then
        // deliberately never read: a ban is never inferred from free text.
        error?: { code?: unknown; status?: unknown; message?: unknown } | null;
      }
    | null
    | undefined,
): AuthProbeResult {
  if (!res) return 'unknown';
  // A confirmed ban outranks everything, including a 5xx envelope.
  if (res.error?.code === 'user_banned') return 'disabled';
  if (res.data?.user) return 'active';
  // Ranked BELOW a resolving user, so a stale error alongside a live user never
  // signs a working device out, and below a ban, so a revoked-and-banned user
  // still gets the better answer if GoTrue ever offers it.
  if (typeof res.error?.code === 'string' && SESSION_GONE_CODES.has(res.error.code)) {
    return 'signed-out';
  }
  const status = res.error?.status;
  if (typeof status === 'number' && status >= 500) return 'unavailable';
  return 'unknown';
}
