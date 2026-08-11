/**
 * Telemetry redaction for token-bearing URLs (security wave E, MED-1).
 *
 * GC 27 — never log a share token or a signed URL. Three separate URL
 * shapes in this app carry a live credential:
 *
 *   1. Supabase Storage signed URLs — the credential is the `?token=<jwt>`
 *      query parameter.
 *   2. Share links — `/m/<token>`, `/r/<token>`, `/i/<token>`,
 *      `/invite/<token>`, `/orders/sign/<token>`,
 *      `/returns/request/<token>`. The credential is the PATH SEGMENT, so
 *      stripping the query string alone is not enough.
 *   3. Auth links — `/auth/confirm?token_hash=…`, and Supabase
 *      `/auth/v1/verify?token=…` magic/recovery/invite links.
 *
 * Any of those can reach telemetry indirectly, which is why redaction lives
 * at the reporter layer rather than at each call site: a `fetch` /
 * `undici` / `next/image` failure puts the full request URL into
 * `error.message` and `error.stack`, and a webhook post ships both verbatim.
 * `posthog-provider.tsx` and `error.tsx` already guard the *pathname* they
 * beacon (fix wave I6); this closes the message/stack/extra half.
 *
 * Deliberately NOT a general secret scrubber. It redacts URL query strings,
 * URL fragments, credential path segments, and bare JWT-shaped strings.
 * Everything else — ids, org uuids, table names, file names — survives,
 * because an unreadable alert feed is its own outage.
 */

/**
 * Path prefixes whose NEXT segment is a bearer credential. Kept in sync with
 * the route folders under `apps/web/src/app` that take a `[token]` param,
 * plus Supabase's own storage-signing and auth-verify paths.
 */
const CREDENTIAL_PATH_PREFIXES: ReadonlyArray<string> = [
  'm',
  'r',
  'i',
  'invite',
  'returns/request',
  'orders/sign',
];

const REDACTED = '[redacted]';

/**
 * Minimum length for a path segment to be treated as a credential. Every
 * token-bearing column in this schema is CHECK-constrained to `length(token)
 * between 16 and 128` (migrations 0261, 0314) and every minted token is 64
 * hex chars, so 12 is comfortably below the floor while keeping the real,
 * non-credential sibling routes under the same prefixes readable in the
 * alert feed (`/r/track`, `/r/confirm`, `/m/<tok>/photo` — the `photo`
 * segment is never a credential).
 */
const MIN_CREDENTIAL_SEGMENT_LEN = 12;

/** A JWT — Supabase signed-URL tokens, access tokens, `token_hash` values. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

/**
 * Absolute URL, or a root-relative path that starts with a credential
 * prefix. Stops at whitespace and at the characters that normally delimit a
 * URL inside a log line or a stack frame.
 */
const URL_RE = /(?:https?:\/\/|\/)[^\s"'`<>()[\]{}\\,;]*/g;

/** Redacts the query + fragment + credential path segment of ONE url-ish token. */
function redactOneUrl(raw: string): string {
  // Split off query/fragment by hand: `raw` may be a relative path, and it
  // may be malformed (a truncated stack frame), so `new URL()` is not safe
  // to rely on for the path half.
  const hashAt = raw.indexOf('#');
  const withoutHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const hadHash = hashAt !== -1 && hashAt < raw.length - 1;

  const qAt = withoutHash.indexOf('?');
  const beforeQuery = qAt === -1 ? withoutHash : withoutHash.slice(0, qAt);
  const hadQuery = qAt !== -1 && qAt < withoutHash.length - 1;

  const redactedPath = redactCredentialSegments(beforeQuery);
  return (
    redactedPath +
    (hadQuery ? `?${REDACTED}` : '') +
    (hadHash ? `#${REDACTED}` : '')
  );
}

/**
 * Replaces the segment that FOLLOWS a credential prefix. Works on both
 * absolute URLs (`https://host/m/<tok>/photo/0`) and root-relative paths
 * (`/m/<tok>`), and on Supabase's storage-signing path shape
 * (`/storage/v1/object/sign/<bucket>/<path>` — the path itself is not the
 * credential, but the `?token=` we already dropped was).
 */
function redactCredentialSegments(pathish: string): string {
  const schemeAt = pathish.indexOf('://');
  let origin = '';
  let path = pathish;
  if (schemeAt !== -1) {
    const slashAt = pathish.indexOf('/', schemeAt + 3);
    if (slashAt === -1) return pathish; // origin only — nothing to redact
    origin = pathish.slice(0, slashAt);
    path = pathish.slice(slashAt);
  }

  const segments = path.split('/');
  // segments[0] is '' for a leading slash. Compare joined prefixes so
  // multi-segment prefixes ('orders/sign') match too.
  for (const prefix of CREDENTIAL_PATH_PREFIXES) {
    const parts = prefix.split('/');
    for (let i = 1; i + parts.length < segments.length; i++) {
      const window = segments.slice(i, i + parts.length).join('/');
      if (window !== prefix) continue;
      const credentialIndex = i + parts.length;
      const candidate = segments[credentialIndex];
      if (candidate && candidate.length >= MIN_CREDENTIAL_SEGMENT_LEN) {
        segments[credentialIndex] = REDACTED;
      }
    }
  }
  return origin + segments.join('/');
}

/**
 * Strips credentials out of an arbitrary log/telemetry string: every URL's
 * query string and fragment, every credential path segment, and every bare
 * JWT. Returns the input unchanged when there is nothing to redact.
 */
export function redactTokens(input: string): string {
  if (!input) return input;
  return input.replace(URL_RE, redactOneUrl).replace(JWT_RE, REDACTED);
}

/** `redactTokens` for a value of unknown type; non-strings pass through. */
export function redactTokensDeep<T>(value: T): T {
  if (typeof value === 'string') return redactTokens(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactTokensDeep) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactTokensDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
