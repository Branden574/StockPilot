/**
 * Route TEMPLATES for performance telemetry.
 *
 * A performance event must say WHERE it happened without saying WHAT the
 * person was looking at. `/dashboard/inventory/3f2c…` names an item;
 * `/dashboard/inventory/[id]` names a screen. Only the second may leave the
 * browser (owner rule, performance program 2026-09: no SKUs, names, emails,
 * search terms or credentials in telemetry).
 *
 * SAFE BY DEFAULT, not a blocklist. A segment survives only when it has the
 * shape of a route FOLDER in this app: lowercase letters and hyphens, at most
 * 40 characters. Everything else (uuids, numbers, tokens, anything with a
 * digit, an uppercase letter, a dot, an `@`, a percent-escape) becomes a
 * placeholder. A new dynamic route is therefore templated correctly without
 * anyone remembering to register it here; the failure mode of a new STATIC
 * folder with a digit in its name is a harmless `[id]`.
 *
 * The query string and the fragment are always dropped, and dropped FIRST:
 * that is where search terms and filters live, and a `?return=https://…`
 * inside one must never be mistaken for the URL being templated.
 */

/** Same list as `redact-urls.ts`: the NEXT segment after these is a bearer credential. */
const CREDENTIAL_PREFIXES: ReadonlyArray<ReadonlyArray<string>> = [
  ['m'],
  ['r'],
  ['i'],
  ['invite'],
  ['returns', 'request'],
  ['orders', 'sign'],
];

const STATIC_SEGMENT_RE = /^[a-z][a-z-]{0,39}$/;
/** A scheme counts only at the very start: `https://host/…`, never one quoted later in the string. */
const LEADING_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function followsCredentialPrefix(segments: ReadonlyArray<string>, index: number): boolean {
  return CREDENTIAL_PREFIXES.some((prefix) => {
    if (index !== prefix.length) return false;
    return prefix.every((part, i) => segments[i] === part);
  });
}

/**
 * Turns a pathname (or a full URL, or a path with a query) into its template.
 * Never throws: telemetry must not break a page. Unparseable input is `/[unknown]`.
 */
export function toRouteTemplate(input: string | null | undefined): string {
  if (typeof input !== 'string' || input.length === 0) return '/[unknown]';

  // 1. Query and fragment go first, so nothing inside them can be read as structure.
  const cut = input.search(/[?#]/);
  let path = cut === -1 ? input : input.slice(0, cut);

  // 2. Strip `scheme://authority` or a protocol-relative `//authority`. The
  //    authority (host, port, userinfo) is never part of a template.
  const scheme = LEADING_SCHEME_RE.exec(path);
  if (scheme || path.startsWith('//')) {
    const authorityStart = scheme ? scheme[0].length : 2;
    const slashAt = path.indexOf('/', authorityStart);
    path = slashAt === -1 ? '/' : path.slice(slashAt);
  }
  if (!path.startsWith('/')) return '/[unknown]';

  const segments = path.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return '/';

  const out = segments.map((segment, index) => {
    // A credential slot is a placeholder even when the value happens to look
    // like a folder name (`/r/track` is a real sibling route, but it carries
    // nothing worth distinguishing in a performance chart).
    if (followsCredentialPrefix(segments, index)) return '[token]';
    return STATIC_SEGMENT_RE.test(segment) ? segment : '[id]';
  });
  return `/${out.join('/')}`;
}
