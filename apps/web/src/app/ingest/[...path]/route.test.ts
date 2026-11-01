// @vitest-environment node
// Node, not a DOM: a browser-like Request drops the header names a page may
// not set (Cookie among them), and the route receives them as the browser sent
// them. The first test checks that the request handed to the route still has
// them, so it cannot pass by never seeing a cookie.
import { gunzipSync, gzipSync } from 'node:zlib';

import { NextRequest } from 'next/server';
import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The /ingest analytics proxy (docket S34). PostHog's browser SDK sends
 * everything to /ingest on our own origin, so the browser attaches every
 * cookie of this host, the Supabase session among them. The next.config.ts
 * rewrites this route replaced forwarded the request's headers as they came,
 * on any path; the route builds a new request from lists, and only for the
 * requests the SDK makes, each by the method the SDK uses. fetch is a stub:
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

import * as route from './route';

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
// Another PostHog project's key.
const OTHER_PROJECT = 'phc_other';
// The Conversations widget's value from the public remote config.
const WIDGET_REF = 'placeholder-widget';
// A Conversations ticket id, as PostHog hands them out (a UUID), and the
// widget_session_id the SDK makes for a visitor (a UUID v7).
const TICKET = '00000000-0000-4000-8000-000000000000';
const WIDGET_VISIT = '00000000-0000-7000-8000-000000000000';
const SDK_VERSION = '1.438.15';

// Everything a signed-in member's browser sends with a same-origin request, and
// what the platform adds on the way in: the member's credentials, where the
// request came from (Origin, Referer, x-forwarded-host), the platform's own
// headers, and the headers PostHog reads.
const BROWSER_HEADERS: Record<string, string> = {
  cookie: MEMBER_COOKIE,
  authorization: MEMBER_BEARER,
  'content-type': 'text/plain',
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
// visitor address.
const SENT_HEADERS = [
  'accept',
  'content-encoding',
  'content-type',
  'posthog-placeholder-header',
  'user-agent',
  'x-conversations-token',
  'x-forwarded-for',
];
// Pieces of BROWSER_HEADERS that reach PostHog nowhere, not in the address,
// any header or the body: the session cookie and its chunk, PostHog's own
// cookie, the member's bearer token, and our host.
const NEVER_SENT = [
  'placeholder-session',
  'placeholder-chunk',
  'placeholder-ph',
  'eyJplaceholder',
  'app.example.com',
];

const MIB = 1024 * 1024;
// The platform's request body limit (Vercel: "4.5 MB"), as the route reads it.
const CAP = 4.5 * MIB;

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

type Method = 'GET' | 'HEAD' | 'POST';

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

/** The route's answer to a request of this method, a POST with a small body. */
function ask(method: Method, path: string): Promise<Response> {
  if (method === 'POST') {
    return route.POST(incoming(path, { method, body: new Uint8Array([1]) }));
  }
  return method === 'HEAD' ? route.HEAD(incoming(path, { method })) : route.GET(incoming(path));
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
    const req = incoming('/ingest/e/?ip=1&_=1700000000000', {
      method: 'POST',
      headers: BROWSER_HEADERS,
      body: new Uint8Array([1, 2, 3]),
    });
    // The route is handed what the browser sent.
    expect(req.headers.get('cookie')).toBe(MEMBER_COOKIE);
    expect(req.headers.get('authorization')).toBe(MEMBER_BEARER);

    await route.POST(req);

    expect(upstream).toHaveBeenCalledTimes(1);
    const sent = await sentToPostHog();
    expect([...sent.headers.keys()].sort()).toEqual(SENT_HEADERS);
    expect(sent.headers.get('cookie')).toBeNull();
    expect(sent.headers.get('authorization')).toBeNull();
    // The first hop: the visitor, as Vercel recorded it.
    expect(sent.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.headers.get('content-type')).toBe('text/plain');
    expect(sent.headers.get('user-agent')).toBe('Mozilla/5.0 (placeholder)');
    expect(sent.headers.get('posthog-placeholder-header')).toBe('kept');
    expect(sent.headers.get('x-conversations-token')).toBe(WIDGET_REF);
    // Nowhere else either: not in the address, any header or the body.
    for (const piece of NEVER_SENT) {
      expect(everythingIn(sent)).not.toContain(piece);
    }
  });

  it('forwards Authorization only as a PostHog project key (Bearer phc_), never another bearer', async () => {
    await route.POST(
      incoming('/ingest/i/v0/e/', { method: 'POST', headers: { authorization: PROJECT_BEARER } }),
    );
    await route.POST(
      incoming('/ingest/i/v0/e/', { method: 'POST', headers: { authorization: PERSONAL_BEARER } }),
    );
    await route.POST(
      incoming('/ingest/i/v0/e/', {
        method: 'POST',
        headers: { authorization: PROJECT_BEARER.toLowerCase() },
      }),
    );

    expect((await sentToPostHog(0)).headers.get('authorization')).toBe(PROJECT_BEARER);
    expect((await sentToPostHog(1)).headers.get('authorization')).toBeNull();
    expect((await sentToPostHog(2)).headers.get('authorization')).toBeNull();
  });

  it('takes the visitor address from x-real-ip when x-forwarded-for is missing, and off Vercel never from an x-forwarded-for the client could have typed (lib/client-ip.ts)', async () => {
    await route.POST(
      incoming('/ingest/e/', { method: 'POST', headers: { 'x-real-ip': '203.0.113.8' } }),
    );
    await route.POST(incoming('/ingest/e/', { method: 'POST' }));
    vi.stubEnv('VERCEL', '');
    await route.POST(
      incoming('/ingest/e/', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.9' } }),
    );

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
// The bundles it can load by name. Not toolbar, recorder or recorder-v2: the
// route refuses those (the refusal table below says why).
const BUNDLES = [
  'surveys',
  'product-tours',
  'conversations',
  'logs',
  'dead-clicks-autocapture',
  'exception-autocapture',
  'web-vitals-with-attribution',
  'lazy-recorder',
  'posthog-recorder',
];
const SDK_REQUESTS: Array<['GET' | 'POST', string, string]> = [
  // Events: the SDK's own path, and the one this project's remote config
  // names. A gzip batch carries no query flag, a base64 one does, a retry
  // counts itself; an older SDK in a tab still open sent more.
  ['POST', '/e/', API],
  ['POST', '/e/?compression=base64', API],
  ['POST', '/e/?retry_count=1', API],
  ['POST', `/e/?ip=0&_=1700000000000&ver=${SDK_VERSION}&compression=gzip-js`, API],
  ['POST', '/i/v0/e/?_=1700000000000', API],
  ['POST', '/flags/?v=2', API],
  ['POST', `/flags/?v=2&_=1700000000000&ver=${SDK_VERSION}&compression=base64`, API],
  ['POST', '/flags/?v=2&only_evaluate_survey_feature_flags=true', API],
  ['POST', '/s/?_=1700000000000', API],
  ['POST', '/s/?compression=base64&retry_count=2', API],
  ['POST', `/i/v1/logs?token=${PROJECT_REF}`, API],
  ['POST', `/i/v1/logs?token=${PROJECT_REF}&compression=base64`, API],
  ['GET', `/api/surveys/?token=${PROJECT_REF}&_=1700000000000`, API],
  ['GET', `/api/product_tours/?token=${PROJECT_REF}&_=1700000000000`, API],
  ['POST', '/api/conversations/v1/widget/message', API],
  [
    'GET',
    `/api/conversations/v1/widget/messages/${TICKET}?limit=50&widget_session_id=${WIDGET_VISIT}&after=2026-01-01T00%3A00%3A00Z&_=1700000000000`,
    API,
  ],
  ['POST', `/api/conversations/v1/widget/messages/${TICKET}/read`, API],
  [
    'GET',
    `/api/conversations/v1/widget/tickets?limit=20&offset=0&widget_session_id=${WIDGET_VISIT}&_=1700000000000`,
    API,
  ],
  ['POST', '/api/conversations/v1/widget/restore', API],
  ['POST', '/api/conversations/v1/widget/restore/request', API],
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

  it('passes a gzip body through byte for byte, with the method (posthog-js sends gzip as text/plain)', async () => {
    const json = JSON.stringify({ api_key: PROJECT_REF, batch: [{ event: '$pageview' }] });
    const gzip = new Uint8Array(gzipSync(json));
    // Every byte value too, so no text decoding can pass unnoticed.
    const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);

    await route.POST(
      incoming('/ingest/e/?_=1700000000000', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: gzip,
      }),
    );
    await route.POST(
      incoming('/ingest/s/', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: everyByte,
      }),
    );

    const first = await sentToPostHog(0);
    expect(first.method).toBe('POST');
    expect(first.body).toEqual(gzip);
    expect(gunzipSync(first.body).toString('utf8')).toBe(json);
    expect((await sentToPostHog(1)).body).toEqual(everyByte);
  });

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
      const req = incoming(`/ingest${path}`, {
        method,
        headers: BROWSER_HEADERS,
        body: method === 'POST' ? new Uint8Array([1]) : undefined,
      });
      // The route is handed the member's cookie: this cannot pass by never seeing one.
      expect(req.headers.get('cookie'), method).toBe(MEMBER_COOKIE);

      const res = await route[method](req);

      const sent = await sentToPostHog(call);
      expect(sent.method).toBe(method);
      expect([...sent.headers.keys()].sort(), method).toEqual(SENT_HEADERS);
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
  // POST for events, flags, replay, logs and the Conversations writes; GET
  // (and HEAD) for the lists, the remote config and the bundles. Next answers
  // HEAD with the GET handler when a route exports no HEAD
  // (auto-implement-methods.js), so the route checks the method itself.
  it.each(SDK_REQUESTS)(
    '%s /ingest%s: any other method answers 405, no body, and PostHog is not asked',
    async (sdkMethod, path) => {
      const others: Method[] = sdkMethod === 'GET' ? ['POST'] : ['GET', 'HEAD'];
      for (const method of others) {
        const res = await ask(method, `/ingest${path}`);

        expect(res.status, method).toBe(405);
        expect(await res.text(), method).toBe('');
        expect(res.headers.get('x-content-type-options'), method).toBe('nosniff');
        expect(res.headers.get('allow'), method).toBe(sdkMethod === 'GET' ? 'GET, HEAD' : 'POST');
      }
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('answers 405 to a POST on a GET path before reading a byte of its body', async () => {
    const { stream, seen } = chunkedBody(1024, 256);
    const res = await route.POST(
      incoming(`/ingest/static/${SDK_VERSION}/surveys.js`, { method: 'POST', body: stream }),
    );

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
    // posthog-js 1.438.15 they cannot record: only lazy-recorder and
    // posthog-recorder can.
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
    ['a second segment after a ticket', `/ingest/api/conversations/v1/widget/messages/${TICKET}/x`],
    // A ticket id is a UUID: PostHog issues them, and the SDK sends back the
    // one it was given.
    ['a ticket id that is no id', '/ingest/api/conversations/v1/widget/messages/undefined'],
    [
      'a ticket id that is no id, before /read',
      '/ingest/api/conversations/v1/widget/messages/undefined/read',
    ],
    [
      'a ticket id of letters, digits, _ and - that is not a UUID',
      '/ingest/api/conversations/v1/widget/messages/abc_DEF-123',
    ],
    ['a UUID with a character too many', `/ingest/api/conversations/v1/widget/messages/${TICKET}0`],
    [
      'a UUID without its dashes',
      `/ingest/api/conversations/v1/widget/messages/${TICKET.replaceAll('-', '')}`,
    ],
    [
      'a UUID with a dash out of place',
      '/ingest/api/conversations/v1/widget/messages/0000000-00000-4000-8000-000000000000',
    ],
    // The ticket id and the version under /static/ are the only segments not
    // spelled out whole. Each takes only the characters those ids are made of,
    // never a '%', so no encoded slash inside one reaches PostHog.
    [
      'an encoded traversal as a ticket id',
      '/ingest/api/conversations/v1/widget/messages/..%2F..%2F..%2Fapi%2Fprojects%2F',
    ],
    [
      'an encoded traversal as a ticket id, before /read',
      '/ingest/api/conversations/v1/widget/messages/%2E%2E%2Fx/read',
    ],
    ['a ticket id with a dot in it', '/ingest/api/conversations/v1/widget/messages/a.b'],
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
  ])('refuses %s (%s)', async (_label, path) => {
    for (const method of ['GET', 'HEAD', 'POST'] as const) {
      const res = await ask(method, path);

      expect(res.status, method).toBe(404);
      expect(await res.text(), method).toBe('');
      expect(res.headers.get('x-content-type-options'), method).toBe('nosniff');
    }
    expect(upstream).not.toHaveBeenCalled();
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

describe("/ingest passes on a query only where the SDK sends one, and no other project's token", () => {
  it('asks for the remote config with no query, whatever the request carried (the SDK sends none)', async () => {
    for (const path of [`/array/${PROJECT_REF}/config.js`, `/array/${PROJECT_REF}/config`]) {
      for (const method of ['GET', 'HEAD'] as const) {
        upstream.mockClear();
        const res = await ask(method, `/ingest${path}?callback=placeholder&token=${OTHER_PROJECT}`);

        expect(res.status, `${method} ${path}`).toBe(200);
        expect((await sentToPostHog()).url, `${method} ${path}`).toBe(`${ASSETS}${path}`);
      }
    }
  });

  it.each([
    ['GET', `/api/surveys/?token=${OTHER_PROJECT}&_=1700000000000`],
    ['GET', `/api/product_tours/?token=${OTHER_PROJECT}&_=1700000000000`],
    ['POST', `/i/v1/logs?token=${OTHER_PROJECT}`],
    ['POST', `/i/v1/logs?compression=base64&token=${OTHER_PROJECT}`],
    // A second token, an empty one, ours with a space, a name spelled encoded.
    ['GET', `/api/surveys/?token=${PROJECT_REF}&token=${OTHER_PROJECT}`],
    ['GET', '/api/surveys/?token=&_=1700000000000'],
    ['GET', `/api/surveys/?token=${PROJECT_REF}%20`],
    ['GET', `/api/surveys/?%74oken=${OTHER_PROJECT}`],
    // A token on a path the SDK sends none on is held to the same rule.
    ['POST', `/e/?token=${OTHER_PROJECT}`],
  ] as const)(
    "refuses %s /ingest%s with 404: a token that is not this app's key",
    async (method, path) => {
      const res = await ask(method, `/ingest${path}`);

      expect(res.status).toBe(404);
      expect(await res.text()).toBe('');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  it('refuses every token when no project key is set', async () => {
    postHogEnv.NEXT_PUBLIC_POSTHOG_KEY = '';

    for (const [method, path] of [
      ['GET', `/ingest/api/surveys/?token=${PROJECT_REF}`],
      ['GET', '/ingest/api/product_tours/?token=&_=1700000000000'],
      ['POST', '/ingest/i/v1/logs?token=&compression=base64'],
    ] as const) {
      const res = await ask(method, path);
      expect(res.status, path).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('/ingest takes a request body up to the platform limit on every POST path, and no more', () => {
  // posthog-js caps no request body by size and never retries a 4xx, so a
  // cap below the platform's would drop batches the SDK sent for good: event
  // batches (raw JSON after a failed remote config), the console log drain at
  // unload (the whole queue in one POST), a replay snapshot (never split).
  const OVER: Array<[string]> = [
    ['/ingest/e/'],
    [`/ingest/i/v1/logs?token=${PROJECT_REF}`],
    ['/ingest/s/'],
  ];

  it('passes on a body just under the limit and one of exactly the limit on /e/ and /i/v1/logs, by Content-Length and in chunks', async () => {
    const sizes: number[] = [];
    for (const path of ['/ingest/e/', `/ingest/i/v1/logs?token=${PROJECT_REF}`]) {
      for (const size of [CAP - 1, CAP]) {
        const declared = await route.POST(
          incoming(path, {
            method: 'POST',
            headers: { 'content-length': String(size) },
            body: new Uint8Array(size),
          }),
        );
        const chunked = await route.POST(
          incoming(path, { method: 'POST', body: chunkedBody(size, 256 * 1024).stream }),
        );

        for (const res of [declared, chunked]) {
          expect(res.status, `${path} ${size}`).toBe(200);
          expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        }
        sizes.push(size, size);
      }
    }
    expect(upstream).toHaveBeenCalledTimes(sizes.length);
    for (const [call, size] of sizes.entries()) {
      expect((await sentToPostHog(call)).body, `call ${call}`).toHaveLength(size);
    }
  });

  it.each(OVER)(
    'answers 413 to a Content-Length one byte over the limit on %s before reading the body, and asks PostHog nothing',
    async (path) => {
      const { stream, seen } = chunkedBody(16, 16);
      const res = await route.POST(
        incoming(path, {
          method: 'POST',
          headers: { 'content-length': String(CAP + 1) },
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
        incoming(path, { method: 'POST', body: new Uint8Array(CAP + 1) }),
      );
      // The limit in 256 KiB chunks and then one byte.
      const oneOver = chunkedBody(CAP + 1, 256 * 1024);
      const chunked = await route.POST(incoming(path, { method: 'POST', body: oneOver.stream }));
      // Two chunks more than the limit: the first one over is the last one read.
      const longer = chunkedBody(CAP + 2 * 256 * 1024, 256 * 1024);
      const stopped = await route.POST(incoming(path, { method: 'POST', body: longer.stream }));

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

describe('/ingest logs each request it refuses, with the path only', () => {
  // The SDK drops what is refused without retrying, so a remote config that
  // moves /i/v0/e/ or /s/ shows here instead of events vanishing. Never the
  // query (it can carry a token), a header or the body.
  it.each([
    [404, 'GET', `/ingest/api/projects/1/?token=${OTHER_PROJECT}&q=placeholder-query`],
    [404, 'POST', `/ingest/i/v1/logs?token=${OTHER_PROJECT}`],
    [404, 'HEAD', `/ingest/static/toolbar.js?v=${SDK_VERSION}&t=1700000000000`],
    [405, 'GET', '/ingest/e/?compression=base64'],
    [405, 'HEAD', '/ingest/s/'],
    [405, 'POST', `/ingest/array/${PROJECT_REF}/config.js?callback=placeholder-query`],
  ] as const)('a %i to %s %s writes one line', async (status, method, path) => {
    const res = await route[method](
      incoming(path, {
        method,
        headers: BROWSER_HEADERS,
        body: method === 'POST' ? new TextEncoder().encode('placeholder-body') : undefined,
      }),
    );

    expect(res.status).toBe(status);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[ingest] refused', {
      status,
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
      incoming(`/ingest/i/v1/logs?token=${PROJECT_REF}`, {
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
      ['[ingest] refused', { status: 413, method: 'POST', path: '/ingest/i/v1/logs' }],
      ['[ingest] refused', { status: 413, method: 'POST', path: '/ingest/e/' }],
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

    const res = await route.POST(
      incoming('/ingest/e/', { method: 'POST', body: new Uint8Array([1]) }),
    );

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

    const res = await route.POST(
      incoming('/ingest/e/', { method: 'POST', body: new Uint8Array([1]) }),
    );

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

    const res = await route.POST(
      incoming('/ingest/e/', { method: 'POST', body: new Uint8Array([1]) }),
    );

    expect(res.status).toBe(502);
    expect(await res.text()).toBe('');
    expect([...res.headers.keys()]).toEqual(['x-content-type-options']);
    // The server log names the kind of failure, not its text.
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/ECONNREFUSED|socket hang up|aborted/);
  });
});

describe('/ingest serves nothing of PostHog as a page of ours', () => {
  // Bytes, not a string: a string body would bring a content type of its own.
  const PAGE = new TextEncoder().encode('<script>placeholder()</script>');

  function postHogAnswers(contentType: string | null) {
    upstream.mockImplementation(
      async () =>
        new Response(PAGE, {
          status: 200,
          headers: contentType === null ? {} : { 'content-type': contentType },
        }),
    );
  }

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
    ['application/jsonp'],
    [''],
  ])("answers 'text/plain; charset=utf-8', nosniff, when PostHog answers %j", async (type) => {
    postHogAnswers(type);

    for (const [method, path] of [
      ['GET', `/ingest/static/${SDK_VERSION}/surveys.js`],
      ['GET', `/ingest/array/${PROJECT_REF}/config.js`],
      ['POST', '/ingest/e/'],
    ] as const) {
      const res = await ask(method, path);
      expect(res.headers.get('content-type'), path).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
  });

  it("answers 'text/plain; charset=utf-8' when PostHog names no content type", async () => {
    postHogAnswers(null);

    const res = await route.POST(
      incoming('/ingest/e/', { method: 'POST', body: new Uint8Array([1]) }),
    );

    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it.each([
    ['application/json'],
    ['application/json; charset=utf-8'],
    ['application/javascript'],
    ['Application/JavaScript; charset=UTF-8'],
    ['text/javascript; charset=utf-8'],
    ['text/plain'],
  ])("keeps PostHog's %j as it is", async (type) => {
    postHogAnswers(type);

    const res = await route.GET(incoming(`/ingest/static/${SDK_VERSION}/surveys.js`));

    expect(res.headers.get('content-type')).toBe(type);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
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
