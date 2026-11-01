import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { tryToParsePath } from 'next/dist/lib/try-to-parse-path';
import { describe, expect, it, vi } from 'vitest';

// Only the matcher is read; the session refresh behind it is not.
vi.mock('@/lib/supabase/middleware', () => ({ updateSession: vi.fn() }));

import nextConfig from '../../next.config';
import { config as proxyConfig } from '../proxy';

/**
 * Security invariant (docket S34): /ingest reaches PostHog only through
 * app/ingest/[...path]/route.ts, which builds each request from a list of
 * headers and never copies a cookie.
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

/** Paths posthog-js 1.438.15 asks for under api_host '/ingest'. */
const INGEST_PATHS = [
  '/ingest/e/',
  '/ingest/i/v0/e/',
  '/ingest/flags/',
  '/ingest/array/phc_placeholder/config.js',
  '/ingest/static/array.js',
];

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
});
