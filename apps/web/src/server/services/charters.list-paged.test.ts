import { describe, expect, it } from 'vitest';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type SupabaseStub,
} from '@/test/supabase-mock';

import { ChartersService } from './charters';

/**
 * ChartersService.list was ONE read ordered by name, with no range, so
 * PostgREST's 1000-row max_rows cut it off with no error: past 1000 active
 * charters, every charter whose name sorts after the first 1000 was missing
 * from the Charter filter on Items and Books, the add and edit forms, Team's
 * member Charters dialog, Admin > Warehouses and the Charters page (B47). The
 * list is now read page by page, ordered by name and then id, keeping its two
 * count embeds.
 */

const ORG = 'org-test';

function charters(n: number, status: string, prefix: string, idPrefix: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${idPrefix}-0000-4000-8000-${String(i).padStart(12, '0')}`,
    organization_id: ORG,
    name: `${prefix} ${String(i).padStart(4, '0')}`,
    code: null,
    description: null,
    notes: null,
    status,
    address: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    warehouses: [{ warehouse_id: 'wh-1' }],
    users: [],
  }));
}

function pageArgs(stub: SupabaseStub, key: string, page: number, method: string): unknown[][] {
  const methods = stub.chainsAll.get(key)?.[page] ?? [];
  const args = stub.chainArgsAll.get(key)?.[page] ?? [];
  return methods.flatMap((m, i) => (m === method ? [args[i]!] : []));
}

describe('ChartersService.list reads every page', () => {
  const active = charters(1200, 'active', 'A charter', '00000000');
  // The last active charter by name serves two warehouses and two members
  // (one of them twice), so the counts are checked past the first page too.
  active[1199] = {
    ...active[1199]!,
    warehouses: [{ warehouse_id: 'wh-1' }, { warehouse_id: 'wh-2' }],
    users: [{ user_id: 'u1' }, { user_id: 'u1' }, { user_id: 'u2' }] as never,
  };
  const archived = charters(50, 'archived', 'B archived', 'aaaaaaaa');
  const inactive = charters(10, 'inactive', 'C inactive', 'bbbbbbbb');
  const otherOrg = charters(3, 'active', 'A other', 'dddddddd').map((c) => ({
    ...c,
    organization_id: 'org-other',
  }));
  const rows = [...active, ...archived, ...inactive, ...otherOrg];

  it('returns all 1200 active charters with their counts, in two pages ordered by name then id', async () => {
    const stub = makeSupabaseStub({ 'charters.select': servedLikePostgrest(rows) });

    const list = await new ChartersService(makeServiceContext(stub.client) as never).list();

    expect(list.map((c) => c.id)).toEqual(active.map((c) => c.id));
    const last = list.at(-1)!;
    expect(last.warehouse_count).toBe(2);
    expect(last.user_count).toBe(2);
    expect(list[0]!.warehouse_count).toBe(1);
    expect(stub.chainsAll.get('charters.select')).toHaveLength(2);
    expect(pageArgs(stub, 'charters.select', 0, 'order').map((a) => a[0])).toEqual(['name', 'id']);
    expect(pageArgs(stub, 'charters.select', 0, 'range')).toEqual([[0, 999]]);
    expect(pageArgs(stub, 'charters.select', 1, 'range')).toEqual([[1000, 1999]]);
    for (const page of [0, 1]) {
      expect(pageArgs(stub, 'charters.select', page, 'eq')).toEqual(
        expect.arrayContaining([
          ['organization_id', ORG],
          ['status', 'active'],
        ]),
      );
    }
    // The two count embeds are still asked for.
    const select = String(pageArgs(stub, 'charters.select', 0, 'select')[0]?.[0] ?? '');
    expect(select).toMatch(/warehouses:warehouse_charters!charter_id \(warehouse_id\)/);
    expect(select).toMatch(/users:user_warehouse_assignments!charter_id \(user_id\)/);
  });

  it('includeArchived returns the 50 archived charters (inactive ones are in neither view)', async () => {
    const stub = makeSupabaseStub({ 'charters.select': servedLikePostgrest(rows) });

    const list = await new ChartersService(makeServiceContext(stub.client) as never).list({
      includeArchived: true,
    });

    expect(list.map((c) => c.id)).toEqual(archived.map((c) => c.id));
    expect(list.every((c) => c.status === 'archived')).toBe(true);
  });
});
