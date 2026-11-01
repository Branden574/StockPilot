import type { NextRequest } from 'next/server';

import { clientIpFromRequest } from '@/lib/client-ip';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PostHog's first-party proxy (docket S34). The browser SDK sends everything
 * to /ingest on our own origin (api_host in components/analytics/
 * posthog-provider.tsx): event batches, the remote config script on every
 * page, the bundles it loads later. Same-origin keeps the CSP's connect-src at
 * 'self' and keeps ad blockers from dropping the requests (next.config.ts).
 *
 * WHY A ROUTE AND NOT A REWRITE. A same-origin request carries every cookie of
 * this host: the Supabase session (sb-<ref>-auth-token and its chunks, the
 * access and refresh token, Path=/), PostHog's own cookie, the
 * remember-session flag. next.config.ts used to rewrite /ingest to PostHog. An
 * external rewrite is a reverse proxy that forwards the request's headers as
 * they came, cookies included (PostHog's proxy docs for Vercel and Next.js say
 * so), so PostHog's servers most likely received every signed-in member's
 * session with every analytics request. This route builds a new request
 * instead, from a list:
 *
 *   - headers: the ones PostHog's proxy reference names (content-type,
 *     content-encoding, user-agent, every posthog-*), accept, and
 *     x-conversations-token (posthog-js sets it on its Conversations calls:
 *     the widget's value from the public remote config). Authorization only
 *     as `Bearer phc_...`, the project key a capture v1 SDK sends; posthog-js
 *     sends none. Never a cookie, and nothing else the browser or the
 *     platform added (Referer, Origin, x-vercel-*).
 *   - x-forwarded-for: the visitor's address as the platform gave it
 *     (lib/client-ip.ts), so PostHog places the visitor and not this
 *     function's region.
 *   - the path after /ingest as the browser asked for it, trailing slash and
 *     query included (/flags/?v=2; skipTrailingSlashRedirect in
 *     next.config.ts keeps the slash), on PostHog's US hosts as the rewrites
 *     had it: /static/* on the assets host, everything else on the API host.
 *   - the body's bytes as they came: gzip and base64 batches are binary.
 *
 * The answer is PostHog's status and body, with its content type (scripts
 * need it: X-Content-Type-Options is nosniff) and its Retry-After (the SDK
 * waits that long before it retries), and never a Set-Cookie. Its cache
 * policy is kept for /static/* only; every other answer is private, no-store
 * (cacheControl below). fetch has already decoded the body, so
 * Content-Encoding and Content-Length are not copied. A failure of ours
 * answers with no body: 400 for a path that is not PostHog's, 502 when
 * PostHog does not answer within 10 seconds. The SDK retries; analytics is
 * never worth an error page.
 *
 * /ingest stays out of the proxy's matcher (src/proxy.ts): no session refresh
 * runs for analytics. route.test.ts and route.sdk.test.ts pin this route;
 * src/test/ingest-proxy.guard.test.ts fails if a /ingest rewrite or a proxy
 * matcher for /ingest comes back.
 */

const API_ORIGIN = 'https://us.i.posthog.com';
const ASSETS_ORIGIN = 'https://us-assets.i.posthog.com';
const PREFIX = '/ingest';
const TIMEOUT_MS = 10_000;

/** Request headers passed on as they came, with every posthog-* header. */
const REQUEST_HEADERS = new Set([
  'accept',
  'content-encoding',
  'content-type',
  'user-agent',
  'x-conversations-token',
]);

/** Answer headers passed on from PostHog (Cache-Control: see cacheControl). */
const ANSWER_HEADERS = ['content-type', 'retry-after'] as const;

/** Statuses whose answer has no body (the Response constructor refuses one). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * PostHog's address for this request, or null for a path that is not one to
 * pass on. The URL parser has already resolved `.` and `..` segments (%2e
 * spellings too), so a path that climbed out of /ingest/ is refused by the
 * prefix. An encoded slash or backslash survives the parser and could become
 * a separator further on, so it is refused as well. The path is set on an
 * address that already has PostHog's origin, never resolved against it
 * (`//host/...` would name another host), and the origin is checked after.
 */
function upstreamUrl(requestUrl: string): URL | null {
  const incoming = new URL(requestUrl);
  if (!incoming.pathname.startsWith(`${PREFIX}/`)) return null;
  const path = incoming.pathname.slice(PREFIX.length);
  if (/%2f|%5c/i.test(path)) return null;
  const origin = path.split('/')[1] === 'static' ? ASSETS_ORIGIN : API_ORIGIN;
  const url = new URL(origin);
  url.pathname = path;
  url.search = incoming.search;
  return url.origin === origin ? url : null;
}

/**
 * The Cache-Control of our answer. Vercel's CDN stores a function's answer
 * when its Cache-Control allows a shared cache (max-age, s-maxage) and no
 * CDN-Cache-Control says otherwise, and serves it to the next visitor. Only
 * the /static/* bundles are the same files for everyone, so only they keep
 * PostHog's policy (the CDN keeping them saves function calls). Every other
 * answer is private, no-store whatever PostHog sent: one visitor's answer is
 * never stored for another. Vary, CDN-Cache-Control and
 * Vercel-CDN-Cache-Control are never passed on (ANSWER_HEADERS).
 */
function cacheControl(target: URL, upstream: Response): string | null {
  if (target.origin === ASSETS_ORIGIN) return upstream.headers.get('cache-control');
  return 'private, no-store';
}

function upstreamHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  request.headers.forEach((value, header) => {
    // The Fetch standard gives the names in lower case; not every Headers
    // implementation does (happy-dom keeps the case they were set in).
    const name = header.toLowerCase();
    if (REQUEST_HEADERS.has(name) || name.startsWith('posthog-')) headers.set(name, value);
  });
  const authorization = request.headers.get('authorization');
  if (authorization?.startsWith('Bearer phc_')) headers.set('authorization', authorization);
  const visitor = clientIpFromRequest(request);
  if (visitor !== 'unknown') headers.set('x-forwarded-for', visitor);
  return headers;
}

async function proxy(request: NextRequest): Promise<Response> {
  const target = upstreamUrl(request.url);
  if (!target) return new Response(null, { status: 400 });

  let upstream: Response;
  let body: ArrayBuffer | null;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders(request),
      body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body =
      request.method === 'HEAD' || NULL_BODY_STATUSES.has(upstream.status)
        ? null
        : await upstream.arrayBuffer();
  } catch (err) {
    // The kind of failure only (TypeError, TimeoutError): the message can
    // carry the address and the network's own text.
    console.warn('[ingest] PostHog did not answer:', err instanceof Error ? err.name : typeof err);
    return new Response(null, { status: 502 });
  }

  const headers = new Headers();
  for (const name of ANSWER_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const policy = cacheControl(target, upstream);
  if (policy !== null) headers.set('cache-control', policy);
  return new Response(body, { status: upstream.status, headers });
}

export async function GET(request: NextRequest) {
  return proxy(request);
}

export async function HEAD(request: NextRequest) {
  return proxy(request);
}

export async function POST(request: NextRequest) {
  return proxy(request);
}
