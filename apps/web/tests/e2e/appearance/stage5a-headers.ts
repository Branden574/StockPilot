/**
 * Headers parity of plan 8.5 ("CSP and security headers byte-identical
 * before and after (curl against the lab server)"), pure, for
 * headers-parity.spec.ts; the unit test is src/test/stage5a-headers.test.ts.
 *
 * A response's headers become sorted `name: value` lines, after:
 *  - dropping what differs between any two answers of one server: Date, Age,
 *    ETag, Last-Modified, Content-Length, Transfer-Encoding, Connection,
 *    Keep-Alive, Server-Timing, request ids, and Next's cache state
 *    (x-nextjs-cache: HIT, STALE or MISS depends on timing);
 *  - writing every CSP nonce `'nonce-<n>'` (a fresh one per response), in
 *    either CSP header, and an x-nonce header's value `<n>`;
 *  - writing a build's hashed static paths (/_next/static/...) in a Link
 *    header `/_next/static/<asset>`: B and the branch are two builds;
 *  - reducing each Set-Cookie to its name and attributes, without its value,
 *    Expires or Max-Age (a session cookie's value is new on every refresh).
 * Repeated headers (Playwright joins them with a newline) keep their order.
 *
 * SECURITY_HEADERS are the ones held strictly in every case; the full set is
 * held where both servers answer with the same page (Classic on both).
 */

export const SECURITY_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'x-dns-prefetch-control',
  'x-xss-protection',
  'x-permitted-cross-domain-policies',
  'origin-agent-cluster',
  'cache-control',
  'vary',
  'x-robots-tag',
] as const;

const VOLATILE = new Set([
  'date',
  'age',
  'etag',
  'last-modified',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'server-timing',
  'x-request-id',
  'x-invocation-id',
  'x-vercel-id',
  'x-nextjs-cache',
]);

const NONCE = /'nonce-[A-Za-z0-9+/=_-]+'/gu;

function normaliseCookie(line: string): string {
  const [pair, ...attributes] = line.split(';').map((part) => part.trim());
  const name = (pair ?? '').split('=')[0] ?? '';
  const kept = attributes
    .filter((a) => !/^(expires|max-age)=/iu.test(a))
    .map((a) => a.toLowerCase())
    .sort();
  return [name, ...kept].join('; ');
}

function normaliseValue(name: string, value: string): string {
  if (name === 'content-security-policy' || name === 'content-security-policy-report-only') {
    return value.replace(NONCE, "'nonce-<n>'");
  }
  if (name === 'x-nonce') return '<n>';
  if (name === 'link')
    return value.replace(/\/_next\/static\/[^>;,\s]+/gu, '/_next/static/<asset>');
  if (name === 'set-cookie') {
    return value.split('\n').map(normaliseCookie).sort().join('\n');
  }
  return value;
}

/** The response's headers as comparable lines (only `only` names when given). */
export function normaliseHeaders(
  headers: Record<string, string>,
  only?: readonly string[],
): string[] {
  const out: string[] = [];
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (VOLATILE.has(name)) continue;
    if (only && !only.includes(name)) continue;
    out.push(`${name}: ${normaliseValue(name, value)}`);
  }
  return out.sort();
}

/** Lines only one side has, each marked with its side. */
export function diffHeaderLines(before: readonly string[], after: readonly string[]): string[] {
  const a = new Set(before);
  const b = new Set(after);
  return [
    ...[...a].filter((line) => !b.has(line)).map((line) => `B only:      ${line}`),
    ...[...b].filter((line) => !a.has(line)).map((line) => `branch only: ${line}`),
  ];
}
