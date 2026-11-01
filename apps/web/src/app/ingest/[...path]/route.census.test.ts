// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The project key the provider reads, as the route reads it (route.test.ts
// says why it is typed this way).
const { PROJECT_REF, postHogEnv } = vi.hoisted(() => {
  const PROJECT_REF = 'phc_placeholder';
  return { PROJECT_REF, postHogEnv: { NEXT_PUBLIC_POSTHOG_KEY: PROJECT_REF } };
});
vi.mock('@/lib/env.client', () => ({ env: postHogEnv }));

import * as route from './route';

/**
 * The /ingest list against the posthog-js this app installs (docket S34).
 * The route passes on only the requests the SDK makes with this app's init
 * options, each by the one method the SDK uses for it. Here every path the
 * SDK's code names, in the bundle the app imports and in each bundle the
 * route lets it load, is one the route passes on by that method and refuses
 * by any other with 405 (SENT), or one these options never send through
 * /ingest (NOT_SENT, with the reason), and every bundle the package ships is
 * one the route serves or one it refuses. A posthog-js update that adds a
 * path or a bundle fails here until someone reads where the SDK sends it and
 * adds it to the route or to a list below with the reason. fetch is a stub:
 * nothing reaches PostHog.
 */

const require = createRequire(import.meta.url);
const SDK_DIR = path.dirname(require.resolve('posthog-js/package.json'));
const SDK = JSON.parse(readFileSync(path.join(SDK_DIR, 'package.json'), 'utf8')) as {
  version: string;
  module: string;
};
const DIST = path.join(SDK_DIR, 'dist');
const WEB_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Init options that would make the SDK send a request the route's list does
 * not have, or send one elsewhere. The reasons below hold while the provider
 * sets none of them.
 */
const LIST_CHANGING_OPTIONS =
  /\b(?:asset_host|flags_api_host|rewriteRequestPath|disable_web_experiments|opt_in_site_apps|metrics|tracing_headers|addTracingHeaders|__add_tracing_headers|integrations|capture_performance|__preview_external_dependency_versioned_paths)\s*:/;

const API = 'https://us.i.posthog.com';
const ASSETS = 'https://us-assets.i.posthog.com';
const TICKET = '00000000-0000-4000-8000-000000000000';

/** The bundles the route serves (route.ts BUNDLES), by the name the SDK loads each by. */
const SERVED_BUNDLES = [
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

/** Bundles the package ships that these init options never load, or that do nothing here: refused. */
const REFUSED_BUNDLES: Record<string, string> = {
  recorder:
    'defines rrweb only, never initSessionRecording, so it cannot record (extensions/replay/session-recording.js:357-363); only lazy-recorder and posthog-recorder can',
  'recorder-v2':
    'defines rrweb only, never initSessionRecording, so it cannot record (extensions/replay/session-recording.js:357-363); only lazy-recorder and posthog-recorder can',
  'tracing-headers': 'tracing_headers is unset (extensions/tracing-headers.js:75)',
  'intercom-integration': 'integrations is unset (extensions/external-integration.js:70)',
  'crisp-chat-integration': 'integrations is unset (extensions/external-integration.js:70)',
  'web-vitals':
    'capture_performance unset picks web-vitals-with-attribution (extensions/web-vitals/index.js:401-409)',
  'web-vitals-soft-navs': 'soft navigations are a capture_performance option, unset here',
  'web-vitals-with-attribution-soft-navs':
    'soft navigations are a capture_performance option, unset here',
};

/**
 * Bundles the SDK loads by a name the package does not ship (PostHog serves
 * them): refused, each with the reason. The scan below checks the SDK still
 * names each, so the list cannot go stale in silence.
 */
const REFUSED_NOT_SHIPPED: Record<string, string> = {
  toolbar:
    "launched by a #__posthog= link (extensions/toolbar.js:25, :153), it talks to ui_host, which the CSP's connect-src does not allow (next.config.ts), so it cannot work here; served, such a link would load it from our origin on every later page (toolbar.js:146)",
};

/**
 * Files in dist that are never loaded by name: the entry bundles (the app
 * imports module.mjs; the others are for script tags and other builds) and
 * modules other packages import.
 */
const NOT_LOADED_BY_NAME =
  /^(?:array|module|main|customizations|default-extensions|extension-bundles|external-scripts-loader|all-external-dependencies|element-inference|rrweb|rrweb-types|rrweb-plugin-console-record|surveys-preview|product-tours-preview)(?:\.[0-9a-z.-]+)?\.js$/;

type Method = 'GET' | 'HEAD' | 'POST';
type Sample = ['GET' | 'POST', string, string];

/**
 * Every path the SDK names that it sends through /ingest with these options,
 * as the scan below spells it ({} for each ${...}), with the requests that
 * stand for it and the host each goes to.
 */
const SENT: Record<string, Sample[]> = {
  '/e/': [['POST', '/e/', API]],
  '/flags/?v=2': [['POST', '/flags/?v=2', API]],
  '/s/': [['POST', '/s/', API]],
  '/i/v1/logs': [['POST', `/i/v1/logs?token=${PROJECT_REF}`, API]],
  '/api/surveys/': [['GET', `/api/surveys/?token=${PROJECT_REF}`, API]],
  '/api/product_tours/?token={}': [['GET', `/api/product_tours/?token=${PROJECT_REF}`, API]],
  '/array/{}/config': [['GET', `/array/${PROJECT_REF}/config`, ASSETS]],
  '/array/{}/config.js': [['GET', `/array/${PROJECT_REF}/config.js`, ASSETS]],
  '/static/{}/{}.js': SERVED_BUNDLES.map((name): Sample => [
    'GET',
    `/static/${SDK.version}/${name}.js`,
    ASSETS,
  ]),
  '/static/{}.js?v={}': SERVED_BUNDLES.map((name): Sample => [
    'GET',
    `/static/${name}.js?v=${SDK.version}`,
    ASSETS,
  ]),
  '/api/conversations/v1/widget/message': [['POST', '/api/conversations/v1/widget/message', API]],
  '/api/conversations/v1/widget/messages/{}?{}': [
    ['GET', `/api/conversations/v1/widget/messages/${TICKET}?limit=20`, API],
  ],
  '/api/conversations/v1/widget/messages/{}/read': [
    ['POST', `/api/conversations/v1/widget/messages/${TICKET}/read`, API],
  ],
  '/api/conversations/v1/widget/tickets?{}': [
    ['GET', '/api/conversations/v1/widget/tickets?limit=20', API],
  ],
  '/api/conversations/v1/widget/restore': [['POST', '/api/conversations/v1/widget/restore', API]],
  '/api/conversations/v1/widget/restore/request': [
    ['POST', '/api/conversations/v1/widget/restore/request', API],
  ],
};

/** Paths the SDK names that never go through /ingest with these options: a request for each is refused. */
const NOT_SENT: Record<string, [sample: string, why: string]> = {
  '/e': ['/e', 'a prefix the unload queue is sorted by (request-queue.js:75), not a request'],
  '/i/': ['/i/', 'a prefix the SDK compares with (utils/request-router.js:17), not a request'],
  '/api/web_experiments/?token={}': [
    `/api/web_experiments/?token=${PROJECT_REF}`,
    'disable_web_experiments defaults to true (posthog-core.js:218; web-experiments.js:74, :117)',
  ],
  '/api/early_access_features/?token={}{}': [
    `/api/early_access_features/?token=${PROJECT_REF}`,
    'only posthog.getEarlyAccessFeatures() asks for it, and the app never calls it',
  ],
  '/i/v1/metrics': [
    `/i/v1/metrics?token=${PROJECT_REF}`,
    'only posthog.metrics.* or the metrics option send it (posthog-metrics.js:55, :190)',
  ],
  '/project/{}/replay/{}': [
    `/project/${PROJECT_REF}/replay/1`,
    'a link to the PostHog app (ui_host), never a request to api_host (posthog-core.js:3666)',
  ],
  '/project/{}/person/{}': [
    `/project/${PROJECT_REF}/person/1`,
    'a link to the PostHog app (ui_host), never a request to api_host (extensions/sentry-integration.js:46)',
  ],
  '/issues/?project=': [
    '/issues/?project=1',
    'part of a link to Sentry put in an event (extensions/sentry-integration.js:75)',
  ],
};

/**
 * The paths a bundle's code names: string literals that start with
 * /<letter>, and template literals that do, each ${...} read as {}.
 */
function pathsIn(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(/(["'])(\/[a-z_][^"'\\\s]*)\1/g)) found.add(match[2]!);
  for (const match of code.matchAll(/`(?=\/[a-z_])/g)) {
    let text = '';
    let depth = 0;
    for (let i = match.index + 1; i < code.length; i += 1) {
      const c = code[i];
      if (depth === 0 && c === '`') break;
      if (depth === 0 && c === '$' && code[i + 1] === '{') {
        text += '{}';
        depth = 1;
        i += 1;
      } else if (depth > 0) {
        if (c === '{') depth += 1;
        if (c === '}') depth -= 1;
      } else {
        text += c;
      }
    }
    found.add(text);
  }
  return [...found].filter((p) => /^\/[a-z_][a-z0-9_]*(?:[/?]|\{\}|$)/.test(p));
}

const upstream = vi.fn<typeof fetch>();

beforeEach(() => {
  upstream.mockReset();
  upstream.mockImplementation(
    async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', upstream);
  postHogEnv.NEXT_PUBLIC_POSTHOG_KEY = PROJECT_REF;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ask(method: Method, at: string): Promise<Response> {
  const request = new NextRequest(`https://app.example.com/ingest${at}`, {
    method,
    body: method === 'POST' ? new Uint8Array([1]) : undefined,
  });
  return route[method](request);
}

/**
 * What the route does with a request: the method and the address PostHog
 * was asked with, or the route's status when PostHog was not asked.
 */
async function outcome(method: Method, at: string): Promise<string> {
  upstream.mockClear();
  const res = await ask(method, at);
  if (upstream.mock.calls.length === 0) return `answered ${res.status}`;
  const [input, init] = upstream.mock.calls[0]!;
  return `sent ${init?.method} to ${String(input)}`;
}

/**
 * What the route must do with a request the SDK makes by `method`, and with
 * the same address by the other methods: a GET goes on as GET and as HEAD and
 * a POST is refused; a POST goes on as POST and a GET or HEAD is refused.
 */
function expectedFor(method: 'GET' | 'POST', at: string, host: string): Array<[Method, string]> {
  const sent = (m: Method): [Method, string] => [m, `sent ${m} to ${host}${at}`];
  return method === 'GET'
    ? [sent('GET'), sent('HEAD'), ['POST', 'answered 405']]
    : [sent('POST'), ['GET', 'answered 405'], ['HEAD', 'answered 405']];
}

describe('/ingest against the installed posthog-js', () => {
  const files = readdirSync(DIST).filter((file) => file.endsWith('.js'));

  it('serves every bundle the route lists and refuses every other bundle the package ships', async () => {
    const names = files
      .filter((file) => !NOT_LOADED_BY_NAME.test(file))
      .map((file) => file.slice(0, -'.js'.length));
    const unknown = names.filter(
      (name) => !SERVED_BUNDLES.includes(name) && !(name in REFUSED_BUNDLES),
    );
    expect(unknown, 'a new posthog-js bundle: read where the SDK loads it').toEqual([]);
    // Not an empty scan: the app's entry, and the bundles beside it.
    expect(SDK.module).toBe('dist/module.mjs');
    expect(names.length).toBeGreaterThan(10);

    // The SDK still loads each refused name the package does not ship.
    const entry = readFileSync(path.join(DIST, SDK.module.slice('dist/'.length)), 'utf8');
    for (const name of Object.keys(REFUSED_NOT_SHIPPED)) {
      expect(entry, name).toContain(`"${name}"`);
    }

    const wrong: string[] = [];
    for (const name of [...names, ...Object.keys(REFUSED_NOT_SHIPPED)]) {
      for (const at of [
        `/static/${SDK.version}/${name}.js`,
        `/static/${name}.js?v=${SDK.version}`,
      ]) {
        const expected: Array<[Method, string]> = SERVED_BUNDLES.includes(name)
          ? expectedFor('GET', at, ASSETS)
          : (['GET', 'HEAD', 'POST'] as const).map((m) => [m, 'answered 404']);
        for (const [method, want] of expected) {
          const got = await outcome(method, at);
          if (got !== want) wrong.push(`${method} ${at}: ${got}, not ${want}`);
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('passes on every path the SDK names that it sends through /ingest, and refuses the rest', async () => {
    const provider = readFileSync(
      path.join(WEB_ROOT, 'src/components/analytics/posthog-provider.tsx'),
      'utf8',
    );
    expect(provider).toContain("api_host: '/ingest',");
    expect(
      provider.match(LIST_CHANGING_OPTIONS)?.[0] ?? null,
      'the provider sets an init option the /ingest list was not checked against',
    ).toBeNull();

    const scanned = [SDK.module.slice('dist/'.length)].concat(
      SERVED_BUNDLES.filter((name) => files.includes(`${name}.js`)).map((name) => `${name}.js`),
    );
    const named = new Set(
      scanned.flatMap((file) => pathsIn(readFileSync(path.join(DIST, file), 'utf8'))),
    );
    const unknown = [...named].filter((p) => !(p in SENT) && !(p in NOT_SENT));
    expect(unknown, 'a new posthog-js path: read where the SDK sends it').toEqual([]);
    // Not an empty scan: paths every version so far has named are found.
    for (const p of ['/e/', '/flags/?v=2', '/array/{}/config.js', '/static/{}/{}.js']) {
      expect(named.has(p), p).toBe(true);
    }

    // Each request by the SDK's own method goes on with that method (a GET's
    // HEAD too); by any other it is refused with 405. A path never sent is
    // refused with 404 by every method.
    const wrong: string[] = [];
    for (const p of named) {
      const samples: Array<[Method, string, string]> =
        p in SENT
          ? SENT[p]!.flatMap(([method, at, host]) =>
              expectedFor(method, at, host).map(([m, want]): [Method, string, string] => [
                m,
                at,
                want,
              ]),
            )
          : (['GET', 'HEAD', 'POST'] as const).map((method) => [
              method,
              NOT_SENT[p]![0],
              'answered 404',
            ]);
      for (const [method, at, expected] of samples) {
        const got = await outcome(method, at);
        if (got !== expected) wrong.push(`${p}: ${method} ${at}: ${got}, not ${expected}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});
