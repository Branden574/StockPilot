/**
 * Path prefixes that carry a raw, unauthenticated credential IN THE URL
 * itself — `/m/<token>` (maintenance request share links, Task 10) and
 * `/r/<token>` (public order-request links, migration 0261). Anything that
 * logs, forwards, or beacons the current pathname — product analytics,
 * crash reporting — must redact these first: GC 27, never log a share
 * token or signed URL. Shared by `posthog-provider.tsx` and `error.tsx` so
 * the prefix list only lives in one place.
 */
export const SHARE_PATH_PREFIXES = ['/m/', '/r/'] as const;

export function isSharePath(pathname: string | null | undefined): boolean {
  return !!pathname && SHARE_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
