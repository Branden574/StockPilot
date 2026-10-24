/**
 * The one rule for a cookie-authenticated write that a browser sent from
 * another page's origin (docket S14). withApiContext applies it on its cookie
 * path, so every API route that builds its context there refuses such a write
 * with the answer it already gives a signed-out caller. The order sign route and
 * the release-state route also call it before they build a context.
 *
 * WHY. A browser attaches the session cookie to a request whatever page made
 * it. The session cookies are SameSite=Lax, so a page on another SITE cannot
 * have a POST sent with them, but a page on a sibling subdomain (the same site)
 * can. A route handler gets no Origin check from the framework: Next compares
 * Origin with the host before it runs a server action
 * (next/dist/server/app-render/action-handler.js) and does nothing of the kind
 * for a route handler.
 *
 * WHAT IS JUDGED. Only a request that can spend the cookie session on a change:
 *   - a Bearer caller (the phone: apps/mobile/src/lib/api.ts authHeader) is
 *     never judged. It carries no ambient credential, and withApiContext takes
 *     its bearer path and never falls back to the cookie. Any other
 *     Authorization header (Basic, for instance, which a browser can attach on
 *     its own) is judged like a cookie, because withApiContext reads the cookie
 *     for it;
 *   - GET, HEAD and OPTIONS are never judged. They are not writes, and a link
 *     from another site is a GET the browser sends with the cookie (Lax), which
 *     must keep working.
 *
 * WHEN IT IS REFUSED. When the browser says the request came from somewhere
 * else, in either of the two headers a browser sets and no page can set:
 *   - Sec-Fetch-Site is present and is not `same-origin`: `same-site` (a sibling
 *     subdomain), `cross-site`, or `none` (a request no page made, which never
 *     posts);
 *   - Origin is present and its host is not one this request was addressed to.
 *     `null` (a sandboxed frame, a data: URL, a cross-origin redirect) and an
 *     unreadable value name no host, so they are refused too.
 * A request with neither header is not judged: every browser the app supports
 * sends Origin on a POST, so a request without either is not one a page drove.
 *
 * THE HOST. Origin is compared with each host the request was addressed to: the
 * request URL's, the Host header's and the first X-Forwarded-Host's. On Vercel
 * these name the same host: the build sets trustHostHeader
 * (next/dist/build/index.js), so Next builds the URL from the Host header
 * (next/dist/server/route-modules/route-module.js, prepareImpl), and Next's own
 * server-action check compares Origin with X-Forwarded-Host or Host. Under
 * `next dev` or `next start` the URL says `localhost:<port>` whatever the
 * browser typed, so a browser on 127.0.0.1 is matched by its Host header. No
 * page on another origin can choose any of the three: the browser sets Host
 * from the URL it requests, and X-Forwarded-Host is not a header a page may add
 * to a cross-origin request without a preflight, which no route here answers.
 *
 * FORMS. A form posted from a page whose referrer policy is `no-referrer` sends
 * `Origin: null` even to its own origin (the Fetch standard, "append a request
 * Origin header"). The app's pages use strict-origin-when-cross-origin
 * (next.config.ts) and a fetch() always sends its origin, so only such a form
 * could trip the Origin half. No form in the app posts to a route that applies
 * this rule; /auth/confirm, whose own page is no-referrer, uses the
 * Sec-Fetch-Site half alone (fetchSiteIsElsewhere).
 */

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A host as a Host or X-Forwarded-Host header carries it: a name or an IP, and a port. */
const HOST_VALUE_RE = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * The token withApiContext's bearer path authenticates with, or null when the
 * request has none (and withApiContext then reads the cookie session).
 */
export function bearerTokenFrom(req: Request | undefined): string | null {
  const auth = req?.headers.get('authorization') ?? null;
  return auth?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

/** Every method but GET, HEAD and OPTIONS, in whatever case it arrived. */
export function isWriteMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * The browser's own word that the request did not come from a page on this
 * origin: Sec-Fetch-Site is present and is anything but `same-origin`.
 */
export function fetchSiteIsElsewhere(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin';
}

/** The hosts this request was addressed to, each as URL.host normalises it. */
function addressedHosts(req: Request): Set<string> {
  const hosts = new Set<string>();
  let protocol = 'https:';
  try {
    const url = new URL(req.url);
    hosts.add(url.host);
    protocol = url.protocol;
  } catch {
    // No readable URL: only the headers below can name a host.
  }
  const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0];
  for (const raw of [req.headers.get('host'), forwarded]) {
    const value = raw?.trim();
    if (!value || !HOST_VALUE_RE.test(value)) continue;
    try {
      hosts.add(new URL(`${protocol}//${value}`).host);
    } catch {
      // An unreadable header names no host.
    }
  }
  hosts.delete('');
  return hosts;
}

/**
 * True when a browser sent this request from another origin, or from one it
 * will not name: Sec-Fetch-Site is not `same-origin`, or Origin is `null`,
 * unreadable or another host. False when neither header is present.
 */
export function isCrossSiteBrowserRequest(req: Request): boolean {
  if (fetchSiteIsElsewhere(req)) return true;
  const origin = req.headers.get('origin');
  if (origin === null) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  if (!originHost) return true;
  return !addressedHosts(req).has(originHost);
}

/**
 * True when this request must be refused before any cookie session is read: it
 * has no Bearer token, its method is a write, and a browser sent it from
 * another origin.
 */
export function refusesCrossSiteCookieWrite(req: Request): boolean {
  if (bearerTokenFrom(req)) return false;
  if (!isWriteMethod(req.method)) return false;
  return isCrossSiteBrowserRequest(req);
}
