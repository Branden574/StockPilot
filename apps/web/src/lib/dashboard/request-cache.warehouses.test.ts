import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

/**
 * The request-cached warehouses read keeps its outcome.
 *
 * getWarehouseAccess decides from this read for manager-and-above on the
 * request's cookie session, so it must be able to tell a failed read from an
 * org with no warehouses (supabase-js resolves a failure as `{ data: null,
 * error }`). getWarehousesForRequest, which pickers and the layout's switcher
 * use, keeps answering `[]` on a failure, exactly as before.
 */

const holder = vi.hoisted(() => ({ stub: null as SupabaseStub | null }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => holder.stub!.client),
}));
vi.mock('@/lib/auth/session', () => ({ requireOrgContext: vi.fn() }));

import { getWarehousesForRequest, readWarehousesForRequest } from './request-cache';

const ROWS = [
  { id: 'wh-a', name: 'Alpha' },
  { id: 'wh-b', name: 'Bravo' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('readWarehousesForRequest', () => {
  it('returns the rows and failed: false when the read succeeds', async () => {
    holder.stub = makeSupabaseStub({ 'warehouses.select': { data: ROWS, error: null } });
    await expect(readWarehousesForRequest('org-1')).resolves.toEqual({ rows: ROWS, failed: false });
    // Same query as always: this org, not archived, by name.
    expect(holder.stub.chains.get('warehouses.select')).toEqual(['select', 'eq', 'neq', 'order']);
    expect(holder.stub.chainArgs.get('warehouses.select')).toEqual([
      ['id, name'],
      ['organization_id', 'org-1'],
      ['status', 'archived'],
      ['name', { ascending: true }],
    ]);
  });

  it('an org with no warehouses is a SUCCESS with no rows', async () => {
    holder.stub = makeSupabaseStub({ 'warehouses.select': { data: [], error: null } });
    await expect(readWarehousesForRequest('org-1')).resolves.toEqual({ rows: [], failed: false });
  });

  it('a failed read is reported as failed, never as an empty list', async () => {
    holder.stub = makeSupabaseStub({
      'warehouses.select': { data: null, error: { message: 'statement timeout', code: '57014' } },
    });
    await expect(readWarehousesForRequest('org-1')).resolves.toEqual({ rows: [], failed: true });
  });
});

describe('getWarehousesForRequest (unchanged for its list callers)', () => {
  it('returns the rows on success', async () => {
    holder.stub = makeSupabaseStub({ 'warehouses.select': { data: ROWS, error: null } });
    await expect(getWarehousesForRequest('org-1')).resolves.toEqual(ROWS);
  });

  it('returns [] on a failed read, as it always did', async () => {
    holder.stub = makeSupabaseStub({
      'warehouses.select': { data: null, error: { message: 'statement timeout' } },
    });
    await expect(getWarehousesForRequest('org-1')).resolves.toEqual([]);
  });
});
