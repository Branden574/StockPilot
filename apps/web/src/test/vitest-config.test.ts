/**
 * Guard for the apps/web vitest configuration itself.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026-09 the config selected the DOM environment with
 * `test.environmentMatchGlobs`. Vitest 3.x only *deprecates* that option (every
 * run printed a DEPRECATED banner as its first line); Vitest 4 REMOVED it. On
 * that upgrade the option would have been silently ignored, so all ~236 test
 * files under src/components and src/app would have run in the `node`
 * environment and blown up with "document is not defined" at once.
 *
 * The replacement is `test.projects`. The real hazard of that rewrite is not the
 * banner, it is PARTITION: an include/exclude pair that leaves a test file in
 * NEITHER project makes that file vanish from the run with no error at all — a
 * silently shrinking suite. So this test does two things:
 *
 *   1. pins that `environmentMatchGlobs` never comes back, and
 *   2. walks every real *.test.ts(x) file on disk and asserts each one is
 *      claimed by EXACTLY ONE project, with the DOM-needing paths landing in
 *      the happy-dom project.
 *
 * It also pins the absence of a root-level `include`, because `extends: true`
 * merges with Vite's array-CONCATENATING mergeConfig and a root `include` is
 * therefore silently unioned into every project.
 *
 * Per-file `// @vitest-environment` docblocks still override the project
 * environment, so the ~19 files that carry one are unaffected either way.
 */
import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import config from '../../vitest.config';

const WEB_ROOT = path.resolve(__dirname, '../..');

/**
 * Minimal glob -> RegExp for the handful of shapes this config uses
 * (`**`, `*`, `{ts,tsx}`). Deliberately dependency-free: picomatch is not a
 * direct dependency of apps/web, and this test must not be the reason it
 * becomes one.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    // charAt (not glob[i]) because noUncheckedIndexedAccess types the index
    // access as `string | undefined`.
    const ch = glob.charAt(i);
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more path segments; a bare `**` matches the rest.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '{') {
      const close = glob.indexOf('}', i);
      out += `(?:${glob
        .slice(i + 1, close)
        .split(',')
        .join('|')})`;
      i = close;
    } else if ('.+^$()|[]\\?'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesAny(patterns: readonly string[] | undefined, file: string): boolean {
  return (patterns ?? []).some((p) => globToRegExp(p).test(file));
}

function listTestFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      listTestFiles(abs, acc);
    } else if (/\.test\.tsx?$/.test(entry)) {
      acc.push(path.relative(WEB_ROOT, abs));
    }
  }
  return acc;
}

const testConfig = (config as { test?: Record<string, unknown> }).test ?? {};
const projects = (testConfig.projects ?? []) as Array<{
  extends?: boolean;
  test?: { name?: string; environment?: string; include?: string[]; exclude?: string[] };
}>;

describe('apps/web vitest.config.ts', () => {
  it('does not use environmentMatchGlobs (deprecated in v3, removed in v4)', () => {
    expect(testConfig).not.toHaveProperty('environmentMatchGlobs');
  });

  it('declares no root-level include, which would union into every project', () => {
    // `extends: true` re-loads the root config and merges the inline project
    // config over it with Vite's mergeConfig — which CONCATENATES arrays. A root
    // `include` therefore leaks into BOTH projects: the first cut of this
    // migration kept one and the `dom` project collected all 608 files instead
    // of its 236, running every node-only service test under happy-dom.
    expect(testConfig).not.toHaveProperty('include');
  });

  it('declares a happy-dom project and a node project, both extending the root config', () => {
    const byName = new Map(projects.map((p) => [p.test?.name, p]));
    expect([...byName.keys()].sort()).toEqual(['dom', 'node']);
    expect(byName.get('dom')?.test?.environment).toBe('happy-dom');
    expect(byName.get('node')?.test?.environment).toBe('node');
    // `extends: true` is what keeps setupFiles, the '@' / '@stockpilot/core' /
    // 'server-only' aliases, the react plugin and the raised timeouts. Without
    // it every project would silently lose them.
    for (const project of projects) {
      expect(project.extends).toBe(true);
    }
  });

  it('claims every test file on disk for exactly one project', () => {
    const files = listTestFiles(path.join(WEB_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(500);

    const unclaimed: string[] = [];
    const doubleClaimed: string[] = [];
    const misrouted: string[] = [];

    for (const file of files) {
      const owners = projects.filter(
        (p) =>
          matchesAny(p.test?.include, file) &&
          !matchesAny(p.test?.exclude ?? (testConfig.exclude as string[]), file),
      );
      if (owners.length === 0) unclaimed.push(file);
      if (owners.length > 1) doubleClaimed.push(file);
      // Anything rendering React lives under src/components or src/app and must
      // land in happy-dom, or `render()` throws "document is not defined".
      const needsDom = file.startsWith('src/components/') || file.startsWith('src/app/');
      if (owners.length === 1 && needsDom !== (owners[0]?.test?.name === 'dom')) {
        misrouted.push(file);
      }
    }

    expect({ unclaimed, doubleClaimed, misrouted }).toEqual({
      unclaimed: [],
      doubleClaimed: [],
      misrouted: [],
    });
  });
});
