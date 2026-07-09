// Regression: InventoryService.update must surface a duplicate-SKU collision
// (partial unique index inventory_items_org_sku_charter_bin_unique → Postgres
// 23505, migration 0234) as a friendly `conflict` ServiceError, NOT the opaque
// `internal_error` the raw rethrow produced. This is why a pasted/copied SKU
// appeared to fail for no visible reason while an auto-generated (unique) SKU
// saved fine. Post-0234 the message must also make clear the SAME SKU is
// allowed across different charters (only same charter + rack collides).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(
      public code: string,
      message: string,
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

import { InventoryService } from './inventory';

const ITEM = {
  id: 'itm-1',
  organization_id: 'org-1',
  sku: 'OLD-SKU',
  barcode: null,
  name: 'Widget',
  warehouse_id: null,
  bin_location: null,
  charter_id: null,
  custom_fields: {},
  status: 'active',
  item_type: 'product',
  tracking_type: 'none',
  quantity_on_hand: 5,
};

/**
 * update() first calls this.get(id) (a SELECT), then the UPDATE chain. The
 * stub returns ITEM for any select, empty for other tables, and lets each
 * test choose the UPDATE result (23505 vs a generic error vs success).
 */
function makeCtx(updateResult: { data: unknown; error: { code?: string; message: string } | null }) {
  const chain = (result: { data: unknown; error: unknown }) => {
    const p: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq', 'is', 'in', 'order', 'limit', 'maybeSingle']) {
      p[m] = () => p;
    }
    p.single = async () => result;
    p.maybeSingle = async () => result;
    // Make the chain awaitable too (for list-style selects).
    (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res(result);
    return p;
  };
  const supabase = {
    from: (table: string) => {
      if (table !== 'inventory_items') {
        // holdings / warehouse_charters etc → empty
        return chain({ data: [], error: null });
      }
      // A select resolves to ITEM (single) / [ITEM] (list); an update resolves
      // to the test-provided result. We disambiguate by which terminal is hit:
      // the update chain calls .update() then .single(); selects call .select().
      let isUpdate = false;
      const p: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) {
        p[m] = () => p;
      }
      p.update = () => {
        isUpdate = true;
        return p;
      };
      p.single = async () => (isUpdate ? updateResult : { data: ITEM, error: null });
      p.maybeSingle = async () => (isUpdate ? updateResult : { data: ITEM, error: null });
      (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
        res(isUpdate ? updateResult : { data: [ITEM], error: null });
      return p;
    },
  };
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    supabase,
    enabledModules: new Set<string>(),
  } as never;
}

describe('InventoryService.update — duplicate SKU handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps a 23505 unique violation to a friendly conflict (not internal_error)', async () => {
    const svc = new InventoryService(
      makeCtx({ data: null, error: { code: '23505', message: 'duplicate key value' } }),
    );
    const err = await svc.update('itm-1', { sku: 'COPIED-SKU' }).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('conflict');
    expect((err as Error).message).toMatch(/already uses that SKU/i);
    // Post-0234: the copy must tell the user the same SKU is fine across
    // charters (so they don't think SKUs must be globally unique).
    expect((err as Error).message).toMatch(/charter/i);
  });

  it('still surfaces a non-23505 DB error as internal_error', async () => {
    const svc = new InventoryService(
      makeCtx({ data: null, error: { code: '42P01', message: 'some other db error' } }),
    );
    const err = await svc.update('itm-1', { sku: 'X' }).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('internal_error');
  });
});
