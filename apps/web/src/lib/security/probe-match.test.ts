import { buildCustomRoute } from 'next/dist/lib/build-custom-route';
import { modifyRouteRegex } from 'next/dist/lib/redirect-status';
import { tryToParsePath } from 'next/dist/lib/try-to-parse-path';
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import { describe, expect, it } from 'vitest';

import nextConfig from '../../../next.config';
import {
  PROBE_MATCH_MAX_LENGTH,
  pathMatchesKind,
  probeRuleFor,
  ruleParamNames,
  sourceToRegExp,
} from './probe-match';
import { PROBE_KINDS, PROBE_RULES, probeRewrites } from './probe-paths';

/**
 * Security invariant: the probe route keeps a sample of what was asked for
 * only for a path the rule of its own kind takes (review M2), so its matcher
 * must say what Next's matchers say. And the query string is rebuilt by
 * dropping the parameters the rewrite added, whose names come from the rules
 * themselves: they must be the names Next reads from the rewrites
 * next.config.ts gives it. Made-up paths only.
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
  '/wp-content/plugins/example/index.php',
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
  '/',
  '/dashboard',
  '/items/sample-1',
  '/api/security/probe/env_file',
  '',
  'env',
];

const nextStart = PROBE_RULES.map((rule) =>
  getPathMatch(rule.source, {
    strict: true,
    removeUnnamedParams: true,
    regexModifier: (regex: string) => modifyRouteRegex(regex),
  }),
);

describe('sourceToRegExp agrees with the rewrite list', () => {
  PROBE_RULES.forEach((rule, i) => {
    it(`rule ${i} (${rule.kind}) agrees with next start's matcher and the routes-manifest`, () => {
      const mine = sourceToRegExp(rule.source);
      const manifest = new RegExp(
        buildCustomRoute('rewrite', { source: rule.source, destination: '/x' }).regex,
        'i',
      );
      for (const p of CORPUS) {
        expect(mine.test(p), `${rule.source} on ${p}: mine vs next start`).toBe(
          nextStart[i]!(p) !== false,
        );
        expect(mine.test(p), `${rule.source} on ${p}: mine vs manifest`).toBe(manifest.test(p));
      }
    });
  });

  it('probeRuleFor is the first rule next start takes, as Next applies beforeFiles in order', () => {
    for (const p of CORPUS) {
      const at = nextStart.findIndex((match) => match(p) !== false);
      expect(probeRuleFor(p), p).toBe(at === -1 ? null : PROBE_RULES[at]);
    }
  });

  it('pathMatchesKind is true only for the kind of that first rule', () => {
    expect(pathMatchesKind('/api/.env.local', 'env_file')).toBe(true);
    expect(pathMatchesKind('/api/.env.local', 'git_dir')).toBe(false);
    expect(pathMatchesKind('/example/.git/config', 'git_dir')).toBe(true);
    // php_file would take it too, but the WordPress rule comes first.
    expect(pathMatchesKind('/wp-content/plugins/example/index.php', 'wordpress')).toBe(true);
    expect(pathMatchesKind('/wp-content/plugins/example/index.php', 'php_file')).toBe(false);
    expect(pathMatchesKind('/api/security/probe/env_file', 'env_file')).toBe(false);
    for (const kind of PROBE_KINDS) expect(pathMatchesKind('', kind)).toBe(false);
  });

  it('a path longer than the limit is never matched', () => {
    const long = `/${'a/'.repeat(PROBE_MATCH_MAX_LENGTH / 2)}.env`;
    expect(long.length).toBeGreaterThan(PROBE_MATCH_MAX_LENGTH);
    expect(probeRuleFor(long)).toBeNull();
    expect(probeRuleFor(`/${'a/'.repeat(PROBE_MATCH_MAX_LENGTH / 2 - 4)}.env`)?.kind).toBe(
      'env_file',
    );
  });
});

describe('the rewrite parameter names come from the rules', () => {
  it('are the names Next parses from each rewrite next.config.ts gives it', async () => {
    const result = (await nextConfig.rewrites?.()) as { beforeFiles: Array<{ source: string }> };
    const probes = result.beforeFiles.slice(result.beforeFiles.length - PROBE_RULES.length);
    expect(probes).toEqual(probeRewrites());
    probes.forEach((rewrite, i) => {
      const fromNext = (tryToParsePath(rewrite.source).tokens ?? [])
        .filter((t): t is { name: string } => typeof t === 'object' && t !== null && 'name' in t)
        .map((t) => String(t.name));
      expect(ruleParamNames(PROBE_RULES[i]!.source), rewrite.source).toEqual(fromNext);
    });
  });

  it('are the ones the production measurement saw (3a), and no pattern text', () => {
    const all = new Set(PROBE_RULES.flatMap((r) => ruleParamNames(r.source)));
    expect([...all].sort()).toEqual(['dirs', 'file', 'rest', 'seg', 'target', 'tool', 'wp']);
    // "(?:php..." inside a pattern is not a parameter.
    expect(ruleParamNames(PROBE_RULES[PROBE_RULES.length - 1]!.source)).toEqual(['dirs', 'file']);
  });
});
