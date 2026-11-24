import { buildCustomRoute } from 'next/dist/lib/build-custom-route';
import { modifyRouteRegex } from 'next/dist/lib/redirect-status';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_NAME_PART,
  LISTED_HEADER_NAMES,
  PATH_HEADERS,
  lineIsClean,
  measureProbeChannels,
  pathMatchesKind,
  sourceToRegExp,
} from './probe-measure';
import { PROBE_KINDS, PROBE_RULES } from './probe-paths';

/**
 * The measurement's own matcher (sourceToRegExp) must say what the rewrite
 * list says. Made-up paths only.
 */
const CORPUS = [
  '/.env',
  '/.env/',
  '/.ENV',
  '/.env.local',
  '/.env.bak',
  '/api/.env',
  '/a/b/c/.env.production',
  '/.envx/y',
  '/.git',
  '/.git/config',
  '/app/.git/HEAD',
  '/.gitignore',
  '/.github/workflows',
  '/wp-login.php',
  '/blog/wp-login.php',
  '/xmlrpc.php',
  '/wp-config.php.bak',
  '/wp-admin',
  '/wp-admin/x/y',
  '/wp-content/plugins/example/readme.txt',
  '/wordpress/example',
  '/wp',
  '/phpmyadmin',
  '/phpmyadmin4.9/index',
  '/pma/',
  '/adminer.php',
  '/actuator/health',
  '/manager/html',
  '/manager/html/x',
  '/manager/other',
  '/example/etc/passwd',
  '/../../etc/passwd',
  '/a/../etc/shadow',
  '/windows/win.ini',
  '/example/..%2f..%2fexample',
  '/example/%2e%2e%5cexample/x',
  '/example/..%5cexample',
  '/shell.php',
  '/a/b/shell.php5',
  '/a/b/page.phtml',
  '/a/.hidden/shell.php',
  '/.well-known/x/shell.php',
  '/example-probe/settings',
  '/example-probe/settings?example=value',
  '/',
  '/dashboard',
  '/items/sample-1',
  '/api/security/probe/env_file',
  '',
  'env',
];

describe('sourceToRegExp agrees with the rewrite list', () => {
  PROBE_RULES.forEach((rule, i) => {
    it(`rule ${i} (${rule.kind}) agrees with next start's matcher and the routes-manifest`, () => {
      const mine = sourceToRegExp(rule.source);
      const start = getPathMatch(rule.source, {
        strict: true,
        removeUnnamedParams: true,
        regexModifier: (regex: string) => modifyRouteRegex(regex),
      });
      const manifest = new RegExp(
        buildCustomRoute('rewrite', { source: rule.source, destination: '/x' }).regex,
        'i',
      );
      for (const p of CORPUS) {
        expect(mine.test(p), `${rule.source} on ${p}: mine vs next start`).toBe(start(p) !== false);
        expect(mine.test(p), `${rule.source} on ${p}: mine vs manifest`).toBe(manifest.test(p));
      }
    });
  });

  it('pathMatchesKind is true for a kind exactly when one of its rules matches', () => {
    for (const kind of PROBE_KINDS) {
      for (const p of CORPUS) {
        const viaRules = PROBE_RULES.filter((r) => r.kind === kind).some(
          (r) =>
            getPathMatch(r.source, {
              strict: true,
              removeUnnamedParams: true,
              regexModifier: (regex: string) => modifyRouteRegex(regex),
            })(p) !== false,
        );
        expect(pathMatchesKind(p, kind), `${kind} on ${p}`).toBe(viaRules);
      }
    }
  });

  it('a path of the right kind is accepted and of another kind is not', () => {
    expect(pathMatchesKind('/api/.env.local', 'env_file')).toBe(true);
    expect(pathMatchesKind('/api/.env.local', 'git_dir')).toBe(false);
    expect(pathMatchesKind('/example/.git/config', 'git_dir')).toBe(true);
    expect(pathMatchesKind('/api/security/probe/env_file', 'env_file')).toBe(false);
  });
});

describe('the allow-lists', () => {
  it('no listed header name is a forbidden one', () => {
    for (const name of LISTED_HEADER_NAMES) {
      expect(name.startsWith('x-')).toBe(true);
      for (const part of FORBIDDEN_NAME_PART)
        expect(name.includes(part), `${name}/${part}`).toBe(false);
    }
  });
  it('every path header is also listable and referer is in neither', () => {
    for (const name of PATH_HEADERS) expect(LISTED_HEADER_NAMES).toContain(name);
    expect(LISTED_HEADER_NAMES).not.toContain('referer');
    expect(PATH_HEADERS).not.toContain('referer');
  });
});

describe('measureProbeChannels', () => {
  it('reports presence and a match per channel, and only names from the lists', () => {
    const req = new Request(
      'https://app.example.com/api/security/probe/env_file?file=.env&dirs=a',
      {
        headers: {
          'x-matched-path': '/api/security/probe/env_file',
          'x-forwarded-uri': '/example-probe/.env?example=value',
          'x-custom-thing': 'zzz',
          cookie: 'sid=example',
        },
      },
    );
    const m = measureProbeChannels(req, 'env_file');
    expect(m.url).toEqual({ present: true, matchesKind: false });
    expect(m.query).toEqual({ present: true, paramCount: 2, paramNames: ['dirs', 'file'] });
    expect(m.headers['x-matched-path']).toEqual({ present: true, matchesKind: false });
    expect(m.headers['x-forwarded-uri']).toEqual({ present: true, matchesKind: true });
    expect(m.headers['x-original-url']).toEqual({ present: false, matchesKind: false });
    expect(m.headerCount).toBe(4);
    expect(m.headerNames).toEqual(['x-forwarded-uri', 'x-matched-path']);
  });
  it('a full address in a header is read as its path', () => {
    const req = new Request('https://app.example.com/api/security/probe/git_dir', {
      headers: { 'x-original-url': 'https://app.example.com/example/.git/config?example=value' },
    });
    expect(measureProbeChannels(req, 'git_dir').headers['x-original-url'].matchesKind).toBe(true);
  });
});

describe('lineIsClean', () => {
  const req = new Request('https://app.example.com/example-probe/settings?example=value', {
    headers: { 'x-forwarded-uri': '/example-probe/settings', 'x-example': 'example-header-value' },
  });
  it('accepts a line with none of the request text', () => {
    expect(lineIsClean('{"tag":"security.probe.measure","kind":"env_file"}', req)).toBe(true);
  });
  it.each(['/example-probe/settings', '?example=value', 'example-header-value', 'example=value'])(
    'refuses a line holding %j',
    (text) => {
      expect(lineIsClean(`{"x":"${text}"}`, req)).toBe(false);
    },
  );
});
