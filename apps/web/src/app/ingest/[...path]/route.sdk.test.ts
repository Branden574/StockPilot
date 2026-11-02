import { gunzipSync } from 'node:zlib';

import { NextRequest } from 'next/server';
import posthog from 'posthog-js';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Through the real posthog-js (docket S34): an event batch the SDK sends to
 * /ingest reaches PostHog through the route with every header the SDK set,
 * its body byte for byte and its query. The route passes on a LIST of
 * headers, so an SDK update that starts setting one PostHog needs fails here
 * instead of being dropped in silence.
 *
 * The SDK keeps its own reference to fetch from load, so its stub goes in
 * first; the route's fetch is a second stub, put in place after the SDK has
 * sent. Nothing leaves the process. Placeholder key.
 *
 * A DOM test, because posthog-js needs a window. A DOM Request drops a Cookie
 * header, so what happens to cookies is route.test.ts's (Node) business.
 */

const { sdkFetch, realFetch } = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  const sdkFetch = vi.fn<typeof fetch>(async () => new Response('{"status":1}', { status: 200 }));
  globalThis.fetch = sdkFetch;
  return { sdkFetch, realFetch };
});

import * as route from './route';

const PROJECT_REF = 'phc_placeholder';

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('the real SDK through /ingest', () => {
  it('every header the SDK sets on an event batch reaches PostHog, with the body and the query unchanged', async () => {
    const instance = posthog.init(
      PROJECT_REF,
      {
        api_host: '/ingest',
        // Only what keeps a test SDK to the one request under test.
        advanced_disable_flags: true,
        disable_session_recording: true,
        disable_surveys: true,
        disable_external_dependency_loading: true,
        capture_pageview: false,
        autocapture: false,
        request_batching: false,
        // happy-dom reports navigator.webdriver, which the SDK drops as a bot.
        opt_out_useragent_filter: true,
      },
      's34_ingest',
    );
    sdkFetch.mockClear();
    instance.capture('s34_placeholder_event');
    await vi.waitFor(() =>
      expect(sdkFetch.mock.calls.some(([url]) => String(url).startsWith('/ingest/e/'))).toBe(true),
    );
    const [sdkUrl, sdkInit] = sdkFetch.mock.calls.find(([url]) =>
      String(url).startsWith('/ingest/e/'),
    )!;
    const sdkHeaders = new Headers(sdkInit?.headers);
    const sdkBody = new Uint8Array(await new Response(sdkInit?.body).arrayBuffer());
    // The batch went as posthog-js 1.438.15 sends it by default: gzip, as
    // text/plain (lib/src/request.js encodePostData).
    expect(sdkHeaders.get('content-type')).toBe('text/plain');
    expect(gunzipSync(sdkBody).toString('utf8')).toContain('s34_placeholder_event');

    const upstream = vi.fn<typeof fetch>(async () => new Response('{"status":1}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    try {
      // What the browser sends for the SDK's fetch: its method, headers and body.
      const target = new URL(String(sdkUrl), window.location.origin);
      const res = await route.POST(
        new NextRequest(target, {
          method: sdkInit?.method,
          headers: sdkInit?.headers,
          body: sdkInit?.body,
        }),
      );
      expect(res.status).toBe(200);

      expect(upstream).toHaveBeenCalledTimes(1);
      const [input, init] = upstream.mock.calls[0]!;
      const sent = new Request(input, init);
      expect(sent.url).toBe(
        `https://us.i.posthog.com${target.pathname.slice('/ingest'.length)}${target.search}`,
      );
      expect(sent.method).toBe('POST');
      expect([...sdkHeaders.keys()].length).toBeGreaterThan(0);
      for (const [name, value] of sdkHeaders) {
        expect(sent.headers.get(name), name).toBe(value);
      }
      expect(new Uint8Array(await sent.arrayBuffer())).toEqual(sdkBody);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
