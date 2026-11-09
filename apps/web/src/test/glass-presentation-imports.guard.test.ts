import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Liquid Glass plan 8.5, static guard (a): glass presentation files import
 * no server services, Supabase clients or permission helpers. Glass is a
 * look: it draws what the classic page already loaded and decides nothing
 * about who may do what, so a glass file reaching for the server, the
 * database or a permission check would be a new data path or a new gate
 * that classic does not have.
 *
 * A glass presentation file is any source file under apps/web/src whose
 * path names glass (a file such as item-glass-summary.tsx, or a folder such
 * as app/(site-glass), components/marketing/glass or styles/liquid-glass),
 * tests excluded. Forbidden, in a value import, an export-from, a dynamic
 * import or a require:
 *   - '@/server/...', '@/lib/supabase/...', '@/lib/auth/...', '@supabase/...',
 *     'server-only', '@/lib/permissions...', '@/lib/reports/report-access'
 *     (the report gate's module), and a relative path into src/server,
 *     src/lib/supabase or src/lib/auth;
 *   - from '@stockpilot/core', a permission helper: any name with
 *     "permission" in it, and every function packages/core/src/constants/
 *     permissions.ts and roles.ts export (hasPermission, can, roleRank, ...).
 * A type-only import is allowed: it is erased at build time.
 */

const WEB_SRC = resolve(__dirname, '..');
const CORE_CONSTANTS = resolve(__dirname, '../../../../packages/core/src/constants');

const FORBIDDEN_PREFIXES = [
  '@/server',
  '@/lib/supabase',
  '@/lib/auth',
  '@/lib/permissions',
  '@supabase/',
];
const FORBIDDEN_EXACT = ['server-only', '@/lib/reports/report-access'];
const FORBIDDEN_DIRS = ['server', join('lib', 'supabase'), join('lib', 'auth')];

/** The functions a constants module exports (its permission and role helpers). */
function exportedFunctions(source: string): string[] {
  return [...source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gmu)].map(
    (m) => m[1]!,
  );
}

interface ImportUse {
  specifier: string;
  /** The value names imported (empty for a side-effect, namespace or dynamic import). */
  names: string[];
  typeOnly: boolean;
}

/** Every import, export-from, dynamic import and require in a source text. */
function importsOf(source: string): ImportUse[] {
  const out: ImportUse[] = [];
  const statement =
    /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^;=()]*?)\s*from\s*['"]([^'"]+)['"]/gu;
  for (const m of source.matchAll(statement)) {
    const typeOnly = Boolean(m[2]);
    const clause = m[3]!;
    const braces = /\{([\s\S]*)\}/u.exec(clause);
    const names: string[] = [];
    if (braces) {
      for (const part of braces[1]!.split(',')) {
        const item = part.trim();
        if (!item || item.startsWith('type ')) continue;
        names.push(item.split(/\s+as\s+/u)[0]!.trim());
      }
    }
    const outside = clause
      .replace(/\{[\s\S]*\}/u, '')
      .replace(/,/gu, ' ')
      .trim();
    if (outside && outside !== '*' && !outside.startsWith('* as')) names.push(outside);
    if (outside.startsWith('* as')) names.push('*');
    out.push({
      specifier: m[4]!,
      names,
      typeOnly: typeOnly || (braces !== null && names.length === 0 && !outside),
    });
  }
  for (const m of source.matchAll(/(?:^|[;\n])\s*import\s+['"]([^'"]+)['"]/gu)) {
    out.push({ specifier: m[1]!, names: [], typeOnly: false });
  }
  for (const m of source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
    out.push({ specifier: m[1]!, names: ['*'], typeOnly: false });
  }
  return out;
}

/** What one glass file imports that it must not (empty: clean). */
function forbiddenImports(
  file: string,
  source: string,
  coreHelpers: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const use of importsOf(source)) {
    if (use.typeOnly) continue;
    const spec = use.specifier;
    if (FORBIDDEN_EXACT.includes(spec) || FORBIDDEN_PREFIXES.some((p) => spec.startsWith(p))) {
      out.push(`${file}: imports ${spec}`);
      continue;
    }
    if (spec.startsWith('.')) {
      const target = relative(WEB_SRC, resolve(dirname(join(WEB_SRC, file)), spec));
      if (FORBIDDEN_DIRS.some((d) => target === d || target.startsWith(`${d}${sep}`))) {
        out.push(`${file}: imports ${spec} (src/${target})`);
      }
      continue;
    }
    if (spec === '@stockpilot/core' || spec.startsWith('@stockpilot/core/')) {
      const helpers = use.names.filter(
        (name) => /permission/iu.test(name) || coreHelpers.has(name) || name === '*',
      );
      if (spec.includes('constants/permissions') || spec.includes('constants/roles'))
        out.push(`${file}: imports ${spec}`);
      else if (helpers.length) out.push(`${file}: imports ${helpers.join(', ')} from ${spec}`);
    }
  }
  return out;
}

const SOURCE = /\.(ts|tsx|js|mjs)$/u;

/** Every glass presentation file under apps/web/src, relative to it. */
function glassFiles(root = WEB_SRC): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name === 'node_modules' || name === '__mocks__') continue;
      if (statSync(path).isDirectory()) walk(path);
      else {
        const rel = relative(root, path);
        if (SOURCE.test(name) && /glass/iu.test(rel) && !/\.(test|spec)\.[a-z]+$/u.test(name))
          out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

function coreHelperNames(): Set<string> {
  return new Set(
    ['permissions.ts', 'roles.ts'].flatMap((f) =>
      exportedFunctions(readFileSync(join(CORE_CONSTANTS, f), 'utf8')),
    ),
  );
}

describe('glass presentation imports (plan 8.5 static guard a)', () => {
  const helpers = coreHelperNames();

  it('knows the core permission helpers it forbids', () => {
    for (const name of [
      'hasPermission',
      'can',
      'assertPermission',
      'effectivePermissions',
      'roleRank',
      'isAtLeast',
    ]) {
      expect(helpers.has(name), name).toBe(true);
    }
  });

  it('finds the glass presentation files (the twins, the glass components and styles/liquid-glass)', () => {
    const files = glassFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toEqual(
      expect.arrayContaining([
        join('app', '(site-glass)', 'glass-site', 'layout.tsx'),
        join('components', 'marketing', 'glass', 'site-nav.tsx'),
        join('components', 'inventory', 'item-glass-summary.tsx'),
        join('styles', 'liquid-glass', 'glass-css.ts'),
      ]),
    );
    expect(files.some((f) => /\.test\./u.test(f))).toBe(false);
  });

  it('no glass presentation file imports a server service, a Supabase client or a permission helper', () => {
    const findings = glassFiles().flatMap((file) =>
      forbiddenImports(file, readFileSync(join(WEB_SRC, file), 'utf8'), helpers),
    );
    expect(findings).toEqual([]);
  });

  describe('the rule itself (each case fails the guard)', () => {
    const file = join('components', 'po', 'po-receiving-glass.tsx');
    const check = (source: string) => forbiddenImports(file, source, helpers);

    it('a server service', () => {
      expect(check("import { InventoryService } from '@/server/services/inventory';")).toHaveLength(
        1,
      );
    });
    it('a Supabase client, by alias and by package', () => {
      expect(check("import { createClient } from '@/lib/supabase/client';")).toHaveLength(1);
      expect(check("import { createBrowserClient } from '@supabase/ssr';")).toHaveLength(1);
    });
    it('an auth helper, a relative path into src/server, a dynamic import, server-only', () => {
      expect(check("import { requireOrgContext } from '@/lib/auth/session';")).toHaveLength(1);
      expect(check("import { x } from '../../server/actions/orders';")).toHaveLength(1);
      expect(check("const m = await import('@/server/loaders/items');")).toHaveLength(1);
      expect(check("import 'server-only';")).toHaveLength(1);
      expect(check("export { gate } from '@/lib/reports/report-access';")).toHaveLength(1);
    });
    it('a permission helper from core, by name or by "permission"', () => {
      expect(check("import { hasPermission, formatNumber } from '@stockpilot/core';")).toEqual([
        `${file}: imports hasPermission from @stockpilot/core`,
      ]);
      expect(check("import { PERMISSION_META } from '@stockpilot/core';")).toHaveLength(1);
      expect(check("import * as core from '@stockpilot/core';")).toHaveLength(1);
    });
    it('allows type-only imports, presentation helpers and the appearance flag', () => {
      expect(
        check(
          [
            "import type { ReportSlug } from '@/lib/reports/report-access';",
            "import { type Permission, formatCalendarDate } from '@stockpilot/core';",
            "import { liquidGlassRollout } from '@/components/theme/appearance-flag';",
            "import { formatNumber } from '@/lib/utils';",
          ].join('\n'),
        ),
      ).toEqual([]);
    });
  });
});
