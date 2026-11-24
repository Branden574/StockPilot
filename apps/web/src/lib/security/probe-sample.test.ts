import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { isSecretQueryKey, isStorableSample, isStorableTarget } from '@stockpilot/core';

import { probeRuleFor, ruleParamNames } from './probe-match';
import { PROBE_KINDS, PROBE_RULES, type ProbeKind } from './probe-paths';
import {
  NEVER_SAMPLE_PATHS,
  NEXT_INTERNAL_QUERY_PREFIXES,
  mayBeSampled,
  originalQueryOf,
  probeSampleOf,
} from './probe-sample';

/**
 * Security invariant: a sample of what was asked for is kept only for a path
 * the probe rule of the route's own kind takes (review M2), never under a
 * path that can carry a capability token or key (review M1, NEVER_SAMPLE_PATHS,
 * derived here from the app's own route tree), and with the query string as
 * the client sent it (the rewrite's own parameters dropped by the names the
 * rules give them). Made-up paths and values only.
 */

const WEB = path.resolve(__dirname, '../../..');
const APP = path.join(WEB, 'src', 'app');

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) filesUnder(full, out);
    else out.push(full);
  }
  return out;
}

const ROUTE_FILE = /^(page|route)\.(ts|tsx|js|jsx)$/;
const isTest = (name: string) => /\.(test|spec)\.(ts|tsx)$/.test(name);

/** Every page and route under src/app: its file and its address segments (groups and slots left out). */
function routes(): Array<{ file: string; segments: string[] }> {
  const out: Array<{ file: string; segments: string[] }> = [];
  for (const file of filesUnder(APP)) {
    const rel = path.relative(APP, file).split(path.sep);
    const name = rel.pop()!;
    if (!ROUTE_FILE.test(name) || isTest(name)) continue;
    if (rel.some((s) => s.startsWith('_'))) continue;
    const segments = rel.filter((s) => !/^\(.+\)$/.test(s) && !s.startsWith('@'));
    out.push({ file: path.relative(APP, file).split(path.sep).join('/'), segments });
  }
  return out;
}

const isDynamic = (segment: string) => /^\[.+\]$/.test(segment);
const dynamicName = (segment: string) => segment.replace(/^\[+(\.\.\.)?/, '').replace(/\]+$/, '');

/** True when the static start of `segments` is under a NEVER_SAMPLE_PATHS entry. */
function underTheList(segments: readonly string[]): boolean {
  return NEVER_SAMPLE_PATHS.some((entry) => {
    const parts = entry.split('/').filter(Boolean);
    return parts.length <= segments.length && parts.every((p, i) => segments[i] === p);
  });
}

/**
 * The dynamic parts of a route outside NEVER_SAMPLE_PATHS, by name, and why
 * each cannot carry a capability. A row id is a UUID, which the scrubber
 * replaces (checked below); a word is public. A new dynamic part fails the
 * test until it is put here or its route under NEVER_SAMPLE_PATHS.
 */
const ROW_IDS = [
  'id',
  'sessionId',
  'scanId',
  'lineId',
  'evidenceId',
  'attachmentId',
  'groupId',
  'itemId',
  'linkId',
];
const WORDS: Record<string, string> = {
  slug: 'a release note or a report, by its public name',
  kind: 'a probe kind (this route)',
};

const UUID = '0f1e2d3c-4b5a-4968-8776-655443322110';
/** A short value in the shape of an opaque token: the scrubber alone would keep it. */
const OPAQUE = 'Qx7kP2mZ9w';

function req(url: string, method = 'GET') {
  return { url: `https://app.example.com${url}`, method };
}

/** The first kind whose rule takes the path, as the route would be called. */
function kindFor(pathname: string): ProbeKind | null {
  return probeRuleFor(pathname)?.kind ?? null;
}

describe('NEVER_SAMPLE_PATHS, read from the route tree', () => {
  const all = routes();

  it('reads a real tree', () => {
    expect(all.length).toBeGreaterThan(200);
    expect(all.some((r) => r.file === 'r/[token]/page.tsx')).toBe(true);
  });

  it('is exactly this list: changing it is a deliberate change to this test too', () => {
    expect([...NEVER_SAMPLE_PATHS]).toEqual([
      '/r',
      '/m',
      '/i',
      '/invite',
      '/orders/sign',
      '/returns/request',
      '/unsubscribe',
      '/sign-in-alert',
      '/auth',
      '/reset',
      '/api/integrations',
      '/api/v1',
      '/api/public',
      '/ingest',
    ]);
    // The brief's own list (review M1): none of these may leave, whatever the
    // tree walk below finds today (/reset holds no token in its address now).
    for (const entry of [
      '/m',
      '/r',
      '/i',
      '/orders/sign',
      '/returns/request',
      '/unsubscribe',
      '/auth',
      '/reset',
      '/invite',
      '/sign-in-alert',
      '/api/v1',
    ]) {
      expect(NEVER_SAMPLE_PATHS, entry).toContain(entry);
    }
  });

  it('every entry is the start of a route the app has', () => {
    for (const entry of NEVER_SAMPLE_PATHS) {
      const parts = entry.split('/').filter(Boolean);
      expect(
        all.some((r) => parts.every((p, i) => r.segments[i] === p)),
        entry,
      ).toBe(true);
    }
  });

  it('every route with a token, key or other unnamed part in its path is under an entry', () => {
    const outside = new Map<string, string[]>();
    for (const r of all) {
      r.segments.forEach((segment, i) => {
        if (!isDynamic(segment) || underTheList(r.segments.slice(0, i + 1))) return;
        const name = dynamicName(segment);
        if (ROW_IDS.includes(name) || name in WORDS) return;
        outside.set(name, [...(outside.get(name) ?? []), r.file]);
      });
    }
    expect(Object.fromEntries(outside)).toEqual({});
  });

  it('every route that reads a secret-named query parameter is under an entry, or reviewed', () => {
    // Routes outside the list that read a parameter whose name looks secret,
    // and why its value is not a capability.
    const REVIEWED: Record<string, string> = {};
    const found: string[] = [];
    const seen: string[] = [];
    for (const r of all) {
      const src = readFileSync(path.join(APP, r.file), 'utf8');
      if (!/searchParams/.test(src)) continue;
      for (const m of src.matchAll(
        /(?:searchParams|params|query)\??\.get\(\s*['"]([A-Za-z_][\w-]*)['"]\s*\)/g,
      )) {
        const key = `${r.file}::${m[1]}`;
        if (!isSecretQueryKey(m[1]!)) continue;
        seen.push(key);
        if (!underTheList(r.segments) && !(key in REVIEWED)) found.push(key);
      }
    }
    // The reads this test exists for are found (so it does not pass by reading nothing).
    expect(seen).toEqual(
      expect.arrayContaining([
        'unsubscribe/route.ts::t',
        'sign-in-alert/route.ts::a',
        'auth/confirm/route.ts::token_hash',
        'auth/callback/route.ts::code',
      ]),
    );
    expect(found).toEqual([]);
  });

  it('the routes that carry a token or an address in the query are under an entry', () => {
    for (const file of [
      'unsubscribe/route.ts',
      'sign-in-alert/route.ts',
      'auth/callback/route.ts',
      'auth/confirm/route.ts',
      'r/confirm/page.tsx',
      'r/track/page.tsx',
      'api/integrations/quickbooks/callback/route.ts',
      'api/integrations/sage_intacct/callback/route.ts',
      'ingest/[...path]/route.ts',
    ]) {
      const r = all.find((x) => x.file === file);
      expect(r, file).toBeDefined();
      expect(underTheList(r!.segments), file).toBe(true);
    }
  });

  it('a made-up value in each dynamic part, with a scanner name appended, is never kept', () => {
    let underList = 0;
    let rowIds = 0;
    for (const r of all) {
      if (!r.segments.some(isDynamic)) continue;
      for (const probe of ['.env', 'wp-login.php', 'index.php', '.git/config']) {
        for (const value of [OPAQUE, UUID]) {
          const segments = r.segments.map((s) =>
            !isDynamic(s) ? s : dynamicName(s) in WORDS ? 'example-word' : value,
          );
          const pathname = `/${[...segments, probe].join('/')}`;
          const kind = kindFor(pathname);
          if (kind === null) continue;
          const sample = probeSampleOf(req(pathname), kind);
          if (underTheList(r.segments)) {
            expect(sample, pathname).toBeNull();
            underList++;
            continue;
          }
          // Outside the list every dynamic part is a row id or a word (the
          // test above). A row id is a UUID, and no UUID is ever kept.
          if (value !== UUID) continue;
          expect(sample, pathname).not.toBeNull();
          expect(sample!.target.includes(value), pathname).toBe(false);
          rowIds++;
        }
      }
    }
    expect(underList).toBeGreaterThan(300);
    expect(rowIds).toBeGreaterThan(50);
  });
});

describe('mayBeSampled', () => {
  it.each(NEVER_SAMPLE_PATHS.map((p) => [p]))('nothing under %s', (entry) => {
    const pathname = `${entry}/${OPAQUE}/.env`;
    expect(mayBeSampled(pathname), pathname).toBe(false);
    const kind = kindFor(pathname);
    expect(kind, pathname).not.toBeNull();
    expect(probeSampleOf(req(`${pathname}?x=1`), kind!), pathname).toBeNull();
  });

  it.each([
    `/R/${OPAQUE}/.env`,
    `/Api/V1/${OPAQUE}/.env`,
    `//r//${OPAQUE}/.env`,
    `/./r/${OPAQUE}/.env`,
    `/x/../r/${OPAQUE}/.env`,
    `/r/${OPAQUE}/../../.env`,
    `/x/../r/${OPAQUE}/../../.env`,
    `/%72/${OPAQUE}/.env`,
    `/%2572/${OPAQUE}/.env`,
    `/x/..%2fr/${OPAQUE}/.env`,
    `/x%2f..%2fr%2f${OPAQUE}/.env`,
    `/x\\..\\r\\${OPAQUE}/.env`.replace(/\\/g, '%5c'),
    `/r;v=1/${OPAQUE}/.env`,
    `/orders/SIGN/${OPAQUE}/index.php`,
    `/unsubscribe/.env`,
    `/r`,
    `/%zz/../r/${OPAQUE}/.env`,
    `/%72/${OPAQUE}%zz/.env`,
  ])('nothing under a list entry spelled %s', (pathname) => {
    expect(mayBeSampled(pathname)).toBe(false);
  });

  it.each([
    '/.env',
    '/backup/.env',
    '/rr/.env',
    '/reset-thing/.env',
    '/api/v2/.env',
    '/api/.env',
    '/orders/.env',
    '/returns/.env',
    '/x/r/.env',
    '/r-x/.env',
    '/ingested/.env',
  ])('a path under no entry may be sampled: %s', (pathname) => {
    expect(mayBeSampled(pathname)).toBe(true);
  });

  it('nothing for an empty or non-string path', () => {
    expect(mayBeSampled('')).toBe(false);
    expect(mayBeSampled(undefined as unknown as string)).toBe(false);
  });
});

describe('the query string as the client sent it', () => {
  it.each(PROBE_RULES.map((rule, i) => [i, rule.kind, rule] as const))(
    'rule %i (%s): the parameters the rewrite adds are dropped, the client’s kept in order',
    (_i, _kind, rule) => {
      const names = ruleParamNames(rule.source);
      expect(names.length).toBeGreaterThan(0);
      const added = names.map((n) => `${n}=example`).join('&');
      expect(originalQueryOf(`?a2=1&b2=two&${added}`, rule)).toBe('a2=1&b2=two');
      expect(originalQueryOf(`?${added}&a2=1`, rule)).toBe('a2=1');
      expect(originalQueryOf(`?${added}`, rule)).toBe('');
      expect(originalQueryOf('', rule)).toBe('');
      expect(originalQueryOf('?', rule)).toBe('');
    },
  );

  it('Next’s own names are dropped too, and a client parameter of a rewrite name is lost with them', () => {
    const rule = PROBE_RULES.find((r) => r.kind === 'env_file')!;
    for (const prefix of NEXT_INTERNAL_QUERY_PREFIXES) {
      expect(originalQueryOf(`?x=1&${prefix}kind=env_file`, rule)).toBe('x=1');
    }
    expect(originalQueryOf('?file=mine&dirs=a&dirs=b&x=1', rule)).toBe('x=1');
    // An encoded name is the same name.
    expect(originalQueryOf('?%64irs=a&x=1', rule)).toBe('x=1');
    // Another rule's name is the client's own.
    expect(originalQueryOf('?wp=1&file=a', rule)).toBe('wp=1');
    // Kept as sent: escapes and empty parts stay.
    expect(originalQueryOf('?q=a%20b&&x', rule)).toBe('q=a%20b&&x');
  });

  it('Next’s prefixes are the ones Next defines', async () => {
    const constants = (await import('next/dist/lib/constants')) as Record<string, unknown>;
    expect([constants.NEXT_QUERY_PARAM_PREFIX, constants.NEXT_INTERCEPTION_MARKER_PREFIX]).toEqual([
      ...NEXT_INTERNAL_QUERY_PREFIXES,
    ]);
  });
});

describe('probeSampleOf', () => {
  it('a probe request of the route’s own kind: its method, scrubbed path and rebuilt query', () => {
    expect(probeSampleOf(req('/backup/.env?debug=1&file=.env&dirs=backup'), 'env_file')).toEqual({
      reason: 'env_file',
      method: 'GET',
      target: '/backup/.env',
      sample: 'debug=1',
    });
    expect(
      probeSampleOf(
        req('/x/someone%40example.com/.env?q=0f1e2d3c-4b5a-4968-8776-655443322110', 'POST'),
        'env_file',
      ),
    ).toEqual({ reason: 'env_file', method: 'POST', target: '/x/<email>/.env', sample: 'q=<id>' });
    expect(probeSampleOf(req('/wp-login.php'), 'wordpress')).toEqual({
      reason: 'wordpress',
      method: 'GET',
      target: '/wp-login.php',
      sample: null,
    });
  });

  it('no sample when the path is not one the rule of that kind takes (the re-match)', () => {
    expect(probeSampleOf(req('/.env'), 'git_dir')).toBeNull();
    expect(probeSampleOf(req('/api/security/probe/env_file?file=.env'), 'env_file')).toBeNull();
    expect(probeSampleOf(req('/dashboard'), 'php_file')).toBeNull();
    // Another rule comes first for this path: Next would have sent it elsewhere.
    expect(probeSampleOf(req('/wp-content/plugins/example/index.php'), 'php_file')).toBeNull();
    expect(probeSampleOf(req(`/${'a/'.repeat(1100)}.env`), 'env_file')).toBeNull();
  });

  it.each(['TRACE', 'CONNECT', 'PROPFIND', 'get', ''])('no sample for the method %j', (method) => {
    expect(probeSampleOf(req('/.env', method), 'env_file')).toBeNull();
  });

  it('every one of the seven methods is sampled', () => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(probeSampleOf(req('/.env', method), 'env_file')?.method).toBe(method);
    }
  });

  it('no sample for an address that cannot be read, and never a throw', () => {
    expect(probeSampleOf({ url: 'not a url', method: 'GET' }, 'env_file')).toBeNull();
    const hostile = {
      get url(): string {
        throw new Error('example failure');
      },
      method: 'GET',
    };
    expect(probeSampleOf(hostile, 'env_file')).toBeNull();
  });

  it('what it returns is always storable, for every kind', () => {
    for (const kind of PROBE_KINDS) {
      for (const p of [
        '/.env',
        '/.git/config',
        '/wp-login.php',
        '/index.php',
        '/phpmyadmin/',
        '/etc/passwd',
      ]) {
        const s = probeSampleOf(req(`${p}?q=${'x'.repeat(400)}&id=${UUID}`), kind);
        if (s === null) continue;
        expect(isStorableTarget(s.target)).toBe(true);
        expect(isStorableSample(s.sample)).toBe(true);
      }
    }
  });
});
