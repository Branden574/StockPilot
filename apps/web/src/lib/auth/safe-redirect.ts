/**
 * The single same-origin redirect sanitizer for the auth flow.
 *
 * There used to be four near-identical copies of this function — in
 * `components/auth/sign-in-form.tsx`, `components/auth/mfa-challenge-form.tsx`,
 * `app/auth/callback/route.ts` and `app/auth/confirm/route.ts` — and they did
 * NOT agree. The two route handlers rejected `/\evil.com`; the two form
 * components did not, so the most-travelled path in the whole app (sign in with
 * `?redirect=`) was the weakest one. `auth/callback/route.ts` documents why that
 * matters: `//evil.com` and `/\evil.com` are both resolved as PROTOCOL-RELATIVE
 * URLs by real clients (Chrome, `curl -L`), which handed a phishing landing page
 * control over where a freshly-signed-in user lands.
 *
 * Fixing one copy is not a fix. One implementation, imported by all four.
 *
 * Pure and dependency-free on purpose: this is imported by client components, so
 * it must not drag anything server-only into the browser bundle.
 */

/** Where every rejected or absent destination goes. */
export const DEFAULT_APP_PATH = '/dashboard';

/**
 * Reduce an untrusted `?redirect=` / `?next=` value to a path that cannot leave
 * this origin. Returns `fallback` for anything it will not vouch for.
 *
 * Accepts only a path beginning with a single `/`. Rejects absolute URLs
 * (`https://evil.com`), scheme-relative URLs (`//evil.com`), the backslash
 * variant browsers normalise into one (`/\evil.com`), and anything that becomes
 * one of those once the browser strips the characters it ignores.
 */
export function safeRedirectPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_APP_PATH,
): string {
  if (!raw) return fallback;

  // Browsers strip TAB / LF / CR out of a URL before resolving it, so a value
  // like "/\t/evil.com" reaches the network stack as "//evil.com". Validate what
  // the browser will actually act on, not the raw string.
  const cleaned = raw.replace(/[\t\n\r]/g, '');

  if (!cleaned.startsWith('/')) return fallback;

  // Second character decides it: either slash makes the rest an authority, not
  // a path. "/" alone is same-origin and fine.
  const second = cleaned[1];
  if (second === '/' || second === '\\') return fallback;

  return cleaned;
}
