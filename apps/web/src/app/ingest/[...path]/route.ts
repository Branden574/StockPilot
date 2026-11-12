import { gunzipSync } from 'node:zlib';

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
 *     asked: another project's /array/<key>/config.js is a script that
 *     carries that project's site apps, and our origin serves nobody else's
 *     JavaScript. What the provider's init switches off is not on the list
 *     (docket S38): feature flags, session replay, console logs and
 *     Conversations, with the bundles only they load.
 *   - the method: the one the SDK uses for that path (a GET path takes HEAD
 *     too); any other answers 405. Every method Next hands to a route comes
 *     here (the handlers at the end), so each refusal is the route's own.
 *   - headers: accept, content-type, user-agent and every posthog-*.
 *     Authorization only as `Bearer <this app's project key>`, the form a
 *     capture v1 SDK sends a key in; posthog-js sends none. Never a cookie,
 *     and nothing else the browser or the platform added (Referer, Origin,
 *     x-vercel-*). Not Content-Encoding either: PostHog's capture reads it as
 *     a hint of how the body is packed (rust/capture utils.rs
 *     extract_compression) and no posthog-js bundle sets it, so the body
 *     PostHog unpacks is the one this route read (eventBatch below).
 *   - x-forwarded-for: the visitor's address as the platform gave it
 *     (lib/client-ip.ts), so PostHog places the visitor and not this
 *     function's region.
 *   - the query: only the parameter names the SDK sends to that path, each
 *     once and with a value of the form the SDK gives it (the query of each
 *     Target, upstreamQuery below); any other name answers 404. What goes to
 *     PostHog is written again from those pairs, on the host the SDK itself
 *     uses for that path: the assets host for /static/ and /array/, the API
 *     host for the rest (posthog-js utils/request-router.js:145-159;
 *     skipTrailingSlashRedirect in next.config.ts keeps /e/?compression=...
 *     as the SDK spelled it).
 *   - the body: a POST is an event batch, and only one that names this app's
 *     project and no other, in one of the three ways the SDK packs it
 *     (eventBatch and ownBatch below). Its bytes go on as they came, up to
 *     the platform's request body limit (BODY_CAP below); a larger one, or
 *     one that unpacks to more, answers 413.
 *
 * So every place a request names a PostHog project is held to this app's
 * key: the /array/ path, the query's token, Authorization, and the batch.
 *
 * The answer is PostHog's status and body, with its Retry-After (the SDK
 * waits that long before it retries) and its content type when that is the
 * kind the path answers with: JSON from the API, JavaScript for a script
 * (answerContentType below); never a Set-Cookie. Its cache policy is kept
 * for /static/ only; every other answer is private, no-store
 * (Target.shared). Every answer is nosniff. fetch has already decoded the
 * body, so Content-Encoding and Content-Length are not copied. A failure of
 * ours answers with no body: 404 for a path, a query or a batch not on the
 * list, 405 for another method, 413 for a body over the cap (each of these
 * logged with its path and which of them it was: refuse below), 400 for a
 * body that could not be read, 502 when PostHog does not answer within 10
 * seconds. Analytics is never worth an error page.
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
 * The largest request body taken; past it the answer is 413. It is the
 * platform's own limit, because posthog-js 1.438.15 caps no request body by
 * size and never retries a 4xx (retry-queue.js:110), so any lower cap would
 * drop, for good, batches the SDK legitimately sends: an event batch has no
 * size limit (raw JSON once a remote config fails, posthog-core.js:1097;
 * $exception events are never cut, posthog-exceptions.js:168).
 *
 * The limit: "The maximum payload size for the request body or the response
 * body of a Vercel Function is 4.5 MB", and a larger one is answered 413
 * FUNCTION_PAYLOAD_TOO_LARGE before this route runs (Vercel docs, Functions
 * limits, Request body size). The docs give no byte count, so 4.5 MB is
 * read as 4.5 MiB, the larger reading: the route refuses nothing the
 * platform lets through, and stops reading there wherever no platform
 * limit applies (next start).
 *
 * It is also the most a batch may unpack to (eventBatch): the same events
 * sent as raw JSON would have been held to it, and a gzip body unpacks to
 * many times its size.
 */
const BODY_CAP = 4.5 * 1024 * 1024;

/**
 * A posthog.version, the segment the SDK puts in /static/<version>/. Any
 * version, not only the installed one: a tab still open on an older SDK
 * after an update asks for its own.
 */
const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;

/**
 * The bundles the SDK can load by name with this app's init options
 * (entrypoints/external-scripts-loader.js:117-158). None of the settings
 * that would keep one off is set, so the project's remote config can turn
 * each on: the call, then that setting.
 *
 * Not the bundles of what the provider's init switches off, which the SDK
 * then never asks for: conversations (disable_conversations; extensions/
 * conversations/posthog-conversations.js:157) and the recorders,
 * lazy-recorder and posthog-recorder (disable_session_recording;
 * extensions/replay/session-recording.js:196, :318-322). components/
 * analytics/posthog-provider.sdk.test.tsx shows both through the real SDK.
 * logs stays: the SDK loads it when the project captures console logs
 * (posthog-logs.js:67), and the provider's logs.beforeSend drops each record
 * only after that.
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
  'logs', // posthog-logs.js:67; logs.captureConsoleLogs
  'dead-clicks-autocapture', // extensions/dead-clicks-autocapture.js:87; capture_dead_clicks
  'exception-autocapture', // extensions/exception-autocapture/index.js:101; capture_exceptions
  // The one web vitals bundle capture_performance unset picks
  // (extensions/web-vitals/index.js:401-409, :424).
  'web-vitals-with-attribution',
] as const;

/** Whether a query parameter's value has the form the SDK gives it. */
type ValueCheck = (value: string) => boolean;

const matching =
  (form: RegExp): ValueCheck =>
  (value) =>
    form.test(value);

/** Date.now() as text: what the SDK stamps a GET with as `_` (request.js:535-536). */
const MILLISECONDS = matching(/^\d{1,16}$/);

/**
 * This app's own project key: the provider's key, read the same way. PostHog
 * takes a GET's project from the query's token (posthog/api/utils.py
 * get_token, which the product tours view calls; the surveys service,
 * rust/hypercache-server surveys.rs extract_token), and the SDK puts its own
 * key there on the surveys and product tours calls (@posthog/browser-common
 * surveys.js:254-258; posthog-product-tours.js:108). Another project's key
 * would make this function a relay for that project. With no key set,
 * analytics is off and no key passes.
 */
const ownKey: ValueCheck = (value) => {
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  return key !== '' && value === key;
};

/** A query: each parameter name the SDK sends, with the form of its value. */
type Query = ReadonlyMap<string, ValueCheck>;

const NO_QUERY: Query = new Map();

/**
 * What the SDK adds to an event batch's address, and nothing else it could:
 * compression=base64 when the body is the base64 form (request.js:533-537;
 * a gzip body carries no parameter, the SDK takes it off), and retry_count
 * on a retry (retry-queue.js:106; ten retries at most). The time it was
 * sent is in the body (posthog-core.js:1687 timestampMode 'capture-body').
 * Never data=: PostHog's capture reads a batch from that parameter before
 * the body (rust/capture payload/common.rs extract_payload_bytes), and the
 * SDK never puts one there.
 */
const EVENTS_QUERY: Query = new Map([
  ['compression', matching(/^base64$/)],
  ['retry_count', matching(/^\d{1,4}$/)],
]);

/** token=<key>&_=<ms>: the surveys and product tours lists, both by GET. */
const LIST_QUERY: Query = new Map([
  ['token', ownKey],
  ['_', MILLISECONDS],
]);

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
  /**
   * The query parameters the SDK sends to the path. A request with any
   * other name, a name twice or a value of another form is refused, and only
   * these pairs are passed on (upstreamQuery). Empty where the SDK sends no
   * query.
   */
  query: Query;
  /**
   * What the path answers with: JSON from PostHog's API, or a script. The
   * answer keeps PostHog's content type only when it is of that kind
   * (answerContentType).
   */
  answer: 'json' | 'script';
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

function api(method: Target['method'], path: RegExp, query: Query): Endpoint {
  return { path, origin: API_ORIGIN, method, query, answer: 'json', shared: false };
}

function bundle(path: RegExp, query: Query): Endpoint {
  return { path, origin: ASSETS_ORIGIN, method: 'GET', query, answer: 'script', shared: true };
}

/**
 * Every request posthog-js 1.438.15 makes to api_host with this app's init
 * options, but the remote config's (remoteConfig below). Paths are the SDK's
 * own (lib/src unless named), as it writes them.
 *
 * Not here, because the provider's init switches them off (components/
 * analytics/posthog-provider.tsx; posthog-provider.sdk.test.tsx shows each
 * through the real SDK): /flags/ (advanced_disable_feature_flags;
 * @posthog/browser-common feature-flags.js:599-600), /s/
 * (disable_session_recording), /i/v1/logs (logs.beforeSend drops every
 * record) and /api/conversations/ (disable_conversations).
 *
 * Nor these, which the options never make: /api/web_experiments/
 * (disable_web_experiments defaults to true, posthog-core.js:218;
 * web-experiments.js:74, :117), /i/v1/metrics (only posthog.metrics.* or the
 * metrics option send it, posthog-metrics.js:55, :190),
 * /api/early_access_features/ (only posthog.getEarlyAccessFeatures(),
 * posthog-core.js:2464), /site_app/ (opt_in_site_apps defaults to false,
 * posthog-core.js:218; site-apps.js:69, :459-464), tracing-headers and the
 * Intercom and Crisp bundles (their options, extensions/tracing-headers.js:
 * 75, external-integration.js:70).
 */
const ENDPOINTS: readonly Endpoint[] = [
  // Events, POST: the SDK's own path (posthog-core.js:353, sent at :1685-
  // 1687) and the one the project's remote config names instead
  // (:1107-1108), /i/v0/e/ for this project. Heatmaps, exceptions, web vitals
  // and dead clicks are events. These are the only POSTs, so every POST
  // body is an event batch (eventBatch).
  api('POST', /^\/e\/$/, EVENTS_QUERY),
  api('POST', /^\/i\/v0\/e\/$/, EVENTS_QUERY),
  // Surveys, GET (@posthog/browser-common surveys.js:254-259);
  // disable_surveys.
  api('GET', /^\/api\/surveys\/$/, LIST_QUERY),
  // Product tours, GET (posthog-product-tours.js:108-110);
  // disable_product_tours.
  api('GET', /^\/api\/product_tours\/$/, LIST_QUERY),
  // The bundles, by script tag (GET): /static/<version>/<name>.js with no
  // query (entrypoints/external-scripts-loader.js:128), and
  // /static/<name>.js?v=<version> when that fails (:104-114, :137-153;
  // strict_script_versioning is 'fallback', posthog-core.js:218).
  bundle(new RegExp(`^/static/${VERSION}/(?:${BUNDLES.join('|')})\\.js$`), NO_QUERY),
  bundle(
    new RegExp(`^/static/(?:${BUNDLES.join('|')})\\.js$`),
    new Map([['v', matching(new RegExp(`^${VERSION}$`))]]),
  ),
];

/**
 * The remote config, by GET: as a script (entrypoints/external-scripts-
 * loader.js:120) or as JSON when the script carried none (remote-config.js:
 * 31-37, :53-60), for this app's own project key only: the provider's key,
 * read the same way. Another project's config.js carries that project's
 * site apps, so it would run their code as ours; with no key set, analytics
 * is off and no /array/ path is passed on. The SDK sends no query here, so
 * one with any is refused (a ?callback= never reaches PostHog).
 */
function remoteConfig(path: string): Target | null {
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  const answer =
    path === `/array/${key}/config.js` ? 'script' : path === `/array/${key}/config` ? 'json' : null;
  return answer && { origin: ASSETS_ORIGIN, method: 'GET', query: NO_QUERY, answer, shared: false };
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

/**
 * The query to ask PostHog with ('' for none), or null for one the SDK does
 * not send to this path: a parameter name not on the path's list, a name
 * twice (PostHog's services differ on which of two values they read) or a
 * value of another form. URLSearchParams has decoded the names, so one
 * spelled with escapes is read as PostHog would read it. What is returned
 * is written again from the pairs that passed, never copied from the
 * request.
 */
function upstreamQuery(allowed: Query, sent: URLSearchParams): string | null {
  const seen = new Set<string>();
  for (const [name, value] of sent) {
    if (seen.has(name) || !allowed.get(name)?.(value)) return null;
    seen.add(name);
  }
  return seen.size === 0 ? '' : `?${sent.toString()}`;
}

/** Request headers passed on as they came, with every posthog-* header. */
const REQUEST_HEADERS = new Set(['accept', 'content-type', 'user-agent']);

function upstreamHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  request.headers.forEach((value, header) => {
    // The Fetch standard gives the names in lower case; not every Headers
    // implementation does (happy-dom keeps the case they were set in).
    const name = header.toLowerCase();
    if (REQUEST_HEADERS.has(name) || name.startsWith('posthog-')) headers.set(name, value);
  });
  // Authorization only as this app's own project key: PostHog's intakes that
  // read it take the project from it before anything else (rust/capture-logs
  // authorizer.rs resolve_token), so another project's key never goes on.
  // posthog-js sends none.
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

/** The SDK's base64 body: one form field, data, its base64 as encodeURIComponent leaves it. */
const BASE64_FORM = /^data=((?:[0-9A-Za-z]|%2B|%2F|%3D)*)$/;

/**
 * The JSON of an event batch, unpacked the one way its request says it is
 * packed; 'size' when it unpacks to more than BODY_CAP; null when it is not
 * packed as the SDK packs one. The three ways posthog-js 1.438.15 sends a
 * batch (request.js:139-171 encodePostData, :533-537 buildRequestURL):
 *
 *   - gzip, its default (posthog-core.js:658, :1100-1105): the gzip bytes
 *     as text/plain, with no compression parameter;
 *   - base64, when a page is left before any remote config said what PostHog
 *     takes (request.js:583-585): data=<base64 of the JSON> as
 *     application/x-www-form-urlencoded, with compression=base64;
 *   - raw JSON, once a remote config fails (posthog-core.js:1097): as
 *     application/json, with no compression parameter.
 *
 * Each is told by all of its marks together, the content type by its exact
 * text, and anything between two of them is refused. PostHog's capture is
 * more lenient: it will look for base64 or a form inside a body, and takes
 * hints from more places (rust/capture payload/common.rs
 * extract_payload_bytes, payload/decompression.rs decompress_payload). Read
 * this strictly, a body has one reading, and it is the one PostHog arrives
 * at: so the batch checked here (ownBatch) is the batch PostHog takes.
 */
function eventBatch(
  contentType: string | null,
  compression: string | null,
  body: Uint8Array<ArrayBuffer>,
): string | 'size' | null {
  let json: Uint8Array;
  if (compression === 'base64') {
    if (contentType !== 'application/x-www-form-urlencoded') return null;
    const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('latin1');
    const field = BASE64_FORM.exec(text);
    if (!field) return null;
    const base64 = decodeURIComponent(field[1]!);
    const decoded = Buffer.from(base64, 'base64');
    // Node skips what is not base64 and takes loose endings; only the one
    // spelling of these bytes that an encoder writes is taken.
    if (decoded.toString('base64') !== base64) return null;
    json = decoded;
  } else if (compression !== null) {
    // No other value is on the query's list (EVENTS_QUERY); were one put
    // there, a body packed that way would not pass unread.
    return null;
  } else if (body[0] === 0x1f && body[1] === 0x8b) {
    if (contentType !== 'text/plain') return null;
    try {
      json = gunzipSync(body, { maxOutputLength: BODY_CAP });
    } catch (err) {
      // Node's own error for output past maxOutputLength; any other is a
      // body that is not gzip after all.
      return (err as { code?: unknown } | null)?.code === 'ERR_BUFFER_TOO_LARGE' ? 'size' : null;
    }
  } else {
    if (contentType !== 'application/json') return null;
    json = body;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(json);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** All a batch has at its top, as the SDK builds it (request.js:544-548). */
const BATCH_FIELDS = new Set(['api_key', 'batch', 'sent_at']);

/**
 * The names PostHog reads a project key under, on a batch and on an event
 * (rust/capture v0_request.rs BatchedRequest; rust/common/types event.rs
 * RawEvent), besides an event's properties.token.
 */
const KEY_FIELDS = ['api_key', 'token', '$token'] as const;

/** An event that names no project but this app's: by any of its key fields, and by properties.token. */
function ownEvent(event: unknown, key: string): boolean {
  if (!isRecord(event)) return false;
  if (KEY_FIELDS.some((field) => Object.hasOwn(event, field) && event[field] !== key)) return false;
  if (!Object.hasOwn(event, 'properties')) return true;
  const { properties } = event;
  return isRecord(properties) && (!Object.hasOwn(properties, 'token') || properties.token === key);
}

/**
 * Whether a batch's JSON is one the SDK builds for this app's project: an
 * object of api_key, batch and sent_at and nothing else, whose api_key is
 * this app's key, with at least one event, and no event naming another
 * project. With no key set, analytics is off and no batch passes.
 *
 * PostHog files a batch under its api_key, before any key an event carries
 * (rust/capture utils.rs extract_and_verify_token), so that field must be
 * there and be ours. Nothing else at the top, because PostHog reads a body
 * that fails as a batch as one event instead (v0_request.rs RawRequest, an
 * untagged choice), and an event's key is read from fields a batch does not
 * have: with only these three, there is no second reading to file under
 * another project. An event without a key of its own takes the batch's.
 */
function ownBatch(json: string): boolean {
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (key === '') return false;
  let batch: unknown;
  try {
    batch = JSON.parse(json);
  } catch {
    return false;
  }
  return (
    isRecord(batch) &&
    Object.keys(batch).every((field) => BATCH_FIELDS.has(field)) &&
    batch.api_key === key &&
    Array.isArray(batch.batch) &&
    batch.batch.length > 0 &&
    batch.batch.every((event) => ownEvent(event, key))
  );
}

/** The media types each kind of path answers with. */
const ANSWER_MEDIA_TYPES: Record<Target['answer'], ReadonlySet<string>> = {
  json: new Set(['application/json']),
  script: new Set(['application/javascript', 'text/javascript']),
};
const PLAIN_TEXT = 'text/plain; charset=utf-8';

/**
 * PostHog's Content-Type when its media type is the kind the path answers
 * with (parameters kept), else plain text: nothing of PostHog's is served as
 * a page of ours, and nothing from a JSON path as a script. A value naming
 * two types (comma-joined) is refused too, as a browser takes the last of
 * them.
 */
function answerContentType(answer: Target['answer'], value: string | null): string {
  if (value === null || value.includes(',')) return PLAIN_TEXT;
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase();
  return ANSWER_MEDIA_TYPES[answer].has(mediaType) ? value : PLAIN_TEXT;
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
 * What a refused request had that the list does not: its path, its method
 * (405), its query, its size (413: a body over the cap, as sent or once
 * unpacked) or its body (a batch that is not one of this app's).
 */
type Reason = 'path' | 'method' | 'query' | 'size' | 'body';

/**
 * A request not passed on: 404, 405 (with Allow) or 413. One log line each,
 * with the path and which part of the request it was (Reason), never the
 * part itself: not the query (it can carry a token), a header or the body.
 * The SDK drops what is refused without retrying, and /i/v0/e/ comes from
 * the project's remote config, so this line is where a config that names a
 * new path, or an SDK update that sends something new, shows, instead of
 * events vanishing.
 */
function refuse(
  status: 404 | 405 | 413,
  reason: Reason,
  method: string,
  path: string,
  allow?: string,
): Response {
  console.warn('[ingest] refused', { status, reason, method, path });
  return emptyAnswer(status, allow);
}

async function proxy(request: NextRequest): Promise<Response> {
  const incoming = new URL(request.url);
  const path = incoming.pathname;
  const { method } = request;
  const destination = targetFor(path);
  if (!destination) return refuse(404, 'path', method, path);
  if (method !== destination.method && !(method === 'HEAD' && destination.method === 'GET')) {
    const allow = destination.method === 'GET' ? 'GET, HEAD' : 'POST';
    return refuse(405, 'method', method, path, allow);
  }
  const query = upstreamQuery(destination.query, incoming.searchParams);
  if (query === null) return refuse(404, 'query', method, path);

  let requestBody: Uint8Array<ArrayBuffer> | undefined;
  if (method === 'POST') {
    let read: Uint8Array<ArrayBuffer> | null;
    try {
      read = await readBody(request);
    } catch {
      return emptyAnswer(400);
    }
    if (read === null) return refuse(413, 'size', method, path);
    // Every POST on the list is an event batch. One that is not this app's
    // goes no further, whichever path took it.
    const batch = eventBatch(
      request.headers.get('content-type'),
      incoming.searchParams.get('compression'),
      read,
    );
    if (batch === 'size') return refuse(413, 'size', method, path);
    if (batch === null || !ownBatch(batch)) return refuse(404, 'body', method, path);
    requestBody = read;
  }

  const target = new URL(destination.origin);
  target.pathname = path.slice(PREFIX.length);
  target.search = query;

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
    'content-type': answerContentType(destination.answer, upstream.headers.get('content-type')),
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
