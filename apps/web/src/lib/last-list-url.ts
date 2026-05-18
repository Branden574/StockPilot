/**
 * Persists the user's most-recent list URL (path + search) per "list
 * surface" so that edit / create / variant-add flows can bounce the
 * user back to the exact page, search, filter, and sort they were on
 * — even when the normal `?return=` chain breaks (direct URL entry,
 * mid-flight cmd-click, browser autocomplete, third-party redirect,
 * stale referrer, etc).
 *
 * The list components call {@link rememberLastListUrl} on every render
 * (cheap — just a sessionStorage write), and the post-mutation flows
 * call {@link getLastListUrl} when no explicit returnHref is available
 * or when the explicit returnHref looks like a bare list URL or a
 * detail page (i.e. lost the user's pagination context).
 *
 * Storage is sessionStorage so the value resets per tab — never bleeds
 * across logged-out sessions or different browser windows. Keys are
 * namespaced by the surface's basePath so /dashboard/inventory and
 * /dashboard/books don't clobber each other.
 *
 * Values are still piped through {@link safeReturnPath} on retrieval
 * so a poisoned sessionStorage value can't redirect off-origin.
 */
import { safeReturnPath } from './safe-return-path';

const PREFIX = 'stockpilot:lastListUrl:';

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

/**
 * Cache the current URL for a given list surface. Call this from the
 * list table whenever it renders so the cached value is always
 * current.
 *
 * @param basePath e.g. '/dashboard/inventory' or '/dashboard/books'
 * @param fullUrl e.g. '/dashboard/inventory?page=3&q=lanyard&sort=name_asc'
 */
export function rememberLastListUrl(basePath: string, fullUrl: string): void {
  if (!isBrowser()) return;
  // Reject anything that doesn't validate — keeps an out-of-band caller
  // from poisoning the cache. The value will be re-validated on read
  // anyway, but failing here is cheap insurance.
  if (!safeReturnPath(fullUrl)) return;
  try {
    window.sessionStorage.setItem(PREFIX + basePath, fullUrl);
  } catch {
    // Quota exceeded / private browsing throws — silently no-op.
  }
}

/**
 * Read the cached URL for a list surface. Returns null when nothing
 * was cached, when storage is unavailable, or when the cached value
 * fails {@link safeReturnPath} validation.
 */
export function getLastListUrl(basePath: string): string | null {
  if (!isBrowser()) return null;
  try {
    const raw = window.sessionStorage.getItem(PREFIX + basePath);
    return safeReturnPath(raw);
  } catch {
    return null;
  }
}

/**
 * Pick the best post-mutation redirect target for a list surface.
 *
 * Precedence:
 *   1. `explicit` (the `?return=` chain) — but only when it carries
 *      query state. A bare list URL or a detail page URL counts as
 *      "lost context" and falls through to sessionStorage.
 *   2. The sessionStorage value the list table wrote on last render.
 *   3. `basePath` as a final fallback (page 1, no filters).
 *
 * @param basePath the list surface, e.g. '/dashboard/inventory'
 * @param explicit the returnHref / return-param value already in hand
 *                 (may be null/undefined when the chain dropped it)
 */
export function resolveListReturnHref(
  basePath: string,
  explicit: string | null | undefined,
): string {
  const validatedExplicit = safeReturnPath(explicit);
  // An explicit value that includes a `?` is carrying state (page,
  // search, filters, sort). Use it.
  if (validatedExplicit && validatedExplicit.includes('?')) {
    return validatedExplicit;
  }
  // Otherwise prefer the cached list URL — it has the freshest state
  // the list table was rendering.
  const cached = getLastListUrl(basePath);
  if (cached) return cached;
  // Fall back to whatever explicit value we had (even if state-less)
  // before defaulting to the bare basePath.
  return validatedExplicit ?? basePath;
}
