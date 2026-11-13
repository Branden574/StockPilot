import { gunzipSync } from 'node:zlib';

import { render } from '@testing-library/react';
import { autoImplementMethods } from 'next/dist/server/route-modules/app-route/helpers/auto-implement-methods';
import type { HTTP_METHOD } from 'next/dist/server/web/http';
import { NextRequest } from 'next/server';
import posthog, { type PostHog, type PostHogConfig } from 'posthog-js';
import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Through the real posthog-js (dockets S34 and S38): what the SDK sends to
 * /ingest with this app's init options, the provider's own, is what the
 * route passes on. The route takes a LIST of paths, of query parameters and
 * of headers, and an event batch only as the SDK packs one for this app's
 * project, so an SDK update that sends anything new (a path, a parameter, a
 * header PostHog needs, another way to pack a batch) fails here instead of
 * being refused in production, where the SDK drops it without a word.
 *
 * The SDK keeps its own reference to fetch from load, so its stub goes in
 * first; the route's fetch is a second stub, in place only while a request
 * goes through the route. Scripts the SDK asks for are kept out of the
 * document. Nothing leaves the process. Placeholder key.
 *
 * A DOM test, because posthog-js needs a window. A DOM Request drops a Cookie
 * header, so what happens to cookies is route.test.ts's (Node) business.
 */

const { sdkFetch, realFetch, PROJECT_REF } = vi.hoisted(() => {
  const realFetch = globalThis.fetch;
  const sdkFetch = vi.fn<typeof fetch>();
  globalThis.fetch = sdkFetch;
  // A neutral name holds the value (route.test.ts says why).
  return { sdkFetch, realFetch, PROJECT_REF: 'phc_placeholder' };
});

vi.mock('next/navigation', () => ({ usePathname: () => window.location.pathname }));
vi.mock('@/lib/env.client', () => ({ env: { NEXT_PUBLIC_POSTHOG_KEY: PROJECT_REF } }));

import { PostHogProvider } from '@/components/analytics/posthog-provider';

import * as route from './route';

/** The route's handlers as Next hands a request to them (route.test.ts says why). */
const viaNext = autoImplementMethods(route);

const OTHER_PROJECT = 'phc_other';
const API = 'https://us.i.posthog.com';
const ASSETS = 'https://us-assets.i.posthog.com';

/**
 * A PostHog project with everything switched on that a project can switch
 * on by itself, as its remote config would say it (posthog-js remote-config
 * types): what the provider's init does not refuse, this turns on.
 */
const EVERYTHING_ON = {
  token: PROJECT_REF,
  supportedCompression: ['gzip', 'gzip-js'],
  analytics: { endpoint: '/i/v0/e/' },
  hasFeatureFlags: true,
  autocapture_opt_out: false,
  captureDeadClicks: true,
  heatmaps: true,
  capturePerformance: { network_timing: true, web_vitals: true, web_vitals_allowed_metrics: null },
  autocaptureExceptions: true,
  errorTracking: { autocaptureExceptions: true, suppressionRules: [] },
  logs: { captureConsoleLogs: true },
  sessionRecording: { endpoint: '/s/' },
  conversations: { enabled: true, token: 'placeholder-widget' },
  surveys: true,
  productTours: true,
  elementsChainAsString: true,
  defaultIdentifiedOnly: true,
  siteApps: [{ id: 1, url: '/site_app/1/placeholder/' }],
};

/** What PostHog answers the SDK with, by path: the project's remote config, empty lists, and Ok. */
function postHogAnswers(config: Record<string, unknown> | null): void {
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  sdkFetch.mockImplementation(async (input) => {
    const { pathname } = new URL(String(input), window.location.origin);
    if (pathname.endsWith('/config')) {
      return config ? json(config) : new Response('', { status: 503 });
    }
    if (pathname.endsWith('/api/surveys/')) return json({ surveys: [] });
    if (pathname.endsWith('/api/product_tours/')) return json({ product_tours: [] });
    return json({ status: 1 });
  });
}

let providerOptions: Partial<PostHogConfig> = {};

beforeAll(async () => {
  // The options the provider passes to posthog.init, from the provider itself.
  const init = vi.spyOn(posthog, 'init').mockImplementation(() => posthog);
  render(createElement(PostHogProvider, null, null));
  await vi.waitFor(() => expect(init).toHaveBeenCalled());
  providerOptions = init.mock.calls[0]?.[1] ?? {};
  init.mockRestore();
  expect(providerOptions.api_host).toBe('/ingest');
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/**
 * Every script the SDK asks for, kept out of the document so happy-dom never
 * fetches it. With `defaults` unset the SDK puts scripts in the body.
 */
const scripts: HTMLScriptElement[] = [];
let restoreScripts = () => {};

function interceptScripts(): void {
  function keep<T extends Node>(node: T): T {
    if (node instanceof HTMLScriptElement) scripts.push(node);
    return node;
  }
  const append = vi.spyOn(document.body, 'appendChild').mockImplementation(keep);
  const insert = vi.spyOn(document.body, 'insertBefore').mockImplementation(keep);
  restoreScripts = () => {
    append.mockRestore();
    insert.mockRestore();
  };
}

/** The script tag the SDK asks for the project's remote config with, once it has. */
async function remoteConfigScript(): Promise<HTMLScriptElement> {
  const isConfig = (script: HTMLScriptElement) =>
    addressOf(script.src) === `/ingest/array/${PROJECT_REF}/config.js`;
  await vi.waitFor(() => expect(scripts.some(isConfig)).toBe(true));
  return scripts.find(isConfig)!;
}

afterEach(() => {
  restoreScripts();
  scripts.length = 0;
  sdkFetch.mockReset();
  vi.unstubAllGlobals();
});

/** A request the SDK made: by fetch, or by a script tag. */
interface Asked {
  method: HTTP_METHOD;
  /** Its address after our origin: /ingest/..., query and all. */
  at: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer> | undefined;
}

function addressOf(url: string): string {
  const { origin, pathname, search } = new URL(url, window.location.origin);
  expect(origin, url).toBe(window.location.origin);
  return `${pathname}${search}`;
}

/** Every request the SDK made by fetch since the last reset, bodies as bytes. */
async function askedByFetch(): Promise<Asked[]> {
  const asked: Asked[] = [];
  for (const [input, init] of sdkFetch.mock.calls) {
    asked.push({
      method: (init?.method ?? 'GET') as HTTP_METHOD,
      at: addressOf(String(input)),
      headers: new Headers(init?.headers),
      body:
        init?.body === undefined || init.body === null
          ? undefined
          : new Uint8Array(await new Response(init.body).arrayBuffer()),
    });
  }
  return asked;
}

/** Every script the SDK asked for since the last reset: a GET with no body. */
function askedByScript(): Asked[] {
  return scripts.map((script) => ({
    method: 'GET',
    at: addressOf(script.src),
    headers: new Headers(),
    body: undefined,
  }));
}

/** What the route did with a request: its answer's status, and what it asked PostHog. */
async function throughRoute(asked: Asked) {
  const upstream = vi.fn<typeof fetch>(
    async () =>
      new Response('{"status":1}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', upstream);
  try {
    const res = (await viaNext[asked.method](
      new NextRequest(new URL(asked.at, window.location.origin), {
        method: asked.method,
        headers: asked.headers,
        body: asked.body,
      }),
      {},
    )) as Response;
    const calls = upstream.mock.calls.map(([input, init]) => new Request(input, init));
    return { status: res.status, calls };
  } finally {
    vi.unstubAllGlobals();
  }
}

/** The JSON of a batch the SDK sent, whichever way it packed it. */
function batchOf({ headers, body }: Asked): { api_key?: string; batch?: Array<{ event: string }> } {
  const bytes = Buffer.from(body ?? new Uint8Array());
  const type = headers.get('content-type');
  const text =
    type === 'text/plain'
      ? gunzipSync(bytes).toString('utf8')
      : type === 'application/x-www-form-urlencoded'
        ? Buffer.from(
            decodeURIComponent(bytes.toString('latin1').slice('data='.length)),
            'base64',
          ).toString('utf8')
        : bytes.toString('utf8');
  return JSON.parse(text) as { api_key?: string; batch?: Array<{ event: string }> };
}

/** An SDK instance with the provider's options; `extra` only where a test must steer the SDK. */
function sdk(name: string, extra: Partial<PostHogConfig> = {}, key: string = PROJECT_REF): PostHog {
  return posthog.init(
    key,
    {
      ...providerOptions,
      // happy-dom reports navigator.webdriver, which the SDK drops as a bot.
      opt_out_useragent_filter: true,
      ...extra,
    },
    name,
  );
}

/** Only what keeps a test SDK to the request under test; everything else is the provider's. */
const QUIET: Partial<PostHogConfig> = {
  advanced_disable_flags: true,
  disable_surveys: true,
  disable_external_dependency_loading: true,
  capture_pageview: false,
  autocapture: false,
  request_batching: false,
};

describe('the real SDK through /ingest, with the options the provider gives it', () => {
  it('asks for nothing the route refuses on a page whose PostHog project has every feature switched on', async () => {
    interceptScripts();
    postHogAnswers(EVERYTHING_ON);
    const version = posthog.version;

    // The page loads: the SDK asks for the project's remote config as a
    // script, and as JSON when the script left none.
    const instance = sdk('s38_page');
    const configScript = await remoteConfigScript();
    configScript.onload?.call(configScript, new Event('load'));
    // With the config in, the SDK asks for the bundles of what the project
    // switched on.
    await vi.waitFor(() =>
      expect(scripts.map((script) => addressOf(script.src))).toEqual(
        expect.arrayContaining([
          `/ingest/static/${version}/surveys.js`,
          `/ingest/static/${version}/dead-clicks-autocapture.js`,
          `/ingest/static/${version}/exception-autocapture.js`,
        ]),
      ),
    );
    // One of them does not load: the SDK asks for it by its other address.
    const surveys = scripts.find((script) => script.src.endsWith(`/static/${version}/surveys.js`))!;
    surveys.onerror?.call(surveys, new Event('error'));
    await vi.waitFor(() =>
      expect(scripts.map((script) => addressOf(script.src))).toContain(
        `/ingest/static/surveys.js?v=${version}`,
      ),
    );

    // The member is identified, the app captures an event, the lists are
    // asked for, and the page goes away: the queue empties.
    instance.identify('00000000-0000-4000-8000-000000000001', { plan: 'placeholder' });
    instance.capture('s38_placeholder_event');
    instance.capture('s38_placeholder_now', {}, { send_instantly: true });
    instance.getSurveys(() => {}, true);
    instance.productTours?.getProductTours(() => {}, true);
    window.dispatchEvent(new Event('onpagehide' in window ? 'pagehide' : 'unload'));
    await vi.waitFor(async () => {
      const paths = (await askedByFetch()).map(({ at }) => at.split('?')[0]);
      expect(paths).toEqual(
        expect.arrayContaining([
          `/ingest/array/${PROJECT_REF}/config`,
          '/ingest/i/v0/e/',
          '/ingest/api/surveys/',
          '/ingest/api/product_tours/',
        ]),
      );
    });

    const asked = [...(await askedByFetch()), ...askedByScript()];
    // Not an empty walk: the requests every page makes, and several bundles.
    const made = new Set(asked.map(({ method, at }) => `${method} ${at.split('?')[0]}`));
    expect([...made]).toEqual(
      expect.arrayContaining([
        `GET /ingest/array/${PROJECT_REF}/config.js`,
        `GET /ingest/array/${PROJECT_REF}/config`,
        'POST /ingest/i/v0/e/',
        'GET /ingest/api/surveys/',
        'GET /ingest/api/product_tours/',
        `GET /ingest/static/${version}/surveys.js`,
        'GET /ingest/static/surveys.js',
      ]),
    );
    expect([...made].filter((request) => request.includes('/static/')).length).toBeGreaterThan(4);
    // The batches are this app's, whole: the pageview, the identify and both events.
    const events = asked
      .filter(({ method }) => method === 'POST')
      .flatMap((request) => {
        const batch = batchOf(request);
        expect(batch.api_key).toBe(PROJECT_REF);
        return (batch.batch ?? []).map(({ event }) => event);
      });
    expect(events).toEqual(
      expect.arrayContaining(['$pageview', 's38_placeholder_event', 's38_placeholder_now']),
    );

    // Every one of them goes on: by its method, to the host the SDK itself
    // would use, with its own query. What the provider switches off (flags,
    // replay, console logs, Conversations) is refused by the route, so the
    // SDK asking for any of it would show here.
    const refused: string[] = [];
    for (const request of asked) {
      const { status, calls } = await throughRoute(request);
      const host = /^\/ingest\/(?:static|array)\//.test(request.at) ? ASSETS : API;
      const went =
        status === 200 &&
        calls.length === 1 &&
        calls[0]!.method === request.method &&
        calls[0]!.url === `${host}${request.at.slice('/ingest'.length)}`;
      if (!went) refused.push(`${request.method} ${request.at}: ${status}`);
    }
    expect(refused, 'a request the SDK makes that the route does not pass on').toEqual([]);
  });

  /** The one event batch the SDK has sent to /ingest/e/ since the last reset, once it has. */
  async function eventBatchSent(nth = 0): Promise<Asked> {
    const batches = async () =>
      (await askedByFetch()).filter(({ at }) => at.startsWith('/ingest/e/'));
    await vi.waitFor(async () => expect((await batches()).length).toBeGreaterThan(nth));
    return (await batches())[nth]!;
  }

  /** That the route passed a batch on as the SDK sent it: its headers, its query, its bytes. */
  async function expectPassedOn(sent: Asked): Promise<void> {
    const { status, calls } = await throughRoute(sent);
    expect(status, sent.at).toBe(200);
    expect(calls).toHaveLength(1);
    const [passed] = calls;
    expect(passed!.method).toBe('POST');
    expect(passed!.url).toBe(`${API}${sent.at.slice('/ingest'.length)}`);
    // Every header the SDK set, so one PostHog needs is never dropped in silence.
    expect([...sent.headers.keys()].length).toBeGreaterThan(0);
    for (const [name, value] of sent.headers) {
      expect(passed!.headers.get(name), name).toBe(value);
    }
    expect(new Uint8Array(await passed!.arrayBuffer())).toEqual(sent.body);
  }

  it('an event batch packed the default way, gzip, reaches PostHog with every header the SDK set, its query and its bytes unchanged', async () => {
    postHogAnswers(null);
    const instance = sdk('s38_gzip', QUIET);
    instance.capture('s38_placeholder_event');

    const sent = await eventBatchSent();
    // As posthog-js 1.438.15 sends it by default: gzip, as text/plain, with
    // no query (lib/src/request.js encodePostData, buildRequestURL).
    expect(sent.at).toBe('/ingest/e/');
    expect(sent.headers.get('content-type')).toBe('text/plain');
    expect(gunzipSync(sent.body!).toString('utf8')).toContain('s38_placeholder_event');
    await expectPassedOn(sent);
  });

  it('the two other ways the SDK packs a batch, when the remote config cannot be loaded, reach PostHog the same', async () => {
    interceptScripts();
    postHogAnswers(null);
    const instance = sdk('s38_no_config', {
      disable_surveys: true,
      capture_pageview: false,
      autocapture: false,
      request_batching: false,
    });
    // Neither the config script nor its JSON loads, so the SDK does not know
    // what PostHog takes: it sends raw JSON (posthog-core.js:1097).
    const configScript = await remoteConfigScript();
    configScript.onerror?.call(configScript, new Event('error'));
    await vi.waitFor(async () =>
      expect((await askedByFetch()).map(({ at }) => at)).toContain(
        `/ingest/array/${PROJECT_REF}/config`,
      ),
    );
    await vi.waitFor(() => expect(instance.compression).toBeUndefined());

    instance.capture('s38_placeholder_json');
    const json = await eventBatchSent(0);
    expect(json.at).toBe('/ingest/e/');
    expect(json.headers.get('content-type')).toBe('application/json');
    expect(batchOf(json).batch?.[0]?.event).toBe('s38_placeholder_json');
    await expectPassedOn(json);

    // And, as the page goes away, base64 in a form (request.js:583-585); by
    // fetch, as the provider switches the beacon off.
    instance.capture('s38_placeholder_base64', {}, { transport: 'sendBeacon' });
    const base64 = await eventBatchSent(1);
    expect(base64.at).toBe('/ingest/e/?compression=base64');
    expect(base64.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(batchOf(base64).batch?.[0]?.event).toBe('s38_placeholder_base64');
    await expectPassedOn(base64);
  });

  it('a batch with every kind of value in an event reaches PostHog too: the SDK writes it with JSON.stringify, the one writing the route takes', async () => {
    postHogAnswers(null);
    const instance = sdk('s38_values', QUIET);
    const holdsItself: Record<string, unknown> = { name: 'placeholder' };
    holdsItself.itself = holdsItself;
    instance.capture('s38_placeholder_values', {
      marks: '" \\ / : , { } [ ] \n \u0000 \u2028 \uFEFF \u00E9 \uD840\uDC00 \uD840',
      looksLikeABatch: `{"api_key":"${OTHER_PROJECT}","api_key":"${PROJECT_REF}","batch":[]}`,
      numbers: [0, -0, 0.1 + 0.2, 1e20, 1e21, 1e-7, Number.MAX_VALUE, NaN, Infinity],
      big: BigInt('12345678901234567890'),
      names: { b: 1, 10: 2, 2: 3 },
      error: new Error('placeholder'),
      when: new Date(0),
      nothing: undefined,
      none: null,
      holdsItself,
    });

    const sent = await eventBatchSent();
    expect(sent.headers.get('content-type')).toBe('text/plain');
    const text = gunzipSync(sent.body!).toString('utf8');
    expect(text).toContain('s38_placeholder_values');
    // Written by JSON.stringify: read and written again, it is the same text.
    expect(JSON.stringify(JSON.parse(text))).toBe(text);
    await expectPassedOn(sent);
  });

  it('a batch the SDK builds for another PostHog project goes no further than the route, whichever way it is packed', async () => {
    interceptScripts();
    postHogAnswers(null);
    const gzip = sdk('s38_other_gzip', QUIET, OTHER_PROJECT);
    gzip.capture('s38_placeholder_event');
    const unpacked = sdk(
      's38_other_no_config',
      { ...QUIET, disable_compression: true },
      OTHER_PROJECT,
    );
    unpacked.capture('s38_placeholder_json');
    unpacked.capture('s38_placeholder_base64', {}, { transport: 'sendBeacon' });

    await eventBatchSent(2);
    const sent = (await askedByFetch()).filter(({ at }) => at.startsWith('/ingest/e/'));
    expect(sent.map(({ headers }) => headers.get('content-type')).sort()).toEqual([
      'application/json',
      'application/x-www-form-urlencoded',
      'text/plain',
    ]);
    for (const batch of sent) {
      expect(batchOf(batch).api_key).toBe(OTHER_PROJECT);
      const { status, calls } = await throughRoute(batch);
      expect(status, batch.at).toBe(404);
      expect(calls).toEqual([]);
    }
  });

  it('a batch PostHog did not take is sent again with its retry counted, and the route passes that on too', async () => {
    postHogAnswers(null);
    sdkFetch.mockImplementationOnce(async () => new Response('', { status: 503 }));
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    try {
      const instance = sdk('s38_retry', QUIET);
      instance.capture('s38_placeholder_event');
      await vi.advanceTimersByTimeAsync(60_000);

      const retry = await eventBatchSent(1);
      expect(retry.at).toBe('/ingest/e/?retry_count=1');
      await expectPassedOn(retry);
    } finally {
      vi.useRealTimers();
    }
  });
});
