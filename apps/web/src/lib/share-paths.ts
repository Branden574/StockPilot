/**
 * Routes that carry a raw, unauthenticated credential IN THE URL PATH:
 *
 *   /m/<token>                 maintenance request share links
 *   /r/<token>                 public order-request links (migration 0261)
 *   /i/<token>                 item share links
 *   /invite/<token>            organization invitations
 *   /orders/sign/<token>       order signature links
 *   /returns/request/<token>   return request links
 *
 * Anything that logs, forwards, or beacons the current pathname (product
 * analytics, crash reporting) must leave these alone: GC 27, never log a share
 * token or signed URL.
 *
 * ONE LIST, on purpose. This file used to name only `/m/` and `/r/` while
 * `redact-urls.ts` named all six, so analytics and the error beacon sent the
 * other four tokens out verbatim once PostHog was switched on in production.
 * `redact-urls.ts` now imports `CREDENTIAL_PATH_PREFIXES` from here, and
 * `share-paths.test.ts` walks `src/app` for every `[token]` route folder and
 * fails when one is missing from this list. A new token route cannot be
 * forgotten silently again.
 */

/** No leading or trailing slash; the segment after each of these is a bearer credential. */
export const CREDENTIAL_PATH_PREFIXES: ReadonlyArray<string> = [
  'm',
  'r',
  'i',
  'invite',
  'returns/request',
  'orders/sign',
];

export const SHARE_PATH_PREFIXES: ReadonlyArray<string> = CREDENTIAL_PATH_PREFIXES.map(
  (prefix) => `/${prefix}/`,
);

export function isSharePath(pathname: string | null | undefined): boolean {
  return !!pathname && SHARE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
