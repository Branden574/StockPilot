// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { autoImplementMethods } from 'next/dist/server/route-modules/app-route/helpers/auto-implement-methods';
import { HTTP_METHODS, type HTTP_METHOD } from 'next/dist/server/web/http';
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

/** The route's handlers as Next hands a request to them (route.test.ts says why). */
const viaNext = autoImplementMethods(route);

/**
 * The /ingest list against the posthog-js this app installs (dockets S34 and
 * S38). The route passes on only the requests the SDK makes with this app's
 * init options, each by the one method the SDK uses for it and with the
 * query the SDK gives it. Here:
 *
 *   - every path the SDK's code names, in the bundle the app imports and in
 *     each bundle the route lets it load, is one the route passes on by that
 *     method and refuses by every other method Next hands to a route with
 *     405 (SENT), or one these options never send through /ingest and the
 *     route refuses by every method with 404 (NOT_SENT, with the reason);
 *   - every call that builds an address is read, not only the paths written
 *     out: the SDK asks for nothing but through its request router, so a call
 *     that takes its path from a variable is one this file has an entry for
 *     (ROUTED_BY_VARIABLE), and a path put together from pieces cannot slip
 *     past the scan of literals;
 *   - every bundle the package ships is one the route serves or one it
 *     refuses, and so is every name the SDK's loader can be asked for, read
 *     from the SDK's own type for it, whether the package ships that file or
 *     PostHog serves it.
 *
 * A posthog-js update that adds a path, a call or a bundle fails here until
 * someone reads where the SDK sends it and adds it to the route or to a list
 * below with the reason. fetch is a stub: nothing reaches PostHog.
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
/** The bundles the route serves (route.ts BUNDLES), by the name the SDK loads each by. */
const SERVED_BUNDLES = [
  'surveys',
  'product-tours',
  'logs',
  'dead-clicks-autocapture',
  'exception-autocapture',
  'web-vitals-with-attribution',
];

const RECORDING_OFF =
  'the provider sets disable_session_recording, so the SDK never asks for a recorder (extensions/replay/session-recording.js:196, :318-322; posthog-provider.sdk.test.tsx)';

/** Bundles the package ships that these init options never load, or that do nothing here: refused. */
const REFUSED_BUNDLES: Record<string, string> = {
  conversations:
    'the provider sets disable_conversations (extensions/conversations/posthog-conversations.js:157; posthog-provider.sdk.test.tsx)',
  'lazy-recorder': RECORDING_OFF,
  'posthog-recorder': RECORDING_OFF,
  recorder:
    'defines rrweb only, never initSessionRecording, so it cannot record (extensions/replay/session-recording.js:357-363)',
  'recorder-v2':
    'defines rrweb only, never initSessionRecording, so it cannot record (extensions/replay/session-recording.js:357-363)',
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
 * modules other packages import. loader and loader-bootstrap are not in the
 * installed package: posthog-js 1.447 ships them, as the files a page puts
 * in a script tag of its own (entrypoints/loader.js reads its project from
 * that tag and loads array.js from beside itself); the bundle the app
 * imports names neither.
 */
const NOT_LOADED_BY_NAME =
  /^(?:array|module|main|customizations|default-extensions|extension-bundles|external-scripts-loader|all-external-dependencies|element-inference|rrweb|rrweb-types|rrweb-plugin-console-record|surveys-preview|product-tours-preview|loader|loader-bootstrap)(?:\.[0-9a-z.-]+)?\.js$/;

/** Every method Next hands to a route (HTTP_METHODS), each asked as Next asks it. */
type Method = HTTP_METHOD;
type Sample = ['GET' | 'POST', string, string];

/**
 * Every path the SDK names that it sends through /ingest with these options,
 * as the scan below spells it ({} for each ${...}), with the requests that
 * stand for it, each with a query the SDK builds for it, and the host each
 * goes to.
 */
const SENT: Record<string, Sample[]> = {
  // An event batch: gzip with no query, base64 saying so, a retry counting
  // itself (request.js:533-537; retry-queue.js:106). /i/v0/e/ is the path
  // this project's remote config names instead (posthog-core.js:1107-1108):
  // the SDK's code does not spell it.
  '/e/': [
    ['POST', '/e/', API],
    ['POST', '/e/?compression=base64', API],
    ['POST', '/e/?retry_count=1', API],
    ['POST', '/i/v0/e/', API],
    ['POST', '/i/v0/e/?retry_count=2&compression=base64', API],
  ],
  '/api/surveys/': [['GET', `/api/surveys/?token=${PROJECT_REF}&_=1700000000000`, API]],
  '/api/product_tours/?token={}': [
    ['GET', `/api/product_tours/?token=${PROJECT_REF}&_=1700000000000`, API],
  ],
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
};

/** Paths the SDK names that never go through /ingest with these options: a request for each is refused. */
const NOT_SENT: Record<string, [sample: string, why: string]> = {
  '/e': ['/e', 'a prefix the unload queue is sorted by (request-queue.js:75), not a request'],
  '/i/': ['/i/', 'a prefix the SDK compares with (utils/request-router.js:17), not a request'],
  // What the provider's init switches off (components/analytics/
  // posthog-provider.tsx; posthog-provider.sdk.test.tsx shows each through
  // the real SDK).
  '/flags/?v=2': [
    '/flags/?v=2',
    'the provider sets advanced_disable_feature_flags, so no reload asks (@posthog/browser-common feature-flags.js:599-600); only posthog.getRemoteConfigPayload() asks otherwise (:897), and the app never calls it',
  ],
  '/s/': [
    '/s/',
    'here a prefix the SDK compares with (utils/request-router.js:17); as a request it is a replay snapshot, which the recorder bundle sends, and the provider sets disable_session_recording',
  ],
  '/i/v1/logs': [
    `/i/v1/logs?token=${PROJECT_REF}`,
    "the provider's logs.beforeSend drops every record before it is queued, so there is never one to send (@posthog/browser-common logs.js:393, :449)",
  ],
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
 * The calls that hand the SDK's request router a path that is not written
 * out at the call, by the file and by what the minifier leaves readable:
 * the router's endpointFor(target, path) (utils/request-router.js) and the
 * client adapter's sendRequest(path, ...) (extensions/browser-client.js),
 * which passes its path to the router. Each with where its paths come from.
 * A new one is a path this file's scan of literals may not have seen.
 */
const ROUTED_BY_VARIABLE: Record<string, string> = {
  'module.mjs endpointFor("assets", <variable>)':
    "the loader's fallback address, /static/{}.js?v={}, built just above the call (entrypoints/external-scripts-loader.js:104-114)",
  'module.mjs endpointFor("api", <variable>)':
    "a site app's address from the remote config (external-scripts-loader.js:159-162); opt_in_site_apps is off, and the route refuses /site_app/",
  'module.mjs endpointFor("api", this.analyticsDefaultEndpoint)':
    "the events path: '/e/' (posthog-core.js:353) or the remote config's analytics.endpoint (:1107-1108), /i/v0/e/ for this project",
  'module.mjs endpointFor(<variable>, <variable>)':
    "the client adapter's sendRequest (extensions/browser-client.js:295-296): the path of each sendRequest call",
  'surveys.js endpointFor(<variable>, <variable>)':
    'the same adapter, built into the surveys bundle; nothing in the bundle calls its sendRequest',
  'module.mjs sendRequest(<variable>)':
    'feature flags: /flags/?v=2, with &only_evaluate_survey_feature_flags=true or without (@posthog/browser-common feature-flags.js:683, :747)',
};

/** The targets the router knows (utils/request-router.js endpointFor). */
const ROUTER_TARGETS = ['"api"', '"assets"', '"flags"', '"ui"'];

/** Where the ${...} that starts at `at` (its $) ends: the index of its closing brace. */
function expressionEnd(code: string, at: number): number {
  let depth = 0;
  for (let i = at + 1; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return code.length;
}

/**
 * The arguments of the call whose opening bracket is at `open`, split at its
 * top-level commas; null for a definition (`name(a, b) {`) or a bracket that
 * never closes.
 */
function argumentsAt(code: string, open: number): string[] | null {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code[i]!;
    if (c === '"' || c === "'" || c === '`') {
      // A string or a template, whole: its brackets and commas are text.
      const start = i;
      for (i += 1; i < code.length && code[i] !== c; i += 1) {
        if (code[i] === '\\') i += 1;
        else if (c === '`' && code[i] === '$' && code[i + 1] === '{') i = expressionEnd(code, i);
      }
      current += code.slice(start, i + 1);
    } else if (c === '(' || c === '[' || c === '{') {
      depth += 1;
      if (depth > 1) current += c;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) {
        if (current !== '' || parts.length > 0) parts.push(current);
        // A definition, `name(a, b) {`, is not a call.
        return code[i + 1] === '{' ? null : parts;
      }
      current += c;
    } else if (c === ',' && depth === 1) {
      parts.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  return null;
}

/** The arguments of every call of `name` in `code`, each as written. */
function callsOf(code: string, name: string): string[][] {
  const calls: string[][] = [];
  for (const match of code.matchAll(new RegExp(String.raw`\b${name}\(`, 'g'))) {
    const args = argumentsAt(code, match.index + match[0].length - 1);
    if (args) calls.push(args.map((arg) => arg.trim()));
  }
  return calls;
}

/**
 * A path written out whole as one string or template, with {} for each
 * ${...}; null for anything else (a variable, pieces joined with +).
 */
function literalPath(arg: string): string | null {
  const quote = arg[0];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let text = '';
  for (let i = 1; i < arg.length; i += 1) {
    const c = arg[i]!;
    if (c === quote) return i === arg.length - 1 ? text : null;
    if (c === '\\') {
      text += arg[i + 1];
      i += 1;
    } else if (quote === '`' && c === '$' && arg[i + 1] === '{') {
      i = expressionEnd(arg, i);
      text += '{}';
    } else {
      text += c;
    }
  }
  return null;
}

interface Routed {
  /** Paths written out at a call of the router or of the adapter. */
  literals: string[];
  /** Calls whose path is not written out, as ROUTED_BY_VARIABLE spells them. */
  byVariable: string[];
}

/** Every call in `code` that hands the request router a path. */
function routedIn(file: string, code: string): Routed {
  const routed: Routed = { literals: [], byVariable: [] };
  const take = (call: string, pathArg: string) => {
    const literal = literalPath(pathArg);
    if (literal !== null) routed.literals.push(literal);
    else routed.byVariable.push(`${file} ${call}`);
  };
  for (const [target = '', pathArg] of callsOf(code, 'endpointFor')) {
    const to = ROUTER_TARGETS.includes(target) ? target : '<variable>';
    // No path: the host alone (the PostHog app's address, for a link).
    if (pathArg === undefined) continue;
    const named = pathArg === 'this.analyticsDefaultEndpoint' ? pathArg : '<variable>';
    take(`endpointFor(${to}, ${named})`, pathArg);
  }
  for (const [pathArg = ''] of callsOf(code, 'sendRequest'))
    take('sendRequest(<variable>)', pathArg);
  return routed;
}

/**
 * The paths a bundle's code names: string literals that start with a slash
 * and a letter, digit or underscore, and template literals that do, each
 * ${...} read as {}.
 */
function pathsIn(code: string): string[] {
  const found = new Set<string>();
  for (const match of code.matchAll(/(["'])(\/[A-Za-z0-9_][^"'\\\s]*)\1/g)) found.add(match[2]!);
  for (const match of code.matchAll(/`(?=\/[A-Za-z0-9_])/g)) {
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
  return [...found].filter((p) => /^\/[A-Za-z0-9_][A-Za-z0-9_.-]*(?:[/?]|\{\}|$)/.test(p));
}

/** The members of a union of string literals the SDK's types export, other unions it names included. */
function unionMembers(types: string, name: string): string[] {
  const union = new RegExp(String.raw`export type ${name} = ([^;]+);`).exec(types)?.[1];
  if (union === undefined) throw new Error(`posthog-js no longer exports the type ${name}`);
  return union
    .split('|')
    .map((member) => member.trim())
    .flatMap((member) => {
      const text = /^'([^']+)'$/.exec(member)?.[1];
      return text === undefined ? unionMembers(types, member) : [text];
    });
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An event batch for this app's project, as posthog-js builds one (request.js:538-549). */
const BATCH = JSON.stringify({
  api_key: PROJECT_REF,
  batch: [{ event: '$pageview', properties: { token: PROJECT_REF } }],
  sent_at: '2026-01-01T00:00:00.000Z',
});

/** A POST's batch packed the way its address says (request.js:139-171): base64 form, or gzip. */
function postInit(at: string): {
  headers: Record<string, string>;
  body: string | Uint8Array<ArrayBuffer>;
} {
  const base64 =
    new URL(at, 'https://app.example.com').searchParams.get('compression') === 'base64';
  return base64
    ? {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(Buffer.from(BATCH).toString('base64'))}`,
      }
    : { headers: { 'content-type': 'text/plain' }, body: new Uint8Array(gzipSync(BATCH)) };
}

async function ask(method: Method, at: string): Promise<Response> {
  const request = new NextRequest(`https://app.example.com/ingest${at}`, {
    method,
    ...(method === 'POST'
      ? postInit(at)
      : { body: ['PUT', 'PATCH', 'DELETE'].includes(method) ? new Uint8Array([1]) : undefined }),
  });
  return (await viaNext[method](request, {})) as Response;
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
 * the same address by every other method: a GET goes on as GET and as HEAD,
 * a POST as POST, and any other method (OPTIONS, PUT, PATCH and DELETE
 * among them) is refused with 405.
 */
function expectedFor(method: 'GET' | 'POST', at: string, host: string): Array<[Method, string]> {
  const allowed: Method[] = method === 'GET' ? ['GET', 'HEAD'] : ['POST'];
  return HTTP_METHODS.map((m): [Method, string] =>
    allowed.includes(m) ? [m, `sent ${m} to ${host}${at}`] : [m, 'answered 405'],
  );
}

describe('/ingest against the installed posthog-js', () => {
  const files = readdirSync(DIST).filter((file) => file.endsWith('.js'));
  const entry = SDK.module.slice('dist/'.length);
  /** The bundle the app imports, and each bundle the route lets it load. */
  const scanned = [entry].concat(
    SERVED_BUNDLES.filter((name) => files.includes(`${name}.js`)).map((name) => `${name}.js`),
  );
  const code = new Map(scanned.map((file) => [file, readFileSync(path.join(DIST, file), 'utf8')]));

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
    // Every bundle the route serves is one the package ships.
    expect(SERVED_BUNDLES.filter((name) => !names.includes(name))).toEqual([]);

    // The SDK still loads each refused name the package does not ship.
    for (const name of Object.keys(REFUSED_NOT_SHIPPED)) {
      expect(code.get(entry), name).toContain(`"${name}"`);
    }

    const wrong: string[] = [];
    for (const name of [...names, ...Object.keys(REFUSED_NOT_SHIPPED)]) {
      for (const at of [
        `/static/${SDK.version}/${name}.js`,
        `/static/${name}.js?v=${SDK.version}`,
      ]) {
        const expected: Array<[Method, string]> = SERVED_BUNDLES.includes(name)
          ? expectedFor('GET', at, ASSETS)
          : HTTP_METHODS.map((m): [Method, string] => [m, 'answered 404']);
        for (const [method, want] of expected) {
          const got = await outcome(method, at);
          if (got !== want) wrong.push(`${method} ${at}: ${got}, not ${want}`);
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it("has an answer for every name the SDK's loader can be asked for, shipped in the package or not", async () => {
    // The loader builds /static/<version>/<name>.js for whatever name it is
    // handed (entrypoints/external-scripts-loader.js:117-158), and the SDK
    // types that name: every one it can pass is a member of
    // PostHogExtensionKind. remote-config is the loader's name for
    // /array/<key>/config.js, not a bundle.
    const kinds = unionMembers(
      readFileSync(path.join(DIST, 'src/utils/globals.d.ts'), 'utf8'),
      'PostHogExtensionKind',
    );
    expect(kinds).toEqual(expect.arrayContaining(['surveys', 'toolbar', 'remote-config']));
    expect(kinds.length).toBeGreaterThan(10);

    const unknown = kinds.filter(
      (kind) =>
        kind !== 'remote-config' &&
        !SERVED_BUNDLES.includes(kind) &&
        !(kind in REFUSED_BUNDLES) &&
        !(kind in REFUSED_NOT_SHIPPED),
    );
    expect(unknown, 'a new name the loader can be asked for: read what loads it').toEqual([]);
    // Each name refused as not shipped is one the loader can be asked for,
    // and really is not in the package.
    for (const name of Object.keys(REFUSED_NOT_SHIPPED)) {
      expect(kinds, name).toContain(name);
      expect(files, name).not.toContain(`${name}.js`);
    }

    // A name that is not a bundle of the route's is refused under /static/.
    const wrong: string[] = [];
    for (const kind of kinds.filter((name) => !SERVED_BUNDLES.includes(name))) {
      for (const at of [
        `/static/${SDK.version}/${kind}.js`,
        `/static/${kind}.js?v=${SDK.version}`,
      ]) {
        const got = await outcome('GET', at);
        if (got !== 'answered 404') wrong.push(`GET ${at}: ${got}, not answered 404`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('has read every call that hands the request router a path that is not written out', () => {
    const routed = scanned.map((file) => routedIn(file, code.get(file)!));
    // Not an empty scan: the calls every version so far has made.
    expect(routed[0]!.literals).toEqual(
      expect.arrayContaining(['/array/{}/config.js', '/static/{}/{}.js', '/api/surveys/']),
    );

    expect(
      routed.flatMap(({ byVariable }) => byVariable).sort(),
      'a call that takes its path from a variable: read where the path comes from',
    ).toEqual(Object.keys(ROUTED_BY_VARIABLE).sort());
    // The one place a path is put together from pieces: the router itself
    // puts a slash before a path that has none (utils/request-router.js).
    const pieced = [...code.get(entry)!.matchAll(/`\/\$\{/g)];
    expect(pieced, 'a path put together from pieces').toHaveLength(1);
    expect(code.get(entry)!.slice(pieced[0]!.index - 60, pieced[0]!.index)).toContain(
      'endpointFor(',
    );
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
    // What the route refuses because the provider switches it off.
    for (const option of [
      'advanced_disable_feature_flags: true,',
      'disable_session_recording: true,',
      'disable_conversations: true,',
      'logs: { beforeSend: () => null },',
    ]) {
      expect(provider, option).toContain(option);
    }

    // The paths written out anywhere in the code, and the ones written out
    // where the router is called (a path the first scan's pattern missed
    // would still be in the second).
    const named = new Set(
      scanned.flatMap((file) => [
        ...pathsIn(code.get(file)!),
        ...routedIn(file, code.get(file)!).literals.filter((p) => p !== ''),
      ]),
    );
    const unknown = [...named].filter((p) => !(p in SENT) && !(p in NOT_SENT));
    expect(unknown, 'a new posthog-js path: read where the SDK sends it').toEqual([]);
    // Not an empty scan: paths every version so far has named are found.
    for (const p of ['/e/', '/flags/?v=2', '/array/{}/config.js', '/static/{}/{}.js']) {
      expect(named.has(p), p).toBe(true);
    }
    // No entry for a path the SDK no longer names.
    expect(
      [...Object.keys(SENT), ...Object.keys(NOT_SENT)].filter((p) => !named.has(p)),
      'a listed path the SDK no longer names',
    ).toEqual([]);

    // Each request by the SDK's own method goes on with that method (a GET's
    // HEAD too) and with its query; by any other method Next hands to a route
    // it is refused with 405. A path never sent is refused with 404 by every
    // method.
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
          : HTTP_METHODS.map((method): [Method, string, string] => [
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

  it('stamps the time in a query only where the lists above have one, and puts no other name in a query', () => {
    // A GET the SDK stamps gets `_`, a POST it stamps that way would get
    // sent_at (request.js:533-537). The two the SDK's core stamps so are
    // product tours and web experiments; the two the adapter's callers do
    // are surveys and early access features. Every one is a GET, and an
    // event batch carries its time in the body (posthog-core.js:1687), so
    // no POST the route passes on has a time in its query.
    const main = code.get(entry)!;
    expect(main.match(/timestampMode:"query"/g) ?? []).toHaveLength(2);
    expect(main.match(/sentAt:"query"/g) ?? []).toHaveLength(2);
    expect(main).toContain('timestampMode:e.sentAt');
    const stamped = callsOf(main, 'sendRequest')
      .filter(([, init = '']) => init.includes('sentAt:"query"'))
      .map(([pathArg = '', init = '']) => [
        literalPath(pathArg),
        /method:"([A-Z]+)"/.exec(init)?.[1],
      ]);
    expect(stamped).toEqual([
      ['/api/surveys/', 'GET'],
      ['/api/early_access_features/?token={}{}', 'GET'],
    ]);

    // The names the adapter's callers put in a query of their own.
    const queries = callsOf(main, 'sendRequest').flatMap(([pathArg = '', init = '']) =>
      [...init.matchAll(/query:\{([^}]*)\}/g)].map((match) => [
        literalPath(pathArg),
        match[1]!.split(',').map((pair) => pair.split(':')[0]),
      ]),
    );
    expect(queries).toEqual([
      ['/api/surveys/', ['token']],
      ['/i/v1/logs', ['token']],
      ['/i/v1/logs', ['token']],
    ]);
    // And the one a retry adds (retry-queue.js:106).
    expect(main.match(/retry_count/g) ?? []).toHaveLength(1);
  });
});
