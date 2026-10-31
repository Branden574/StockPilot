import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security invariant (ordering visibility, design 3.5): a PLATFORM-MANAGED
 * permission (orders:manage_catalog_visibility) is changed only by StockPilot
 * support, through ONE path:
 *
 *   setOrderItemsAccessAction (fresh step-up)
 *     -> PermissionExceptionsService.set (GoTrue-verified allowlisted actor)
 *       -> public.platform_set_permission_exception (service role only)
 *
 * The database cannot see the platform allowlist (a server env) and refuses
 * every other write of the key (tg_platform_managed_permission_guard), so the
 * function trusts its caller to have checked the actor. That makes "who calls
 * it" a security boundary this file pins:
 *
 *   1. the function's name appears in code in exactly one file, the service,
 *      which calls it once;
 *   2. every write to user_permission_overrides or role_permission_overrides
 *      is in a listed file, inside an exported function that refuses the
 *      platform-managed keys (isPlatformManagedPermission) before it writes;
 *      and no writer names a platform-managed key itself.
 *
 * A new caller or writer fails here until someone reasons about it.
 */

const REPO = path.resolve(__dirname, '../../../../../..');
const ROOTS = ['apps/web/src', 'apps/mobile/src', 'apps/mobile/app', 'packages/core/src'];

const SERVICE = 'apps/web/src/server/services/platform/permission-exceptions.ts';

/** Files allowed to write the override tables, with how many writes and why. */
const OVERRIDE_WRITERS: Record<string, { writes: number; why: string }> = {
  'apps/web/src/server/actions/permissions.ts': {
    writes: 5,
    why: 'the Roles page: role rows (set, clear), the Auditor preset (role rows), user rows (set, clear); each action refuses platform-managed keys first',
  },
};

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** The code without its comments, so prose that names a call is not a call. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sources(): Array<{ rel: string; code: string }> {
  return ROOTS.flatMap((root) => files(path.join(REPO, root))).map((full) => ({
    rel: path.relative(REPO, full).split(path.sep).join('/'),
    code: code(readFileSync(full, 'utf8')),
  }));
}

const OVERRIDE_WRITE =
  /\.from\(\s*['"](?:user|role)_permission_overrides['"]\s*\)\s*\.(?:insert|upsert|update|delete)\s*\(/g;
const PLATFORM_FN = /platform_set_permission_exception/;
const PLATFORM_RPC = /\.rpc\(\s*['"]platform_set_permission_exception['"]/g;
const PLATFORM_KEY = /['"]orders:manage_catalog_visibility['"]|ORDER_CATALOG_VISIBILITY_PERMISSION|PLATFORM_MANAGED_PERMISSIONS/;

describe('the platform exception has one caller', () => {
  it('only the service names platform_set_permission_exception in code, and calls it once', () => {
    const named: string[] = [];
    const calls: Record<string, number> = {};
    for (const s of sources()) {
      if (PLATFORM_FN.test(s.code)) named.push(s.rel);
      const n = s.code.match(PLATFORM_RPC)?.length ?? 0;
      if (n > 0) calls[s.rel] = n;
    }
    expect(named).toEqual([SERVICE]);
    expect(calls).toEqual({ [SERVICE]: 1 });
  });
});

describe('no other path writes a platform-managed key', () => {
  const all = sources();

  it('every override-table write is in a listed file, with the listed count', () => {
    const found: Record<string, number> = {};
    for (const s of all) {
      const n = s.code.match(OVERRIDE_WRITE)?.length ?? 0;
      if (n > 0) found[s.rel] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(OVERRIDE_WRITERS).map(([f, v]) => [f, v.writes])));
  });

  it('each write sits in an exported function that refuses platform-managed keys before it', () => {
    for (const rel of Object.keys(OVERRIDE_WRITERS)) {
      const src = all.find((s) => s.rel === rel)!.code;
      for (const m of src.matchAll(OVERRIDE_WRITE)) {
        const before = src.slice(0, m.index);
        const fnStart = before.lastIndexOf('export async function ');
        expect(fnStart, `${rel}: write at ${m.index} is outside an exported function`).toBeGreaterThanOrEqual(0);
        const body = before.slice(fnStart);
        expect(body, `${rel}: write at ${m.index} has no platform-managed refusal before it`).toMatch(
          /isPlatformManagedPermission\(/,
        );
      }
    }
  });

  it('no writer names a platform-managed key itself', () => {
    for (const rel of Object.keys(OVERRIDE_WRITERS)) {
      expect(all.find((s) => s.rel === rel)!.code).not.toMatch(PLATFORM_KEY);
    }
  });
});
