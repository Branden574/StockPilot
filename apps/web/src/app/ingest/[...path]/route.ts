import type { NextRequest } from 'next/server';

import { clientIpFromRequest } from '@/lib/client-ip';
import { env } from '@/lib/env.client';

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
 * instead, from lists:
 *
 *   - the path: only the requests posthog-js 1.438.15 makes with this app's
 *     init options, each matched whole (ENDPOINTS below, with where in the SDK
 *     each comes from), and the remote config only for this app's own project
 *     key (remoteConfig below). Anything else answers 404 and PostHog is not
 *     asked: a rewrite of every path let anyone's project key into
 *     /array/<key>/config.js, a script that carries that project's site apps,
 *     so our origin would serve their JavaScript.
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
 *   - the query as it came (/flags/?v=2; skipTrailingSlashRedirect in
 *     next.config.ts keeps the slash before it), on the host the SDK itself
 *     uses for that path: the assets host for /static/ and /array/, the API
 *     host for the rest (posthog-js utils/request-router.js:145-159).
 *   - the body's bytes as they came (gzip and base64 batches are binary), up
 *     to the largest the SDK sends (readBody below); a larger one answers 413.
 *
 * The answer is PostHog's status and body, with its Retry-After (the SDK
 * waits that long before it retries) and its content type when that is one a
 * PostHog answer has (answerContentType below), and never a Set-Cookie. Its
 * cache policy is kept for /static/ only; every other answer is private,
 * no-store (Target.shared). Every answer is nosniff. fetch has already
 * decoded the body, so Content-Encoding and Content-Length are not copied. A
 * failure of ours answers with no body: 404 for a path not on the list, 413
 * for a body over the cap, 400 for a body that could not be read, 502 when
 * PostHog does not answer within 10 seconds. The SDK retries; analytics is
 * never worth an error page.
 *
 * /ingest stays out of the proxy's matcher (src/proxy.ts): no session refresh
 * runs for analytics. route.test.ts, route.census.test.ts and
 * route.sdk.test.ts pin this route; src/test/ingest-proxy.guard.test.ts fails
 * if a /ingest rewrite or a proxy matcher for /ingest comes back.
 */

const API_ORIGIN = 'https://us.i.posthog.com';
const ASSETS_ORIGIN = 'https://us-assets.i.posthog.com';
const PREFIX = '/ingest';
const TIMEOUT_MS = 10_000;

const MIB = 1024 * 1024;
/**
 * The largest request body taken, past which the answer is 413. The SDK's
 * largest are its event batches: everything captured in one 3 second flush
 * (request-queue.js:54, :115-131), at most about 130 events (10 a second,
 * bursts of 100: rate-limiter.js:11-12), each string cut to 65,535
 * characters (posthog-core.js:218, :1629-1630), gzipped (:658, :1687). Log
 * batches are at most 100 records of 10,000 characters, gzipped
 * (@posthog/browser-common logs-config.js:38, console-logs.js:37). A
 * mebibyte is far above both.
 */
const BODY_CAP = MIB;
/**
 * Replay snapshots are bigger: the recorder sends a buffer once it passes
 * 0.9 MiB (extensions/replay/external/lazy-loaded-session-recorder.js:141,
 * :2054, :2101) and one event of up to 6.3 MiB unsplit (sessionrecording-
 * utils.js:201-205), and a 3 second flush can hold more than one send. The
 * platform refuses a function body over 4.5 MB before this route runs, so on
 * Vercel that is the cap.
 */
const REPLAY_BODY_CAP = 8 * MIB;

/** A posthog.version, the segment the SDK puts in /static/<version>/. */
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;

/**
 * The bundles the SDK can load by name with this app's init options
 * (entrypoints/external-scripts-loader.js:117-158). None of the settings
 * that would keep one off is set, so the project's remote config can turn
 * each on: the call, then that setting.
 */
const BUNDLES = [
  'surveys', // browser-surveys.js:57; disable_surveys
  'product-tours', // posthog-product-tours.js:76; disable_product_tours
  'conversations', // extensions/conversations/posthog-conversations.js:157; disable_conversations
  'logs', // posthog-logs.js:67; logs.captureConsoleLogs
  'dead-clicks-autocapture', // extensions/dead-clicks-autocapture.js:87; capture_dead_clicks
  'exception-autocapture', // extensions/exception-autocapture/index.js:101; capture_exceptions
  // The one web vitals bundle capture_performance unset picks
  // (extensions/web-vitals/index.js:401-409, :424).
  'web-vitals-with-attribution',
  // The recorder: lazy-recorder unless the remote config names another of
  // the four the package ships (extensions/replay/session-recording.js:196,
  // :318-322); disable_session_recording.
  'lazy-recorder',
  'posthog-recorder',
  'recorder',
  'recorder-v2',
  // Launched from PostHog's app with #__posthog=... in the address
  // (extensions/toolbar.js:25, :153); no init option.
  'toolbar',
] as const;

/** Where a request goes, and how its answer comes back. */
interface Target {
  origin: typeof API_ORIGIN | typeof ASSETS_ORIGIN;
  /** The largest request body passed on. */
  maxBody: number;
  /**
   * PostHog's Cache-Control is kept. Vercel's CDN stores a function's answer
   * when its Cache-Control allows a shared cache (max-age, s-maxage) and no
   * CDN-Cache-Control says otherwise, and serves it to the next visitor.
   * Only the /static/ bundles are the same files for everyone; every other
   * answer is private, no-store whatever PostHog sent. Vary,
   * CDN-Cache-Control and Vercel-CDN-Cache-Control are never passed on.
   */
  shared: boolean;
}

interface Endpoint extends Target {
  /** The whole path after /ingest. */
  path: RegExp;
}

function api(path: RegExp, maxBody = BODY_CAP): Endpoint {
  return { path, origin: API_ORIGIN, maxBody, shared: false };
}

/**
 * Every request posthog-js 1.438.15 makes to api_host with this app's init
 * options, but the remote config's (remoteConfig below). Paths are the SDK's
 * own (lib/src unless named), as it writes them. Not here, because these
 * options never make them: /api/web_experiments/ (disable_web_experiments
 * defaults to true, posthog-core.js:218; web-experiments.js:74, :117),
 * /i/v1/metrics (only posthog.metrics.* or the metrics option send it,
 * posthog-metrics.js:55, :190), /api/early_access_features/ (only
 * posthog.getEarlyAccessFeatures(), posthog-core.js:2464), /site_app/
 * (opt_in_site_apps defaults to false, posthog-core.js:218; site-apps.js:69,
 * :459-464), tracing-headers and the Intercom and Crisp bundles (their
 * options, extensions/tracing-headers.js:75, external-integration.js:70).
 */
const ENDPOINTS: readonly Endpoint[] = [
  // Events: the SDK's own path (posthog-core.js:353, sent at :1685) and the
  // one the project's remote config names instead (:1107-1108), /i/v0/e/ for
  // this project. Heatmaps, exceptions, web vitals and dead clicks are events.
  api(/^\/e\/$/),
  api(/^\/i\/v0\/e\/$/),
  // Feature flags, ?v=2 (@posthog/browser-common feature-flags.js:683, :897);
  // advanced_disable_flags, advanced_disable_feature_flags.
  api(/^\/flags\/$/),
  // Replay snapshots (extensions/replay/external/lazy-loaded-session-
  // recorder.js:115, :2224); disable_session_recording.
  api(/^\/s\/$/, REPLAY_BODY_CAP),
  // Console logs (@posthog/browser-common logs.js:393, :449);
  // logs.captureConsoleLogs.
  api(/^\/i\/v1\/logs$/),
  // Surveys (@posthog/browser-common surveys.js:254); disable_surveys.
  api(/^\/api\/surveys\/$/),
  // Product tours (posthog-product-tours.js:108); disable_product_tours.
  api(/^\/api\/product_tours\/$/),
  // Conversations (extensions/conversations/external/index.js:147-148, :549,
  // :637, :681, :807, :1390, :1435); disable_conversations. The one segment
  // after messages/ is the ticket's id.
  api(/^\/api\/conversations\/v1\/widget\/(?:message|tickets|restore|restore\/request)$/),
  api(/^\/api\/conversations\/v1\/widget\/messages\/[0-9A-Za-z_-]+(?:\/read)?$/),
  // The bundles: /static/<version>/<name>.js (entrypoints/external-scripts-
  // loader.js:128), and /static/<name>.js?v=<version> when that fails
  // (:104-114, :137-153; strict_script_versioning is 'fallback',
  // posthog-core.js:218).
  {
    path: new RegExp(`^/static/(?:${VERSION}/)?(?:${BUNDLES.join('|')})\\.js$`),
    origin: ASSETS_ORIGIN,
    maxBody: BODY_CAP,
    shared: true,
  },
];

/**
 * The remote config, as a script (entrypoints/external-scripts-loader.js:120)
 * or as JSON when the script carried none (remote-config.js:31-37, :53-60),
 * for this app's own project key only: the provider's key, read the same
 * way. Another project's config.js carries that project's site apps, so it
 * would run their code as ours; with no key set, analytics is off and no
 * /array/ path is passed on.
 */
function remoteConfig(path: string): Target | null {
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || (path !== `/array/${key}/config.js` && path !== `/array/${key}/config`)) return null;
  return { origin: ASSETS_ORIGIN, maxBody: BODY_CAP, shared: false };
}

/**
 * Where a path under /ingest goes, or null for one not on the list. The URL
 * parser has already resolved `.` and `..` segments (%2e spellings too), so a
 * path is matched as it would be served; an encoded slash or backslash
 * matches no pattern.
 */
function targetFor(pathname: string): Target | null {
  if (!pathname.startsWith(`${PREFIX}/`)) return null;
  const path = pathname.slice(PREFIX.length);
  return ENDPOINTS.find((endpoint) => endpoint.path.test(path)) ?? remoteConfig(path);
}

/** Request headers passed on as they came, with every posthog-* header. */
const REQUEST_HEADERS = new Set([
  'accept',
  'content-encoding',
  'content-type',
  'user-agent',
  'x-conversations-token',
]);

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

/**
 * The request's body, or null when it is larger than `cap`: by its
 * Content-Length before a byte is read, and by the bytes read when it has
 * none (a chunked body), stopping at the first byte over.
 */
async function readBody(
  request: NextRequest,
  cap: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= cap)) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The media types PostHog answers this SDK with: JSON, scripts and text. */
const ANSWER_MEDIA_TYPES = new Set([
  'application/json',
  'application/javascript',
  'text/javascript',
  'text/plain',
]);
const PLAIN_TEXT = 'text/plain; charset=utf-8';

/**
 * PostHog's Content-Type when its media type is one of ANSWER_MEDIA_TYPES
 * (parameters kept), else plain text: nothing of PostHog's is served as a
 * page of ours. A value naming two types (comma-joined) is refused too, as a
 * browser takes the last of them.
 */
function answerContentType(value: string | null): string {
  if (value === null || value.includes(',')) return PLAIN_TEXT;
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase();
  return ANSWER_MEDIA_TYPES.has(mediaType) ? value : PLAIN_TEXT;
}

/** Statuses whose answer has no body (the Response constructor refuses one). */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** An answer of our own: no body, nothing PostHog said. */
function emptyAnswer(status: 400 | 404 | 413 | 502): Response {
  return new Response(null, { status, headers: { 'x-content-type-options': 'nosniff' } });
}

async function proxy(request: NextRequest): Promise<Response> {
  const incoming = new URL(request.url);
  const destination = targetFor(incoming.pathname);
  if (!destination) return emptyAnswer(404);

  let requestBody: Uint8Array<ArrayBuffer> | undefined;
  if (request.method === 'POST') {
    let read: Uint8Array<ArrayBuffer> | null;
    try {
      read = await readBody(request, destination.maxBody);
    } catch {
      return emptyAnswer(400);
    }
    if (read === null) return emptyAnswer(413);
    requestBody = read;
  }

  const target = new URL(destination.origin);
  target.pathname = incoming.pathname.slice(PREFIX.length);
  target.search = incoming.search;

  let upstream: Response;
  let body: ArrayBuffer | null;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders(request),
      body: requestBody,
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
    return emptyAnswer(502);
  }

  const headers = new Headers({
    'content-type': answerContentType(upstream.headers.get('content-type')),
    'x-content-type-options': 'nosniff',
  });
  const retryAfter = upstream.headers.get('retry-after');
  if (retryAfter !== null) headers.set('retry-after', retryAfter);
  const policy = destination.shared ? upstream.headers.get('cache-control') : 'private, no-store';
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
