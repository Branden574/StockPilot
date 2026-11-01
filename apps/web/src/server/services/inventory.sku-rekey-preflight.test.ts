import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Editing a SKU re-keys every record that shares it (Model B): update() writes
 * the edited record, then moves the others in a second statement. The two
 * statements share no transaction, so when the new SKU was already used in
 * the same charter and rack as one of the OTHER records, the second statement
 * failed (unique index 0234, organization + SKU + charter + rack label) after
 * the first had committed, and the group was left split: the edited record on
 * the new SKU, the rest on the old one.
 *
 * update() now checks every slot the group would move into BEFORE it writes
 * anything, so that collision is refused with nothing changed. (A record that
 * takes the slot in the moment between the check and the write still meets
 * the old honest message; closing that needs both statements in one database
 * transaction, a function this change does not add.)
 *
 * The model below enforces the 0234 rule on every write, on both clients: the
 * caller's (RLS) client writes the edited record, the service-role client the
 * others.
 */

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(
      public code: string,
      message: string,
      public details?: Record<string, unknown>,
    ) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
  assertModuleEnabled: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { createAdminClient } from '@/lib/supabase/admin';
import { callArgs, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

import { InventoryService } from './inventory';

const CHARTER_ADVICE =
  /(change|switch|pick|choose|use) (the |a |another |a different )?(sku, (the )?)?charter|different charter|another charter|charter, or|different rack|another rack|rack\/location/i;

type Row = {
  id: string;
  organization_id: string;
  sku: string;
  name: string;
  charter_id: string | null;
  bin_location: string | null;
  warehouse_id: string | null;
  deleted_at: string | null;
  custom_fields: Record<string, unknown>;
  status: string;
  item_type: string;
  tracking_type: string;
  quantity_on_hand: number;
  category_id: string | null;
  group_id: string | null;
};

function record(over: Partial<Row> & Pick<Row, 'id' | 'sku'>): Row {
  return {
    organization_id: 'org-1',
    name: 'Mouse pad',
    charter_id: null,
    bin_location: null,
    warehouse_id: null,
    deleted_at: null,
    custom_fields: {},
    status: 'active',
    item_type: 'product',
    tracking_type: 'none',
    quantity_on_hand: 4,
    category_id: null,
    group_id: null,
    ...over,
  };
}

/** Whether a row passes the eq / neq / is filters of a mock chain. */
function matches(row: Row, call: MockCall): boolean {
  return call.methods.every((m, i) => {
    const [col, val] = call.args[i] as [keyof Row, unknown];
    if (m === 'eq') return row[col] === val;
    if (m === 'neq') return row[col] !== val;
    if (m === 'is') return row[col] === val;
    return true;
  });
}

const slot = (r: Row) => JSON.stringify([r.organization_id, r.sku, r.charter_id, r.bin_location]);

function harness(rows: Row[], opts: { failPreflightRead?: boolean } = {}) {
  const writes: Array<{
    client: 'caller' | 'admin';
    ids: string[];
    payload: Record<string, unknown>;
  }> = [];

  // One table for both clients. An UPDATE applies to every row its filters
  // match, all or nothing: a result that would put two live rows on one
  // (organization, SKU, charter, rack label) slot fails as 0234 does.
  function update(client: 'caller' | 'admin', call: MockCall) {
    const payload = (callArgs(call, 'update')?.[0] ?? {}) as Record<string, unknown>;
    const hit = rows.filter((r) => matches(r, call));
    const after = rows.map((r) => (hit.includes(r) ? { ...r, ...payload } : r));
    const live = after.filter((r) => r.deleted_at === null).map(slot);
    if (new Set(live).size !== live.length) {
      return {
        data: null,
        error: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "inventory_items_org_sku_charter_bin_unique"',
        },
      };
    }
    for (const r of hit) Object.assign(r, payload);
    writes.push({ client, ids: hit.map((r) => r.id), payload });
    return { data: hit.map((r) => ({ ...r })), error: null };
  }

  function select(call: MockCall) {
    if (opts.failPreflightRead && call.methods.includes('range')) {
      return { data: null, error: { message: 'upstream timeout' } };
    }
    const hit = rows.filter((r) => matches(r, call)).sort((a, b) => a.id.localeCompare(b.id));
    const range = callArgs(call, 'range') as [number, number] | undefined;
    return { data: range ? hit.slice(range[0], range[1] + 1) : hit, error: null };
  }

  const caller = makeSupabaseStub({
    'inventory_items.select': select,
    'inventory_items.update': (call) => update('caller', call),
    'item_stock_levels.select': { data: [], error: null },
  });
  const admin = makeSupabaseStub({
    'inventory_items.select': select,
    'inventory_items.update': (call) => update('admin', call),
  });
  vi.mocked(createAdminClient).mockReturnValue(admin.client as never);

  const svc = new InventoryService({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    supabase: caller.client,
    enabledModules: new Set<string>(),
  } as never);
  return { svc, writes, rows };
}

beforeEach(() => vi.clearAllMocks());

describe('InventoryService.update: a SKU edit moves the whole group or nothing', () => {
  it('refuses, with nothing written, when the new SKU is taken at another record of the group', async () => {
    const { svc, writes, rows } = harness([
      record({ id: 'row-a', sku: 'SP-OLD', bin_location: '22-C' }),
      record({ id: 'row-b', sku: 'SP-OLD', charter_id: 'ch-1', bin_location: '7-A' }),
      // Already on the new SKU, in the same charter and rack as row-b.
      record({
        id: 'row-z',
        sku: 'SP-NEW',
        charter_id: 'ch-1',
        bin_location: '7-A',
        name: 'Black pad',
      }),
    ]);

    const err = (await svc.update('row-a', { sku: 'SP-NEW' }).catch((e: unknown) => e)) as {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };

    expect(err.code).toBe('conflict');
    expect(err.message).toContain('SP-NEW');
    expect(err.message).toContain('SP-OLD');
    expect(err.message).toMatch(/nothing was changed/i);
    expect(err.message).not.toMatch(CHARTER_ADVICE);
    // The record that holds the slot may be one the editor cannot see: it is
    // never named.
    expect(err.message).not.toContain('Black pad');
    expect(err.details).toMatchObject({
      reason: 'sku_taken_in_group',
      sku: 'SP-NEW',
      previousSku: 'SP-OLD',
    });
    // Nothing was written, on either client: the group is still whole.
    expect(writes).toEqual([]);
    expect(rows.filter((r) => r.sku === 'SP-OLD').map((r) => r.id)).toEqual(['row-a', 'row-b']);
  });

  it("refuses, with nothing written, when the edit moves this record onto another group member's charter and rack", async () => {
    const { svc, writes } = harness([
      record({ id: 'row-a', sku: 'SP-OLD', bin_location: '22-C' }),
      record({ id: 'row-b', sku: 'SP-OLD', charter_id: 'ch-1', bin_location: '7-A' }),
    ]);

    const err = (await svc
      .update('row-a', { sku: 'SP-NEW', charterId: 'ch-1', binLocation: '7-A' })
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/nothing was changed/i);
    expect(writes).toEqual([]);
  });

  it('moves every record of the group when no slot is taken', async () => {
    const { svc, writes, rows } = harness([
      record({ id: 'row-a', sku: 'SP-OLD', bin_location: '22-C' }),
      record({ id: 'row-b', sku: 'SP-OLD', charter_id: 'ch-1', bin_location: '7-A' }),
      // The new SKU elsewhere is fine: another charter and rack.
      record({ id: 'row-z', sku: 'SP-NEW', charter_id: 'ch-2', bin_location: '7-A' }),
    ]);

    await svc.update('row-a', { sku: 'SP-NEW' });

    expect(writes.map((w) => [w.client, w.ids])).toEqual([
      ['caller', ['row-a']],
      ['admin', ['row-b']],
    ]);
    expect(
      rows
        .filter((r) => r.sku === 'SP-NEW')
        .map((r) => r.id)
        .sort(),
    ).toEqual(['row-a', 'row-b', 'row-z']);
  });

  it('refuses, with nothing written, when the check cannot read the group (fails closed)', async () => {
    const { svc, writes } = harness(
      [
        record({ id: 'row-a', sku: 'SP-OLD', bin_location: '22-C' }),
        record({ id: 'row-b', sku: 'SP-OLD', charter_id: 'ch-1', bin_location: '7-A' }),
      ],
      { failPreflightRead: true },
    );

    const err = (await svc.update('row-a', { sku: 'SP-NEW' }).catch((e: unknown) => e)) as {
      code: string;
    };

    expect(err.code).toBe('internal_error');
    expect(writes).toEqual([]);
  });

  it('checks nothing extra when the SKU does not change', async () => {
    const { svc, writes } = harness(
      [
        record({ id: 'row-a', sku: 'SP-OLD', bin_location: '22-C' }),
        record({ id: 'row-b', sku: 'SP-OLD', charter_id: 'ch-1', bin_location: '7-A' }),
      ],
      // A paged read would fail: none must be made for a name-only edit.
      { failPreflightRead: true },
    );

    await svc.update('row-a', { name: 'Mouse pad, black' });

    expect(writes.map((w) => [w.client, w.ids])).toEqual([
      ['caller', ['row-a']],
      ['admin', ['row-b']],
    ]);
  });
});
