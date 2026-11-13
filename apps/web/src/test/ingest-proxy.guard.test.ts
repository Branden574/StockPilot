import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { tryToParsePath } from 'next/dist/lib/try-to-parse-path';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

// Only the matcher is read; the session refresh behind it is not.
vi.mock('@/lib/supabase/middleware', () => ({ updateSession: vi.fn() }));
// The project key the route pins /array/ and token= to, under a neutral name
// (route.test.ts says why it is typed this way).
const { PROJECT_REF, postHogEnv } = vi.hoisted(() => {
  const PROJECT_REF = 'phc_placeholder';
  return { PROJECT_REF, postHogEnv: { NEXT_PUBLIC_POSTHOG_KEY: PROJECT_REF } };
});
vi.mock('@/lib/env.client', () => ({ env: postHogEnv }));

import nextConfig from '../../next.config';
import * as ingestRoute from '../app/ingest/[...path]/route';
import { config as proxyConfig } from '../proxy';

/**
 * Security invariant (docket S34): /ingest reaches PostHog only through
 * app/ingest/[...path]/route.ts, which builds each request from lists (of
 * paths, query parameters and headers) and never copies a cookie.
 *
 * PostHog's browser SDK sends everything to /ingest on our own origin
 * (api_host in components/analytics/posthog-provider.tsx), so the browser
 * attaches every cookie of this host, the Supabase session among them. Until
 * S34 next.config.ts rewrote /ingest to PostHog's hosts. An external rewrite
 * is a reverse proxy that forwards the request's headers as they came, cookies
 * included (PostHog's own proxy docs for Vercel and Next.js say so), so a
 * rewrite for /ingest, or for any address on PostHog's hosts, must not come
 * back. Nor may the proxy (middleware) run for /ingest: it would refresh the
 * session on every analytics request. skipTrailingSlashRedirect stays on so
 * /ingest/e/ reaches the route as the SDK spelled it, not through a 308.
 *
 * The matcher is compiled with tryToParsePath, the parser Next itself turns a
 * matcher into a pattern with (getMiddlewareMatchers in
 * next/dist/build/analysis/get-page-static-info.js). If an upgrade moves it,
 * this file fails to load rather than passing without looking.
 */

const WEB_ROOT = path.resolve(__dirname, '../..');

type Rewrite = { source: string; destination: string };

async function rewrites(): Promise<Rewrite[]> {
  const result = await nextConfig.rewrites?.();
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return [...(result.beforeFiles ?? []), ...(result.afterFiles ?? []), ...(result.fallback ?? [])];
}

/** A rewrite that would proxy analytics with the browser's headers. */
function analyticsRewrites(list: Rewrite[]): Rewrite[] {
  return list.filter(
    (r) => /^\/ingest(?:\/|$|:)/.test(r.source) || /posthog\.com/i.test(r.destination),
  );
}

/**
 * Requests posthog-js 1.438.15 makes under api_host '/ingest' with this app's
 * init options, by the method it makes each with: events, the surveys list,
 * the remote config and a bundle by both of its addresses. (The npm SDK never
 * asks for /static/array.js: that is the script-tag snippet's file.)
 */
const INGEST_REQUESTS: Array<['GET' | 'POST', string]> = [
  ['POST', '/ingest/e/'],
  ['POST', '/ingest/i/v0/e/'],
  ['GET', `/ingest/api/surveys/?token=${PROJECT_REF}`],
  ['GET', `/ingest/array/${PROJECT_REF}/config.js`],
  ['GET', '/ingest/static/1.438.15/surveys.js'],
  ['GET', '/ingest/static/surveys.js?v=1.438.15'],
];
/**
 * Paths under /ingest the route refuses, as the provider's init switches
 * them off (flags, replay, console logs): the proxy runs for none of them
 * either.
 */
const INGEST_REFUSED_PATHS = ['/ingest/flags/', '/ingest/s/', '/ingest/i/v1/logs'];
const INGEST_PATHS = [
  ...INGEST_REQUESTS.map(([, at]) => new URL(at, 'https://app.example.com').pathname),
  ...INGEST_REFUSED_PATHS,
];

/** An event batch for this app's project, gzip, as posthog-js sends one by default. */
const EVENT_BATCH = new Uint8Array(
  gzipSync(
    JSON.stringify({
      api_key: PROJECT_REF,
      batch: [{ event: '$pageview', properties: { token: PROJECT_REF } }],
      sent_at: '2026-01-01T00:00:00.000Z',
    }),
  ),
);

describe('/ingest reaches PostHog only through the route handler', () => {
  it('next.config.ts has no rewrite for /ingest or to PostHog', async () => {
    expect(analyticsRewrites(await rewrites())).toEqual([]);
  });

  it('the check finds the two rewrites the route replaced', () => {
    const replaced: Rewrite[] = [
      {
        source: '/ingest/static/:path*',
        destination: 'https://us-assets.i.posthog.com/static/:path*',
      },
      { source: '/ingest/:path*', destination: 'https://us.i.posthog.com/:path*' },
    ];
    expect(analyticsRewrites(replaced)).toEqual(replaced);
    expect(
      analyticsRewrites([
        { source: '/stats/:path*', destination: 'https://eu.i.posthog.com/:path*' },
      ]),
    ).toHaveLength(1);
    expect(analyticsRewrites([{ source: '/old-page', destination: '/new-page' }])).toEqual([]);
  });

  it('the route handler exists and the PostHog provider sends to it', () => {
    expect(existsSync(path.join(WEB_ROOT, 'src/app/ingest/[...path]/route.ts'))).toBe(true);
    const provider = readFileSync(
      path.join(WEB_ROOT, 'src/components/analytics/posthog-provider.tsx'),
      'utf8',
    );
    expect(provider).toMatch(/\bapi_host:\s*'\/ingest',/);
  });

  it('keeps skipTrailingSlashRedirect on', () => {
    expect(nextConfig.skipTrailingSlashRedirect).toBe(true);
  });

  it("the proxy's matcher matches no /ingest path", () => {
    const matcher = proxyConfig.matcher as readonly string[];
    const compiled = matcher.map((source) => {
      const { regexStr, error } = tryToParsePath(source);
      expect(error, source).toBeUndefined();
      return { source, re: new RegExp(regexStr!) };
    });
    for (const p of INGEST_PATHS) {
      expect(
        compiled.filter((m) => m.re.test(p)).map((m) => m.source),
        p,
      ).toEqual([]);
    }
    // Not vacuous: the same reading matches the paths the proxy is for, and a
    // catch-all would be caught.
    expect(compiled.some((m) => m.re.test('/dashboard/inventory'))).toBe(true);
    expect(new RegExp(tryToParsePath('/((?!api|_next).*)').regexStr!).test('/ingest/e/')).toBe(
      true,
    );
  });

  it('the paths checked above are requests the route passes on, so the check is not of paths nobody asks for', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    try {
      for (const [method, at] of INGEST_REQUESTS) {
        upstream.mockClear();
        const request = new NextRequest(`https://app.example.com${at}`, {
          method,
          ...(method === 'POST'
            ? { headers: { 'content-type': 'text/plain' }, body: EVENT_BATCH }
            : {}),
        });
        const res = await ingestRoute[method](request);
        expect(res.status, at).toBe(200);
        expect(upstream, at).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
