// Model B — "one product = one SKU": editing a SHARED product field (name,
// sku, unit_cost, retail_price, description, category_id, barcode,
// reorder_point, reorder_quantity, item_type) on ANY placement of a SKU must
// fan out to every OTHER non-deleted inventory_items row sharing that item's
// ORIGINAL (organization_id, sku) — so editing the Chromebook's cost on one
// rack updates every rack. PER-PLACEMENT fields (charter_id, warehouse_id,
// primary_location_id, bin_location, quantity_on_hand, status, rack
// custom_fields) must NEVER propagate. Editing the sku itself re-keys the
// WHOLE group (all placements move to the new sku together), keyed on the
// ORIGINAL sku captured before the patch is applied.
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
import { audit } from './audit';

type UpdateCall = {
  scope: 'target' | 'siblings';
  payload: Record<string, unknown>;
  filterSku?: string;
  filterOrg?: string;
};

/**
 * update() flow this harness models:
 *   1. this.get(id)                         → SELECT on inventory_items (+ a
 *      read of item_stock_levels, which we stub empty via the generic table
 *      branch below)
 *   2. target row UPDATE  .eq('id', id)      → tagged scope 'target'
 *   3. (conditionally) sibling row UPDATE
 *      .eq('sku', originalSku).neq('id', id) → tagged scope 'siblings',
 *      distinguished from the target update by the presence of .neq('id',…)
 *
 * Each `.from('inventory_items')` call gets its own closure-scoped chain, so
 * the target and sibling updates (two separate `.from()` calls within one
 * `update()` invocation) are captured as independent entries in `updates`.
 */
function harness(opts: { targetSku: string }) {
  const TARGET_ID = 'row-a';
  const TARGET = {
    id: TARGET_ID,
    organization_id: 'org-1',
    sku: opts.targetSku,
    barcode: null,
    name: 'Chromebook',
    warehouse_id: null,
    bin_location: null,
    charter_id: null,
    custom_fields: {},
    status: 'active',
    item_type: 'product',
    tracking_type: 'none',
    quantity_on_hand: 5,
  };

  const updates: UpdateCall[] = [];

  const emptyChain = () => {
    const p: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq', 'neq', 'is', 'in', 'order', 'limit']) {
      p[m] = () => p;
    }
    p.single = async () => ({ data: null, error: null });
    p.maybeSingle = async () => ({ data: null, error: null });
    (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
    return p;
  };

  const supabase = {
    from: (table: string) => {
      if (table !== 'inventory_items') return emptyChain();

      let isUpdate = false;
      let payload: Record<string, unknown> = {};
      let hasNeqId = false;
      let filterSku: string | undefined;
      let filterOrg: string | undefined;

      const p: Record<string, unknown> = {};
      p.select = () => p;
      p.update = (data: Record<string, unknown>) => {
        isUpdate = true;
        payload = data;
        return p;
      };
      p.eq = (col: string, val: unknown) => {
        if (col === 'sku') filterSku = val as string;
        // Captured so propagation tests can assert the sibling UPDATE stays
        // org-scoped — the crown-jewel guard against cross-tenant
        // corruption. Without recording this, deleting the
        // `.eq('organization_id', …)` in inventory.ts would silently pass
        // every test here.
        if (col === 'organization_id') filterOrg = val as string;
        return p;
      };
      p.neq = (col: string) => {
        if (col === 'id') hasNeqId = true;
        return p;
      };
      p.is = () => p;
      p.in = () => p;
      p.order = () => p;
      p.limit = () => p;

      const resolve = () => {
        if (isUpdate) {
          updates.push({ scope: hasNeqId ? 'siblings' : 'target', payload, filterSku, filterOrg });
          const resultData = hasNeqId ? [] : { ...TARGET, ...payload };
          return { data: resultData, error: null };
        }
        return { data: TARGET, error: null };
      };
      p.single = async () => resolve();
      p.maybeSingle = async () => resolve();
      (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res(resolve());
      return p;
    },
  };

  const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    supabase,
    enabledModules: new Set<string>(),
  } as never;

  return { svc: new InventoryService(ctx), updates };
}

describe('InventoryService.update — shared-field propagation by SKU', () => {
  beforeEach(() => vi.clearAllMocks());

  it('propagates unit_cost to all same-sku siblings, but NOT charter', async () => {
    const { svc, updates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { unitCost: 469.95, charterId: 'chr-1' });
    // target row got both; siblings got ONLY unit_cost (shared), NOT charter (per-placement)
    const sibling = updates.find((u) => u.scope === 'siblings');
    expect(sibling).toBeDefined();
    expect(sibling!.payload.unit_cost).toBe(469.95);
    expect(sibling!.payload).not.toHaveProperty('charter_id');
    // Crown-jewel invariant: the sibling fan-out UPDATE is org-scoped, so it
    // can never touch another tenant's rows even if two orgs somehow shared
    // a SKU string.
    expect(sibling!.filterOrg).toBe('org-1');

    const target = updates.find((u) => u.scope === 'target');
    expect(target!.payload.unit_cost).toBe(469.95);
    expect(target!.payload.charter_id).toBe('chr-1');

    // Audited with the propagated sku.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ extra: expect.objectContaining({ propagated_to_sku: 'SP-X' }) }),
      expect.anything(),
    );
  });

  it('editing sku re-keys the whole group (all placements move to the new sku)', async () => {
    const { svc, updates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { sku: 'SP-Y' });
    const sibling = updates.find((u) => u.scope === 'siblings');
    // siblings selected by the ORIGINAL sku, set to the NEW sku
    expect(sibling).toBeDefined();
    expect(sibling!.filterSku).toBe('SP-X');
    expect(sibling!.payload.sku).toBe('SP-Y');
    // Crown-jewel invariant: the re-key fan-out is still org-scoped.
    expect(sibling!.filterOrg).toBe('org-1');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ extra: expect.objectContaining({ propagated_to_sku: 'SP-Y' }) }),
      expect.anything(),
    );
  });

  it('a per-placement-only edit (charter/qty) does NOT touch siblings', async () => {
    const { svc, updates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { charterId: 'chr-2' });
    expect(updates.some((u) => u.scope === 'siblings')).toBe(false);

    // No propagated_to_sku on the audit extra when siblings weren't touched.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.not.objectContaining({ propagated_to_sku: expect.anything() }),
      }),
      expect.anything(),
    );
  });

  it('a sibling-update 23505 (re-keying into a colliding group) surfaces as a friendly conflict', async () => {
    // Force the sibling update to fail with a unique-violation by making the
    // stub's inventory_items chain reject when it sees the sibling's
    // .neq('id', …) marker.
    const supabase = {
      from: (table: string) => {
        if (table !== 'inventory_items') {
          const p: Record<string, unknown> = {};
          for (const m of ['select', 'update', 'eq', 'neq', 'is', 'in', 'order', 'limit']) p[m] = () => p;
          p.single = async () => ({ data: null, error: null });
          p.maybeSingle = async () => ({ data: null, error: null });
          (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
          return p;
        }
        let isUpdate = false;
        let payload: Record<string, unknown> = {};
        let hasNeqId = false;
        const TARGET = {
          id: 'row-a',
          organization_id: 'org-1',
          sku: 'SP-X',
          barcode: null,
          name: 'Chromebook',
          warehouse_id: null,
          bin_location: null,
          charter_id: null,
          custom_fields: {},
          status: 'active',
          item_type: 'product',
          tracking_type: 'none',
          quantity_on_hand: 5,
        };
        const p: Record<string, unknown> = {};
        p.select = () => p;
        p.update = (data: Record<string, unknown>) => {
          isUpdate = true;
          payload = data;
          return p;
        };
        p.eq = () => p;
        p.neq = (col: string) => {
          if (col === 'id') hasNeqId = true;
          return p;
        };
        p.is = () => p;
        p.in = () => p;
        const resolve = () => {
          if (isUpdate && hasNeqId) {
            return { data: null, error: { code: '23505', message: 'duplicate key value' } };
          }
          if (isUpdate) return { data: { ...TARGET, ...payload }, error: null };
          return { data: TARGET, error: null };
        };
        p.single = async () => resolve();
        p.maybeSingle = async () => resolve();
        (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res(resolve());
        return p;
      },
    };
    const ctx = {
      organizationId: 'org-1',
      userId: 'u-1',
      role: 'admin',
      supabase,
      enabledModules: new Set<string>(),
    } as never;
    const err = await new InventoryService(ctx)
      .update('row-a', { unitCost: 1 })
      .catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('conflict');
    expect((err as Error).message).toMatch(/already uses that SKU/i);
  });
});
