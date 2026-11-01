import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Changing a record's charter on the item form (B26). A record's charter is
 * per placement: update() writes it on this record only, after checking that
 * the record's warehouse services the charter (warehouse_charters).
 *
 * Two defects sat next to that check:
 *  - it ran on every save that carried the charter, changed or not. The form
 *    sends every field on every save, so a record whose charter its warehouse
 *    no longer lists (an admin unlinked it later) could not be saved at all
 *    once the form stopped replacing that charter with Generic on load;
 *  - it ignored a failed read of the pairing and answered "This charter is
 *    not serviced by the chosen warehouse", which is not what happened.
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
vi.mock('@/lib/supabase/admin', () => ({
  // The shared-field fan-out's client: no other record shares this SKU.
  createAdminClient: () => {
    const p: Record<string, unknown> = {};
    for (const m of ['from', 'update', 'select', 'eq', 'neq', 'is', 'order', 'range']) {
      p[m] = () => p;
    }
    (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
      res({ data: [], error: null });
    return p;
  },
}));

import { callArgs, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

import { InventoryService } from './inventory';

const W1 = 'wh-1';
const W2 = 'wh-2';
const NORTH = 'charter-north';
const SOUTH = 'charter-south';

const RECORD = {
  id: 'item-1',
  organization_id: 'org-1',
  sku: 'CB-1',
  name: 'Chromebook',
  warehouse_id: W1,
  charter_id: NORTH,
  bin_location: null,
  custom_fields: {},
  status: 'active',
  item_type: 'product',
  tracking_type: 'none',
  quantity_on_hand: 4,
  category_id: null,
  group_id: null,
  deleted_at: null,
};

function harness(opts: {
  pairs: Array<{ warehouse_id: string; charter_id: string }>;
  pairReadFails?: boolean;
  record?: Partial<typeof RECORD>;
}) {
  const record = { ...RECORD, ...opts.record };
  const writes: Array<Record<string, unknown>> = [];
  const stub = makeSupabaseStub({
    'inventory_items.select': { data: record, error: null },
    'inventory_items.update': (call) => {
      const payload = (callArgs(call, 'update')?.[0] ?? {}) as Record<string, unknown>;
      writes.push(payload);
      return { data: { ...record, ...payload }, error: null };
    },
    'item_stock_levels.select': { data: [], error: null },
    'warehouse_charters.select': opts.pairReadFails
      ? { data: null, error: { message: 'upstream timeout' } }
      : servedLikePostgrest(opts.pairs.map((p) => ({ organization_id: 'org-1', ...p }))),
  });
  const svc = new InventoryService({
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    supabase: stub.client,
    enabledModules: new Set<string>(),
  } as never);
  return { svc, writes };
}

beforeEach(() => vi.clearAllMocks());

describe('InventoryService.update: the charter on the item form', () => {
  it('writes the newly picked charter when the warehouse services it', async () => {
    const { svc, writes } = harness({
      pairs: [
        { warehouse_id: W1, charter_id: NORTH },
        { warehouse_id: W1, charter_id: SOUTH },
      ],
    });

    await svc.update('item-1', { warehouseId: W1, charterId: SOUTH });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ charter_id: SOUTH });
  });

  it('refuses, with nothing written, a charter the warehouse does not service', async () => {
    const { svc, writes } = harness({ pairs: [{ warehouse_id: W1, charter_id: NORTH }] });

    const err = (await svc
      .update('item-1', { warehouseId: W1, charterId: SOUTH })
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('validation_error');
    expect(err.message).toBe('This charter is not serviced by the chosen warehouse.');
    expect(writes).toEqual([]);
  });

  it('saves a record whose charter its warehouse no longer lists, when the charter is not changed', async () => {
    // An admin unlinked North from the warehouse after this record was given
    // it. The form sends the charter back unchanged with every other field.
    const { svc, writes } = harness({ pairs: [{ warehouse_id: W1, charter_id: SOUTH }] });

    await svc.update('item-1', { name: 'Chromebook 511', warehouseId: W1, charterId: NORTH });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ name: 'Chromebook 511', charter_id: NORTH });
  });

  it('checks an unchanged charter against the warehouse a record moves to', async () => {
    const { svc, writes } = harness({ pairs: [{ warehouse_id: W1, charter_id: NORTH }] });

    const err = (await svc
      .update('item-1', { warehouseId: W2, charterId: NORTH })
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('validation_error');
    expect(err.message).toBe('This charter is not serviced by the chosen warehouse.');
    expect(writes).toEqual([]);
  });

  it('refuses honestly, with nothing written, when the pairing cannot be read', async () => {
    const { svc, writes } = harness({ pairs: [], pairReadFails: true });

    const err = (await svc
      .update('item-1', { warehouseId: W1, charterId: SOUTH })
      .catch((e: unknown) => e)) as { code: string; message: string };

    expect(err.code).toBe('internal_error');
    expect(err.message).not.toMatch(/not serviced/i);
    expect(writes).toEqual([]);
  });

  it('clears the charter (Generic) without a pairing check', async () => {
    const { svc, writes } = harness({ pairs: [] });

    await svc.update('item-1', { warehouseId: W1, charterId: null });

    expect(writes[0]).toMatchObject({ charter_id: null });
  });
});
