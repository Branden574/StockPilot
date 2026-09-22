import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

/**
 * checkModuleAccess() answers from the request-cached module set instead of a
 * `module_enabled` RPC per call.
 *
 * WHY. Measured 2026-09-22: 3-5% of calls from Vercel to Supabase stall 1-8 s
 * at Supabase's entry point on weekday daytimes, and a page waits for the
 * slowest call on its serial path. The gate was one RPC per call (~51 call
 * sites; the Books page made two in series before its header) for a set that
 * `get_request_context()` already returned with the membership.
 *
 * WHAT MUST HOLD, and what this file pins:
 *   1. PARITY with SQL module_enabled() (migration 0354), modelled below line
 *      for line, over every registered module x comped / not comped x row
 *      enabled / disabled / missing, on both the bundle and the legacy path.
 *   2. NEVER WIDER than the definer function for a caller RLS does not
 *      recognise as a member.
 *   3. FAIL CLOSED: an unreadable set denies every non-core module; core
 *      modules stay on, as they always were (the gate never asked for them).
 *   4. PER REQUEST: a module switched off is off on the next request.
 *   5. COST: a render that resolves its org context and asks any number of
 *      gates makes ONE Supabase call in total, and never `module_enabled`.
 */

// ── One request ──────────────────────────────────────────────────────────────
// Inside a real RSC render React `cache()` shares one answer per request.
// Outside one (as here) it does not memoize at all, which would hide exactly
// the sharing this change relies on, so it is modelled: every cache()d
// function holds one answer per argument list until newRequest().
const pass = vi.hoisted(() => ({ memo: new Map<unknown, Map<string, unknown>>() }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    cache:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        let byArgs = pass.memo.get(fn);
        if (!byArgs) pass.memo.set(fn, (byArgs = new Map()));
        const key = JSON.stringify(args);
        if (!byArgs.has(key)) byArgs.set(key, fn(...args));
        return byArgs.get(key) as R;
      },
  };
});
const newRequest = () => pass.memo.clear();

vi.mock('next/headers', () => ({
  headers: vi.fn(
    async () =>
      new Headers({ 'x-stockpilot-user-id': 'u1', 'x-stockpilot-user-email': 'u1@example.com' }),
  ),
  cookies: vi.fn(async () => ({ get: () => undefined, set: () => {}, delete: () => {} })),
}));

// ── The database ─────────────────────────────────────────────────────────────
const ORG = 'A';
interface Db {
  /** organizations.all_modules_comp for ORG (boolean NOT NULL in the schema). */
  comp: boolean;
  /** organization_modules for ORG: module_id -> enabled. Absent = no row. */
  rows: Record<string, boolean>;
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  /**
   * is_org_member(ORG) for u1. false = a membership row the user can still see
   * but RLS no longer honours (expired act-as, disabled account): organizations
   * and organization_modules are both `is_org_member`-only.
   */
  member: boolean;
}
let db: Db;
const faults = { bundle: false, modulesRead: false, orgRead: false, frameworkError: null as unknown };
const calls = { rpc: [] as string[], from: [] as string[] };

/**
 * public.module_enabled(p_org, p_module) as migration 0354 defines it, one
 * clause per line of the SQL. SECURITY DEFINER: it reads both tables whatever
 * the caller's RLS says.
 *
 *   select exists (select 1 from organization_modules om
 *                   where om.organization_id = p_org and om.module_id = p_module and om.enabled)
 *       or ( coalesce((select o.all_modules_comp from organizations o where o.id = p_org), false)
 *            and ((select auth.uid()) is null or public.is_org_member(p_org)) );
 */
function sqlModuleEnabled(
  pOrg: string,
  pModule: string,
  caller: { uid: string | null; isOrgMember: boolean },
): boolean {
  const rowArm = pOrg === ORG && db.rows[pModule] === true;
  const comp = (pOrg === ORG ? db.comp : null) ?? false;
  const compArm = comp && (caller.uid === null || caller.isOrgMember);
  return rowArm || compArm;
}

/** The gate before this change: core short-circuit, then one RPC; an RPC error denied. */
function oldGate(moduleId: ModuleId): boolean {
  if (MODULE_REGISTRY[moduleId].tier === 'core') return true;
  return sqlModuleEnabled(ORG, moduleId, { uid: 'u1', isOrgMember: db.member });
}

const ORG_SETTINGS = () => ({
  logo_url: null,
  terminology: null,
  mfa_policy: 'optional',
  timezone: 'America/Los_Angeles',
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
  all_modules_comp: db.comp,
});
const PROFILE = () => ({
  id: 'u1',
  email: 'u1@example.com',
  full_name: 'Una One',
  avatar_url: null,
  default_organization_id: ORG,
  disabled_at: null,
});
const visibleEnabledRows = () =>
  db.member
    ? Object.entries(db.rows)
        .filter(([, on]) => on)
        .map(([id]) => id)
        .sort()
    : [];

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async (fn: string, args?: { p_org: string; p_module: string }) => {
      calls.rpc.push(fn);
      if (fn === 'module_enabled' && args) {
        // Answered faithfully, so the OLD gate passes the parity table and
        // only the cost assertions tell the two apart.
        return { data: sqlModuleEnabled(args.p_org, args.p_module, { uid: 'u1', isOrgMember: db.member }), error: null };
      }
      if (fn !== 'get_request_context' || faults.bundle) {
        return { data: null, error: { code: 'PGRST202', message: 'not found' } };
      }
      // SECURITY INVOKER (0355): the organization and module rows under RLS.
      return {
        error: null,
        data: {
          user_id: 'u1',
          profile: PROFILE(),
          memberships: [
            {
              organization_id: ORG,
              role: db.role,
              organization: db.member ? { id: ORG, name: 'Org A', ...ORG_SETTINGS() } : null,
              role_overrides: [],
              user_overrides: [],
              enabled_modules: visibleEnabledRows(),
            },
          ],
        },
      };
    },
    from: (table: string) => {
      calls.from.push(table);
      const filters: Record<string, unknown> = {};
      const answer = (): { data: unknown; error: unknown } => {
        switch (table) {
          case 'user_profiles':
            return { data: PROFILE(), error: null };
          case 'organization_members':
            return {
              data: [
                {
                  organization_id: ORG,
                  role: db.role,
                  organizations: db.member ? { id: ORG, name: 'Org A', logo_url: null } : null,
                },
              ],
              error: null,
            };
          case 'role_permission_overrides':
          case 'user_permission_overrides':
            return { data: [], error: null };
          case 'organizations':
            if (faults.orgRead) return { data: null, error: { message: 'upstream timeout' } };
            return { data: db.member && filters.id === ORG ? ORG_SETTINGS() : null, error: null };
          case 'organization_modules':
            if (faults.frameworkError) throw faults.frameworkError;
            if (faults.modulesRead) return { data: null, error: { message: 'upstream timeout' } };
            if (filters.enabled !== true || filters.organization_id !== ORG) {
              throw new Error('organization_modules read without its filters');
            }
            return { data: visibleEnabledRows().map((module_id) => ({ module_id })), error: null };
          default:
            throw new Error(`unexpected table ${table}`);
        }
      };
      const builder: Record<string, unknown> = {};
      for (const m of ['select', 'not', 'is', 'limit', 'neq', 'order']) builder[m] = () => builder;
      builder.eq = (col: string, val: unknown) => ((filters[col] = val), builder);
      builder.maybeSingle = async () => answer();
      builder.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(res(answer()));
        } catch (e) {
          return Promise.resolve(rej(e));
        }
      };
      return builder;
    },
  }),
}));

import { requireOrgContext } from '@/lib/auth/session';

import { checkModuleAccess } from './module-gate';

const ALL_MODULES = Object.keys(MODULE_REGISTRY) as ModuleId[];
const CORE = ALL_MODULES.filter((m) => MODULE_REGISTRY[m].tier === 'core');
const NON_CORE = ALL_MODULES.filter((m) => MODULE_REGISTRY[m].tier !== 'core');

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  newRequest();
  db = { comp: false, rows: {}, role: 'manager', member: true };
  faults.bundle = false;
  faults.modulesRead = false;
  faults.orgRead = false;
  faults.frameworkError = null;
  calls.rpc = [];
  calls.from = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('the fixture covers what the parity table claims', () => {
  it('has core, optional and premium modules', () => {
    expect(CORE.length).toBeGreaterThan(0);
    expect(ALL_MODULES.some((m) => MODULE_REGISTRY[m].tier === 'optional')).toBe(true);
    expect(ALL_MODULES.some((m) => MODULE_REGISTRY[m].tier === 'premium')).toBe(true);
  });
});

describe('parity with SQL module_enabled() (0354), every module', () => {
  const ROW_STATES = ['enabled', 'disabled', 'missing'] as const;
  const cases = (['bundle', 'legacy'] as const).flatMap((p) =>
    [true, false].flatMap((comp) => ROW_STATES.map((row) => [p, comp, row] as const)),
  );

  it.each(cases)('%s path, comped=%s, row %s', async (p, comp, row) => {
    for (const moduleId of ALL_MODULES) {
      newRequest();
      faults.bundle = p === 'legacy';
      // An unrelated enabled row is always present, so an answer that only asks
      // "is ANY module on?" fails.
      const other: ModuleId = moduleId === 'orders' ? 'rentals' : 'orders';
      db = {
        comp,
        rows: { [other]: true, ...(row === 'missing' ? {} : { [moduleId]: row === 'enabled' }) },
        role: 'manager',
        member: true,
      };
      const got = await checkModuleAccess(moduleId);
      const want = oldGate(moduleId);
      expect({ moduleId, enabled: got.enabled }).toEqual({ moduleId, enabled: want });
      // And the model says what 0354 says, not merely what the new code says.
      const tier = MODULE_REGISTRY[moduleId].tier;
      expect(want).toBe(tier === 'core' || comp || row === 'enabled');
    }
  });
});

describe('never wider than module_enabled()', () => {
  it.each(['bundle', 'legacy'] as const)(
    '%s path: a caller RLS does not recognise as a member is denied, even where the definer function would say yes',
    async (p) => {
      faults.bundle = p === 'legacy';
      for (const comp of [true, false]) {
        db = { comp, rows: Object.fromEntries(NON_CORE.map((m) => [m, true])), role: 'admin', member: false };
        for (const moduleId of NON_CORE) {
          newRequest();
          const got = await checkModuleAccess(moduleId);
          expect(got.enabled).toBe(false);
          // module_enabled() reads the rows as definer and would have said yes:
          expect(sqlModuleEnabled(ORG, moduleId, { uid: 'u1', isOrgMember: false })).toBe(true);
        }
      }
    },
  );
});

describe('fails closed', () => {
  it('organization_modules unreadable, not comped: every non-core module is denied, core stays on', async () => {
    faults.bundle = true;
    faults.modulesRead = true;
    db.rows = Object.fromEntries(NON_CORE.map((m) => [m, true]));
    for (const moduleId of NON_CORE) {
      newRequest();
      expect((await checkModuleAccess(moduleId)).enabled).toBe(false);
    }
    for (const moduleId of CORE) {
      newRequest();
      expect((await checkModuleAccess(moduleId)).enabled).toBe(true);
    }
    expect(consoleError).toHaveBeenCalled();
  });

  it('organization_modules unreadable, comped: only the comp that WAS read grants, as module_enabled() would', async () => {
    // module_enabled() is `rows OR comp`: for a comped organization it is true
    // whatever the rows say, so the unreadable rows decide nothing here. This
    // is also exactly what the sidebar and assertModuleEnabled already answer
    // from the same set.
    faults.bundle = true;
    faults.modulesRead = true;
    db.comp = true;
    for (const moduleId of NON_CORE) {
      newRequest();
      expect((await checkModuleAccess(moduleId)).enabled).toBe(true);
    }
  });

  it('organization row unreadable: denied even with an enabled row, and logged', async () => {
    faults.bundle = true;
    faults.orgRead = true;
    db.rows = Object.fromEntries(NON_CORE.map((m) => [m, true]));
    for (const moduleId of NON_CORE) {
      newRequest();
      await expect(checkModuleAccess(moduleId)).resolves.toEqual({ enabled: false, canManage: false });
    }
    for (const moduleId of CORE) {
      newRequest();
      expect((await checkModuleAccess(moduleId)).enabled).toBe(true);
    }
    expect(consoleError).toHaveBeenCalledWith(
      '[module-gate] module set unreadable, denying access',
      NON_CORE[0],
      expect.stringContaining('getOrgRowForRequest'),
    );
  });

  it('framework control flow is rethrown, not mistaken for a read failure', async () => {
    const { notFound } = await vi.importActual<typeof import('next/navigation')>('next/navigation');
    try {
      notFound();
    } catch (e) {
      faults.frameworkError = e;
    }
    expect(faults.frameworkError).toBeTruthy();
    faults.bundle = true;
    await expect(checkModuleAccess('books')).rejects.toBe(faults.frameworkError);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('per request, never across requests', () => {
  it.each(['bundle', 'legacy'] as const)('%s path: a module switched off is off on the next request', async (p) => {
    faults.bundle = p === 'legacy';
    db.rows = { books: true };
    expect((await checkModuleAccess('books')).enabled).toBe(true);

    db.rows = { books: false };
    newRequest();
    expect((await checkModuleAccess('books')).enabled).toBe(false);

    db.comp = true; // and a comp granted in the platform console is on next request
    newRequest();
    expect((await checkModuleAccess('books')).enabled).toBe(true);
  });
});

describe('canManage is unchanged: owner and admin, whatever the module state', () => {
  it.each([
    ['owner', true],
    ['admin', true],
    ['manager', false],
    ['staff', false],
    ['viewer', false],
  ] as const)('%s -> %s', async (role, canManage) => {
    for (const moduleId of ['overview', 'books', 'api_access'] as ModuleId[]) {
      for (const on of [true, false]) {
        newRequest();
        db = { comp: false, rows: { [moduleId]: on }, role, member: true };
        expect((await checkModuleAccess(moduleId)).canManage).toBe(canManage);
      }
    }
  });
});

describe('cost', () => {
  it('a render that resolves its context and asks four gates makes ONE Supabase call, never module_enabled', async () => {
    db.rows = { books: true, orders: true };
    await requireOrgContext();
    const got = await Promise.all([
      checkModuleAccess('books'),
      checkModuleAccess('price_tracking'),
      checkModuleAccess('orders'),
      checkModuleAccess('inventory'),
    ]);
    expect(got.map((g) => g.enabled)).toEqual([true, false, true, true]);
    expect(calls.rpc).toEqual(['get_request_context']);
    expect(calls.from).toEqual([]);
  });

  it('on the legacy path the gates share the layout\'s two reads, and still never call module_enabled', async () => {
    faults.bundle = true;
    db.rows = { books: true };
    await requireOrgContext();
    const before = { rpc: calls.rpc.length, from: calls.from.length };
    await Promise.all([checkModuleAccess('books'), checkModuleAccess('price_tracking')]);
    await Promise.all([checkModuleAccess('orders'), checkModuleAccess('rentals')]);
    expect(calls.rpc).not.toContain('module_enabled');
    // One organization_modules read and one organizations read for the whole
    // render, however many gates ask.
    expect(calls.from.slice(before.from).sort()).toEqual(['organization_modules', 'organizations']);
    expect(calls.rpc.length).toBe(before.rpc);
  });
});

describe('the Books page asks its two gates together', () => {
  it('no gate is awaited on its own', () => {
    const file = path.resolve(__dirname, '../../app/(dashboard)/dashboard/books/page.tsx');
    const code = readFileSync(file, 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    expect(code).not.toMatch(/await\s+checkModuleAccess\(/);
    expect(code).toMatch(
      // Both gates in ONE Promise.all; other independent reads (the search
      // params) may join it after them.
      /await\s+Promise\.all\(\[\s*checkModuleAccess\('books'\),\s*checkModuleAccess\('price_tracking'\),?[^\]]*\]\)/,
    );
  });
});
