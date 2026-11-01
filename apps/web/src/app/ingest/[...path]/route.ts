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
 *   - the method: the one the SDK uses for that path (a GET path takes HEAD
 *     too); any other answers 405. Every method Next hands to a route comes
 *     here (the handlers at the end), so each refusal is the route's own.
 *   - headers: the ones PostHog's proxy reference names (content-type,
 *     content-encoding, user-agent, every posthog-*), accept, and
 *     x-conversations-token (posthog-js sets it on its Conversations calls:
 *     the widget's value from the public remote config). Authorization only
 *     as `Bearer <this app's project key>`, the form a capture v1 SDK sends
 *     a key in; posthog-js sends none. Never a cookie, and nothing else the
 *     browser or the platform added (Referer, Origin, x-vercel-*).
 *   - x-forwarded-for: the visitor's address as the platform gave it
 *     (lib/client-ip.ts), so PostHog places the visitor and not this
 *     function's region.
 *   - the query as it came (/flags/?v=2; skipTrailingSlashRedirect in
 *     next.config.ts keeps the slash before it), but none for the remote
 *     config, where the SDK sends none, and a project key in it (token or
 *     api_key) only if it is this app's (ownTokens below; 404 otherwise), on
 *     the host the SDK itself uses for that path: the assets host for
 *     /static/ and /array/, the API host for the rest (posthog-js
 *     utils/request-router.js:145-159).
 *   - the body's bytes as they came (gzip and base64 batches are binary), up
 *     to the platform's request body limit (BODY_CAP below); a larger one
 *     answers 413.
 *
 * The answer is PostHog's status and body, with its Retry-After (the SDK
 * waits that long before it retries) and its content type when that is one a
 * PostHog answer has (answerContentType below), and never a Set-Cookie. Its
 * cache policy is kept for /static/ only; every other answer is private,
 * no-store (Target.shared). Every answer is nosniff. fetch has already
 * decoded the body, so Content-Encoding and Content-Length are not copied. A
 * failure of ours answers with no body: 404 for a path or a project key not
 * on the list, 405 for another method, 413 for a body over the cap (each of
 * these three logged with its path: refuse below), 400 for a body that could
 * not be read, 502 when PostHog does not answer within 10 seconds. Analytics
 * is never worth an error page.
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

/**
 * The largest request body taken, on every POST path; past it the answer is
 * 413. It is the platform's own limit, because posthog-js 1.438.15 caps no
 * request body by size and never retries a 4xx (retry-queue.js:110), so any
 * lower cap would drop, for good, bodies the SDK legitimately sends: an
 * event batch has no size limit (raw JSON once a remote config fails,
 * posthog-core.js:1097; $exception events are never cut,
 * posthog-exceptions.js:168), the console log drain at unload posts the
 * whole queue, up to 2,048 records, at once (@posthog/browser-common
 * logs.js:445-458, logs-config.js:37), and one replay event is never split
 * (extensions/replay/external/sessionrecording-utils.js:204-205).
 *
 * The limit: "The maximum payload size for the request body or the response
 * body of a Vercel Function is 4.5 MB", and a larger one is answered 413
 * FUNCTION_PAYLOAD_TOO_LARGE before this route runs (Vercel docs, Functions
 * limits, Request body size). The docs give no byte count, so 4.5 MB is
 * read as 4.5 MiB, the larger reading: the route refuses nothing the
 * platform lets through, and stops reading there wherever no platform
 * limit applies (next start).
 */
const BODY_CAP = 4.5 * 1024 * 1024;

/**
 * A posthog.version, the segment the SDK puts in /static/<version>/. Any
 * version, not only the installed one: a tab still open on an older SDK
 * after an update asks for its own.
 */
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;

/**
 * A Conversations ticket id: a UUID. PostHog issues them, and the SDK sends
 * back the one it was given (extensions/conversations/external/index.js:
 * 567-569, :839-840; its own example is getMessages('ticket-uuid'),
 * posthog-conversations.js:320).
 */
const TICKET = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';

/**
 * The bundles the SDK can load by name with this app's init options
 * (entrypoints/external-scripts-loader.js:117-158). None of the settings
 * that would keep one off is set, so the project's remote config can turn
 * each on: the call, then that setting.
 *
 * Not toolbar: a #__posthog= link launches it (extensions/toolbar.js:25,
 * :153) and it talks to ui_host, which the CSP's connect-src does not allow
 * (next.config.ts), so it cannot work here; served, a crafted link would
 * load PostHog's toolbar from our origin, and on every later page too, as
 * the SDK keeps the link's state (toolbar.js:146).
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
  // The recorder: lazy-recorder unless the remote config names another
  // (extensions/replay/session-recording.js:196, :318-322);
  // disable_session_recording. Only these two define initSessionRecording,
  // without which the SDK records nothing (session-recording.js:357-363);
  // the package's recorder and recorder-v2 define rrweb only, so they are
  // refused.
  'lazy-recorder',
  'posthog-recorder',
] as const;

/** Where a request goes, and how its answer comes back. */
interface Target {
  origin: typeof API_ORIGIN | typeof ASSETS_ORIGIN;
  /**
   * The one method the SDK uses for the path; a GET path takes HEAD too.
   * Checked here, not by which handlers the module exports: it exports one
   * for every method (the end of this file), and Next answers HEAD with the
   * GET handler when there is no HEAD one
   * (next/dist/server/route-modules/app-route/helpers/
   * auto-implement-methods.js:36-45).
   */
  method: 'GET' | 'POST';
  /** The query is passed on; false for a path the SDK sends no query to. */
  query: boolean;
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

function api(method: Target['method'], path: RegExp): Endpoint {
  return { path, origin: API_ORIGIN, method, query: true, shared: false };
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
  // Events, POST: the SDK's own path (posthog-core.js:353, sent at :1685-
  // 1687) and the one the project's remote config names instead
  // (:1107-1108), /i/v0/e/ for this project. Heatmaps, exceptions, web vitals
  // and dead clicks are events.
  api('POST', /^\/e\/$/),
  api('POST', /^\/i\/v0\/e\/$/),
  // Feature flags, POST ?v=2 (@posthog/browser-common feature-flags.js:683,
  // :897-899); advanced_disable_flags, advanced_disable_feature_flags.
  api('POST', /^\/flags\/$/),
  // Replay snapshots, POST, like events (extensions/replay/external/
  // lazy-loaded-session-recorder.js:115, :2224); disable_session_recording.
  api('POST', /^\/s\/$/),
  // Console logs, POST (@posthog/browser-common logs.js:393, :449-450);
  // logs.captureConsoleLogs.
  api('POST', /^\/i\/v1\/logs$/),
  // Surveys, GET (@posthog/browser-common surveys.js:254-255);
  // disable_surveys.
  api('GET', /^\/api\/surveys\/$/),
  // Product tours, GET (posthog-product-tours.js:108-109);
  // disable_product_tours.
  api('GET', /^\/api\/product_tours\/$/),
  // Conversations (extensions/conversations/external/index.js:147-148);
  // disable_conversations. POST a message (:549), mark a ticket read
  // (:681), restore (:807) and ask for a restore link (:1435); GET a
  // ticket's messages (:637) and the tickets (:1390-1391).
  api('POST', /^\/api\/conversations\/v1\/widget\/(?:message|restore|restore\/request)$/),
  api('POST', new RegExp(`^/api/conversations/v1/widget/messages/${TICKET}/read$`)),
  api('GET', /^\/api\/conversations\/v1\/widget\/tickets$/),
  api('GET', new RegExp(`^/api/conversations/v1/widget/messages/${TICKET}$`)),
  // The bundles, by script tag (GET): /static/<version>/<name>.js
  // (entrypoints/external-scripts-loader.js:128), and
  // /static/<name>.js?v=<version> when that fails (:104-114, :137-153;
  // strict_script_versioning is 'fallback', posthog-core.js:218).
  {
    path: new RegExp(`^/static/(?:${VERSION}/)?(?:${BUNDLES.join('|')})\\.js$`),
    origin: ASSETS_ORIGIN,
    method: 'GET',
    query: true,
    shared: true,
  },
];

/**
 * The remote config, by GET: as a script (entrypoints/external-scripts-
 * loader.js:120) or as JSON when the script carried none (remote-config.js:
 * 31-37, :53-60), for this app's own project key only: the provider's key,
 * read the same way. Another project's config.js carries that project's
 * site apps, so it would run their code as ours; with no key set, analytics
 * is off and no /array/ path is passed on. The SDK sends no query here, so
 * none is passed on (a ?callback= never reaches PostHog).
 */
function remoteConfig(path: string): Target | null {
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || (path !== `/array/${key}/config.js` && path !== `/array/${key}/config`)) return null;
  return { origin: ASSETS_ORIGIN, method: 'GET', query: false, shared: false };
}

/**
 * Every project key in the query is this app's. PostHog takes a GET's
 * project from the query's token, or from its api_key when it has no token
 * (posthog/api/utils.py get_token, which the product tours view calls; the
 * surveys service, rust/hypercache-server surveys.rs extract_token: token,
 * then api_key), so both names are held to the key, every value of each
 * (URLSearchParams decodes an encoded name too). The SDK puts its own key in
 * token= on the surveys, product tours and console logs calls
 * (@posthog/browser-common surveys.js:254, logs.js:449; posthog-product-
 * tours.js:108) and never sends an api_key in a query (only in an event
 * batch's body, request.js:545); another project's key under either name
 * would make this function a relay for that project. With no key set, no
 * key passes. Authorization is held to the same key (upstreamHeaders).
 *
 * NOT THE PAYLOAD, NOR THE WIDGET'S TOKEN. An event payload names its
 * project too (a batch's api_key, each event's properties.token; gzip or
 * base64 encoded), whether it comes as the body or as a data= query field,
 * which PostHog's capture reads before the body (rust/capture payload
 * common.rs extract_payload_bytes), and the route passes both on as they
 * came, unread. X-Conversations-Token picks the project for the
 * Conversations widget's calls (posthog/auth.py WidgetAuthentication) and
 * is passed on as it came too: its value is the widget's own, from the
 * remote config, which the route cannot know. So anyone can still send
 * events for any PostHog project through /ingest, and reach another
 * project's Conversations widget, as the rewrites this route replaced let
 * them on every path. Abuse of that relay (cost, other projects' events
 * laundered through our origin) is left to an edge rate limit (docket
 * S38), the refusal of the paths S22 turns off, the Conversations ones
 * among them (S38 part 2), and a check of the payload's key (S38 part 3).
 */
function ownTokens(query: URLSearchParams): boolean {
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  return [...query.getAll('token'), ...query.getAll('api_key')].every(
    (value) => key !== '' && value === key,
  );
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
  // Authorization only as this app's own project key: PostHog's console log
  // intake takes the project from it before the query's token
  // (rust/capture-logs authorizer.rs resolve_token), so another project's
  // key there would undo ownTokens on /i/v1/logs. posthog-js sends none.
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  const authorization = request.headers.get('authorization');
  if (key !== '' && authorization === `Bearer ${key}`) {
    headers.set('authorization', authorization);
  }
  const visitor = clientIpFromRequest(request);
  if (visitor !== 'unknown') headers.set('x-forwarded-for', visitor);
  return headers;
}

/**
 * The request's body, or null when it is larger than BODY_CAP: by its
 * Content-Length before a byte is read, and by the bytes read when it has
 * none (a chunked body), stopping at the first byte over.
 */
async function readBody(request: NextRequest): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= BODY_CAP)) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_CAP) {
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
function emptyAnswer(status: 400 | 404 | 405 | 413 | 502, allow?: string): Response {
  const headers = new Headers({ 'x-content-type-options': 'nosniff' });
  if (allow) headers.set('allow', allow);
  return new Response(null, { status, headers });
}

/**
 * A request not passed on: 404 for a path or a project key not on the list,
 * 405 (with Allow) for a method the SDK does not use on the path, 413 for a
 * body over the cap. One log line each, with the path only: never the query
 * (it can carry a token), a header or the body. The SDK drops what is refused
 * without retrying, and /i/v0/e/ and /s/ come from the project's remote
 * config, so this line is where a config that names a new path shows,
 * instead of events vanishing.
 */
function refuse(status: 404 | 405 | 413, method: string, path: string, allow?: string): Response {
  console.warn('[ingest] refused', { status, method, path });
  return emptyAnswer(status, allow);
}

async function proxy(request: NextRequest): Promise<Response> {
  const incoming = new URL(request.url);
  const path = incoming.pathname;
  const { method } = request;
  const destination = targetFor(path);
  if (!destination) return refuse(404, method, path);
  if (method !== destination.method && !(method === 'HEAD' && destination.method === 'GET')) {
    return refuse(405, method, path, destination.method === 'GET' ? 'GET, HEAD' : 'POST');
  }
  if (destination.query && !ownTokens(incoming.searchParams)) return refuse(404, method, path);

  let requestBody: Uint8Array<ArrayBuffer> | undefined;
  if (method === 'POST') {
    let read: Uint8Array<ArrayBuffer> | null;
    try {
      read = await readBody(request);
    } catch {
      return emptyAnswer(400);
    }
    if (read === null) return refuse(413, method, path);
    requestBody = read;
  }

  const target = new URL(destination.origin);
  target.pathname = path.slice(PREFIX.length);
  if (destination.query) target.search = incoming.search;

  let upstream: Response;
  let body: ArrayBuffer | null;
  try {
    upstream = await fetch(target, {
      method,
      headers: upstreamHeaders(request),
      body: requestBody,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body =
      method === 'HEAD' || NULL_BODY_STATUSES.has(upstream.status)
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

// posthog-js sends none of the methods below. They are exported so that the
// route, not Next, refuses them like any method a path does not take: 405
// with the path's Allow, or 404 off the list, each logged (refuse). Left
// out, Next would answer OPTIONS itself with a 204 and one Allow for every
// path, and PUT, PATCH and DELETE with a bare 405, and nothing would be
// logged (next/dist/server/route-modules/app-route/helpers/
// auto-implement-methods.js:16-28, :48-74). A method Next does not know is
// answered 400 by Next before any route (app-route/module.js
// resolveHandler).
export async function PUT(request: NextRequest) {
  return proxy(request);
}

export async function PATCH(request: NextRequest) {
  return proxy(request);
}

export async function DELETE(request: NextRequest) {
  return proxy(request);
}

export async function OPTIONS(request: NextRequest) {
  return proxy(request);
}
