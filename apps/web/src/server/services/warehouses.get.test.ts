import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The warehouse detail read selects only columns the warehouses table has.
 *
 * get() selected `charter_id`, a column 0008 dropped (2026-05-04) when a
 * warehouse's charters moved to warehouse_charters. The detail page shipped a
 * week later (c0132bfb) with that select, so PostgREST answered every load
 * with HTTP 400, code 42703 ("column warehouses.charter_id does not exist"),
 * get() threw internal_error and /dashboard/warehouses/[id] showed the error
 * page. Found by the 2026-10-05 select sweep: every resolved select in the app
 * was sent to the local stack with limit 0.
 *
 * The stub answers like PostgREST: a select naming the dropped column is
 * refused, so the old select fails this test the way it failed in production.
 */

vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));

import { WarehousesService } from './warehouses';

const ROW = {
  id: 'wh-1',
  organization_id: 'org-test',
  name: 'Main DC',
  code: 'DC1',
  address: null,
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  manager_user_id: 'user-9',
  status: 'active',
  notes: null,
  created_at: '2026-05-10T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  manager: { id: 'user-9', full_name: 'Dana Lee', email: 'dana@acme.test', avatar_url: null },
};

function stubLikePostgrest() {
  return makeSupabaseStub({
    'warehouses.select': (call) => {
      const select = String(call.args[call.methods.indexOf('select')]?.[0] ?? '');
      if (/(^|[\s,])charter_id\s*(,|$)/.test(select)) {
        return {
          data: null,
          error: { code: '42703', message: 'column warehouses.charter_id does not exist' },
        };
      }
      return { data: ROW, error: null };
    },
  });
}

describe('WarehousesService.get', () => {
  it('loads the warehouse and its manager', async () => {
    const stub = stubLikePostgrest();
    const svc = new WarehousesService(makeServiceContext(stub.client) as never);

    const detail = await svc.get('wh-1');

    expect(detail).toMatchObject({
      id: 'wh-1',
      name: 'Main DC',
      code: 'DC1',
      manager_user_id: 'user-9',
      manager: { id: 'user-9', full_name: 'Dana Lee', email: 'dana@acme.test', avatar_url: null },
      status: 'active',
    });
    expect(detail).not.toHaveProperty('charter_id');
  });

  it('pins the select: the warehouse columns and the manager through manager_user_id', async () => {
    const stub = stubLikePostgrest();
    const svc = new WarehousesService(makeServiceContext(stub.client) as never);

    await svc.get('wh-1');

    const chain = stub.chainsAll.get('warehouses.select')?.[0] ?? [];
    const args = stub.chainArgsAll.get('warehouses.select')?.[0] ?? [];
    expect(String(args[chain.indexOf('select')]?.[0]).replace(/\s+/g, ' ').trim()).toBe(
      'id, organization_id, name, code, address, contact_name, contact_email, contact_phone, manager_user_id, ' +
        'status, notes, created_at, updated_at, manager:user_profiles!manager_user_id (id, full_name, email, avatar_url)',
    );
    expect(args[chain.indexOf('eq')]).toEqual(['organization_id', 'org-test']);
  });
});
