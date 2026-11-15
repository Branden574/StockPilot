import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';
import { MODULE_REGISTRY, type ModuleId } from '@stockpilot/core';

/**
 * The request-cached module set keeps its outcome (docket R7).
 *
 * checkModuleAccess decides from this read, and it must be able to tell a
 * module that is off from rows that could not be read: supabase-js resolves a
 * failed query as `{ data: null, error }`, which the set alone turns into "no
 * rows". readModulesForRequest's own set stays the fail-closed one either
 * way, with the outcome beside it.
 *
 * getModulesForRequest, which withContext() and the pages' own reads use,
 * holds a state that was not read as unknown (lib/modules/module-state): a
 * core module and a module known to be on answer, and asking about any other
 * module, or listing the set, throws ModulesUnavailableError. A set that was
 * read answers exactly as before.
 */

const holder = vi.hoisted(() => ({
  stub: null as SupabaseStub | null,
  bundle: null as unknown,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => holder.stub!.client),
}));
vi.mock('@/lib/auth/request-context-bundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/request-context-bundle')>()),
  loadRequestContextBundle: vi.fn(async () => holder.bundle),
}));

import { OrganizationRowUnavailableError } from '@/lib/auth/organization-row-unavailable';
import {
  ModulesUnavailableError,
  moduleSetUnreadable,
  UnreadableModuleSet,
} from '@/lib/modules/module-state';

import { getModulesForRequest, readModulesForRequest } from './request-cache';

const ORG = 'org-1';
const NON_CORE = (Object.keys(MODULE_REGISTRY) as ModuleId[]).filter(
  (m) => MODULE_REGISTRY[m].tier !== 'core',
);
const ORG_ROW = (comp: boolean) => ({
  terminology: null,
  mfa_policy: 'optional',
  logo_url: null,
  timezone: 'America/Los_Angeles',
  nav_overrides: null,
  dashboard_layout: null,
  order_status_config: null,
  all_modules_comp: comp,
});
const UNREADABLE = { data: null, error: { message: 'upstream timeout', code: '57014' } };

/** The legacy reads: the rows, and the organization row the comp flag comes from. */
function legacy(rows: { data: unknown; error: unknown }, org: { data: unknown; error: unknown }) {
  holder.bundle = null;
  holder.stub = makeSupabaseStub({
    'organization_modules.select': rows as never,
    'organizations.select': org as never,
  });
  return holder.stub;
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  holder.bundle = null;
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('readModulesForRequest', () => {
  it('the membership bundle answered: its set, read, with no query of its own', async () => {
    holder.stub = makeSupabaseStub({});
    holder.bundle = {
      profile: null,
      memberships: [
        {
          organization_id: ORG,
          role: 'manager',
          organization: { id: ORG, name: 'Org', ...ORG_ROW(false) },
          role_overrides: [],
          user_overrides: [],
          enabled_modules: ['rentals', 'po_imports'],
        },
      ],
    };
    await expect(readModulesForRequest(ORG)).resolves.toEqual({
      modules: new Set(['rentals', 'po_imports']),
      rowsUnreadable: false,
    });
    expect(holder.stub.fromCalls).toEqual([]);
  });

  it('the rows were read: the enabled rows, read, from the same query as always', async () => {
    const stub = legacy(
      { data: [{ module_id: 'rentals' }], error: null },
      { data: [ORG_ROW(false)], error: null },
    );
    await expect(readModulesForRequest(ORG)).resolves.toEqual({
      modules: new Set(['rentals']),
      rowsUnreadable: false,
    });
    expect(stub.chainArgs.get('organization_modules.select')).toEqual([
      ['module_id'],
      ['organization_id', ORG],
      ['enabled', true],
    ]);
  });

  it('an organization with every module off is a SUCCESS with no rows', async () => {
    legacy({ data: [], error: null }, { data: [ORG_ROW(false)], error: null });
    await expect(readModulesForRequest(ORG)).resolves.toEqual({
      modules: new Set(),
      rowsUnreadable: false,
    });
  });

  it('failed rows are reported as unreadable, never as "every module off", and logged', async () => {
    legacy(UNREADABLE, { data: [ORG_ROW(false)], error: null });
    await expect(readModulesForRequest(ORG)).resolves.toEqual({
      modules: new Set(),
      rowsUnreadable: true,
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[getModulesForRequest] organization_modules query failed:',
      UNREADABLE.error,
    );
  });

  it('failed rows of a comped organization: the comp that WAS read still grants every non-core module', async () => {
    legacy(UNREADABLE, { data: [ORG_ROW(true)], error: null });
    const read = await readModulesForRequest(ORG);
    expect(read.rowsUnreadable).toBe(true);
    expect([...read.modules].sort()).toEqual([...NON_CORE].sort());
  });

  it('an unreadable organization row still throws, as getOrgRowForRequest always has', async () => {
    legacy({ data: [{ module_id: 'rentals' }], error: null }, UNREADABLE);
    await expect(readModulesForRequest(ORG)).rejects.toBeInstanceOf(
      OrganizationRowUnavailableError,
    );
  });
});

describe('readModulesForRequest: only a list of module rows is an answer', () => {
  it('an empty body with no error is not "no rows": unreadable', async () => {
    legacy({ data: null, error: null }, { data: [ORG_ROW(false)], error: null });
    await expect(readModulesForRequest(ORG)).resolves.toEqual({
      modules: new Set(),
      rowsUnreadable: true,
    });
  });

  it('a row that names no module is not an answer: unreadable, and nothing in it is read as on', async () => {
    legacy(
      { data: [{ module_id: 'rentals' }, { enabled: true }], error: null },
      { data: [ORG_ROW(false)], error: null },
    );
    await expect(readModulesForRequest(ORG)).resolves.toEqual({
      modules: new Set(),
      rowsUnreadable: true,
    });
  });
});

describe('getModulesForRequest', () => {
  it('returns the plain set when the rows were read', async () => {
    legacy(
      { data: [{ module_id: 'rentals' }], error: null },
      { data: [ORG_ROW(false)], error: null },
    );
    const set = await getModulesForRequest(ORG);
    expect(set).toEqual(new Set(['rentals']));
    expect(moduleSetUnreadable(set)).toBe(false);
    // Read, so "off" is an answer.
    expect(set.has('po_imports')).toBe(false);
  });

  it('an organization with every module off is the plain empty set: every module answers off', async () => {
    legacy({ data: [], error: null }, { data: [ORG_ROW(false)], error: null });
    const set = await getModulesForRequest(ORG);
    expect(moduleSetUnreadable(set)).toBe(false);
    for (const id of NON_CORE) expect(set.has(id)).toBe(false);
  });

  it('holds rows that could not be read as unknown: a core module answers, any other module and the list refuse', async () => {
    legacy(UNREADABLE, { data: [ORG_ROW(false)], error: null });
    const set = await getModulesForRequest(ORG);
    expect(set).toBeInstanceOf(UnreadableModuleSet);
    expect(moduleSetUnreadable(set)).toBe(true);
    expect(set.has('inventory')).toBe(true);
    for (const id of NON_CORE) {
      expect(() => set.has(id)).toThrow(ModulesUnavailableError);
    }
    expect(() => Array.from(set)).toThrow(ModulesUnavailableError);
    expect(() => set.size).toThrow(ModulesUnavailableError);
  });

  it('rows that could not be read under a comp that was read: the plain set of every non-core module', async () => {
    legacy(UNREADABLE, { data: [ORG_ROW(true)], error: null });
    const set = await getModulesForRequest(ORG);
    expect(moduleSetUnreadable(set)).toBe(false);
    expect([...set].sort()).toEqual([...NON_CORE].sort());
  });

  it('an unreadable organization row still rejects', async () => {
    legacy({ data: [{ module_id: 'rentals' }], error: null }, UNREADABLE);
    await expect(getModulesForRequest(ORG)).rejects.toBeInstanceOf(OrganizationRowUnavailableError);
  });
});
