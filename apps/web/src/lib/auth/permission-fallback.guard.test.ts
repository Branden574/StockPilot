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
  'server/services/connections.ts': {
    count: 2,
    why: 'assertSyncLogManage picks which key to assert by static role, then asserts it on the effective set: it can refuse an admin who holds only the other key, never widen. Follow-up.',
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
    why: 'who is told about a return: the rows it read with the service role; a failed read tells no one.',
  },
  'server/services/maintenance-notify.ts': {
    count: 1,
    why: 'who is told about a maintenance request: the rows it read with the service role; a failed read tells no one.',
  },
  'app/api/cron/recurring-pos/route.ts': {
    count: 1,
    why: 'which template creators are told: the rows it read with the service role; a failed read tells no creator.',
  },
  'components/settings/role-permission-matrix.tsx': {
    count: 1,
    why: "the editable matrix's preview of a role under the role overrides it shows.",
  },
};

/**
 * A context written in place for can() or canDistributeBundles() with no
 * `permissions` key: core can() answers it from the role's static defaults.
 * None today; a context a request built carries its effective set.
 */
const IN_PLACE_CONTEXTS: Record<string, Allowed> = {};

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
    expect(
      sitesOf(/\b(?:can|canDistributeBundles)\s*\(\s*\{(?![^{}]*\bpermissions\b)[^{}]*\}/g),
    ).toEqual(counts(IN_PLACE_CONTEXTS));
  });
});
