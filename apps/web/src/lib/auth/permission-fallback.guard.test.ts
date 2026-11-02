import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A request is authorized from its EFFECTIVE permission set (ctx.permissions:
 * the role's defaults with the organization's overrides applied), never from
 * the role's static defaults (docket S19).
 *
 * WHY THIS GUARD EXISTS. Until docket S19 the backup permission loader
 * answered a failed override read with the role's defaults, so every
 * permission an organization had taken away came back for that request, with
 * nothing but a console line to show for it. /api/v1/me/permissions had the
 * same fallback for a context with no set, the What's New audience another,
 * and the two OAuth callbacks checked integrations:manage on the role alone.
 * A static fallback is a revoke that silently stops applying. So the static
 * defaults may appear in code only at the sites below, each with the reason
 * it is safe, in every form that reaches them: ROLE_PERMISSIONS, the static
 * hasPermission(), core effectivePermissions() (with no override rows it IS
 * the role's defaults), and a context written in place for can() without its
 * permission set (core can() then answers from the role's defaults). A new
 * site fails here until someone writes down why it cannot hand a revoke back.
 *
 * The counts are exact, not ceilings: fixing a follow-up below fails too, so
 * the list is kept true rather than left to describe sites that are gone.
 */
const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const isTestFile = (file: string) =>
  /\.test\.tsx?$/.test(file) || file.startsWith(path.join(SRC, 'test') + path.sep);

/** Comments may talk about the static defaults; code may not use them. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Every non-test source file that matches `pattern`, with its count. */
function sitesOf(pattern: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    if (isTestFile(file)) continue;
    const count = [...codeOnly(readFileSync(file, 'utf8')).matchAll(pattern)].length;
    if (count > 0) out[path.relative(SRC, file).split(path.sep).join('/')] = count;
  }
  return out;
}

interface Allowed {
  count: number;
  why: string;
}

const counts = (allowed: Record<string, Allowed>) =>
  Object.fromEntries(Object.entries(allowed).map(([file, { count }]) => [file, count]));

/** Reads of a role's static defaults (`ROLE_PERMISSIONS[...]` or `ROLE_PERMISSIONS.x`). */
const STATIC_DEFAULTS: Record<string, Allowed> = {
  'app/(dashboard)/dashboard/settings/roles/page.tsx': {
    count: 1,
    why: '"Your role can" when the context carries no set: display only, without the platform-managed keys.',
  },
  'server/services/releases.ts': {
    count: 1,
    why: "the What's New audience of a context with no set (a cron, a test), without the platform-managed keys.",
  },
};

/** Static role checks (`hasPermission(role, key)`), which no override can change. */
const STATIC_CHECKS: Record<string, Allowed> = {
  'app/(dashboard)/dashboard/settings/roles/page.tsx': {
    count: 1,
    why: 'the reference matrix of every role at its defaults.',
  },
  'components/settings/role-permission-matrix.tsx': {
    count: 2,
    why: "the editable matrix's default for each role, under the overrides it shows.",
  },
  'components/rentals/rentals-list-table.tsx': {
    count: 2,
    why: 'which actions to offer, by static role; the server gates each one. Follow-up.',
  },
  'lib/auth/permissions.ts': {
    count: 1,
    why: 'a static assertPermission that nothing imports. Follow-up: delete it.',
  },
};

/**
 * Calls of core effectivePermissions(). Given no override rows it returns the
 * role's static defaults exactly, so `effectivePermissions(role)` is the same
 * fallback as ROLE_PERMISSIONS[role]. Each site feeds it override rows it read
 * and checked, or is the owner, who holds every key.
 */
const RESOLVERS: Record<string, Allowed> = {
  'lib/auth/effective-permissions.ts': {
    count: 3,
    why: 'the backup loader: the rows it read (a failed read refuses); the owner, every key with only a platform-managed deny applied, and every key but the platform-managed ones when that read fails.',
  },
  'lib/auth/session.ts': {
    count: 1,
    why: 'the page path: the override rows from the same request-context round trip as the role.',
  },
  'lib/auth/api-context.ts': {
    count: 1,
    why: 'the API path: the override rows from the same request-context round trip as the role.',
  },
  'server/services/returns-notify.ts': {
    count: 1,
    why: 'who is told about a return: the rows it read with the service role; a failed read, or an answer that is not a list, tells no one.',
  },
  'server/services/maintenance-notify.ts': {
    count: 1,
    why: 'who is told about a maintenance request: the rows it read with the service role; a failed read, or an answer that is not a list, tells no one.',
  },
  'app/api/cron/recurring-pos/route.ts': {
    count: 1,
    why: 'which template creators are told: the rows it read with the service role; a failed read, or an answer that is not a list, tells no creator.',
  },
  'components/settings/role-permission-matrix.tsx': {
    count: 1,
    why: "the editable matrix's preview of a role under the role overrides it shows.",
  },
};

/**
 * Every read of an override table refuses an answer that is not a list
 * (docket S27). postgrest-js resolves an empty body with data null and no
 * error; read with `data ?? []` that is "no overrides", so a revoke the
 * organization made disappears (it fails open) and so does a grant. These
 * reads decide a request, or run with the service role where no row rule
 * stands behind them: their answer is the decision.
 *
 * The census is exact, per file and per table. Each `.from('<table>')` read
 * is matched by a strict check that names the table: `listRows('<table>'`,
 * `requireList: '<table>'` (paginated reads), `readOverrides('<table>'`, or
 * an annotated `Array.isArray(` site. A new read, or a reader put back to
 * `?? []`, fails here. It never matches "any `?? []` in the file": the Roles
 * page keeps one after its check, and unrelated fallbacks sit next to these
 * reads (recurring-pos route, digest).
 */
const OVERRIDE_TABLES = [
  'role_permission_overrides',
  'user_permission_overrides',
  'role_default_permissions',
] as const;
type OverrideTable = (typeof OVERRIDE_TABLES)[number];
type PerTable = Partial<Record<OverrideTable, number>>;

interface OverrideTableSites {
  /** `.from('<table>')` followed by `.select(`, per table. */
  reads: PerTable;
  /** `.from('<table>')` followed by a write (`.upsert(`, `.delete(`, ...), per table. */
  writes?: PerTable;
  /** The file's `Array.isArray(` sites and the reads they check, per table. */
  isArray?: { sites: number; checks: PerTable };
  why: string;
}

const OVERRIDE_TABLE_SITES: Record<string, OverrideTableSites> = {
  'lib/auth/effective-permissions.ts': {
    reads: { role_permission_overrides: 1, user_permission_overrides: 2 },
    isArray: { sites: 2, checks: { user_permission_overrides: 1 } },
    why: "the backup loader: readOverrides refuses an answer that is not a list (its own Array.isArray), and the owner's platform-managed read checks with Array.isArray.",
  },
  'app/(dashboard)/dashboard/settings/roles/page.tsx': {
    reads: { role_permission_overrides: 1, user_permission_overrides: 1 },
    isArray: { sites: 1, checks: { role_permission_overrides: 1, user_permission_overrides: 1 } },
    why: 'the editable matrix: one Array.isArray check over its three reads throws to the settings boundary before the rows are used.',
  },
  'app/api/cron/recurring-pos/route.ts': {
    reads: { role_permission_overrides: 1, user_permission_overrides: 1 },
    why: 'which template creators are told: listRows; an answer that is not a list tells no creator and is reported.',
  },
  'server/services/returns-notify.ts': {
    reads: { role_permission_overrides: 1, user_permission_overrides: 1 },
    why: 'who is told about a return: listRows; the catch reports and tells no one.',
  },
  'server/services/maintenance-notify.ts': {
    reads: { role_permission_overrides: 1, user_permission_overrides: 1 },
    why: 'who is told about a maintenance request: listRows; the catch reports and tells no one.',
  },
  'server/services/digest.ts': {
    reads: {
      role_permission_overrides: 1,
      user_permission_overrides: 1,
      role_default_permissions: 1,
    },
    why: 'what each digest recipient may read: listRows on the role reads, requireList on the paginated member read; the organization is skipped and reported.',
  },
  'server/services/platform/permission-exceptions.ts': {
    reads: { role_permission_overrides: 1, user_permission_overrides: 1 },
    why: "the console's Users tab: listRows; the column shows as unavailable.",
  },
  'server/actions/permissions.ts': {
    reads: {},
    writes: { role_permission_overrides: 3, user_permission_overrides: 2 },
    why: "writes only: the Roles page's grant, revoke and clear.",
  },
};

const TABLES = OVERRIDE_TABLES.join('|');
const OVERRIDE_TABLE_FROM = new RegExp(
  `\\.from\\(\\s*['"](${TABLES})['"]\\s*\\)\\s*\\.(\\w+)\\s*\\(`,
  'g',
);
/**
 * A strict check that names the table, by mechanism. `listRows` may carry a
 * row type (`listRows<{ role: string; granted: boolean }>(`), so the optional
 * type argument is skipped up to its closing `>`; it holds no parentheses.
 */
const STRICT_CHECKS = [
  new RegExp(`\\blistRows\\s*(?:<[^()]*?>)?\\s*\\(\\s*['"](${TABLES})['"]`, 'g'),
  new RegExp(`\\brequireList\\s*:\\s*['"](${TABLES})['"]`, 'g'),
  new RegExp(`\\breadOverrides\\s*\\(\\s*['"](${TABLES})['"]`, 'g'),
];

/** Per file: the override-table reads and writes, the strict checks, the Array.isArray sites. */
function overrideTableCensus() {
  const out: Record<
    string,
    { reads: PerTable; writes: PerTable; strict: PerTable; isArray: number }
  > = {};
  for (const file of sourceFiles(SRC)) {
    if (isTestFile(file)) continue;
    const code = codeOnly(readFileSync(file, 'utf8'));
    const reads: PerTable = {};
    const writes: PerTable = {};
    for (const [, table, method] of code.matchAll(OVERRIDE_TABLE_FROM)) {
      const into = method === 'select' ? reads : writes;
      into[table as OverrideTable] = (into[table as OverrideTable] ?? 0) + 1;
    }
    if (Object.keys(reads).length === 0 && Object.keys(writes).length === 0) continue;
    const strict: PerTable = {};
    for (const pattern of STRICT_CHECKS) {
      for (const [, table] of code.matchAll(pattern)) {
        strict[table as OverrideTable] = (strict[table as OverrideTable] ?? 0) + 1;
      }
    }
    out[path.relative(SRC, file).split(path.sep).join('/')] = {
      reads,
      writes,
      strict,
      isArray: [...code.matchAll(/\bArray\.isArray\s*\(/g)].length,
    };
  }
  return out;
}

/**
 * A context written in place for can(), canDistributeBundles() or
 * canEditOrganizationSetup() with no `permissions` key: core can() answers it
 * from the role's static defaults. None today; a context a request built
 * carries its effective set.
 */
const IN_PLACE_CONTEXTS: Record<string, Allowed> = {};

/** A call of can() or a core predicate built on it, given an object literal
 *  with no `permissions` key. */
const IN_PLACE_CONTEXT =
  /\b(?:can|canDistributeBundles|canEditOrganizationSetup)\s*\(\s*\{(?![^{}]*\bpermissions\b)[^{}]*\}/g;

describe("no request falls back to a role's static permissions (docket S19)", () => {
  it('resolves src/ (the scans below would pass vacuously on a wrong path)', () => {
    expect(existsSync(path.join(SRC, 'lib', 'auth', 'effective-permissions.ts'))).toBe(true);
    expect(sourceFiles(SRC).length).toBeGreaterThan(500);
  });

  it('reads ROLE_PERMISSIONS only at the annotated display sites', () => {
    expect(sitesOf(/\bROLE_PERMISSIONS\s*(?:\[|\?\.|\.)/g)).toEqual(counts(STATIC_DEFAULTS));
  });

  it('calls the static hasPermission() only at the annotated sites', () => {
    expect(sitesOf(/\bhasPermission\s*\(/g)).toEqual(counts(STATIC_CHECKS));
  });

  it('calls core effectivePermissions() only at the annotated resolvers', () => {
    expect(sitesOf(/\beffectivePermissions\s*\(/g)).toEqual(counts(RESOLVERS));
  });

  it('never writes a context in place for can() without its permission set', () => {
    expect(sitesOf(IN_PLACE_CONTEXT)).toEqual(counts(IN_PLACE_CONTEXTS));
  });

  it('reads a context written in place for every core predicate built on can()', () => {
    const found = (code: string) => [...code.matchAll(IN_PLACE_CONTEXT)].length;
    for (const fn of ['can', 'canDistributeBundles', 'canEditOrganizationSetup']) {
      expect(found(`${fn}({ role: 'admin' }, 'items:read')`), fn).toBe(1);
      expect(found(`${fn}({ role, permissions })`), fn).toBe(0);
    }
  });
});

describe('every override-table read refuses an answer that is not a list (docket S27)', () => {
  it('reads the override tables only at the census sites, each read with a strict check naming its table', () => {
    const census = overrideTableCensus();
    const found = Object.fromEntries(
      Object.entries(census).map(([file, c]) => {
        const site = OVERRIDE_TABLE_SITES[file];
        // A strict check by mechanism, plus the reads an annotated
        // Array.isArray site checks (only annotated sites count: digest.ts has
        // others, for embedded relations).
        const checked: PerTable = {};
        for (const table of OVERRIDE_TABLES) {
          const n = (c.strict[table] ?? 0) + (site?.isArray?.checks[table] ?? 0);
          if (n > 0) checked[table] = n;
        }
        return [
          file,
          {
            reads: c.reads,
            writes: c.writes,
            checked,
            isArraySites: site?.isArray ? c.isArray : null,
          },
        ];
      }),
    );
    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(OVERRIDE_TABLE_SITES).map(([file, site]) => [
          file,
          {
            reads: site.reads,
            writes: site.writes ?? {},
            // Exactly one strict check per read.
            checked: site.reads,
            isArraySites: site.isArray ? site.isArray.sites : null,
          },
        ]),
      ),
    );
  });
});
