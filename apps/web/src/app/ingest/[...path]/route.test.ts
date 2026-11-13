// @vitest-environment node
// Node, not a DOM: a browser-like Request drops the header names a page may
// not set (Cookie among them), and the route receives them as the browser sent
// them. The first test checks that the request handed to the route still has
// them, so it cannot pass by never seeing a cookie.
import { gunzipSync, gzipSync } from 'node:zlib';

import { autoImplementMethods } from 'next/dist/server/route-modules/app-route/helpers/auto-implement-methods';
import { HTTP_METHODS, type HTTP_METHOD } from 'next/dist/server/web/http';
import { NextRequest } from 'next/server';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The /ingest analytics proxy (dockets S34 and S38). PostHog's browser SDK
 * sends everything to /ingest on our own origin, so the browser attaches
 * every cookie of this host, the Supabase session among them. The
 * next.config.ts rewrites this route replaced forwarded the request's headers
 * as they came, on any path; the route builds a new request from lists, and
 * only for the requests the SDK makes with this app's init options: each by
 * the method the SDK uses, with the query parameters the SDK sends, and an
 * event batch only for this app's own PostHog project. fetch is a stub:
 * nothing here reaches PostHog. Placeholder values only.
 */

// The project key the provider reads (lib/env.client.ts), as the route reads
// it. vi.hoisted: the mock's factory runs before the top-level consts. A
// neutral name holds the value: secret scanners fire on a secret-shaped name
// holding a string literal.
const { PROJECT_REF, postHogEnv } = vi.hoisted(() => {
  const PROJECT_REF = 'phc_placeholder';
  return { PROJECT_REF, postHogEnv: { NEXT_PUBLIC_POSTHOG_KEY: PROJECT_REF } };
});
vi.mock('@/lib/env.client', () => ({ env: postHogEnv }));
// gunzipSync as it is, watched: what the route unpacks a gzip body to.
vi.mock('node:zlib', async (importOriginal) => {
  const zlib = await importOriginal<typeof import('node:zlib')>();
  return { ...zlib, gunzipSync: vi.fn(zlib.gunzipSync) };
});

import * as route from './route';

/**
 * The route's handlers as Next hands a request to them: the route's own for
 * each method it exports, and Next's own answer for each it does not (for
 * OPTIONS a 204 with an Allow of the exported methods, for the rest a 405
 * with no Allow; the route never runs, so nothing is logged).
 * next/dist/server/route-modules/app-route/helpers/auto-implement-methods.js
 * builds them; app-route/module.js calls it on the route module and answers
 * each request with the handler for its method (a method not in HTTP_METHODS
 * gets Next's own 400 before any handler). Every test that names a method
 * asks through this, so a method the route leaves to Next is tested as Next
 * answers it. If an upgrade moves it, this file fails to load rather than
 * passing without looking.
 */
const viaNext = autoImplementMethods(route);

const SITE = 'https://app.example.com';
// What a signed-in member's browser attaches to a same-origin request: the
// Supabase session (and a chunk of it), PostHog's own cookie and the
// remember-session flag.
const MEMBER_COOKIE =
  'sb-placeholder-auth-token=placeholder-session; sb-placeholder-auth-token.0=placeholder-chunk; ph_phc_placeholder_posthog=placeholder-ph; stockpilot-remember-session=1';
const MEMBER_BEARER = 'Bearer eyJplaceholder';
// A PostHog project key, as a capture v1 SDK sends it, and a personal API key.
const PROJECT_BEARER = `Bearer ${PROJECT_REF}`;
const PERSONAL_BEARER = 'Bearer phx_placeholder';
// Another PostHog project's key, and as a capture v1 SDK would send it.
const OTHER_PROJECT = 'phc_other';
const OTHER_PROJECT_BEARER = `Bearer ${OTHER_PROJECT}`;
// What a Conversations widget would send as its token, and a ticket id as
// PostHog hands them out (a UUID): the provider switches Conversations off.
const WIDGET_REF = 'placeholder-widget';
const TICKET = '00000000-0000-4000-8000-000000000000';
const SDK_VERSION = '1.438.15';

// Everything a signed-in member's browser sends with a same-origin request, and
// what the platform adds on the way in: the member's credentials, where the
// request came from (Origin, Referer, x-forwarded-host), the platform's own
// headers, the headers PostHog reads, and two the SDK never sets with this
// app's init options: a Content-Encoding (PostHog would take it as a hint of
// how the body is packed) and a Conversations token. A POST's content type
// goes with its body (packed below), so it is not here.
const BROWSER_HEADERS: Record<string, string> = {
  cookie: MEMBER_COOKIE,
  authorization: MEMBER_BEARER,
  'content-encoding': 'gzip',
  accept: '*/*',
  'user-agent': 'Mozilla/5.0 (placeholder)',
  'posthog-placeholder-header': 'kept',
  'x-conversations-token': WIDGET_REF,
  origin: SITE,
  referer: `${SITE}/dashboard/inventory?q=placeholder`,
  'accept-language': 'en-US',
  'x-forwarded-for': '203.0.113.7, 198.51.100.2',
  'x-real-ip': '203.0.113.7',
  'x-forwarded-host': 'app.example.com',
  'x-vercel-id': 'iad1::placeholder',
};
// Of those, the only headers PostHog is sent: the ones it reads, and the
// visitor address; with a POST, its content type too.
const SENT_HEADERS = ['accept', 'posthog-placeholder-header', 'user-agent', 'x-forwarded-for'];
const SENT_HEADERS_POST = [...SENT_HEADERS, 'content-type'].sort();
// Pieces of BROWSER_HEADERS that reach PostHog nowhere, not in the address,
// any header or the body: the session cookie and its chunk, PostHog's own
// cookie, the member's bearer token, our host, and the widget's token.
const NEVER_SENT = [
  'placeholder-session',
  'placeholder-chunk',
  'placeholder-ph',
  'eyJplaceholder',
  'app.example.com',
  WIDGET_REF,
];

const MIB = 1024 * 1024;
// The platform's request body limit (Vercel: "4.5 MB"), as the route reads it.
const CAP = 4.5 * MIB;
// The most an event batch's JSON may be, however it is packed, and the most
// names it may hold, as the route reads them.
const MOST_BATCH_BYTES = MIB;
const MOST_NAMES = 65_536;

/** How many names a value read from JSON holds: every member of every object in it. */
function namesIn(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  const members = Array.isArray(value) ? [] : Object.keys(value);
  return members.length + Object.values(value).reduce<number>((sum, v) => sum + namesIn(v), 0);
}

const upstream = vi.fn<typeof fetch>();
// The route's log lines. Quiet here; the refusal line is asserted on below.
let warn: MockInstance<Console['warn']>;

beforeEach(() => {
  upstream.mockReset();
  upstream.mockImplementation(
    async () =>
      new Response('{"status":1}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', upstream);
  // On Vercel the platform overwrites x-forwarded-for with the visitor's
  // address, and lib/client-ip.ts reads it only there.
  vi.stubEnv('VERCEL', '1');
  postHogEnv.NEXT_PUBLIC_POSTHOG_KEY = PROJECT_REF;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A method Next hands to a route handler (HTTP_METHODS). */
type Method = HTTP_METHOD;
/** The methods whose requests carry a body here: a small one, which a refusal must not read. */
const WITH_BODY: ReadonlySet<Method> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SENT_AT = '2026-01-01T00:00:00.000Z';

/** An event as posthog-js builds one: its project key is in properties.token (posthog-core.js:1811). */
function eventFor(key: string, name = '$pageview'): Record<string, unknown> {
  return { event: name, properties: { token: key, distinct_id: 'placeholder-visitor' } };
}

/**
 * The JSON of an event batch as posthog-js 1.438.15 builds one for a project
 * (lib/src/request.js:538-549 addSentAtToCaptureBody): api_key, batch and
 * sent_at, and nothing else.
 */
function batchJson(key: string = PROJECT_REF, events: unknown[] = [eventFor(key)]): string {
  return JSON.stringify({ api_key: key, batch: events, sent_at: SENT_AT });
}

/** How the SDK packs a batch (request.js:139-171 encodePostData, :533-537 buildRequestURL). */
type Packing = 'gzip' | 'base64' | 'json';
const PACKINGS: readonly Packing[] = ['gzip', 'base64', 'json'];

interface Packed {
  /** What the SDK adds to the address for this packing: compression=base64, or nothing. */
  query: string;
  contentType: string;
  body: Uint8Array<ArrayBuffer>;
}

/** `text` as the bytes of a request body. */
function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

/** The base64 form body: data=<base64 of the JSON>, as encodeURIComponent writes it. */
function base64Form(json: string): Uint8Array<ArrayBuffer> {
  return bytes(`data=${encodeURIComponent(Buffer.from(json, 'utf8').toString('base64'))}`);
}

/** A batch's JSON packed one of the three ways, with the address and the content type that go with it. */
function packed(packing: Packing, json: string = batchJson()): Packed {
  if (packing === 'gzip') {
    return { query: '', contentType: 'text/plain', body: new Uint8Array(gzipSync(json)) };
  }
  if (packing === 'base64') {
    return {
      query: 'compression=base64',
      contentType: 'application/x-www-form-urlencoded',
      body: base64Form(json),
    };
  }
  return { query: '', contentType: 'application/json', body: bytes(json) };
}

/** The packing an address asks for: base64 when it says so, else the SDK's default, gzip. */
function packingOf(path: string): Packing {
  return new URL(path, SITE).searchParams.get('compression') === 'base64' ? 'base64' : 'gzip';
}

function incoming(
  path: string,
  init: {
    method?: Method;
    headers?: Record<string, string>;
    body?: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
  } = {},
): NextRequest {
  return new NextRequest(`${SITE}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    // A stream body needs it in Node (a typed array does not mind it).
    ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

/** The answer to a request, from the handler Next picks for its method (viaNext). */
async function answerOf(request: NextRequest): Promise<Response> {
  return (await viaNext[request.method as Method](request, {})) as Response;
}

/**
 * A POST of an event batch to `path`, as the SDK sends one: packed the way
 * the address says, with the content type of that packing. `headers` are
 * what else the request carries.
 */
function batchPost(
  path: string,
  json: string = batchJson(),
  headers: Record<string, string> = {},
): NextRequest {
  const { contentType, body } = packed(packingOf(path), json);
  return incoming(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': contentType },
    body,
  });
}

/**
 * The answer to a request of this method. A POST carries a batch of this
 * app's events, as the SDK sends one; a PUT, PATCH or DELETE a small body.
 */
function ask(method: Method, path: string): Promise<Response> {
  if (method === 'POST') return answerOf(batchPost(path));
  const body = WITH_BODY.has(method) ? new Uint8Array([1]) : undefined;
  return answerOf(incoming(path, { method, body }));
}

/** The request fetch was asked to make, with its input and init merged as fetch merges them. */
async function sentToPostHog(call = 0) {
  const [input, init] = upstream.mock.calls[call]!;
  const request = new Request(input, init);
  return {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: new Uint8Array(await request.arrayBuffer()),
    redirect: request.redirect,
    cache: request.cache,
  };
}

/** A request sent to PostHog as one string: its address, its header values and its body. */
function everythingIn(sent: Awaited<ReturnType<typeof sentToPostHog>>): string {
  return `${sent.url} ${[...sent.headers.values()].join(' ')} ${Buffer.from(sent.body).toString('latin1')}`;
}

/** `text` with every character percent-encoded: only '%', digits and A-F. */
function encodedWhole(text: string): string {
  return [...text]
    .map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
    .join('');
}

/**
 * A body of `total` bytes sent in chunks of `chunkSize` (the last one shorter)
 * with no Content-Length, that counts the chunks asked for and says whether it
 * was cancelled. It makes a chunk only when one is read (no high-water mark),
 * so `pulled` is what the route read.
 */
function chunkedBody(total: number, chunkSize: number) {
  const seen = { pulled: 0, cancelled: false };
  let left = total;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (left === 0) {
          controller.close();
          return;
        }
        const size = Math.min(chunkSize, left);
        left -= size;
        seen.pulled += 1;
        controller.enqueue(new Uint8Array(size));
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, seen };
}

/** The refusal lines the route logged. */
function refusals() {
  return warn.mock.calls.filter(([first]) => first === '[ingest] refused');
}

describe('/ingest sends PostHog no member credential', () => {
  it('forwards no cookie and no member Authorization: only the headers PostHog reads, and the visitor address', async () => {
    const req = batchPost('/ingest/e/', batchJson(), BROWSER_HEADERS);
    // The route is handed what the browser sent.
    expect(req.headers.get('cookie')).toBe(MEMBER_COOKIE);
    expect(req.headers.get('authorization')).toBe(MEMBER_BEARER);
    expect(req.headers.get('content-encoding')).toBe('gzip');
    expect(req.headers.get('x-conversations-token')).toBe(WIDGET_REF);

    await route.POST(req);

    expect(upstream).toHaveBeenCalledTimes(1);
    const sent = await sentToPostHog();
    expect([...sent.headers.keys()].sort()).toEqual(SENT_HEADERS_POST);
    expect(sent.headers.get('cookie')).toBeNull();
    expect(sent.headers.get('authorization')).toBeNull();
    // The first hop: the visitor, as Vercel recorded it.
    expect(sent.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.headers.get('content-type')).toBe('text/plain');
    expect(sent.headers.get('user-agent')).toBe('Mozilla/5.0 (placeholder)');
    expect(sent.headers.get('posthog-placeholder-header')).toBe('kept');
    // Neither of the two the SDK never sets here: PostHog would unpack the
    // body by a Content-Encoding, and a Conversations token picks a project.
    expect(sent.headers.get('content-encoding')).toBeNull();
    expect(sent.headers.get('x-conversations-token')).toBeNull();
    // Nowhere else either: not in the address, any header or the body.
    for (const piece of NEVER_SENT) {
      expect(everythingIn(sent)).not.toContain(piece);
    }
  });

  it("forwards Authorization only as this app's own project key (Bearer <key>), never another project's key or another bearer", async () => {
    for (const authorization of [
      PROJECT_BEARER,
      PERSONAL_BEARER,
      PROJECT_BEARER.toLowerCase(),
      OTHER_PROJECT_BEARER,
      `${PROJECT_BEARER}x`,
    ]) {
      await route.POST(batchPost('/ingest/i/v0/e/', batchJson(), { authorization }));
    }
    for (const authorization of [PROJECT_BEARER, OTHER_PROJECT_BEARER]) {
      await route.GET(
        incoming(`/ingest/api/surveys/?token=${PROJECT_REF}`, { headers: { authorization } }),
      );
    }

    expect(upstream).toHaveBeenCalledTimes(7);
    expect((await sentToPostHog(0)).headers.get('authorization')).toBe(PROJECT_BEARER);
    for (const call of [1, 2, 3, 4]) {
      expect((await sentToPostHog(call)).headers.get('authorization'), `call ${call}`).toBeNull();
    }
    expect((await sentToPostHog(5)).headers.get('authorization')).toBe(PROJECT_BEARER);
    const other = await sentToPostHog(6);
    expect(other.headers.get('authorization')).toBeNull();
    expect(everythingIn(other)).not.toContain(OTHER_PROJECT);
  });

  it('takes the visitor address from x-real-ip when x-forwarded-for is missing, and off Vercel never from an x-forwarded-for the client could have typed (lib/client-ip.ts)', async () => {
    await route.POST(batchPost('/ingest/e/', batchJson(), { 'x-real-ip': '203.0.113.8' }));
    await route.POST(batchPost('/ingest/e/'));
    vi.stubEnv('VERCEL', '');
    await route.POST(batchPost('/ingest/e/', batchJson(), { 'x-forwarded-for': '203.0.113.9' }));

    expect((await sentToPostHog(0)).headers.get('x-forwarded-for')).toBe('203.0.113.8');
    // No address known: none is made up.
    expect((await sentToPostHog(1)).headers.get('x-forwarded-for')).toBeNull();
    expect((await sentToPostHog(2)).headers.get('x-forwarded-for')).toBeNull();
  });
});

// Every request posthog-js 1.438.15 makes with this app's init options, by the
// one method it uses for it and with the queries it builds, and where the SDK
// itself sends it when nothing proxies it (utils/request-router.js: the assets
// host for /static/ and /array/).
const API = 'https://us.i.posthog.com';
const ASSETS = 'https://us-assets.i.posthog.com';
// The bundles it can load by name. Not toolbar, recorder or recorder-v2, and
// not the bundles of what the provider switches off (conversations,
// lazy-recorder, posthog-recorder): the route refuses those (the refusal
// table below says why).
const BUNDLES = [
  'surveys',
  'product-tours',
  'logs',
  'dead-clicks-autocapture',
  'exception-autocapture',
  'web-vitals-with-attribution',
];
const SDK_REQUESTS: Array<['GET' | 'POST', string, string]> = [
  // Events: the SDK's own path, and the one this project's remote config
  // names. A gzip batch carries no query, a base64 one says so, a retry
  // counts itself (up to ten).
  ['POST', '/e/', API],
  ['POST', '/e/?compression=base64', API],
  ['POST', '/e/?retry_count=1', API],
  ['POST', '/e/?retry_count=3&compression=base64', API],
  ['POST', '/i/v0/e/', API],
  ['POST', '/i/v0/e/?compression=base64', API],
  ['POST', '/i/v0/e/?retry_count=10', API],
  ['GET', `/api/surveys/?token=${PROJECT_REF}&_=1700000000000`, API],
  ['GET', `/api/product_tours/?token=${PROJECT_REF}&_=1700000000000`, API],
  ['GET', `/array/${PROJECT_REF}/config.js`, ASSETS],
  ['GET', `/array/${PROJECT_REF}/config`, ASSETS],
  ...BUNDLES.map((name): ['GET', string, string] => [
    'GET',
    `/static/${SDK_VERSION}/${name}.js`,
    ASSETS,
  ]),
  // The SDK's fallback when the versioned file does not load.
  ...BUNDLES.map((name): ['GET', string, string] => [
    'GET',
    `/static/${name}.js?v=${SDK_VERSION}`,
    ASSETS,
  ]),
  // A tab still running an older or a pre-release SDK.
  ['GET', '/static/1.433.5/surveys.js', ASSETS],
  ['GET', '/static/1.439.0-beta.1/surveys.js', ASSETS],
  ['GET', '/static/surveys.js?v=1.439.0-beta.1', ASSETS],
];

describe('/ingest passes on the requests posthog-js makes, to the host the SDK itself uses', () => {
  it.each(SDK_REQUESTS)('%s /ingest%s goes to %s', async (method, path, host) => {
    const res = await ask(method, `/ingest${path}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(upstream).toHaveBeenCalledTimes(1);
    const sent = await sentToPostHog();
    expect(sent.url).toBe(`${host}${path}`);
    expect(sent.method).toBe(method);
  });

  it.each(PACKINGS)(
    'passes a %s batch through byte for byte, with its method and its content type',
    async (packing) => {
      // An event that holds every character a byte can spell, so no text
      // decoding on the way can pass unnoticed.
      const everyChar = String.fromCharCode(...Array.from({ length: 256 }, (_, i) => i));
      const json = batchJson(PROJECT_REF, [
        eventFor(PROJECT_REF),
        { ...eventFor(PROJECT_REF, 'placeholder_event'), note: everyChar },
      ]);
      const { query, contentType, body } = packed(packing, json);

      for (const path of ['/e/', '/i/v0/e/']) {
        upstream.mockClear();
        const at = `${path}${query ? `?${query}` : ''}`;
        const res = await route.POST(
          incoming(`/ingest${at}`, {
            method: 'POST',
            headers: { 'content-type': contentType },
            body,
          }),
        );

        expect(res.status, at).toBe(200);
        expect(upstream).toHaveBeenCalledTimes(1);
        const sent = await sentToPostHog();
        expect(sent.url, at).toBe(`${API}${at}`);
        expect(sent.method).toBe('POST');
        expect(sent.headers.get('content-type')).toBe(contentType);
        expect(sent.body).toEqual(body);
      }
    },
  );

  it('asks PostHog without following a redirect, without a cache, and with a 10 second limit', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await route.GET(incoming(`/ingest/array/${PROJECT_REF}/config.js`));

    const sent = await sentToPostHog();
    expect(sent.redirect).toBe('manual');
    expect(sent.cache).toBe('no-store');
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(upstream.mock.calls[0]![1]?.signal).toBe(timeout.mock.results[0]!.value);
  });

  it('sends HEAD as HEAD, with no body either way', async () => {
    upstream.mockImplementationOnce(
      async () =>
        new Response(null, { status: 200, headers: { 'content-type': 'application/javascript' } }),
    );
    const res = await route.HEAD(
      incoming(`/ingest/static/${SDK_VERSION}/surveys.js`, { method: 'HEAD' }),
    );

    const sent = await sentToPostHog();
    expect(sent.method).toBe('HEAD');
    expect(sent.url).toBe(`${ASSETS}/static/${SDK_VERSION}/surveys.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(await res.text()).toBe('');
  });

  it('is a dynamic route on the Node runtime', () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
  });
});

describe('/ingest sends no member credential and passes back no cookie, on every request the SDK makes', () => {
  // The first test is one POST of events. Most of the requests that carry the
  // session cookies are GETs: the remote config on every page load, the
  // bundles (a script tag with crossOrigin 'anonymous' still sends this
  // origin's cookies), the surveys and tours lists. For each request the SDK
  // makes, by its method (and a GET's by HEAD too): only SENT_HEADERS go out,
  // and PostHog's Set-Cookie and its other headers do not come back.
  it.each(SDK_REQUESTS)('%s /ingest%s', async (sdkMethod, path) => {
    upstream.mockImplementation(
      async () =>
        new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=300',
            'set-cookie': 'ph_placeholder=1; Path=/',
            'x-placeholder-upstream': '1',
          },
        }),
    );

    const methods: Method[] = sdkMethod === 'GET' ? ['GET', 'HEAD'] : ['POST'];
    for (const [call, method] of methods.entries()) {
      const req =
        method === 'POST'
          ? batchPost(`/ingest${path}`, batchJson(), BROWSER_HEADERS)
          : incoming(`/ingest${path}`, { method, headers: BROWSER_HEADERS });
      // The route is handed the member's cookie: this cannot pass by never seeing one.
      expect(req.headers.get('cookie'), method).toBe(MEMBER_COOKIE);

      const res = await answerOf(req);

      const sent = await sentToPostHog(call);
      expect(sent.method).toBe(method);
      expect([...sent.headers.keys()].sort(), method).toEqual(
        method === 'POST' ? SENT_HEADERS_POST : SENT_HEADERS,
      );
      for (const piece of NEVER_SENT) {
        expect(everythingIn(sent), `${method} ${piece}`).not.toContain(piece);
      }
      expect(res.status, method).toBe(200);
      expect(res.headers.getSetCookie(), method).toEqual([]);
      expect([...res.headers.keys()].sort(), method).toEqual([
        'cache-control',
        'content-type',
        'x-content-type-options',
      ]);
    }
    expect(upstream).toHaveBeenCalledTimes(methods.length);
  });
});

describe('/ingest takes each path only by the method the SDK uses for it', () => {
  // POST for events; GET (and HEAD) for the lists, the remote config and the
  // bundles. Every other
  // method Next hands to a route is the route's to refuse, OPTIONS, PUT,
  // PATCH and DELETE included: left to Next, OPTIONS would get Next's 204
  // with one Allow for every path, and the others a 405 with no Allow and no
  // log line. Next answers HEAD with the GET handler when a route exports no
  // HEAD, so the route checks the method itself.
  it.each(SDK_REQUESTS)(
    "%s /ingest%s: any other method answers 405 with the path's Allow, no body and one log line, and PostHog is not asked",
    async (sdkMethod, path) => {
      const allowed: Method[] = sdkMethod === 'GET' ? ['GET', 'HEAD'] : ['POST'];
      const others = HTTP_METHODS.filter((method) => !allowed.includes(method));
      expect(others).toEqual(expect.arrayContaining(['OPTIONS', 'PUT', 'PATCH', 'DELETE']));
      for (const method of others) {
        const res = await ask(method, `/ingest${path}`);

        expect(res.status, method).toBe(405);
        expect(await res.text(), method).toBe('');
        expect(res.headers.get('x-content-type-options'), method).toBe('nosniff');
        expect(res.headers.get('allow'), method).toBe(allowed.join(', '));
      }
      expect(upstream).not.toHaveBeenCalled();
      const pathname = new URL(`/ingest${path}`, SITE).pathname;
      expect(refusals()).toEqual(
        others.map((method) => [
          '[ingest] refused',
          { status: 405, reason: 'method', method, path: pathname },
        ]),
      );
    },
  );

  it.each([
    ['POST', `/ingest/static/${SDK_VERSION}/surveys.js`],
    ['PUT', '/ingest/e/'],
    ['PATCH', '/ingest/e/'],
    ['DELETE', '/ingest/e/'],
    ['PUT', `/ingest/array/${PROJECT_REF}/config.js`],
  ] as const)('answers 405 to %s %s before reading a byte of its body', async (method, path) => {
    const { stream, seen } = chunkedBody(1024, 256);
    const res = await answerOf(incoming(path, { method, body: stream }));

    expect(res.status).toBe(405);
    expect(seen.pulled).toBe(0);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('/ingest refuses every other path with 404, no body and no request to PostHog', () => {
  it.each([
    ['/ingest with nothing after it', '/ingest/'],
    ['a page of ours', '/ingest/login'],
    ["PostHog's private API", '/ingest/api/projects/1/'],
    ["another project's remote config", `/ingest/array/${OTHER_PROJECT}/config.js`],
    ["another project's remote config, as JSON", `/ingest/array/${OTHER_PROJECT}/config`],
    ['another file under our own key', `/ingest/array/${PROJECT_REF}/other.js`],
    ['a site app (opt_in_site_apps is off)', '/ingest/site_app/1/x/y/'],
    ['dot segments into another endpoint', `/ingest/static/${SDK_VERSION}/../../api/projects/1/`],
    ['dot segments out of an allowed path', `/ingest/e/../decide/?v=3`],
    ['encoded dot segments', '/ingest/%2e%2e/%2E%2E/api/projects/'],
    [
      'dot segments into another project',
      `/ingest/static/${SDK_VERSION}/../../array/${OTHER_PROJECT}/config.js`,
    ],
    ['an extra segment under /static/<version>/', `/ingest/static/${SDK_VERSION}/extra/surveys.js`],
    ['a bundle these options never load', `/ingest/static/${SDK_VERSION}/tracing-headers.js`],
    ['a bundle these options never load, unversioned', '/ingest/static/intercom-integration.js'],
    // The toolbar talks to PostHog's app host, which the CSP's connect-src
    // does not allow, so it cannot work here; served, a crafted #__posthog=
    // link would load it from our origin on every later page.
    ['the toolbar', `/ingest/static/${SDK_VERSION}/toolbar.js`],
    ['the toolbar, by its fallback address', `/ingest/static/toolbar.js?v=${SDK_VERSION}`],
    [
      'the toolbar, by its fallback address with its time',
      `/ingest/static/toolbar.js?v=${SDK_VERSION}&t=1700000000000`,
    ],
    // recorder and recorder-v2 define no initSessionRecording, so with
    // posthog-js 1.438.15 they cannot record at all.
    ['a recorder bundle that cannot record', `/ingest/static/${SDK_VERSION}/recorder.js`],
    [
      'a recorder bundle that cannot record, unversioned',
      `/ingest/static/recorder.js?v=${SDK_VERSION}`,
    ],
    [
      'the other recorder bundle that cannot record',
      `/ingest/static/${SDK_VERSION}/recorder-v2.js`,
    ],
    [
      'the other recorder bundle that cannot record, unversioned',
      `/ingest/static/recorder-v2.js?v=${SDK_VERSION}`,
    ],
    ['a file that is not a bundle', '/ingest/static/array.js'],
    ['a source map', `/ingest/static/${SDK_VERSION}/surveys.js.map`],
    ['a version that is not one', '/ingest/static/latest/surveys.js'],
    ['a path that only starts like /static/', '/ingest/statics/placeholder.js'],
    ['an events path with no trailing slash', '/ingest/e'],
    ['an events path with more after it', '/ingest/e/x'],
    ['the old flags endpoint', '/ingest/decide/?v=3'],
    [
      'web experiments (disable_web_experiments)',
      `/ingest/api/web_experiments/?token=${PROJECT_REF}`,
    ],
    ['metrics (never sent with these options)', `/ingest/i/v1/metrics?token=${PROJECT_REF}`],
    [
      'early access features (never asked for)',
      `/ingest/api/early_access_features/?token=${PROJECT_REF}`,
    ],
    // What the provider's init switches off (components/analytics/
    // posthog-provider.tsx), so the SDK never asks for it: feature flags
    // (advanced_disable_feature_flags), session replay
    // (disable_session_recording), console logs (logs.beforeSend drops every
    // record) and Conversations (disable_conversations), each with the
    // bundles only it loads.
    ['feature flags', '/ingest/flags/?v=2'],
    ['feature flags, with no query', '/ingest/flags/'],
    [
      'feature flags, for surveys only',
      '/ingest/flags/?v=2&only_evaluate_survey_feature_flags=true',
    ],
    ['replay snapshots', '/ingest/s/'],
    ['replay snapshots, base64', '/ingest/s/?compression=base64'],
    ['console logs', `/ingest/i/v1/logs?token=${PROJECT_REF}`],
    ['a Conversations message', '/ingest/api/conversations/v1/widget/message'],
    ["a Conversations ticket's messages", `/ingest/api/conversations/v1/widget/messages/${TICKET}`],
    [
      'marking a Conversations ticket read',
      `/ingest/api/conversations/v1/widget/messages/${TICKET}/read`,
    ],
    ['the Conversations tickets', '/ingest/api/conversations/v1/widget/tickets?limit=20'],
    ['a Conversations restore', '/ingest/api/conversations/v1/widget/restore'],
    ['a Conversations restore link', '/ingest/api/conversations/v1/widget/restore/request'],
    ['the Conversations bundle', `/ingest/static/${SDK_VERSION}/conversations.js`],
    ['the Conversations bundle, unversioned', `/ingest/static/conversations.js?v=${SDK_VERSION}`],
    ['the recorder', `/ingest/static/${SDK_VERSION}/lazy-recorder.js`],
    ['the recorder, unversioned', `/ingest/static/lazy-recorder.js?v=${SDK_VERSION}`],
    [
      'the recorder the remote config can name',
      `/ingest/static/${SDK_VERSION}/posthog-recorder.js`,
    ],
    [
      'the recorder the remote config can name, unversioned',
      `/ingest/static/posthog-recorder.js?v=${SDK_VERSION}`,
    ],
    // The version under /static/ is the only segment not spelled out whole.
    // It takes only the characters a version is made of, never a '%', so no
    // encoded slash inside one reaches PostHog.
    [
      "an encoded traversal in a version's pre-release part",
      `/ingest/static/${SDK_VERSION}-${encodedWhole('x/../../array/other/config.js?')}/surveys.js`,
    ],
    [
      "an encoded traversal after a version's numbers",
      `/ingest/static/1.2.3${encodedWhole('/../../array/other/config.js?')}/surveys.js`,
    ],
    ['a path that would read as another host', '/ingest//other.example/x'],
    ['an encoded slash', '/ingest/static/..%2F..%2Fapi%2Fprojects%2F'],
    ['an encoded slash in lower case', '/ingest/e%2f'],
    ['an encoded backslash', '/ingest/static/%5C..%5Capi'],
  ])('refuses %s (%s), by every method', async (_label, path) => {
    for (const method of HTTP_METHODS) {
      const res = await ask(method, path);

      expect(res.status, method).toBe(404);
      expect(await res.text(), method).toBe('');
      expect(res.headers.get('x-content-type-options'), method).toBe('nosniff');
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(refusals().map(([, line]) => line)).toEqual(
      HTTP_METHODS.map((method) => ({
        status: 404,
        reason: 'path',
        method,
        path: new URL(path, SITE).pathname,
      })),
    );
  });

  it('refuses every /array/ path when no project key is set', async () => {
    postHogEnv.NEXT_PUBLIC_POSTHOG_KEY = '';

    for (const path of [
      `/ingest/array/${PROJECT_REF}/config.js`,
      `/ingest/array/${PROJECT_REF}/config`,
      '/ingest/array//config.js',
    ]) {
      const res = await route.GET(incoming(path));
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toBe('');
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('/ingest passes on only the query parameters the SDK sends to each path', () => {
  // Per path, the names posthog-js 1.438.15 puts in a query, each once and
  // with a value of the form the SDK gives it:
  //   /e/, /i/v0/e/                      compression=base64, retry_count=<n>
  //   /api/surveys/, /api/product_tours/ token=<this app's key>, _=<ms>
  //   /static/<name>.js                  v=<version>
  //   /static/<version>/<name>.js, /array/<key>/config(.js)   none
  // Any other name, a name twice or a value of another form answers 404, and
  // PostHog is not asked.
  const BUNDLE = `/static/${SDK_VERSION}/surveys.js`;
  const FALLBACK = '/static/surveys.js';
  const SURVEYS = '/api/surveys/';
  const TOURS = '/api/product_tours/';
  const CONFIG_JS = `/array/${PROJECT_REF}/config.js`;
  const CONFIG = `/array/${PROJECT_REF}/config`;

  it.each([
    // A batch in the query. PostHog's capture reads one from data= before
    // the body, so it never goes on, whatever the body is.
    ['POST', '/e/?data=placeholder'],
    ['POST', `/e/?data=${encodeURIComponent(batchJson(OTHER_PROJECT))}`],
    ['POST', '/i/v0/e/?data=placeholder'],
    ['POST', '/e/?compression=base64&data=placeholder'],
    ['POST', '/e/?%64ata=placeholder'],
    ['POST', '/e/?data='],
    // Names that would pick a project, or a person, on some PostHog endpoint.
    ['POST', '/e/?personal_api_key=phx_placeholder'],
    ['POST', '/e/?temporary_token=placeholder'],
    ['GET', `${SURVEYS}?token=${PROJECT_REF}&personal_api_key=phx_placeholder`],
    ['GET', `${TOURS}?token=${PROJECT_REF}&temporary_token=placeholder`],
    // A name the SDK does not send to that path, though it sends it to
    // another, or older SDKs did.
    ['POST', '/e/?placeholder_name=1'],
    ['POST', '/e/?_=1700000000000'],
    ['POST', '/e/?sent_at=1700000000000'],
    ['POST', `/e/?ver=${SDK_VERSION}`],
    ['POST', '/e/?ip=0'],
    ['POST', '/e/?beacon=1'],
    ['POST', '/e/?v=2'],
    ['POST', `/i/v0/e/?token=${PROJECT_REF}`],
    ['GET', `${SURVEYS}?token=${PROJECT_REF}&compression=base64`],
    ['GET', `${TOURS}?token=${PROJECT_REF}&v=2`],
    ['GET', `${BUNDLE}?v=${SDK_VERSION}`],
    ['GET', `${BUNDLE}?t=1700000000000`],
    ['GET', `${FALLBACK}?v=${SDK_VERSION}&t=1700000000000`],
    ['GET', `${FALLBACK}?token=${PROJECT_REF}`],
    ['GET', `${CONFIG_JS}?callback=placeholder`],
    ['GET', `${CONFIG_JS}?token=${PROJECT_REF}`],
    ['HEAD', `${CONFIG_JS}?_=1700000000000`],
    ['GET', `${CONFIG}?callback=placeholder`],
    ['HEAD', `${CONFIG}?v=2`],
    // No name at all, and a name of escapes only.
    ['POST', '/e/?=1'],
    ['GET', `${SURVEYS}?token=${PROJECT_REF}&=1`],
    ['GET', `${SURVEYS}?token=${PROJECT_REF}&%00=1`],
    // A name twice: PostHog's services differ on which value they read.
    ['POST', '/e/?compression=base64&compression=base64'],
    ['POST', '/e/?retry_count=1&retry_count=2'],
    ['GET', `${SURVEYS}?token=${PROJECT_REF}&_=1&_=2`],
    ['GET', `${FALLBACK}?v=${SDK_VERSION}&v=${SDK_VERSION}`],
    // A value of another form than the SDK's.
    ['POST', '/e/?compression=gzip-js'],
    ['POST', '/e/?compression=gzip'],
    ['POST', '/e/?compression=lz64'],
    ['POST', '/e/?compression=Base64'],
    ['POST', '/e/?compression='],
    ['POST', '/e/?compression'],
    ['POST', '/e/?retry_count=one'],
    ['POST', '/e/?retry_count=-1'],
    ['POST', '/e/?retry_count=12345'],
    ['POST', '/e/?retry_count='],
    ['GET', `${SURVEYS}?token=${PROJECT_REF}&_=now`],
    ['GET', `${SURVEYS}?token=${PROJECT_REF}&_=1700000000000%26token%3D${OTHER_PROJECT}`],
    ['GET', `${SURVEYS}?token=${PROJECT_REF}&_=1;token=${OTHER_PROJECT}`],
    ['GET', `${FALLBACK}?v=latest`],
    ['GET', `${FALLBACK}?v=`],
    ['GET', `${FALLBACK}?v=${SDK_VERSION}%2F..%2F..%2Farray`],
  ] as const)('refuses %s /ingest%s with 404', async (method, path) => {
    const res = await ask(method, `/ingest${path}`);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(upstream).not.toHaveBeenCalled();
    expect(refusals()).toEqual([
      [
        '[ingest] refused',
        {
          status: 404,
          reason: 'query',
          method,
          path: new URL(`/ingest${path}`, SITE).pathname,
        },
      ],
    ]);
  });

  it.each([
    ['GET', `${SURVEYS}?token=${OTHER_PROJECT}&_=1700000000000`],
    ['GET', `${TOURS}?token=${OTHER_PROJECT}&_=1700000000000`],
    ['HEAD', `${SURVEYS}?token=${OTHER_PROJECT}`],
    // A second token, an empty one, ours with a space, a name spelled encoded.
    ['GET', `${SURVEYS}?token=${PROJECT_REF}&token=${OTHER_PROJECT}`],
    ['GET', `${SURVEYS}?token=${OTHER_PROJECT}&token=${PROJECT_REF}`],
    ['GET', `${SURVEYS}?token=&_=1700000000000`],
    ['GET', `${SURVEYS}?token=${PROJECT_REF}%20`],
    ['GET', `${SURVEYS}?%74oken=${OTHER_PROJECT}`],
    // PostHog takes a GET's project from api_key when the query has no token
    // (posthog/api/utils.py get_token; the surveys service's extract_token:
    // token, then api_key). The SDK never sends that name, so it is refused
    // whatever its value: another project's, alone, after an empty token,
    // next to our token, spelled encoded, empty, and this app's own.
    ['GET', `${SURVEYS}?api_key=${OTHER_PROJECT}&_=1700000000000`],
    ['GET', `${TOURS}?api_key=${OTHER_PROJECT}&_=1700000000000`],
    ['HEAD', `${SURVEYS}?api_key=${OTHER_PROJECT}`],
    ['GET', `${TOURS}?token=&api_key=${OTHER_PROJECT}`],
    ['GET', `${SURVEYS}?token=${PROJECT_REF}&api_key=${OTHER_PROJECT}`],
    ['GET', `${SURVEYS}?%61pi_key=${OTHER_PROJECT}`],
    ['GET', `${TOURS}?api_key=&_=1700000000000`],
    ['GET', `${SURVEYS}?api_key=${PROJECT_REF}&_=1700000000000`],
    ['GET', `${TOURS}?token=${PROJECT_REF}&api_key=${PROJECT_REF}`],
    // On the event paths the project is named in the batch, never the query.
    ['POST', `/e/?token=${OTHER_PROJECT}`],
    ['POST', `/e/?api_key=${OTHER_PROJECT}`],
    ['POST', `/e/?api_key=${PROJECT_REF}`],
  ] as const)(
    "refuses %s /ingest%s with 404: a project key in the query that is not this app's own, under the name the SDK sends it",
    async (method, path) => {
      const res = await ask(method, `/ingest${path}`);

      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(upstream).not.toHaveBeenCalled();
      expect(refusals()).toHaveLength(1);
      expect(refusals()[0]![1]).toMatchObject({ status: 404, reason: 'query' });
    },
  );

  it('refuses every token when no project key is set', async () => {
    postHogEnv.NEXT_PUBLIC_POSTHOG_KEY = '';

    for (const [method, path] of [
      ['GET', `/ingest${SURVEYS}?token=${PROJECT_REF}`],
      ['GET', `/ingest${TOURS}?token=&_=1700000000000`],
      ['HEAD', `/ingest${SURVEYS}?token=`],
    ] as const) {
      const res = await ask(method, path);
      expect(res.status, path).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('asks PostHog with the pairs it checked, written again: a name spelled with escapes goes on plain', async () => {
    for (const [method, path, asked] of [
      [
        'GET',
        `${SURVEYS}?%74oken=${PROJECT_REF}&%5F=1700000000000`,
        `${API}${SURVEYS}?token=${PROJECT_REF}&_=1700000000000`,
      ],
      ['GET', `${FALLBACK}?%76=${SDK_VERSION}`, `${ASSETS}${FALLBACK}?v=${SDK_VERSION}`],
      [
        'POST',
        '/e/?retry_count=%32&%63ompression=base64',
        `${API}/e/?retry_count=2&compression=base64`,
      ],
      // No parameter at all: no '?' either.
      ['GET', `${SURVEYS}?`, `${API}${SURVEYS}`],
      ['POST', '/e/?&', `${API}/e/`],
    ] as const) {
      upstream.mockClear();
      const res = await ask(method, `/ingest${path}`);

      expect(res.status, path).toBe(200);
      expect((await sentToPostHog()).url, path).toBe(asked);
    }
  });
});

describe("/ingest passes on an event batch only for this app's own PostHog project", () => {
  // PostHog files a batch under the project its body names. The SDK builds
  // one as { api_key, batch, sent_at } and packs it one of three ways; the
  // route unpacks it that one way and passes it on, bytes unchanged, only if
  // it names this app's project and no other. (That each packing of our own
  // batch goes on byte for byte is tested with the SDK's requests above.)
  const EVENT_PATHS = ['/ingest/e/', '/ingest/i/v0/e/'] as const;
  const ours = eventFor(PROJECT_REF);
  const theirs = eventFor(OTHER_PROJECT);

  /** A batch written field by field, for the ones the SDK would not build. */
  function batchOf(fields: Record<string, unknown>): string {
    return JSON.stringify(fields);
  }

  async function expectRefused(requests: NextRequest[]): Promise<void> {
    for (const request of requests) {
      const res = await route.POST(request);
      const at = `${new URL(request.url).pathname}${new URL(request.url).search}`;

      expect(res.status, at).toBe(404);
      expect(await res.text(), at).toBe('');
      expect(res.headers.get('x-content-type-options'), at).toBe('nosniff');
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(refusals()).toEqual(
      requests.map((request) => [
        '[ingest] refused',
        { status: 404, reason: 'body', method: 'POST', path: new URL(request.url).pathname },
      ]),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(OTHER_PROJECT);
  }

  it.each([
    ["another project's batch", batchJson(OTHER_PROJECT)],
    [
      "another project's key on the batch, over our own events",
      batchOf({ api_key: OTHER_PROJECT, batch: [ours], sent_at: SENT_AT }),
    ],
    [
      "our batch with another project's event in it (properties.token)",
      batchJson(PROJECT_REF, [ours, theirs]),
    ],
    [
      'our batch with an event that names another project as token',
      batchJson(PROJECT_REF, [{ ...ours, token: OTHER_PROJECT }]),
    ],
    [
      'our batch with an event that names another project as api_key',
      batchJson(PROJECT_REF, [{ ...ours, api_key: OTHER_PROJECT }]),
    ],
    [
      'our batch with an event that names another project as $token',
      batchJson(PROJECT_REF, [{ ...ours, $token: OTHER_PROJECT }]),
    ],
    ['a batch with no key', batchOf({ batch: [ours], sent_at: SENT_AT })],
    ['a batch whose key is empty', batchOf({ api_key: '', batch: [ours], sent_at: SENT_AT })],
    ['a batch whose key is null', batchOf({ api_key: null, batch: [ours], sent_at: SENT_AT })],
    [
      'a batch whose key is a list holding ours',
      batchOf({ api_key: [PROJECT_REF], batch: [ours], sent_at: SENT_AT }),
    ],
    [
      'a batch whose key is ours with a space after it',
      batchOf({ api_key: `${PROJECT_REF} `, batch: [ours], sent_at: SENT_AT }),
    ],
    [
      'a batch keyed as token, which the SDK never writes',
      batchOf({ token: PROJECT_REF, batch: [ours], sent_at: SENT_AT }),
    ],
    [
      'our batch that names another project as token beside its api_key',
      batchOf({ api_key: PROJECT_REF, token: OTHER_PROJECT, batch: [ours], sent_at: SENT_AT }),
    ],
    [
      'our batch that names another project as $token beside its api_key',
      batchOf({ api_key: PROJECT_REF, $token: OTHER_PROJECT, batch: [ours], sent_at: SENT_AT }),
    ],
    // PostHog reads a body that fails as a batch as one event instead. With
    // nothing at the top but the SDK's three fields, there is no such
    // second reading.
    [
      "our batch that also reads as one event of another project's",
      batchOf({
        api_key: PROJECT_REF,
        batch: [ours],
        sent_at: SENT_AT,
        event: '$pageview',
        properties: { token: OTHER_PROJECT },
      }),
    ],
    [
      'our batch that also reads as one event, with a sent_at no batch has',
      batchOf({
        api_key: PROJECT_REF,
        batch: [ours],
        sent_at: 1700000000000,
        event: '$pageview',
        properties: { token: OTHER_PROJECT },
      }),
    ],
    [
      'our batch with one more field at the top',
      batchOf({
        api_key: PROJECT_REF,
        batch: [ours],
        sent_at: SENT_AT,
        historical_migration: true,
      }),
    ],
    ['our events as a list, with no batch around them', JSON.stringify([ours])],
    ['one event of ours, with no batch around it', JSON.stringify(ours)],
    ['our batch of no events', batchJson(PROJECT_REF, [])],
    [
      'our batch whose events are one object, not a list',
      batchOf({ api_key: PROJECT_REF, batch: ours, sent_at: SENT_AT }),
    ],
    ['our batch with an event that is text', batchJson(PROJECT_REF, [ours, 'placeholder'])],
    ['our batch with an event that is null', batchJson(PROJECT_REF, [null])],
    ['our batch with an event that is a list', batchJson(PROJECT_REF, [[ours]])],
    [
      'our batch with an event whose properties are text',
      batchJson(PROJECT_REF, [{ event: '$pageview', properties: 'token' }]),
    ],
    [
      'our batch with an event whose properties are a list',
      batchJson(PROJECT_REF, [{ event: '$pageview', properties: [{ token: PROJECT_REF }] }]),
    ],
    [
      "our batch with its key written twice, another project's last",
      `{"api_key":"${PROJECT_REF}","batch":[${JSON.stringify(ours)}],"api_key":"${OTHER_PROJECT}"}`,
    ],
    ['JSON that is null', 'null'],
    ['JSON that is our key as text', JSON.stringify(PROJECT_REF)],
    ['JSON that is a number', '1'],
    ['text that is not JSON', `{"api_key":"${PROJECT_REF}","batch":[`],
    ['nothing', ''],
    ['our batch with a byte order mark before it', `\uFEFF${batchJson()}`],
    ["our batch with another project's after it", `${batchJson()}${batchJson(OTHER_PROJECT)}`],
  ])('refuses %s, however it is packed, on both event paths', async (_label, json) => {
    await expectRefused(
      EVENT_PATHS.flatMap((path) =>
        PACKINGS.map((packing) => {
          const { query, contentType, body } = packed(packing, json);
          return incoming(`${path}${query ? `?${query}` : ''}`, {
            method: 'POST',
            headers: { 'content-type': contentType },
            body,
          });
        }),
      ),
    );
  });

  // The SDK writes every batch with JSON.stringify (@posthog/browser-common
  // utils/request-utils.js jsonStringify), and only a text written that one
  // way goes on. JSON.parse keeps the last of two members with one name;
  // another reader may keep the first, or refuse both. A text JSON.stringify
  // writes has no name twice, so every reader finds the batch the route
  // read. Each text below is a batch of OURS as JSON.parse reads it: written
  // again by JSON.stringify it passes, so each refusal is for how it is
  // written.
  const oursText = JSON.stringify(ours);
  const theirsText = JSON.stringify(theirs);
  /** A batch whose one event is this text, with our key. */
  const withEvent = (event: string) =>
    `{"api_key":"${PROJECT_REF}","batch":[${event}],"sent_at":"${SENT_AT}"}`;

  it.each([
    // A name twice, wherever the route reads a key: another project's
    // first, ours last.
    [
      "with its key written twice, another project's first",
      `{"api_key":"${OTHER_PROJECT}","api_key":"${PROJECT_REF}","batch":[${oursText}],"sent_at":"${SENT_AT}"}`,
    ],
    [
      "with its key written twice, another project's first with its name spelled with an escape",
      `{"api\\u005fkey":"${OTHER_PROJECT}","api_key":"${PROJECT_REF}","batch":[${oursText}],"sent_at":"${SENT_AT}"}`,
    ],
    [
      "with its events written twice, another project's first",
      `{"api_key":"${PROJECT_REF}","batch":[${theirsText}],"batch":[${oursText}],"sent_at":"${SENT_AT}"}`,
    ],
    [
      "with an event whose token is written twice, another project's first",
      withEvent(`{"event":"$pageview","token":"${OTHER_PROJECT}","token":"${PROJECT_REF}"}`),
    ],
    [
      "with an event whose api_key is written twice, another project's first",
      withEvent(`{"event":"$pageview","api_key":"${OTHER_PROJECT}","api_key":"${PROJECT_REF}"}`),
    ],
    [
      "with an event whose $token is written twice, another project's first",
      withEvent(`{"event":"$pageview","$token":"${OTHER_PROJECT}","$token":"${PROJECT_REF}"}`),
    ],
    [
      "with an event whose properties are written twice, another project's first",
      withEvent(
        `{"event":"$pageview","properties":{"token":"${OTHER_PROJECT}"},"properties":{"token":"${PROJECT_REF}"}}`,
      ),
    ],
    [
      "with an event whose properties.token is written twice, another project's first",
      withEvent(
        `{"event":"$pageview","properties":{"token":"${OTHER_PROJECT}","token":"${PROJECT_REF}"}}`,
      ),
    ],
    [
      "with no sent_at and its key written twice, another project's first",
      `{"api_key":"${OTHER_PROJECT}","api_key":"${PROJECT_REF}","batch":[${oursText}]}`,
    ],
    // A name twice where no key is read: the same rule, at any depth.
    [
      'with its key written twice, ours both times',
      `{"api_key":"${PROJECT_REF}","api_key":"${PROJECT_REF}","batch":[${oursText}],"sent_at":"${SENT_AT}"}`,
    ],
    [
      'with its sent_at written twice',
      `{"api_key":"${PROJECT_REF}","batch":[${oursText}],"sent_at":"${SENT_AT}","sent_at":"${SENT_AT}"}`,
    ],
    [
      'with a name written twice deep inside an event',
      withEvent(
        `{"event":"$pageview","properties":{"token":"${PROJECT_REF}","$set":{"plan":[{"tier":"a","tier":"b"}]}}}`,
      ),
    ],
    // Each name once, but not as JSON.stringify writes it.
    ['with a space before it', ` ${batchJson()}`],
    ['with a line break after it', `${batchJson()}\n`],
    ['with a space after a comma', batchJson().replace(',"batch"', ', "batch"')],
    [
      "with its key's name spelled with an escape",
      batchJson().replace('"api_key"', '"api\\u005fkey"'),
    ],
    [
      'with its key spelled with an escape',
      batchJson().replace(`"${PROJECT_REF}"`, `"\\u0070${PROJECT_REF.slice(1)}"`),
    ],
    [
      'with a slash spelled with an escape',
      batchJson(PROJECT_REF, [{ ...ours, at: '/dashboard' }]).replace(
        '"/dashboard"',
        '"\\/dashboard"',
      ),
    ],
    [
      'with a number written another way',
      batchJson(PROJECT_REF, [{ ...ours, offset: 1000 }]).replace(':1000', ':1e3'),
    ],
    // The same length as JSON.stringify's text, which puts whole-number
    // names first, lowest first.
    [
      'with whole-number names in another order',
      batchJson(PROJECT_REF, [{ ...ours, sizes: { 1: 'a', 2: 'b' } }]).replace(
        '"1":"a","2":"b"',
        '"2":"b","1":"a"',
      ),
    ],
  ])('refuses our batch %s, however it is packed, on both event paths', async (_label, json) => {
    // What the route reads from it is a batch of ours: written the one way,
    // it goes on.
    const writtenAgain = JSON.stringify(JSON.parse(json));
    expect(writtenAgain).not.toBe(json);
    const control = await route.POST(
      incoming('/ingest/e/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bytes(writtenAgain),
      }),
    );
    expect(control.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    upstream.mockClear();

    await expectRefused(
      EVENT_PATHS.flatMap((path) =>
        PACKINGS.map((packing) => {
          const { query, contentType, body } = packed(packing, json);
          return incoming(`${path}${query ? `?${query}` : ''}`, {
            method: 'POST',
            headers: { 'content-type': contentType },
            body,
          });
        }),
      ),
    );
  });

  it('refuses our batch nested deeper than JSON.stringify writes, however it is packed, on both event paths', async () => {
    const DEPTH = 200_000;
    const json = withEvent(
      `{"event":"$pageview","properties":{"token":"${PROJECT_REF}","deep":${'['.repeat(DEPTH)}${']'.repeat(DEPTH)}}}`,
    );
    // JSON.parse reads it; JSON.stringify gives up on what was read, so it
    // cannot be told whether the text is the one JSON.stringify writes.
    const read = JSON.parse(json) as { api_key: unknown };
    expect(read.api_key).toBe(PROJECT_REF);
    expect(() => JSON.stringify(read)).toThrow(RangeError);

    await expectRefused(
      EVENT_PATHS.flatMap((path) =>
        PACKINGS.map((packing) => {
          const { query, contentType, body } = packed(packing, json);
          return incoming(`${path}${query ? `?${query}` : ''}`, {
            method: 'POST',
            headers: { 'content-type': contentType },
            body,
          });
        }),
      ),
    );
  });

  // A batch is nested at most this many levels: { batch: [ { properties: {
  // are four, and posthog-js 1.438.15 builds none deeper than nine (an
  // exception with its stack frames).
  const MOST_LEVELS = 64;
  /**
   * Our batch whose one event holds `levels` levels in all, the batch's own
   * four among them; `before` is written into its properties first.
   */
  const eventNestedTo = (levels: number, before = '') =>
    `{"event":"$pageview","properties":{"token":"${PROJECT_REF}"${before},"deep":${'['.repeat(levels - 4)}0${']'.repeat(levels - 4)}}}`;
  const nestedTo = (levels: number, before = '') => withEvent(eventNestedTo(levels, before));
  /** The same, nested in objects. */
  const objectsTo = (levels: number) =>
    withEvent(
      `{"event":"$pageview","properties":{"token":"${PROJECT_REF}","deep":${'{"a":'.repeat(levels - 4)}0${'}'.repeat(levels - 4)}}}`,
    );
  /** Each packing of `json` to both event paths. */
  const everyWay = (json: string) =>
    EVENT_PATHS.flatMap((path) =>
      PACKINGS.map((packing) => {
        const { query, contentType, body } = packed(packing, json);
        return incoming(`${path}${query ? `?${query}` : ''}`, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
        });
      }),
    );

  it.each([
    ['one level deeper than the most', nestedTo(MOST_LEVELS + 1)],
    ['in objects one level deeper than the most', objectsTo(MOST_LEVELS + 1)],
    [
      'deeper than the most after text that ends in a backslash',
      nestedTo(MOST_LEVELS + 1, ',"note":"placeholder \\\\"'),
    ],
    [
      'deeper than the most, many times over, as large as a batch may be',
      (() => {
        const unit = `${'['.repeat(MOST_LEVELS)}${']'.repeat(MOST_LEVELS)}`;
        const one = nestedTo(5);
        const count = Math.floor((MOST_BATCH_BYTES - one.length) / (unit.length + 1));
        return one.replace('"deep":[0]', `"deep":[${Array(count).fill(unit).join(',')}]`);
      })(),
    ],
    [
      'deeper than the most after text that holds closing brackets and braces',
      nestedTo(MOST_LEVELS + 1, `,"note":"${']'.repeat(MOST_LEVELS)}${'}'.repeat(MOST_LEVELS)}"`),
    ],
    [
      'deeper than the most in its last event only, after many ordinary ones',
      withEvent(`${Array(MOST_LEVELS).fill(oursText).join(',')},${eventNestedTo(MOST_LEVELS + 1)}`),
    ],
    [
      'deeper than the most only at the end of a batch as large as a batch may be',
      (() => {
        const last = eventNestedTo(MOST_LEVELS + 1);
        const room = MOST_BATCH_BYTES - withEvent(last).length - 1;
        const count = Math.floor(room / (oursText.length + 1));
        return withEvent(`${Array(count).fill(oursText).join(',')},${last}`);
      })(),
    ],
  ])(
    'refuses, before reading it, our batch nested %s, however it is packed, on both event paths',
    async (_, json) => {
      expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MOST_BATCH_BYTES);
      for (const packing of PACKINGS) {
        expect(packed(packing, json).body.byteLength).toBeLessThanOrEqual(CAP);
      }
      // It is our batch, written as JSON.stringify writes it, with no more
      // names than the most: only how deep it is nested sets it apart.
      expect(JSON.stringify(JSON.parse(json))).toBe(json);
      expect(namesIn(JSON.parse(json))).toBeLessThanOrEqual(MOST_NAMES);
      const parse = vi.spyOn(JSON, 'parse');

      await expectRefused(everyWay(json));
      // Refused on the count alone: the text is never read as JSON.
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it('passes on our batch nested to the most levels, one with many events, and one with any number of brackets inside its text', async () => {
    const atTheMost = [nestedTo(MOST_LEVELS), objectsTo(MOST_LEVELS)];
    // Each event closes what it opened: levels are counted down again.
    const manyEvents = batchJson(
      PROJECT_REF,
      Array.from({ length: MOST_LEVELS * 2 }, () => ({
        ...ours,
        properties: { ...(ours.properties as object), list: [[1], {}] },
      })),
    );
    const marksInText = batchJson(PROJECT_REF, [
      {
        ...ours,
        properties: {
          ...(ours.properties as Record<string, unknown>),
          brackets: '['.repeat(MOST_LEVELS * 4) + '{'.repeat(MOST_LEVELS * 4),
          quoted: `\\" ${'[{'.repeat(MOST_LEVELS * 2)} \\\\`,
          names: { ['['.repeat(MOST_LEVELS * 2)]: '"]}'.repeat(MOST_LEVELS * 2) },
        },
      },
    ]);
    for (const json of [...atTheMost, manyEvents, marksInText]) {
      for (const request of everyWay(json)) {
        upstream.mockClear();
        const at = `${request.url} ${json.length}`;
        const res = await route.POST(request);

        expect(res.status, at).toBe(200);
        expect(upstream, at).toHaveBeenCalledTimes(1);
      }
    }
    expect(refusals()).toEqual([]);
  });

  // A batch holds at most MOST_NAMES names, counting every member of every
  // object in it, the batch's own among them. posthog-js 1.438.15's events
  // hold about one name for every 45 bytes or more.
  /** The seven names of our batch with one event, before what its properties list holds. */
  const OWN_NAMES = 7;
  /** Our batch holding `names` names in all: its own, then objects of one name each. */
  const namesTo = (names: number, name = (_: number) => 'a', before = '') =>
    withEvent(
      `{"event":"$pageview","properties":{"token":"${PROJECT_REF}"${before},"list":[${Array.from(
        { length: names - OWN_NAMES - (before ? 1 : 0) },
        (_, i) => `{"${name(i)}":0}`,
      ).join(',')}]}}`,
    );
  /** Our batch of ordinary events and, last, one that holds the rest of `names` names. */
  const namesInLastEvent = (names: number) => {
    const ordinary = Array(1000).fill(oursText).join(',');
    // The batch's own three, the ordinary events', and the last event's own four.
    const restOf = names - 3 - 1000 * namesIn(ours) - 4;
    return withEvent(
      `${ordinary},{"event":"$pageview","properties":{"token":"${PROJECT_REF}","list":[${Array(restOf).fill('{"a":0}').join(',')}]}}`,
    );
  };

  it.each([
    ['one more name than the most', namesTo(MOST_NAMES + 1)],
    [
      'one more name than the most, each a name of its own',
      namesTo(MOST_NAMES + 1, (i) => `n${i.toString(36)}`),
    ],
    [
      'one more name than the most, after text that ends in a backslash',
      namesTo(MOST_NAMES + 1, undefined, ',"note":"placeholder \\\\"'),
    ],
    [
      'one more name than the most, the last of them in its last event',
      namesInLastEvent(MOST_NAMES + 1),
    ],
  ])(
    'refuses, before reading it, our batch with %s, however it is packed, on both event paths',
    async (_, json) => {
      expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MOST_BATCH_BYTES);
      // It is our batch, written as JSON.stringify writes it, nested no
      // deeper than the most: only how many names it holds sets it apart.
      const read = JSON.parse(json) as unknown;
      expect(JSON.stringify(read)).toBe(json);
      expect(namesIn(read)).toBe(MOST_NAMES + 1);
      const parse = vi.spyOn(JSON, 'parse');

      await expectRefused(everyWay(json));
      // Refused on the count alone: the text is never read as JSON.
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it('passes on our batch with the most names, spread over many events, and one with any number of colons inside its text', async () => {
    const atTheMost = [
      namesTo(MOST_NAMES),
      namesTo(MOST_NAMES, (i) => `n${i.toString(36)}`),
      namesInLastEvent(MOST_NAMES),
    ];
    const colonsInText = withEvent(
      JSON.stringify({
        ...ours,
        properties: {
          ...(ours.properties as Record<string, unknown>),
          colons: ':'.repeat(MOST_NAMES * 2),
          quoted: `\\" ${'":'.repeat(MOST_NAMES)} \\\\`,
          names: { [':'.repeat(MOST_NAMES)]: '":'.repeat(MOST_NAMES) },
        },
      }),
    );
    for (const json of [...atTheMost, colonsInText]) {
      expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MOST_BATCH_BYTES);
      expect(namesIn(JSON.parse(json))).toBeLessThanOrEqual(MOST_NAMES);
      for (const request of everyWay(json)) {
        upstream.mockClear();
        const at = `${request.url} ${json.length}`;
        const res = await route.POST(request);

        expect(res.status, at).toBe(200);
        expect(upstream, at).toHaveBeenCalledTimes(1);
      }
    }
    expect(refusals()).toEqual([]);
  });

  it('passes on our batch whatever JSON.stringify wrote into it: marks inside text, every kind of number, names in its own order', async () => {
    const json = batchJson(PROJECT_REF, [
      {
        ...ours,
        // Text that reads like a batch of another project's, and every mark
        // JSON.stringify escapes or leaves as it is.
        note: `{"api_key":"${OTHER_PROJECT}","api_key":"${PROJECT_REF}","batch":[${theirsText}]}`,
        marks: '" \\ / : , { } [ ] \b \f \n \r \t \u0000 \u001f \u007f \u2028 \u2029 \uFEFF \u00E9',
        // Half of a pair is written as an escape, a whole pair as it is.
        halfPair: 'a\uD840b',
        pair: '\uD840\uDC00',
        numbers: [
          0,
          -0,
          -1.5,
          1e20,
          1e21,
          1e-6,
          1e-7,
          Number.MIN_VALUE,
          Number.MAX_VALUE,
          Number.MAX_SAFE_INTEGER,
          0.1 + 0.2,
          NaN,
          Infinity,
        ],
        // Whole-number names come out first, lowest first, however they
        // were set; the rest in the order they were set.
        names: { b: 1, 10: 2, 2: 3, a: 4, '': 5, '-1': 6, '007': 7, ['__proto__']: 8 },
        empty: [{}, [], null, true, false, '', undefined],
        left: undefined,
      },
    ]);
    // As JSON.stringify wrote them.
    for (const written of [
      String.raw`"marks":"\" \\ / : , { } [ ] \b \f \n \r \t \u0000 \u001f ` +
        '\u007f \u2028 \u2029 \uFEFF \u00E9"',
      String.raw`"halfPair":"a\ud840b"`,
      '"pair":"\uD840\uDC00"',
      '"numbers":[0,0,-1.5,100000000000000000000,1e+21,0.000001,1e-7,5e-324,1.7976931348623157e+308,9007199254740991,0.30000000000000004,null,null]',
      '"names":{"2":3,"10":2,"b":1,"a":4,"":5,"-1":6,"007":7,"__proto__":8}',
      '"empty":[{},[],null,true,false,"",null]}',
    ]) {
      expect(json).toContain(written);
    }

    for (const packing of PACKINGS) {
      upstream.mockClear();
      const { query, contentType, body } = packed(packing, json);
      const res = await route.POST(
        incoming(`/ingest/e/${query ? `?${query}` : ''}`, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
        }),
      );

      expect(res.status, packing).toBe(200);
      expect(upstream, packing).toHaveBeenCalledTimes(1);
      expect((await sentToPostHog()).body, packing).toEqual(body);
    }
    expect(refusals()).toEqual([]);
  });

  it("passes on our batch whose events carry our key under every name, or none of their own: PostHog files those under the batch's", async () => {
    const json = batchJson(PROJECT_REF, [
      { event: 'placeholder_bare' },
      { event: 'placeholder_empty', properties: {} },
      {
        ...ours,
        token: PROJECT_REF,
        api_key: PROJECT_REF,
        $token: PROJECT_REF,
      },
    ]);
    const withoutSentAt = batchOf({ api_key: PROJECT_REF, batch: [ours] });

    for (const packing of PACKINGS) {
      for (const text of [json, withoutSentAt]) {
        const { query, contentType, body } = packed(packing, text);
        const res = await route.POST(
          incoming(`/ingest/e/${query ? `?${query}` : ''}`, {
            method: 'POST',
            headers: { 'content-type': contentType },
            body,
          }),
        );
        expect(res.status, packing).toBe(200);
      }
    }
    expect(upstream).toHaveBeenCalledTimes(PACKINGS.length * 2);
    expect(refusals()).toEqual([]);
  });

  // Each packing is told by all of its marks together: the compression
  // parameter, the content type by its exact text, and how the body starts.
  // PostHog's capture is more lenient than that (it looks for base64 or a
  // form inside a body, and takes hints from more places), so a body between
  // two packings could read one way here and another way there. Each of
  // these carries OUR batch, or ours where the route would look and another
  // project's where a lenient reader would.
  const toBase64 = (json: string) => Buffer.from(json, 'utf8').toString('base64');
  // A batch of ours whose base64 has each character encodeURIComponent
  // escapes: '+', '/' and the '=' padding.
  const oursJson = [0, 1, 2]
    .flatMap((lead) => [0, 1, 2].map((tail) => ['~'.repeat(lead), '~'.repeat(tail)]))
    .map(([lead, tail]) => batchJson(PROJECT_REF, [{ ...ours, note: `${lead}>>>???${tail}` }]))
    .find(
      (json) => /\+/.test(toBase64(json)) && /\//.test(toBase64(json)) && /=$/.test(toBase64(json)),
    )!;
  const gzipOurs = packed('gzip', oursJson).body;
  const jsonOurs = packed('json', oursJson).body;
  const formOurs = packed('base64', oursJson).body;
  const base64Ours = toBase64(oursJson);
  /**
   * The same bytes in base64 no encoder writes: the last character before
   * the padding, with one of the bits it does not use set.
   */
  function looseBase64(base64: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = base64.indexOf('=') - 1;
    const loose = `${base64.slice(0, last)}${alphabet[alphabet.indexOf(base64[last]!) + 1]}${base64.slice(last + 1)}`;
    expect(Buffer.from(loose, 'base64')).toEqual(Buffer.from(base64, 'base64'));
    expect(loose).not.toBe(base64);
    return loose;
  }
  const base64Theirs = toBase64(batchJson(OTHER_PROJECT));
  const FORM = 'application/x-www-form-urlencoded';
  const BASE64 = '?compression=base64';

  it('the three packings these are built from pass, so each refusal below is for the one thing changed', async () => {
    for (const escaped of ['%2B', '%2F', '%3D']) {
      expect(Buffer.from(formOurs).toString('latin1')).toContain(escaped);
    }
    for (const [query, contentType, body] of [
      ['', 'text/plain', gzipOurs],
      ['', 'application/json', jsonOurs],
      [BASE64, FORM, formOurs],
    ] as const) {
      const res = await route.POST(
        incoming(`/ingest/e/${query}`, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
        }),
      );
      expect(res.status, contentType).toBe(200);
    }
  });

  it.each<[string, string, string | null, Uint8Array<ArrayBuffer>]>([
    ['gzip sent as application/json', '', 'application/json', gzipOurs],
    ['gzip sent as a form', '', FORM, gzipOurs],
    ['gzip with no content type', '', null, gzipOurs],
    ['gzip as text/plain with a charset', '', 'text/plain; charset=utf-8', gzipOurs],
    ['gzip as Text/Plain', '', 'Text/Plain', gzipOurs],
    ['gzip marked base64', BASE64, FORM, gzipOurs],
    ['gzip marked base64, as text/plain', BASE64, 'text/plain', gzipOurs],
    ['gzip of gzip', '', 'text/plain', new Uint8Array(gzipSync(gzipOurs))],
    [
      'gzip with bytes after it',
      '',
      'text/plain',
      new Uint8Array(Buffer.concat([gzipOurs, Buffer.from(batchJson(OTHER_PROJECT))])),
    ],
    ['gzip cut short', '', 'text/plain', gzipOurs.slice(0, gzipOurs.byteLength - 4)],
    ['the two bytes gzip starts with, and no more', '', 'text/plain', new Uint8Array([0x1f, 0x8b])],
    ['raw JSON sent as text/plain', '', 'text/plain', jsonOurs],
    [
      'raw JSON as application/json with a charset',
      '',
      'application/json; charset=utf-8',
      jsonOurs,
    ],
    ['raw JSON as Application/JSON', '', 'Application/JSON', jsonOurs],
    ['raw JSON with no content type', '', null, jsonOurs],
    ['raw JSON sent as a form', '', FORM, jsonOurs],
    ['raw JSON marked base64', BASE64, FORM, jsonOurs],
    ['raw JSON marked base64, as application/json', BASE64, 'application/json', jsonOurs],
    [
      'raw JSON that is not UTF-8',
      '',
      'application/json',
      new Uint8Array(
        Buffer.concat([
          Buffer.from(`{"api_key":"${PROJECT_REF}","batch":[{"event":"`),
          Buffer.from([0xff]),
          Buffer.from('"}]}'),
        ]),
      ),
    ],
    ['the base64 form with no compression parameter', '', FORM, formOurs],
    ['the base64 form sent as text/plain', BASE64, 'text/plain', formOurs],
    ['the base64 form sent as application/json', BASE64, 'application/json', formOurs],
    ['the base64 form with a charset on its type', BASE64, `${FORM}; charset=UTF-8`, formOurs],
    ['the base64 form with no content type', BASE64, null, formOurs],
    ['base64 with no data= before it', BASE64, FORM, bytes(encodeURIComponent(base64Ours))],
    [
      'the base64 form with a second data field',
      BASE64,
      FORM,
      bytes(`data=${encodeURIComponent(base64Ours)}&data=${encodeURIComponent(base64Theirs)}`),
    ],
    [
      'the base64 form with a field before data',
      BASE64,
      FORM,
      bytes(`ver=${SDK_VERSION}&data=${encodeURIComponent(base64Ours)}`),
    ],
    [
      'the base64 form with a compression field after data',
      BASE64,
      FORM,
      bytes(`data=${encodeURIComponent(base64Ours)}&compression=gzip-js`),
    ],
    ['the base64 form with its + / = not escaped', BASE64, FORM, bytes(`data=${base64Ours}`)],
    [
      'the base64 form with its + written as a space',
      BASE64,
      FORM,
      bytes(`data=${encodeURIComponent(base64Ours).replaceAll('%2B', '+')}`),
    ],
    [
      'the base64 form with lower-case escapes',
      BASE64,
      FORM,
      bytes(
        `data=${encodeURIComponent(base64Ours).replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase())}`,
      ),
    ],
    [
      'the base64 form with a line break in its base64',
      BASE64,
      FORM,
      bytes(`data=${encodeURIComponent(`${base64Ours.slice(0, 8)}\n${base64Ours.slice(8)}`)}`),
    ],
    [
      'the base64 form with its padding left off',
      BASE64,
      FORM,
      bytes(`data=${encodeURIComponent(base64Ours.replace(/=+$/, ''))}`),
    ],
    [
      'the base64 form with bits set after its last byte',
      BASE64,
      FORM,
      bytes(`data=${encodeURIComponent(looseBase64(base64Ours))}`),
    ],
    [
      'the base64 form in the URL-safe alphabet',
      BASE64,
      FORM,
      bytes(`data=${Buffer.from(oursJson, 'utf8').toString('base64url')}`),
    ],
    [
      'the base64 form of a gzip batch',
      BASE64,
      FORM,
      bytes(`data=${encodeURIComponent(Buffer.from(gzipOurs).toString('base64'))}`),
    ],
    [
      'the base64 form of the base64 of our batch',
      BASE64,
      FORM,
      bytes(`data=${encodeURIComponent(Buffer.from(base64Ours).toString('base64'))}`),
    ],
  ])('refuses our own batch as %s', async (_label, query, contentType, body) => {
    await expectRefused(
      EVENT_PATHS.map((path) =>
        incoming(`${path}${query}`, {
          method: 'POST',
          headers: contentType === null ? {} : { 'content-type': contentType },
          body,
        }),
      ),
    );
  });

  it('refuses every batch when no project key is set: ours, and one that names no project', async () => {
    postHogEnv.NEXT_PUBLIC_POSTHOG_KEY = '';

    await expectRefused(
      [
        batchJson(PROJECT_REF),
        batchJson(''),
        batchOf({ batch: [{ event: '$pageview' }], sent_at: SENT_AT }),
      ].flatMap((json) => EVENT_PATHS.map((path) => batchPost(path, json))),
    );
  });
});

describe('/ingest takes a request body up to the platform limit on every POST path, and no more', () => {
  // The route reads a request body up to the platform's own limit, so that
  // it answers, and logs, every body the platform lets through; past that
  // it answers 413 before reading on. What a batch may unpack to is held
  // lower (the next describe), so a body this large answers 404 once read.
  const OVER: Array<[string]> = [['/ingest/e/'], ['/ingest/i/v0/e/']];

  /** The raw JSON of a batch of this app's events that is exactly `size` bytes. */
  function batchJsonOfSize(size: number): Uint8Array<ArrayBuffer> {
    const without = batchJson(PROJECT_REF, [{ ...eventFor(PROJECT_REF), pad: '' }]);
    const json = batchJson(PROJECT_REF, [
      { ...eventFor(PROJECT_REF), pad: 'a'.repeat(size - without.length) },
    ]);
    const body = bytes(json);
    expect(body).toHaveLength(size);
    return body;
  }

  /** `body` sent in chunks of `chunkSize` with no Content-Length. */
  function inChunks(body: Uint8Array<ArrayBuffer>, chunkSize: number): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (offset >= body.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(body.slice(offset, offset + chunkSize));
          offset += chunkSize;
        },
      },
      { highWaterMark: 0 },
    );
  }

  const JSON_TYPE = { 'content-type': 'application/json' };

  it('reads a body just under the limit and one of exactly the limit, by Content-Length and in chunks, and refuses the batch in it by its size', async () => {
    const refused: Array<[string, Record<string, unknown>]> = [];
    for (const [path] of OVER) {
      for (const size of [CAP - 1, CAP]) {
        const body = batchJsonOfSize(size);
        const declared = await route.POST(
          incoming(path, {
            method: 'POST',
            headers: { ...JSON_TYPE, 'content-length': String(size) },
            body,
          }),
        );
        const chunked = await route.POST(
          incoming(path, {
            method: 'POST',
            headers: JSON_TYPE,
            body: inChunks(body, 256 * 1024),
          }),
        );

        // Read to the end, not refused as too large a request: the batch
        // it holds is larger than a batch may be.
        for (const res of [declared, chunked]) {
          expect(res.status, `${path} ${size}`).toBe(404);
          expect(await res.text()).toBe('');
          expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        }
        const line = { status: 404, reason: 'size', method: 'POST', path };
        refused.push(['[ingest] refused', line], ['[ingest] refused', line]);
      }
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(refusals()).toEqual(refused);
  });

  it.each(OVER)(
    'answers 413 to a Content-Length one byte over the limit on %s before reading the body, and asks PostHog nothing',
    async (path) => {
      const { stream, seen } = chunkedBody(16, 16);
      const res = await route.POST(
        incoming(path, {
          method: 'POST',
          headers: { ...JSON_TYPE, 'content-length': String(CAP + 1) },
          body: stream,
        }),
      );

      expect(res.status).toBe(413);
      expect(await res.text()).toBe('');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(seen.pulled).toBe(0);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it.each(OVER)(
    'answers 413 to a body with no Content-Length one byte over the limit on %s, and stops reading at the first byte over',
    async (path) => {
      const typed = await route.POST(
        incoming(path, { method: 'POST', headers: JSON_TYPE, body: batchJsonOfSize(CAP + 1) }),
      );
      // The limit in 256 KiB chunks and then one byte.
      const oneOver = chunkedBody(CAP + 1, 256 * 1024);
      const chunked = await route.POST(
        incoming(path, { method: 'POST', headers: JSON_TYPE, body: oneOver.stream }),
      );
      // Two chunks more than the limit: the first one over is the last one read.
      const longer = chunkedBody(CAP + 2 * 256 * 1024, 256 * 1024);
      const stopped = await route.POST(
        incoming(path, { method: 'POST', headers: JSON_TYPE, body: longer.stream }),
      );

      for (const res of [typed, chunked, stopped]) {
        expect(res.status).toBe(413);
        expect(await res.text()).toBe('');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      }
      expect(oneOver.seen.cancelled).toBe(true);
      expect(longer.seen.pulled).toBe(CAP / (256 * 1024) + 1);
      expect(longer.seen.cancelled).toBe(true);
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('answers 400 with no body when the request body breaks off, and asks PostHog nothing', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('placeholder: the client went away'));
      },
    });
    const res = await route.POST(incoming('/ingest/e/', { method: 'POST', body: broken }));

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('/ingest reads an event batch only up to a set size, however it is packed', () => {
  // The route reads every batch it passes on, and what reading costs grows
  // with what is read; a batch that unpacks to more than MOST_BATCH_BYTES is
  // refused before it is read, and is not unpacked past that size.
  const EVENT_PATHS = ['/ingest/e/', '/ingest/i/v0/e/'] as const;

  /** The JSON of a batch of this app's events that is exactly `size` bytes. */
  function batchOfSize(size: number): string {
    const without = batchJson(PROJECT_REF, [{ ...eventFor(PROJECT_REF), pad: '' }]);
    const json = batchJson(PROJECT_REF, [
      { ...eventFor(PROJECT_REF), pad: 'a'.repeat(size - without.length) },
    ]);
    expect(Buffer.byteLength(json)).toBe(size);
    return json;
  }

  /** `json` packed each way, to each event path. */
  function everyWay(json: string): NextRequest[] {
    return EVENT_PATHS.flatMap((path) =>
      PACKINGS.map((packing) => {
        const { query, contentType, body } = packed(packing, json);
        return incoming(`${path}${query ? `?${query}` : ''}`, {
          method: 'POST',
          headers: { 'content-type': contentType },
          body,
        });
      }),
    );
  }

  it('passes on, bytes unchanged, a batch of exactly the size and one just under it, however it is packed', async () => {
    const sent: Uint8Array[] = [];
    for (const size of [MOST_BATCH_BYTES - 1, MOST_BATCH_BYTES]) {
      for (const request of everyWay(batchOfSize(size))) {
        const body = new Uint8Array(await request.clone().arrayBuffer());
        const res = await route.POST(request);

        expect(res.status, `${request.url} ${size}`).toBe(200);
        sent.push(body);
      }
    }
    expect(upstream).toHaveBeenCalledTimes(sent.length);
    for (const [call, body] of sent.entries()) {
      // Compared as bytes in one step: a deep compare of a mebibyte is slow.
      const onward = Buffer.from((await sentToPostHog(call)).body);
      expect(onward.equals(Buffer.from(body)), `call ${call}`).toBe(true);
    }
    expect(refusals()).toEqual([]);
  });

  it('refuses a batch one byte over the size, however it is packed, before reading it, and logs it as too large', async () => {
    const requests = everyWay(batchOfSize(MOST_BATCH_BYTES + 1));
    const parse = vi.spyOn(JSON, 'parse');
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');

    for (const request of requests) {
      const res = await route.POST(request);
      const at = `${new URL(request.url).pathname}${new URL(request.url).search}`;

      expect(res.status, at).toBe(404);
      expect(await res.text(), at).toBe('');
      expect(res.headers.get('x-content-type-options'), at).toBe('nosniff');
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    expect(refusals()).toEqual(
      requests.map((request) => [
        '[ingest] refused',
        { status: 404, reason: 'size', method: 'POST', path: new URL(request.url).pathname },
      ]),
    );
  });

  it('unpacks a gzip body no further than the size, however much more it holds', async () => {
    // A batch a byte over the size, one twice the size, and 64 MiB of one
    // character: each some kilobytes as sent.
    const bodies = [
      new Uint8Array(gzipSync(batchOfSize(MOST_BATCH_BYTES + 1))),
      new Uint8Array(gzipSync(batchOfSize(2 * MOST_BATCH_BYTES))),
      new Uint8Array(gzipSync(Buffer.alloc(64 * MIB, 0x61))),
    ];
    const atTheSize = new Uint8Array(gzipSync(batchOfSize(MOST_BATCH_BYTES)));
    const gunzip = vi.mocked(gunzipSync);
    gunzip.mockClear();

    for (const [i, body] of bodies.entries()) {
      expect(body.byteLength, `body ${i}`).toBeLessThan(MIB / 4);
      const res = await route.POST(
        incoming(EVENT_PATHS[i % 2]!, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body,
        }),
      );

      expect(res.status, `body ${i}`).toBe(404);
      expect(await res.text()).toBe('');
    }
    // Each stopped at the size, with nothing unpacked handed on.
    expect(gunzip.mock.results.map((result) => result.type)).toEqual(['throw', 'throw', 'throw']);
    const passed = await route.POST(
      incoming('/ingest/e/', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: atTheSize,
      }),
    );
    expect(passed.status).toBe(200);
    expect(gunzip.mock.results.at(-1)).toMatchObject({ type: 'return' });
    expect((gunzip.mock.results.at(-1)!.value as Uint8Array).byteLength).toBe(MOST_BATCH_BYTES);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(refusals()).toEqual(
      bodies.map((_, i) => [
        '[ingest] refused',
        { status: 404, reason: 'size', method: 'POST', path: EVENT_PATHS[i % 2] },
      ]),
    );
  });

  it('decodes a base64 body only when its text decodes to no more than the size', async () => {
    const over = packed('base64', batchOfSize(MOST_BATCH_BYTES + 1));
    const atTheSize = packed('base64', batchOfSize(MOST_BATCH_BYTES));
    const from = vi.spyOn(Buffer, 'from');
    const decodedBase64 = () =>
      from.mock.calls.flatMap((call, i) =>
        call[1] === 'base64' ? [(from.mock.results[i]!.value as Buffer).byteLength] : [],
      );

    const refused = await route.POST(
      incoming(`/ingest/e/?${over.query}`, {
        method: 'POST',
        headers: { 'content-type': over.contentType },
        body: over.body,
      }),
    );
    expect(refused.status).toBe(404);
    expect(decodedBase64()).toEqual([]);

    const passed = await route.POST(
      incoming(`/ingest/i/v0/e/?${atTheSize.query}`, {
        method: 'POST',
        headers: { 'content-type': atTheSize.contentType },
        body: atTheSize.body,
      }),
    );
    expect(passed.status).toBe(200);
    expect(decodedBase64()).toEqual([MOST_BATCH_BYTES]);
    expect(refusals()).toEqual([
      ['[ingest] refused', { status: 404, reason: 'size', method: 'POST', path: '/ingest/e/' }],
    ]);
  });
});

describe('/ingest logs each request it refuses, with the path and which part of the request it was', () => {
  // The SDK drops what is refused without retrying, so a remote config that
  // moves /i/v0/e/, or an SDK update that sends something new, shows here
  // instead of events vanishing. Never the query (it can carry a token), a
  // header or the body: only which of them it was.
  it.each([
    [404, 'path', 'GET', `/ingest/api/projects/1/?token=${OTHER_PROJECT}&q=placeholder-query`],
    [404, 'path', 'POST', `/ingest/i/v1/logs?token=${OTHER_PROJECT}`],
    [404, 'path', 'HEAD', `/ingest/static/toolbar.js?v=${SDK_VERSION}&t=1700000000000`],
    [405, 'method', 'GET', '/ingest/e/?compression=base64'],
    [405, 'method', 'HEAD', '/ingest/i/v0/e/'],
    [405, 'method', 'POST', `/ingest/array/${PROJECT_REF}/config.js?callback=placeholder-query`],
    [404, 'query', 'GET', `/ingest/api/surveys/?api_key=${OTHER_PROJECT}&q=placeholder-query`],
    [404, 'query', 'GET', `/ingest/api/surveys/?token=${OTHER_PROJECT}`],
    [404, 'query', 'POST', '/ingest/e/?data=placeholder-query'],
    [404, 'query', 'GET', `/ingest/array/${PROJECT_REF}/config.js?callback=placeholder-query`],
    // A POST whose body is not a batch of this app's events.
    [404, 'body', 'POST', '/ingest/e/'],
    [404, 'body', 'POST', '/ingest/i/v0/e/?retry_count=1'],
    // Methods the SDK never sends, which Next would otherwise answer itself.
    [405, 'method', 'PUT', '/ingest/e/?q=placeholder-query'],
    [405, 'method', 'PATCH', '/ingest/i/v0/e/'],
    [405, 'method', 'DELETE', `/ingest/api/surveys/?token=${PROJECT_REF}&q=placeholder-query`],
    [405, 'method', 'OPTIONS', `/ingest/array/${PROJECT_REF}/config.js?q=placeholder-query`],
    [404, 'path', 'OPTIONS', '/ingest/login?q=placeholder-query'],
    [404, 'path', 'DELETE', `/ingest/api/projects/1/?token=${OTHER_PROJECT}`],
  ] as const)('a %i (%s) to %s %s writes one line', async (status, reason, method, path) => {
    const res = await answerOf(
      incoming(path, {
        method,
        headers: { ...BROWSER_HEADERS, 'content-type': 'application/json' },
        // Another project's batch, with a mark of its own in it.
        body: WITH_BODY.has(method)
          ? bytes(batchJson(OTHER_PROJECT, [eventFor(OTHER_PROJECT, 'placeholder-body')]))
          : undefined,
      }),
    );

    expect(res.status).toBe(status);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[ingest] refused', {
      status,
      reason,
      method,
      path: new URL(path, SITE).pathname,
    });
    const line = JSON.stringify(warn.mock.calls);
    for (const piece of [...NEVER_SENT, OTHER_PROJECT, 'placeholder-query', 'placeholder-body']) {
      expect(line).not.toContain(piece);
    }
  });

  it('logs a 413 once, by Content-Length and by the bytes read, with the path only', async () => {
    await route.POST(
      incoming('/ingest/i/v0/e/?retry_count=1', {
        method: 'POST',
        headers: { ...BROWSER_HEADERS, 'content-length': String(CAP + 1) },
        body: chunkedBody(16, 16).stream,
      }),
    );
    await route.POST(
      incoming('/ingest/e/?compression=base64', {
        method: 'POST',
        headers: BROWSER_HEADERS,
        body: new Uint8Array(CAP + 1),
      }),
    );

    expect(warn.mock.calls).toEqual([
      [
        '[ingest] refused',
        { status: 413, reason: 'size', method: 'POST', path: '/ingest/i/v0/e/' },
      ],
      ['[ingest] refused', { status: 413, reason: 'size', method: 'POST', path: '/ingest/e/' }],
    ]);
  });

  it('logs nothing for a request it passes on', async () => {
    for (const [method, path] of SDK_REQUESTS) {
      await ask(method, `/ingest${path}`);
    }

    expect(upstream).toHaveBeenCalledTimes(SDK_REQUESTS.length);
    expect(refusals()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("/ingest answers with PostHog's answer, minus what is not PostHog's to set", () => {
  it('keeps the status, the body, the content type and the cache policy; drops Set-Cookie, Content-Encoding, Content-Length and the rest', async () => {
    const script = 'console.log("placeholder")';
    upstream.mockImplementationOnce(async () => {
      const answer = new Response(script, {
        status: 200,
        headers: {
          'content-type': 'application/javascript',
          'cache-control': 'public, max-age=300',
          'set-cookie': 'ph_placeholder=1; Path=/',
          // fetch has already decoded the body by the time the route reads it.
          'content-encoding': 'gzip',
          'content-length': '999',
          'access-control-allow-origin': '*',
          'x-placeholder-upstream': '1',
        },
      });
      expect(answer.headers.getSetCookie()).toHaveLength(1);
      return answer;
    });

    const res = await route.GET(incoming(`/ingest/static/${SDK_VERSION}/surveys.js`));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(script);
    expect([...res.headers.keys()].sort()).toEqual([
      'cache-control',
      'content-type',
      'x-content-type-options',
    ]);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("passes PostHog's refusals on with their status and body, with Retry-After so the SDK waits as long as PostHog asked, and with no Set-Cookie", async () => {
    upstream.mockImplementationOnce(
      async () =>
        new Response('{"type":"throttled"}', {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'retry-after': '30',
            'set-cookie': 'ph_placeholder=1; Path=/',
          },
        }),
    );

    const res = await route.POST(batchPost('/ingest/e/'));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.text()).toBe('{"type":"throttled"}');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('answers a status that carries no body (204) without one', async () => {
    upstream.mockImplementationOnce(
      async () =>
        new Response(null, { status: 204, headers: { 'set-cookie': 'ph_placeholder=1; Path=/' } }),
    );

    const res = await route.POST(batchPost('/ingest/e/'));

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    [
      'PostHog cannot be reached',
      () => Promise.reject(new TypeError('fetch failed: connect ECONNREFUSED us.i.posthog.com')),
    ],
    [
      'PostHog does not answer in time',
      () =>
        Promise.reject(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
        ),
    ],
    [
      'the answer breaks off',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('socket hang up'));
            },
          }),
          { status: 200 },
        ),
    ],
  ])('answers 502 with no body when %s', async (_label, failure) => {
    upstream.mockImplementationOnce(failure);

    const res = await route.POST(batchPost('/ingest/e/'));

    expect(res.status).toBe(502);
    expect(await res.text()).toBe('');
    expect([...res.headers.keys()]).toEqual(['x-content-type-options']);
    // The server log names the kind of failure, not its text.
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/ECONNREFUSED|socket hang up|aborted/);
  });
});

describe('/ingest answers each path with the kind of content that path has, and nothing of PostHog as a page of ours', () => {
  // Bytes, not a string: a string body would bring a content type of its own.
  const PAGE = new TextEncoder().encode('<script>placeholder()</script>');
  const PLAIN = 'text/plain; charset=utf-8';

  // Every kind of path the route passes on: the scripts (a bundle by both of
  // its addresses, the remote config script) and the JSON answers (events,
  // the lists, the remote config as JSON).
  const SCRIPT_PATHS: Array<['GET' | 'POST', string]> = [
    ['GET', `/ingest/static/${SDK_VERSION}/surveys.js`],
    ['GET', `/ingest/static/surveys.js?v=${SDK_VERSION}`],
    ['GET', `/ingest/array/${PROJECT_REF}/config.js`],
  ];
  const JSON_PATHS: Array<['GET' | 'POST', string]> = [
    ['POST', '/ingest/e/'],
    ['POST', '/ingest/i/v0/e/'],
    ['GET', `/ingest/api/surveys/?token=${PROJECT_REF}`],
    ['GET', `/ingest/api/product_tours/?token=${PROJECT_REF}`],
    ['GET', `/ingest/array/${PROJECT_REF}/config`],
  ];

  function postHogAnswers(contentType: string | null) {
    upstream.mockImplementation(
      async () =>
        new Response(PAGE, {
          status: 200,
          headers: contentType === null ? {} : { 'content-type': contentType },
        }),
    );
  }

  it('covers every kind of path the route passes on', () => {
    const covered = new Set(
      [...SCRIPT_PATHS, ...JSON_PATHS].map(([, path]) =>
        new URL(path, SITE).pathname.replace(/\/static\/.*$/, '/static/'),
      ),
    );
    const passed = new Set(
      SDK_REQUESTS.map(([, path]) =>
        new URL(`/ingest${path}`, SITE).pathname.replace(/\/static\/.*$/, '/static/'),
      ),
    );
    expect([...covered].sort()).toEqual([...passed].sort());
  });

  it.each([
    ['text/html; charset=utf-8'],
    ['text/html'],
    ['image/svg+xml'],
    ['application/xml'],
    ['application/xhtml+xml'],
    ['text/css'],
    ['application/octet-stream'],
    ['text/plain, text/html'],
    ['text/plain; x=1, text/html'],
    ['application/json, text/html'],
    ['application/javascript, text/html'],
    ['application/jsonp'],
    ['text/plain'],
    [''],
    [null],
  ])(
    "answers 'text/plain; charset=utf-8', nosniff, on every path when PostHog answers %j",
    async (type) => {
      postHogAnswers(type);

      for (const [method, path] of [...SCRIPT_PATHS, ...JSON_PATHS]) {
        const res = await ask(method, path);
        expect(res.status, path).toBe(200);
        expect(res.headers.get('content-type'), path).toBe(PLAIN);
        expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      }
    },
  );

  it.each([
    ['application/javascript'],
    ['Application/JavaScript; charset=UTF-8'],
    ['text/javascript; charset=utf-8'],
  ])(
    "keeps PostHog's %j on a script path, and answers plain text with it on a JSON path",
    async (type) => {
      postHogAnswers(type);

      for (const [method, path] of SCRIPT_PATHS) {
        const res = await ask(method, path);
        expect(res.headers.get('content-type'), path).toBe(type);
        expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      }
      for (const [method, path] of JSON_PATHS) {
        const res = await ask(method, path);
        expect(res.headers.get('content-type'), path).toBe(PLAIN);
        expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      }
    },
  );

  it.each([['application/json'], ['application/json; charset=utf-8'], ['Application/JSON']])(
    "keeps PostHog's %j on a JSON path, and answers plain text with it on a script path",
    async (type) => {
      postHogAnswers(type);

      for (const [method, path] of JSON_PATHS) {
        const res = await ask(method, path);
        expect(res.headers.get('content-type'), path).toBe(type);
        expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      }
      for (const [method, path] of SCRIPT_PATHS) {
        const res = await ask(method, path);
        expect(res.headers.get('content-type'), path).toBe(PLAIN);
        expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
      }
    },
  );

  it('answers a HEAD with the same content type as its GET', async () => {
    postHogAnswers('application/javascript');
    const script = await ask('HEAD', `/ingest/static/${SDK_VERSION}/surveys.js`);
    const list = await ask('HEAD', `/ingest/api/surveys/?token=${PROJECT_REF}`);

    expect(script.headers.get('content-type')).toBe('application/javascript');
    expect(list.headers.get('content-type')).toBe(PLAIN);
  });
});

describe('/ingest lets a shared cache keep only the /static/ bundles', () => {
  // Vercel's CDN stores a function's answer when its Cache-Control allows a
  // shared cache. The /static/ bundles are the same files for everyone; no
  // other answer may be stored for the next visitor, whatever PostHog says.
  const BUNDLE = `/ingest/static/${SDK_VERSION}/surveys.js`;
  const ELSEWHERE: Array<[string, 'GET' | 'POST']> = [
    [`/ingest/array/${PROJECT_REF}/config.js`, 'GET'],
    [`/ingest/array/${PROJECT_REF}/config`, 'GET'],
    [`/ingest/api/surveys/?token=${PROJECT_REF}`, 'GET'],
    ['/ingest/e/', 'POST'],
  ];

  function postHogAnswers(headers: Record<string, string>) {
    upstream.mockImplementation(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json', ...headers },
        }),
    );
  }

  it.each([
    ['public, max-age=300'],
    ['s-maxage=60'],
    ['public, max-age=31536000, immutable'],
    ['no cache policy at all'],
  ])(
    "answers 'private, no-store' on every path but /static/ when PostHog says %s",
    async (policy) => {
      postHogAnswers(policy === 'no cache policy at all' ? {} : { 'cache-control': policy });

      for (const [path, method] of ELSEWHERE) {
        const res = await ask(method, path);
        expect(res.status, path).toBe(200);
        expect(res.headers.get('cache-control'), path).toBe('private, no-store');
      }
    },
  );

  it("keeps PostHog's cache policy on a /static/ bundle, and only there", async () => {
    postHogAnswers({ 'cache-control': 'public, max-age=31536000, immutable' });

    const bundle = await route.GET(incoming(BUNDLE));
    const head = await route.HEAD(incoming(BUNDLE, { method: 'HEAD' }));
    const config = await route.GET(incoming(`/ingest/array/${PROJECT_REF}/config.js`));

    expect(bundle.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(head.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(config.headers.get('cache-control')).toBe('private, no-store');
  });

  it('never passes on Vary, CDN-Cache-Control or Vercel-CDN-Cache-Control', async () => {
    postHogAnswers({
      'cache-control': 'public, max-age=60',
      vary: 'Cookie, Accept-Encoding',
      'cdn-cache-control': 'public, max-age=600',
      'vercel-cdn-cache-control': 'max-age=600',
    });

    const bundle = await route.GET(incoming(BUNDLE));
    const config = await route.GET(incoming(`/ingest/array/${PROJECT_REF}/config.js`));

    for (const res of [bundle, config]) {
      expect(res.headers.get('vary')).toBeNull();
      expect(res.headers.get('cdn-cache-control')).toBeNull();
      expect(res.headers.get('vercel-cdn-cache-control')).toBeNull();
    }
    expect(bundle.headers.get('cache-control')).toBe('public, max-age=60');
    expect(config.headers.get('cache-control')).toBe('private, no-store');
  });
});
