/**
 * Reads the `session_id` claim out of this tab's own access token so the
 * revocation listener can tell whether a "revoked" broadcast is about THIS
 * device. The token is NOT verified here and nothing is authorized with the
 * result: the server already revoked the session; this only decides whether
 * this tab should drop its local copy live instead of at token expiry.
 *
 * Browser-safe on purpose. The old code used Buffer.from(seg, 'base64url'),
 * which works under Node but not in the client bundle: Next ships the `buffer`
 * polyfill there, and its isEncoding() does not know 'base64url', so it threw,
 * the id stayed null, and no broadcast ever matched ("Sign out this device"
 * left a web tab streaming until its token expired).
 */
export function decodeBase64UrlUtf8(segment: string): string {
  // URL-safe alphabet back to the standard one, then restore the padding JWTs
  // strip (atob's forgiving decode would accept it bare; padding keeps this
  // correct for any strict decoder). A length of 1 mod 4 is not valid base64
  // and atob throws on it.
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // fatal: a payload that is not valid UTF-8 is not a token we issued.
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** The session_id claim of an access token, or null if it cannot be read. */
export function sessionIdFromAccessToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    const payload = JSON.parse(decodeBase64UrlUtf8(segment)) as { session_id?: unknown };
    return typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : null;
  } catch {
    return null;
  }
}
