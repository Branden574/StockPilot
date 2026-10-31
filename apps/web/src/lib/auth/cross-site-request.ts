/**
 * The one rule for a cookie-authenticated write that a browser did not send
 * from a page of this origin (docket S14). withApiContext applies it on its
 * cookie path, so every API route that builds its context there refuses such a
 * write with the answer it already gives a signed-out caller. The order sign
 * route and the release-state route also call it before they build a context.
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
 * WHEN IT IS REFUSED. Unless the browser says the request came from a page of
 * this origin, in the two headers a browser sets and no page can set:
 *   - Sec-Fetch-Site is present and is not `same-origin`: `same-site` (a sibling
 *     subdomain), `cross-site`, or `none` (a request no page made, which never
 *     posts);
 *   - Origin is present and its host is not one this request was addressed to.
 *     `null` (a sandboxed frame, a data: URL, a cross-origin redirect) and an
 *     unreadable value name no host, so they are refused too;
 *   - NEITHER header is present (fail closed, the integrator's decision of
 *     2026-10-24). Every browser the app supports (Next 16's targets: Chrome,
 *     Edge and Firefox 111+, Safari 16.4+) sends Origin on every request whose
 *     method is not GET or HEAD (the Fetch standard, "append a request Origin
 *     header"), and Sec-Fetch-Site besides over https, so this costs none of
 *     them anything, and a client, proxy or extension that strips both headers
 *     is not let through. A request that carries either header is judged by
 *     the ones it carries: Sec-Fetch-Site `same-origin` alone (Origin dropped
 *     by an extension) passes, and so does a matching Origin alone (plain http
 *     to a LAN address, where no browser sends Sec-Fetch-Site).
 * The phone is never refused: it sends a Bearer token on every signed-in call
 * (apps/mobile/src/lib/api.ts authHeader). A test or script that drives a
 * cookie write must send an Origin, as the web app's own pages do.
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

/**
 * The browser's own word that a page on another origin made it send this
 * request: Sec-Fetch-Site is present and is neither `same-origin` nor `none`.
 * For a GET that spends something of the person's, which the write rule below
 * never judges: their session (/auth/session-ended) and their export budget
 * (lib/export-rate-limit.ts). A link another site shows, a redirect it starts,
 * an image or a script it loads all say `same-site` or `cross-site` (for a
 * navigation, about every URL it went through), whatever the method.
 *
 * `none` is the person's own act (an address they typed, a bookmark, a link
 * opened from another app), which no page can produce, so it is not another
 * origin. With no Sec-Fetch-Site (a browser without Fetch Metadata, plain http,
 * the phone, a server-side fetch) there is no word either way, so this is
 * false; a GET carries no Origin to judge instead. Any other value (none is
 * defined) is another origin, so only the two this origin and the person send
 * are let through.
 */
export function sentFromAnotherOrigin(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
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
 * True when a header says this request came from another origin, or from one
 * the browser will not name: Sec-Fetch-Site is not `same-origin`, or Origin is
 * `null`, unreadable or another host. False when neither header is present,
 * which the write rule below refuses on its own account.
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
 * True when the browser's own headers place this request on a page of this
 * origin: at least one of Sec-Fetch-Site and Origin is present, and each one
 * present says so.
 */
export function isSameOriginBrowserRequest(req: Request): boolean {
  const named = req.headers.has('sec-fetch-site') || req.headers.has('origin');
  return named && !isCrossSiteBrowserRequest(req);
}

/**
 * True when this request must be refused before any cookie session is read: it
 * has no Bearer token, its method is a write, and the browser does not say it
 * came from a page of this origin (another origin, one it will not name, or
 * neither header at all).
 */
export function refusesCrossSiteCookieWrite(req: Request): boolean {
  if (bearerTokenFrom(req)) return false;
  if (!isWriteMethod(req.method)) return false;
  return !isSameOriginBrowserRequest(req);
}
