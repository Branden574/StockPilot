/**
 * Validates a user-controlled `?return=` value before using it as the
 * back-link target on detail / edit pages. Rejects anything that isn't a
 * same-origin dashboard path so the param can't be turned into an
 * open-redirect vector by a hostile link.
 *
 * Accepts: paths that, after decoding + trimming, begin with
 * `/dashboard/`. Anything else returns `null` — callers fall back to a
 * hardcoded default (`/dashboard/inventory` or `/dashboard/books`).
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2000) return null;

  // Decode once so percent-encoded escapes can't sneak past the
  // string-prefix check. A double-encoded payload (`%252F%252Fevil`)
  // decodes to `%2F%2Fevil`, which still doesn't start with
  // `/dashboard/` — so a single decode is enough.
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return null;
  }

  const lower = decoded.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('vbscript:')
  ) {
    return null;
  }

  if (decoded.includes('//')) {
    // Catches `//evil.com`, `http://evil.com/dashboard/...`, and
    // `/dashboard//evil.com`. Real list URLs never contain `//`.
    return null;
  }

  if (decoded.includes('\x00')) {
    // Null bytes can confuse downstream URL parsers and browsers
    // truncate at them in some contexts. A legitimate `?return=`
    // value will never contain one.
    return null;
  }

  if (!decoded.startsWith('/dashboard/')) {
    return null;
  }

  return decoded;
}
