import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Liquid Glass plan 8.5, static guards (b) and (c), held while Liquid Glass
 * is on its branch:
 *   (b) packages/core/src/modules/registry.ts and the permission constants
 *       (packages/core/src/constants/permissions.ts, roles.ts) are the merge
 *       base's text;
 *   (c) the server surface added since the merge base is exactly the
 *       appearance one: the server actions setMyAppearanceAction and
 *       getMyAppearanceAction (apps/web/src/server/actions/appearance.ts,
 *       both planned, plans/REVISION-DEFAULT.md) and the route handlers
 *       POST /api/appearance/style and POST /api/appearance/account (the
 *       account read as a plain request, from the read action's own server
 *       function: a server action pending on load holds the hydration of the
 *       page's streamed content and a client redirect, measured 2026-11-11;
 *       appearance-account-read.guard.test.ts). Any other new exported
 *       server action (a 'use server' module's export), any new inline
 *       'use server' function, and any new route handler method fails.
 *
 * The comparison is the working tree against the merge base of the branch's
 * tip and origin/main (the tip is HEAD, or for a pull request's merge commit
 * its second parent), as classic-css-pin.guard.test.ts does.
 *
 * STANDS DOWN after the release: once the merge base already holds the
 * appearance actions (Liquid Glass is on main), or the tip is the merge base,
 * there is nothing of Liquid Glass's to hold, and ordinary main changes
 * (a new server action in a later feature) are not this guard's business.
 * Outside CI with no git repository it skips; in CI a missing origin/main is
 * a finding (the CI Test job fetches with fetch-depth: 0).
 */

const REPO = resolve(__dirname, '../../../..');

type Git = (...args: string[]) => string | undefined;

const PROTECTED = [
  'packages/core/src/modules/registry.ts',
  'packages/core/src/constants/permissions.ts',
  'packages/core/src/constants/roles.ts',
];
const APPEARANCE_ACTIONS = 'apps/web/src/server/actions/appearance.ts';
const EXPECTED_ACTIONS = [
  `${APPEARANCE_ACTIONS}: getMyAppearanceAction`,
  `${APPEARANCE_ACTIONS}: setMyAppearanceAction`,
];
const ACCOUNT_ROUTE = 'apps/web/src/app/api/appearance/account/route.ts';
const STYLE_ROUTE = 'apps/web/src/app/api/appearance/style/route.ts';
const EXPECTED_ROUTES = [`${ACCOUNT_ROUTE}: POST`, `${STYLE_ROUTE}: POST`];
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** Whether a module's first statement is the 'use server' directive. */
function isServerModule(source: string): boolean {
  const body = source.replace(/^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/u, '');
  return /^['"]use server['"]/u.test(body);
}

/** The names a module exports (functions, consts, export lists). */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(
    /^export\s+(?:async\s+)?(?:function\*?|const|let|var)\s+([A-Za-z0-9_$]+)/gmu,
  ))
    names.add(m[1]!);
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}(?!\s*from)/gmu)) {
    for (const part of m[1]!.split(',')) {
      const item = part.trim().replace(/^type\s+/u, '');
      if (!item || part.trim().startsWith('type ')) continue;
      names.add(
        item
          .split(/\s+as\s+/u)
          .pop()!
          .trim(),
      );
    }
  }
  if (/^export\s+default\b/mu.test(source)) names.add('default');
  return [...names].sort();
}

/** Inline 'use server' directives (inside a function body), counted. */
function inlineServerDirectives(source: string): number {
  const all = source.match(/['"]use server['"]/gu)?.length ?? 0;
  return all - (isServerModule(source) ? 1 : 0);
}

const isRouteFile = (path: string) =>
  /^apps\/web\/src\/app\/(?:.+\/)?route\.(?:ts|tsx|js|mjs)$/u.test(path);
const isSource = (path: string) =>
  /^apps\/web\/src\/.+\.(?:ts|tsx|js|mjs)$/u.test(path) && !/\.(test|spec)\.[a-z]+$/u.test(path);

interface Surface {
  actions: string[];
  routes: string[];
  inline: number;
}

/** The server surface one file adds over its base text (null: the file is new). */
function addedSurface(path: string, now: string, before: string | null): Surface {
  const actions = isServerModule(now)
    ? exportedNames(now).filter(
        (n) => !(before !== null && isServerModule(before) && exportedNames(before).includes(n)),
      )
    : [];
  const routes = isRouteFile(path)
    ? exportedNames(now)
        .filter((n) => HTTP_METHODS.includes(n))
        .filter((n) => !(before !== null && exportedNames(before).includes(n)))
    : [];
  return {
    actions: actions.map((n) => `${path}: ${n}`),
    routes: routes.map((n) => `${path}: ${n}`),
    inline: Math.max(
      0,
      inlineServerDirectives(now) - (before === null ? 0 : inlineServerDirectives(before)),
    ),
  };
}

type Verdict = { stand: 'down' | 'skip'; why: string } | { findings: string[] };

/** The guard over a repository reached through `git` and `read` (a working-tree file, or null). */
function surfaceVerdict(git: Git, read: (path: string) => string | null, ci: boolean): Verdict {
  const fetch = 'the CI Test job checks out with fetch-depth: 0; locally: git fetch origin';
  if (git('rev-parse', '--git-dir') === undefined) {
    return ci
      ? { findings: [`git is not available (${fetch})`] }
      : { stand: 'skip', why: 'no git repository' };
  }
  const main = git('rev-parse', '--verify', 'origin/main^{commit}')?.trim();
  if (!main) return { findings: [`origin/main is not in this clone (${fetch})`] };
  const isAncestor = (a: string, b: string) =>
    git('merge-base', '--is-ancestor', a, b) !== undefined;
  const second = git('rev-parse', '--verify', '--quiet', 'HEAD^2^{commit}')?.trim();
  const tip = second && isAncestor('HEAD^1', main) && !isAncestor(second, main) ? second : 'HEAD';
  const tipSha = git('rev-parse', `${tip}^{commit}`)?.trim();
  const base = git('merge-base', tip, main)?.trim();
  if (!base) return { findings: [`no merge base of ${tip} and origin/main (${fetch})`] };
  if (base === tipSha) return { stand: 'down', why: 'the tip is on origin/main' };
  if (git('cat-file', '-e', `${base}:${APPEARANCE_ACTIONS}`) !== undefined) {
    return {
      stand: 'down',
      why: 'Liquid Glass is already on main (the merge base holds the appearance actions)',
    };
  }

  const findings: string[] = [];
  for (const path of PROTECTED) {
    const before = git('show', `${base}:${path}`);
    if (before === undefined) findings.push(`${path} is not in the merge base ${base.slice(0, 9)}`);
    else if (read(path) !== before)
      findings.push(`${path} differs from the merge base ${base.slice(0, 9)}`);
  }

  const changed = new Set<string>();
  for (const line of (
    git('diff', '--name-only', '--no-renames', base, '--', 'apps/web/src') ?? ''
  ).split('\n'))
    if (line.trim()) changed.add(line.trim());
  for (const line of (
    git('ls-files', '--others', '--exclude-standard', '--', 'apps/web/src') ?? ''
  ).split('\n'))
    if (line.trim()) changed.add(line.trim());

  const actions: string[] = [];
  const routes: string[] = [];
  for (const path of [...changed].filter(isSource).sort()) {
    const now = read(path);
    if (now === null) continue;
    const before = git('show', `${base}:${path}`) ?? null;
    const added = addedSurface(path, now, before);
    actions.push(...added.actions);
    routes.push(...added.routes);
    if (added.inline > 0)
      findings.push(`${path}: ${added.inline} new inline 'use server' function(s)`);
  }
  for (const a of actions)
    if (!EXPECTED_ACTIONS.includes(a)) findings.push(`a new server action: ${a}`);
  for (const e of EXPECTED_ACTIONS)
    if (!actions.includes(e)) findings.push(`the planned server action is missing: ${e}`);
  for (const r of routes)
    if (!EXPECTED_ROUTES.includes(r)) findings.push(`a new route handler: ${r}`);
  for (const e of EXPECTED_ROUTES)
    if (!routes.includes(e)) findings.push(`the planned route handler is missing: ${e}`);
  return { findings };
}

const realGit: Git = (...args) => {
  try {
    return execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};
const realRead = (path: string) => {
  const full = resolve(REPO, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
};

describe('the appearance server surface (plan 8.5 static guards b and c)', () => {
  const verdict = surfaceVerdict(realGit, realRead, Boolean(process.env.CI));

  it.runIf('findings' in verdict)(
    'registry and permission constants are the merge base’s, and only the appearance actions and route are new',
    () => {
      expect('findings' in verdict ? verdict.findings : []).toEqual([]);
    },
  );

  describe('the rule itself, on a fake repository', () => {
    const BASE = 'b'.repeat(40);
    const TIP = 'c'.repeat(40);
    const actionsFile = [
      "'use server';",
      'export async function getMyAppearanceAction() {}',
      'export async function setMyAppearanceAction() {}',
    ].join('\n');
    const route = 'export async function POST() {}';

    function fake(options: {
      baseFiles?: Record<string, string>;
      tree?: Record<string, string>;
      changed?: string[];
      tip?: string;
      noMain?: boolean;
    }) {
      const baseFiles: Record<string, string> = {
        'packages/core/src/modules/registry.ts': 'registry',
        'packages/core/src/constants/permissions.ts': 'permissions',
        'packages/core/src/constants/roles.ts': 'roles',
        ...options.baseFiles,
      };
      const tree: Record<string, string> = {
        ...baseFiles,
        [APPEARANCE_ACTIONS]: actionsFile,
        [ACCOUNT_ROUTE]: route,
        [STYLE_ROUTE]: route,
        ...options.tree,
      };
      const changed = [APPEARANCE_ACTIONS, ACCOUNT_ROUTE, STYLE_ROUTE, ...(options.changed ?? [])];
      const git: Git = (...args) => {
        const [cmd, ...rest] = args;
        if (cmd === 'rev-parse' && rest[0] === '--git-dir') return '.git';
        if (cmd === 'rev-parse' && rest.includes('origin/main^{commit}'))
          return options.noMain ? undefined : 'm'.repeat(40);
        if (cmd === 'rev-parse' && rest.includes('HEAD^2^{commit}')) return undefined;
        if (cmd === 'rev-parse') return options.tip ?? TIP;
        if (cmd === 'merge-base' && rest[0] === '--is-ancestor') return undefined;
        if (cmd === 'merge-base') return BASE;
        if (cmd === 'cat-file') {
          const path = rest[1]!.slice(BASE.length + 1);
          return path in baseFiles ? '' : undefined;
        }
        if (cmd === 'show') {
          const path = rest[0]!.slice(BASE.length + 1);
          return baseFiles[path];
        }
        if (cmd === 'diff') return changed.join('\n');
        if (cmd === 'ls-files') return '';
        return undefined;
      };
      return surfaceVerdict(git, (p) => tree[p] ?? null, true);
    }

    it('passes with exactly the appearance actions and the two appearance routes', () => {
      expect(fake({})).toEqual({ findings: [] });
    });
    it('fails when a planned route is missing, and on another method of a planned route', () => {
      expect(fake({ tree: { [ACCOUNT_ROUTE]: 'export const dynamic = 1;' } })).toEqual({
        findings: [`the planned route handler is missing: ${ACCOUNT_ROUTE}: POST`],
      });
      expect(
        fake({ tree: { [ACCOUNT_ROUTE]: `${route}\nexport async function GET() {}` } }),
      ).toEqual({ findings: [`a new route handler: ${ACCOUNT_ROUTE}: GET`] });
    });
    it('fails on a new server action anywhere else', () => {
      const path = 'apps/web/src/server/actions/glass-extra.ts';
      expect(
        fake({
          tree: { [path]: "'use server';\nexport async function sneakyAction() {}" },
          changed: [path],
        }),
      ).toEqual({
        findings: [`a new server action: ${path}: sneakyAction`],
      });
    });
    it('fails on a new export added to an existing server-action module', () => {
      const path = 'apps/web/src/server/actions/orders.ts';
      expect(
        fake({
          baseFiles: { [path]: "'use server';\nexport async function a() {}" },
          tree: {
            [path]: "'use server';\nexport async function a() {}\nexport const b = async () => {};",
          },
          changed: [path],
        }),
      ).toEqual({ findings: [`a new server action: ${path}: b`] });
    });
    it('fails on a new inline use server function and on a new route method', () => {
      const comp = 'apps/web/src/components/x/glass-thing.tsx';
      const r = 'apps/web/src/app/api/items/route.ts';
      expect(
        fake({
          baseFiles: { [r]: 'export async function GET() {}' },
          tree: {
            [comp]: "export function A() { async function save() { 'use server'; } return null; }",
            [r]: 'export async function GET() {}\nexport async function DELETE() {}',
          },
          changed: [comp, r],
        }),
      ).toEqual({
        findings: [
          `${comp}: 1 new inline 'use server' function(s)`,
          `a new route handler: ${r}: DELETE`,
        ],
      });
    });
    it('fails when the module registry or a permission constant changed', () => {
      expect(
        fake({ tree: { 'packages/core/src/modules/registry.ts': 'registry, changed' } }),
      ).toEqual({
        findings: [
          `packages/core/src/modules/registry.ts differs from the merge base ${BASE.slice(0, 9)}`,
        ],
      });
      expect(
        fake({ tree: { 'packages/core/src/constants/permissions.ts': 'more' } }),
      ).toMatchObject({
        findings: [expect.stringContaining('permissions.ts differs')],
      });
    });
    it('stands down once the merge base holds the appearance actions, and when the tip is the merge base', () => {
      expect(fake({ baseFiles: { [APPEARANCE_ACTIONS]: actionsFile } })).toMatchObject({
        stand: 'down',
      });
      expect(fake({ tip: BASE })).toMatchObject({ stand: 'down' });
    });
    it('in CI, a clone without origin/main is a finding', () => {
      expect(fake({ noMain: true })).toEqual({
        findings: [expect.stringContaining('origin/main is not in this clone')],
      });
    });
  });
});
