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
 * same fallback for a context with no set, and the What's New audience
 * another. A static fallback is a revoke that silently stops applying. So
 * ROLE_PERMISSIONS and the static hasPermission() may appear in code only at
 * the sites below, each with the reason it is safe. A new site fails here
 * until someone writes down why it cannot hand a revoke back.
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
  'app/api/integrations/quickbooks/callback/route.ts': {
    count: 1,
    why: 'an OAuth callback with only a bare role in hand. Follow-up: the effective set.',
  },
  'app/api/integrations/sage_intacct/callback/route.ts': {
    count: 1,
    why: 'an OAuth callback with only a bare role in hand. Follow-up: the effective set.',
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
});
