// @vitest-environment node
// Node, not a DOM: a browser-like Request drops the header names a page may
// not set (Cookie among them), and the route receives them as the browser sent
// them. The first test checks that the request handed to the route still has
// them, so it cannot pass by never seeing a cookie.
import { gunzipSync, gzipSync } from 'node:zlib';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as route from './route';

/**
 * The /ingest analytics proxy (docket S34). PostHog's browser SDK sends
 * everything to /ingest on our own origin, so the browser attaches every
 * cookie of this host, the Supabase session among them. The next.config.ts
 * rewrites this route replaced forwarded the request's headers as they came;
 * the route builds a new request from a list. fetch is a stub: nothing here
 * reaches PostHog. Placeholder values only.
 */

const SITE = 'https://app.example.com';
// What a signed-in member's browser attaches to a same-origin request: the
// Supabase session (and a chunk of it), PostHog's own cookie and the
// remember-session flag.
const MEMBER_COOKIE =
  'sb-placeholder-auth-token=placeholder-session; sb-placeholder-auth-token.0=placeholder-chunk; ph_phc_placeholder_posthog=placeholder-ph; stockpilot-remember-session=1';
const MEMBER_BEARER = 'Bearer eyJplaceholder';
// A PostHog project key, as a capture v1 SDK sends it, and a personal API key.
const PROJECT_REF = 'phc_placeholder';
const PROJECT_BEARER = `Bearer ${PROJECT_REF}`;
const PERSONAL_BEARER = 'Bearer phx_placeholder';
// The Conversations widget's value from the public remote config.
const WIDGET_REF = 'placeholder-widget';

const upstream = vi.fn<typeof fetch>();

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function incoming(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: Uint8Array<ArrayBuffer> } = {},
): NextRequest {
  return new NextRequest(`${SITE}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
  });
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

describe('/ingest sends PostHog no member credential', () => {
  it('forwards no cookie and no member Authorization: only the headers PostHog reads, and the visitor address', async () => {
    const req = incoming('/ingest/e/?ip=1&_=1700000000000', {
      method: 'POST',
      headers: {
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
      },
      body: new Uint8Array([1, 2, 3]),
    });
    // The route is handed what the browser sent.
    expect(req.headers.get('cookie')).toBe(MEMBER_COOKIE);
    expect(req.headers.get('authorization')).toBe(MEMBER_BEARER);

    await route.POST(req);

    expect(upstream).toHaveBeenCalledTimes(1);
    const sent = await sentToPostHog();
    expect([...sent.headers.keys()].sort()).toEqual([
      'accept',
      'content-encoding',
      'content-type',
      'posthog-placeholder-header',
      'user-agent',
      'x-conversations-token',
      'x-forwarded-for',
    ]);
    expect(sent.headers.get('cookie')).toBeNull();
    expect(sent.headers.get('authorization')).toBeNull();
    // The first hop: the visitor, as Vercel recorded it.
    expect(sent.headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(sent.headers.get('content-type')).toBe('text/plain');
    expect(sent.headers.get('user-agent')).toBe('Mozilla/5.0 (placeholder)');
    expect(sent.headers.get('posthog-placeholder-header')).toBe('kept');
    expect(sent.headers.get('x-conversations-token')).toBe(WIDGET_REF);
    // Nowhere else either: not in the address, any header or the body.
    const everything = `${sent.url} ${[...sent.headers.values()].join(' ')} ${Buffer.from(sent.body).toString('latin1')}`;
    for (const piece of [
      'placeholder-session',
      'placeholder-chunk',
      'placeholder-ph',
      'eyJplaceholder',
    ]) {
      expect(everything).not.toContain(piece);
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

describe('/ingest passes the request on unchanged otherwise', () => {
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

  it('keeps the exact path after /ingest, its trailing slash and the query', async () => {
    for (const path of [
      '/ingest/e/?ip=1&_=1700000000000',
      '/ingest/e/?compression=gzip-js&ver=1.438.15',
      '/ingest/e/?compression=base64&_=1700000000000',
      '/ingest/flags/?v=2&config=true',
      '/ingest/i/v0/e/?_=1700000000000',
      '/ingest/e',
    ]) {
      await route.POST(incoming(path, { method: 'POST', body: new Uint8Array([1]) }));
    }

    const urls = await Promise.all(upstream.mock.calls.map((_, i) => sentToPostHog(i)));
    expect(urls.map((s) => s.url)).toEqual([
      'https://us.i.posthog.com/e/?ip=1&_=1700000000000',
      'https://us.i.posthog.com/e/?compression=gzip-js&ver=1.438.15',
      'https://us.i.posthog.com/e/?compression=base64&_=1700000000000',
      'https://us.i.posthog.com/flags/?v=2&config=true',
      'https://us.i.posthog.com/i/v0/e/?_=1700000000000',
      'https://us.i.posthog.com/e',
    ]);
  });

  it('sends /ingest/static/* to the assets host and everything else, the /array/ config included, to the API host, as the rewrites did', async () => {
    for (const path of [
      '/ingest/static/array.js',
      '/ingest/static/1.438.15/surveys.js?v=1.438.15',
      '/ingest/array/phc_placeholder/config.js',
      '/ingest/array/phc_placeholder/config',
      '/ingest/statics/placeholder.js',
    ]) {
      await route.GET(incoming(path));
    }

    const sent = await Promise.all(upstream.mock.calls.map((_, i) => sentToPostHog(i)));
    expect(sent.map((s) => s.url)).toEqual([
      'https://us-assets.i.posthog.com/static/array.js',
      'https://us-assets.i.posthog.com/static/1.438.15/surveys.js?v=1.438.15',
      'https://us.i.posthog.com/array/phc_placeholder/config.js',
      'https://us.i.posthog.com/array/phc_placeholder/config',
      'https://us.i.posthog.com/statics/placeholder.js',
    ]);
    for (const s of sent) {
      expect(s.method).toBe('GET');
      expect(s.body).toHaveLength(0);
    }
  });

  it('asks PostHog without following a redirect, without a cache, and with a 10 second limit', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await route.GET(incoming('/ingest/array/phc_placeholder/config.js'));

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
    const res = await route.HEAD(incoming('/ingest/static/array.js', { method: 'HEAD' }));

    const sent = await sentToPostHog();
    expect(sent.method).toBe('HEAD');
    expect(sent.url).toBe('https://us-assets.i.posthog.com/static/array.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(await res.text()).toBe('');
  });

  it('is a dynamic route on the Node runtime', () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.runtime).toBe('nodejs');
  });
});

describe('/ingest only ever reaches the two PostHog hosts', () => {
  it.each([
    ['an encoded slash', '/ingest/static/..%2F..%2Fapi%2Fprojects%2F'],
    ['an encoded slash in lower case', '/ingest/static/x%2fy'],
    ['an encoded backslash', '/ingest/static/%5C..%5Capi'],
    ['dot segments that climb out of /ingest', '/ingest/static/../../api/projects/'],
    ['encoded dot segments that climb out of /ingest', '/ingest/%2e%2e/%2E%2E/api/projects/'],
  ])('refuses %s with 400, no body and no request to PostHog', async (_label, path) => {
    const res = await route.GET(incoming(path));

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('keeps a path that would read as another host, if resolved against PostHog, on PostHog', async () => {
    // new URL('//other.example/x', base) names other.example; the route sets
    // the path on PostHog's own address instead.
    await route.GET(incoming('/ingest//other.example/x'));

    const sent = await sentToPostHog();
    expect(new URL(sent.url).host).toBe('us.i.posthog.com');
    expect(sent.url).toBe('https://us.i.posthog.com//other.example/x');
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

    const res = await route.GET(incoming('/ingest/static/array.js'));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(script);
    expect([...res.headers.keys()].sort()).toEqual(['cache-control', 'content-type']);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("passes PostHog's refusals on as they are, with Retry-After so the SDK waits as long as PostHog asked", async () => {
    upstream.mockImplementationOnce(
      async () =>
        new Response('{"type":"throttled"}', {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        }),
    );

    const res = await route.POST(
      incoming('/ingest/e/', { method: 'POST', body: new Uint8Array([1]) }),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.text()).toBe('{"type":"throttled"}');
  });

  it('answers a status that carries no body (204) without one', async () => {
    upstream.mockImplementationOnce(async () => new Response(null, { status: 204 }));

    const res = await route.POST(
      incoming('/ingest/e/', { method: 'POST', body: new Uint8Array([1]) }),
    );

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    upstream.mockImplementationOnce(failure);

    const res = await route.POST(
      incoming('/ingest/e/', { method: 'POST', body: new Uint8Array([1]) }),
    );

    expect(res.status).toBe(502);
    expect(await res.text()).toBe('');
    expect([...res.headers.keys()]).toEqual([]);
    // The server log names the kind of failure, not its text.
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/ECONNREFUSED|socket hang up|aborted/);
  });
});
