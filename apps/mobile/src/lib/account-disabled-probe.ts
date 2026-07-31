/**
 * Deciding "am I disabled?" from a client, given that the server refuses to say.
 *
 * /api/v1 answers a disabled caller with the same uniform 401 an anonymous
 * caller gets, on purpose. So a 401 is only a PROMPT to ask GoTrue directly
 * (supabase.auth.getUser()), and only GoTrue's structured `user_banned` code is
 * accepted as proof. Anything else — a session that simply expired, an offline
 * device, a transient 500 — resolves to 'unknown' or 'unavailable' and never to
 * 'disabled', because showing the disabled screen to a working account is worse
 * than showing it late.
 */

export type AuthProbeResult = 'disabled' | 'active' | 'unknown' | 'unavailable';

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
  const status = res.error?.status;
  if (typeof status === 'number' && status >= 500) return 'unavailable';
  return 'unknown';
}
