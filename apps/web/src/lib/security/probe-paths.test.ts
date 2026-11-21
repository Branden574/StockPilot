import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { buildCustomRoute } from 'next/dist/lib/build-custom-route';
import { checkCustomRoutes } from 'next/dist/lib/load-custom-routes';
import { modifyRouteRegex } from 'next/dist/lib/redirect-status';
import { tryToParsePath } from 'next/dist/lib/try-to-parse-path';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { describe, expect, it, vi } from 'vitest';
import { SECURITY_PROBE_KINDS } from '@stockpilot/core';

import { liquidGlassRollout, marketingRewrites } from '@/components/theme/appearance-flag';

import nextConfig from '../../../next.config';
import {
  PROBE_KINDS,
  PROBE_ROUTE_PREFIX,
  PROBE_RULES,
  probeRewrites,
  type ProbeKind,
} from './probe-paths';

/**
 * The scanner-path rewrites (lib/security/probe-paths.ts), checked with
 * Next's own matchers, the two the app is served by:
 *   - next start: server/lib/router-utils/filesystem.js compiles each
 *     beforeFiles rule with getPathMatch (strict, unnamed params removed,
 *     modifyRouteRegex for the optional trailing slash, no case);
 *   - the routes-manifest Vercel reads: lib/build-custom-route.js's regex,
 *     matched without case (next.config.ts leaves caseSensitiveRoutes unset;
 *     components/theme/appearance-flag.test.ts pins that).
 * A request takes the first rule it matches, as Next does.
 *
 * What is checked: every page, route and metadata file under src/app (with a
 * made-up value for each dynamic segment) and every file under public/ is
 * taken by no rule; /.well-known/* never is, whatever follows; and made-up
 * scanner paths are taken by the rule of their kind, in both matchers.
 *
 * Not checked here: how Vercel's edge spells a path before it matches (for
 * example, whether it decodes %2f first). The rules are matched against the
 * path as a client sent it, which is what both of Next's matchers read.
 */

type Matcher = (pathname: string) => boolean;

const nextStart: Matcher[] = PROBE_RULES.map((rule) => {
  const match = getPathMatch(rule.source, {
    strict: true,
    removeUnnamedParams: true,
    regexModifier: (regex: string) => modifyRouteRegex(regex),
  });
  return (pathname: string) => match(pathname) !== false;
});

const manifest: Matcher[] = PROBE_RULES.map((rule) => {
  const regex = new RegExp(
    buildCustomRoute('rewrite', { source: rule.source, destination: '/x' }).regex,
    'i',
  );
  return (pathname: string) => regex.test(pathname);
});

/** The kind of the first rule a path takes, in one matcher; null for none. */
function kindIn(matchers: Matcher[], pathname: string): ProbeKind | null {
  const at = matchers.findIndex((m) => m(pathname));
  return at === -1 ? null : PROBE_RULES[at]!.kind;
}

/** Both matchers agree, and this is their answer. */
function kindOf(pathname: string): ProbeKind | null {
  const start = kindIn(nextStart, pathname);
  expect(kindIn(manifest, pathname), `the routes-manifest and next start disagree on ${pathname}`).toBe(
    start,
  );
  return start;
}

const WEB = path.resolve(__dirname, '../../..');
const APP = path.join(WEB, 'src', 'app');
const PUBLIC = path.join(WEB, 'public');

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) filesUnder(full, out);
    else out.push(full);
  }
  return out;
}

/** A made-up value for one dynamic segment, as a visitor would send it. */
function sampleSegment(segment: string): string[] {
  if (/^\[\[\.\.\..+\]\]$/.test(segment)) return ['', 'sample-a/sample-b'];
  if (/^\[\.\.\..+\]$/.test(segment)) return ['sample-a', 'sample-a/sample-b'];
  if (/^\[.+\]$/.test(segment)) return ['sample-1', '0f1e2d3c-4b5a-4968-8776-655443322110'];
  return [segment];
}

const METADATA: Record<string, readonly string[]> = {
  robots: ['robots.txt'],
  sitemap: ['sitemap.xml'],
  manifest: ['manifest.webmanifest', 'manifest.json'],
  icon: ['icon', 'icon.png', 'icon.svg'],
  'apple-icon': ['apple-icon', 'apple-icon.png'],
  'opengraph-image': ['opengraph-image', 'opengraph-image.png'],
  'twitter-image': ['twitter-image', 'twitter-image.png'],
};
const ROUTE_FILE = /^(page|route)\.(ts|tsx|js|jsx)$/;

/** Every address a file under src/app serves, with made-up dynamic values. */
function appAddresses(): string[] {
  const addresses = new Set<string>();
  for (const file of filesUnder(APP)) {
    const rel = path.relative(APP, file).split(path.sep);
    const name = rel.pop()!;
    // Private folders (_x) and their contents are not routes.
    if (rel.some((s) => s.startsWith('_'))) continue;
    const stem = name.replace(/\.[^.]+$/, '');
    let leaf: readonly string[];
    if (ROUTE_FILE.test(name)) leaf = [''];
    else if (METADATA[stem]) leaf = METADATA[stem]!;
    else if (/^favicon\.ico$/.test(name)) leaf = [name];
    else continue;
    // Route groups (x) and parallel slots @x add nothing to the address.
    const segments = rel.filter((s) => !/^\(.+\)$/.test(s) && !s.startsWith('@'));
    let paths = [''];
    for (const segment of segments) {
      const values = sampleSegment(segment);
      paths = paths.flatMap((p) => values.map((v) => (v === '' ? p : `${p}/${v}`)));
    }
    for (const p of paths) for (const l of leaf) addresses.add(l === '' ? p || '/' : `${p}/${l}`);
  }
  return [...addresses].sort();
}

function publicAddresses(): string[] {
  return filesUnder(PUBLIC).map((f) => `/${path.relative(PUBLIC, f).split(path.sep).join('/')}`);
}

/** Addresses the app or Next itself serves that are not files under src/app. */
const SERVED_ELSEWHERE = [
  '/',
  '/favicon.ico',
  '/_next/static/chunks/main-app.js',
  '/_next/static/css/app.css',
  '/_next/image',
  '/_next/data/build-1/index.json',
  '/api/security/probe/env_file',
  '/api/security/probe/php_file',
  '/api/security/probe/unknown',
  '/ingest/static/array.js',
  '/r/sample-1',
  '/dashboard/settings/security/activity',
  '/platform/security',
];

/** /.well-known: never a probe, whatever follows. */
const WELL_KNOWN = [
  '/.well-known',
  '/.well-known/',
  '/.well-known/security.txt',
  '/.well-known/apple-app-site-association',
  '/.well-known/assetlinks.json',
  '/.well-known/acme-challenge/sample-token',
  '/.well-known/.env',
  '/.well-known/x/.env.local',
  '/.well-known/.git/config',
  '/.well-known/shell.php',
  '/.well-known/x/index.php',
  '/.well-known/wp-login.php',
  '/.well-known/etc/passwd',
  '/.well-known/..%2f..%2fetc%2fpasswd',
  '/.WELL-KNOWN/.env',
];

/** Paths a scanner sends (made up, in the shapes scanners use), by kind. */
const SCANNER_PATHS: Record<ProbeKind, readonly string[]> = {
  env_file: [
    '/.env',
    '/.env/',
    '/.ENV',
    '/.env.local',
    '/.env.production',
    '/.env.bak',
    '/api/.env',
    '/backend/core/.env',
    '/laravel/.env.example',
  ],
  git_dir: ['/.git', '/.git/', '/.git/config', '/.git/HEAD', '/.GIT/config', '/app/.git/logs/HEAD'],
  wordpress: [
    '/wp-login.php',
    '/WP-LOGIN.PHP',
    '/xmlrpc.php',
    '/wp-config.php.bak',
    '/wp-admin',
    '/wp-admin/',
    '/wp-admin/setup-config.php',
    '/wp-content/plugins/sample-plugin/readme.txt',
    '/wp-includes/wlwmanifest.xml',
    '/wp-json/wp/v2/users',
    '/wordpress/wp-admin/',
    '/wp/wp-login.php',
    '/blog/wp-login.php',
  ],
  php_file: [
    '/index.php',
    '/info.php',
    '/shell.php5',
    '/upload.phtml',
    '/cgi-bin/test.php',
    '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
    '/INDEX.PHP',
  ],
  admin_tool: [
    '/phpmyadmin',
    '/phpmyadmin/',
    '/phpMyAdmin/index.php',
    '/phpmyadmin4.8.1/',
    '/pma/',
    '/adminer.php',
    '/actuator/env',
    '/server-status',
    '/manager/html',
    '/solr/admin/info/system',
  ],
  path_traversal: [
    '/etc/passwd',
    '/a/b/etc/passwd',
    '/cgi-bin/../../etc/passwd',
    '/proc/self/environ',
    '/windows/win.ini',
    '/..%2f..%2f..%2fetc%2fpasswd',
    '/static/..%2F..%2Fwin.ini',
    '/%2e%2e%2f%2e%2e%2fetc/passwd',
    '/download/..%5c..%5cwindows%5cwin.ini',
    '/images/%252e%252e%252fetc%252fpasswd',
  ],
};

/** Near misses: addresses that look like a probe but are not one. */
const NEAR_MISSES = [
  '/env',
  '/environment',
  '/.envrc',
  '/.environment',
  '/.gitignore',
  '/.github/workflows/ci.yml',
  '/.gitattributes',
  '/git',
  '/wp-foo',
  '/wpx/wp-admin',
  '/php',
  '/index.phpx',
  '/manager',
  '/admin',
  '/etc',
  '/etc/passwords',
  '/my..file',
  '/a..b%2fc',
  '/pricing/',
  '/security',
  '/support',
];

describe('the probe rules', () => {
  it('name exactly core’s probe kinds (this module imports nothing, so it keeps its own copy)', () => {
    expect([...PROBE_KINDS]).toEqual([...SECURITY_PROBE_KINDS]);
    expect(new Set(PROBE_RULES.map((r) => r.kind))).toEqual(new Set(PROBE_KINDS));
  });

  it('are valid Next rewrites, each parsed within Next’s limits', () => {
    for (const rule of PROBE_RULES) {
      const parsed = tryToParsePath(rule.source);
      expect(parsed.error, rule.source).toBeFalsy();
      expect(parsed.regexStr!.length, rule.source).toBeLessThanOrEqual(4096);
    }
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`Next refused the rewrites (exit ${String(code)})`);
    }) as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => checkCustomRoutes(probeRewrites(), 'rewrite')).not.toThrow();
      expect(error).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it('each rewrite goes to the probe route with its own kind', () => {
    expect(probeRewrites()).toEqual(
      PROBE_RULES.map((r) => ({ source: r.source, destination: `${PROBE_ROUTE_PREFIX}${r.kind}` })),
    );
  });

  it('next.config.ts puts them in beforeFiles after the marketing rewrites, untouched', async () => {
    const result = await nextConfig.rewrites?.();
    expect(result && !Array.isArray(result)).toBe(true);
    const { beforeFiles, afterFiles, fallback } = result as {
      beforeFiles: unknown[];
      afterFiles: unknown[];
      fallback: unknown[];
    };
    const marketing = beforeFiles.slice(0, beforeFiles.length - PROBE_RULES.length);
    expect(beforeFiles.slice(marketing.length)).toEqual(probeRewrites());
    expect(marketing).toEqual(marketingRewrites(liquidGlassRollout()));
    expect(afterFiles).toEqual([]);
    expect(fallback).toEqual([]);
  });
});

describe('no probe rule takes an address the app serves', () => {
  const app = appAddresses();
  const files = publicAddresses();

  it('reads a real tree', () => {
    expect(app.length).toBeGreaterThan(150);
    expect(app).toContain('/dashboard');
    expect(app).toContain('/robots.txt');
    expect(files.length).toBeGreaterThan(10);
  });

  it('every page, route and metadata file under src/app', () => {
    expect(app.filter((p) => kindOf(p) !== null)).toEqual([]);
    // With a trailing slash too (skipTrailingSlashRedirect lets it through).
    expect(app.filter((p) => p !== '/' && kindOf(`${p}/`) !== null)).toEqual([]);
  });

  it('every file under public/', () => {
    expect(files.filter((p) => kindOf(p) !== null)).toEqual([]);
  });

  it('what Next and the app serve from elsewhere, the probe route itself included', () => {
    expect(SERVED_ELSEWHERE.filter((p) => kindOf(p) !== null)).toEqual([]);
  });

  it('/.well-known/*, whatever follows', () => {
    expect(WELL_KNOWN.filter((p) => kindOf(p) !== null)).toEqual([]);
  });

  it('near misses', () => {
    expect(NEAR_MISSES.filter((p) => kindOf(p) !== null)).toEqual([]);
  });
});

describe('made-up scanner paths are taken by the rule of their kind', () => {
  for (const kind of PROBE_KINDS) {
    it(kind, () => {
      for (const p of SCANNER_PATHS[kind]) expect(kindOf(p), p).toBe(kind);
    });
  }
});
