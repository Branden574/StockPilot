import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * getWarehouseAccess: which client answers for which context.
 *
 * Two rules pull against each other here, and both are pinned:
 *
 *   1. BEARER (2026-07-20, a6a5e10b). A context that brings its own client must
 *      be answered WITH that client. The cookie client is anon on a cookie-less
 *      request, so reading through it told every warehouse-scoped mobile user
 *      they had no warehouses.
 *   2. COOKIE (2026-09-22). A withContext() context brings a client too, the
 *      request's own cookie client. Rule 1 sent it down the direct query as
 *      well: one `warehouses` read per render on top of the layout's
 *      request-cached one (~436 a day). It now shares the layout's read, and
 *      only while its client IS the cookie client withContext() made.
 */

const WAREHOUSES = [
  { id: 'wh-a', name: 'Alpha' },
  { id: 'wh-b', name: 'Bravo' },
];

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'manager',
  })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  readWarehousesForRequest: vi.fn(async () => ({ rows: WAREHOUSES, failed: false })),
}));
const cookieClientStub = makeSupabaseStub({
  'user_warehouse_assignments.select': {
    data: [{ warehouse_id: 'wh-cookie', is_primary: true }],
    error: null,
  },
});
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => cookieClientStub.client),
}));

import { readWarehousesForRequest } from '@/lib/dashboard/request-cache';
import { createClient } from '@/lib/supabase/server';

import { getWarehouseAccess, roleSeesEveryWarehouse } from './warehouse';

type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';

function bearerStub() {
  return makeSupabaseStub({
    'warehouses.select': { data: [{ id: 'wh-b' }, { id: 'wh-c' }], error: null },
    'user_warehouse_assignments.select': {
      data: [
        { warehouse_id: 'wh-b', is_primary: true },
        { warehouse_id: 'wh-c', is_primary: false },
      ],
      error: null,
    },
    'organization_members.select': { data: [{ all_warehouses: false }], error: null },
  });
}

const ctx = (role: Role, supabase?: unknown, cookieClient?: unknown) =>
  ({
    organizationId: 'org-1',
    userId: 'u-1',
    role,
    ...(supabase ? { supabase } : {}),
    ...(cookieClient ? { cookieClient } : {}),
  }) as Parameters<typeof getWarehouseAccess>[0];

beforeEach(() => {
  vi.clearAllMocks();
  cookieClientStub.fromCalls.length = 0;
});

describe('getWarehouseAccess — a withContext() (cookie) context', () => {
  it.each<Role>(['owner', 'admin', 'manager'])(
    '%s: shares the request-cached warehouses read, and issues NO warehouses query of its own',
    async (role) => {
      const own = makeSupabaseStub({ 'warehouses.select': { data: [{ id: 'x' }], error: null } });
      const access = await getWarehouseAccess(ctx(role, own.client, own.client));
      expect(readWarehousesForRequest).toHaveBeenCalledTimes(1);
      expect(readWarehousesForRequest).toHaveBeenCalledWith('org-1');
      expect(own.fromCalls).toEqual([]);
      expect(access).toEqual({
        readableIds: ['wh-a', 'wh-b'],
        writableIds: ['wh-a', 'wh-b'],
        hasAllAccess: true,
        primaryWarehouseId: 'wh-a',
      });
    },
  );

  it('staff: still reads its assignments with its OWN client (unchanged)', async () => {
    const own = bearerStub();
    const access = await getWarehouseAccess(ctx('staff', own.client, own.client));
    expect(readWarehousesForRequest).not.toHaveBeenCalled();
    expect(own.fromCalls.sort()).toEqual(['organization_members', 'user_warehouse_assignments']);
    expect(access.hasAllAccess).toBe(false);
    expect(access.readableIds).toEqual(['wh-b', 'wh-c']);
  });
});

describe('getWarehouseAccess — a Bearer / service-role context (the 2026-07-20 regression)', () => {
  it('manager: queries warehouses with the CALLER client, never the request cache or the cookie client', async () => {
    const bearer = bearerStub();
    const access = await getWarehouseAccess(ctx('manager', bearer.client));
    expect(bearer.fromCalls).toEqual(['warehouses']);
    expect(readWarehousesForRequest).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(access.readableIds).toEqual(['wh-b', 'wh-c']);
    expect(access.hasAllAccess).toBe(true);
  });

  it('staff: reads assignments with the CALLER client, so a scoped mobile user is not "unassigned"', async () => {
    const bearer = bearerStub();
    const access = await getWarehouseAccess(ctx('staff', bearer.client));
    expect(createClient).not.toHaveBeenCalled();
    expect(cookieClientStub.fromCalls).toEqual([]);
    expect(access.readableIds).toEqual(['wh-b', 'wh-c']);
    expect(access.writableIds).toEqual(['wh-b', 'wh-c']);
    expect(access.primaryWarehouseId).toBe('wh-b');
  });

  it('a context whose client is NOT the one marked as the cookie client takes the direct query', async () => {
    // e.g. a withContext() context rebuilt around another client: the mark
    // travels, the client it names does not match, so no borrowing.
    const cookie = makeSupabaseStub();
    const other = bearerStub();
    const access = await getWarehouseAccess(ctx('admin', other.client, cookie.client));
    expect(readWarehousesForRequest).not.toHaveBeenCalled();
    expect(other.fromCalls).toEqual(['warehouses']);
    expect(access.readableIds).toEqual(['wh-b', 'wh-c']);
  });
});

describe('getWarehouseAccess — no context (the requireOrgContext fallback)', () => {
  it('manager: the request-cached read, as before', async () => {
    const access = await getWarehouseAccess();
    expect(readWarehousesForRequest).toHaveBeenCalledTimes(1);
    expect(access.readableIds).toEqual(['wh-a', 'wh-b']);
  });
});

describe('roleSeesEveryWarehouse: the rule an item search uses to skip the read', () => {
  it.each<[Role, boolean]>([
    ['owner', true],
    ['admin', true],
    ['manager', true],
    ['staff', false],
    ['viewer', false],
  ])('%s: %s', (role, expected) => {
    expect(roleSeesEveryWarehouse(role)).toBe(expected);
  });

  it.each<Role>(['owner', 'admin', 'manager'])(
    '%s: getWarehouseAccess answers all access even when its read FAILS, so skipping the read loses nothing',
    async (role) => {
      const failing = makeSupabaseStub({
        'warehouses.select': { data: null, error: { message: 'timeout' } },
      });
      const access = await getWarehouseAccess(ctx(role, failing.client));
      expect(access.unreadable).toBe(true);
      expect(access.hasAllAccess).toBe(roleSeesEveryWarehouse(role));
    },
  );
});
