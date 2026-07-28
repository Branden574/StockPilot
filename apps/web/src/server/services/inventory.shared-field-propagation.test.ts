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
//
// The TARGET row update runs on the caller's RLS-scoped `ctx.supabase` — a
// warehouse-scoped user must only be able to edit rows they can already
// write to. The SIBLING fan-out, however, must run on the SERVICE-ROLE admin
// client (`createAdminClient()`): if it ran on `ctx.supabase`, RLS
// (inventory_items_update → user_can_access_inventory(warehouse_id,
// charter_id, 'write'), migration 0008) would silently filter out sibling
// placements sitting in warehouses/charters the editor can't write to — and
// a zero-row-matched PostgREST UPDATE reports success, so the "shared" field
// would SILENTLY DIVERGE across placements with no error. This file proves
// (a) the sibling UPDATE goes through the admin client, not ctx.supabase,
// and (b) it still carries the organization_id + sku filters (the
// tenant-isolation floor now that RLS is bypassed) — both RED if reverted.
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
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { InventoryService } from './inventory';
import { audit } from './audit';
import { createAdminClient } from '@/lib/supabase/admin';

type UpdateCall = {
  scope: 'target' | 'siblings';
  payload: Record<string, unknown>;
  filterSku?: string;
  filterOrg?: string;
};

/**
 * update() flow this harness models:
 *   1. this.get(id)                          → SELECT on inventory_items (+ a
 *      read of item_stock_levels, which we stub empty via the generic table
 *      branch below) — via ctx.supabase.
 *   2. target row UPDATE  .eq('id', id)       → via ctx.supabase, tagged
 *      scope 'target'.
 *   3. (conditionally) sibling row UPDATE
 *      .eq('sku', originalSku).neq('id', id)  → via createAdminClient(),
 *      NOT ctx.supabase, tagged scope 'siblings'.
 *
 * `ctxUpdates` and `adminUpdates` are captured from two entirely separate
 * stub clients, so a regression that routes the sibling fan-out back onto
 * ctx.supabase shows up as an EMPTY adminUpdates (nothing was ever pushed to
 * the admin stub's closure) rather than merely a differently-tagged entry.
 */
function harness(opts: { targetSku: string; siblingFails23505?: boolean }) {
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
    category_id: null,
    group_id: null,
    variant_size: 'M',
    variant_size_original: 'M',
    variant_size_system: null,
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: null,
    player_name: null,
    variant_key: 'size=m',
  };

  const ctxUpdates: UpdateCall[] = [];
  const adminUpdates: UpdateCall[] = [];

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

  // ctx.supabase — RLS-scoped. Only ever sees the `get()` SELECT and the
  // TARGET row update in the current implementation. Still tags a would-be
  // sibling update (.neq('id', …)) as scope 'siblings' so a regression that
  // routes the fan-out back through ctx.supabase is visible in ctxUpdates
  // instead of silently vanishing.
  const ctxSupabase = {
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
          ctxUpdates.push({ scope: hasNeqId ? 'siblings' : 'target', payload, filterSku, filterOrg });
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

  // createAdminClient() — service-role, bypasses RLS. Only ever sees the
  // sibling fan-out UPDATE. No .select()/.single() is chained on it in the
  // production code (the result is awaited directly off the query builder),
  // so this stub only needs to be thenable.
  const adminSupabase = {
    from: (table: string) => {
      if (table !== 'inventory_items') return emptyChain();

      let payload: Record<string, unknown> = {};
      let filterSku: string | undefined;
      let filterOrg: string | undefined;

      const p: Record<string, unknown> = {};
      p.update = (data: Record<string, unknown>) => {
        payload = data;
        return p;
      };
      p.eq = (col: string, val: unknown) => {
        if (col === 'sku') filterSku = val as string;
        if (col === 'organization_id') filterOrg = val as string;
        return p;
      };
      p.is = () => p;
      p.neq = () => p;

      const resolve = () => {
        adminUpdates.push({ scope: 'siblings', payload, filterSku, filterOrg });
        if (opts.siblingFails23505) {
          return { data: null, error: { code: '23505', message: 'duplicate key value' } };
        }
        return { data: null, error: null };
      };
      (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res(resolve());
      return p;
    },
  };

  vi.mocked(createAdminClient).mockReturnValue(adminSupabase as never);

  const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    supabase: ctxSupabase,
    enabledModules: new Set<string>(),
  } as never;

  return { svc: new InventoryService(ctx), ctxUpdates, adminUpdates };
}

describe('InventoryService.update — shared-field propagation by SKU', () => {
  beforeEach(() => vi.clearAllMocks());

  it('propagates unit_cost to all same-sku siblings via the admin client, but NOT charter', async () => {
    const { svc, ctxUpdates, adminUpdates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { unitCost: 469.95, charterId: 'chr-1' });

    // The sibling fan-out went through the ADMIN client, not ctx.supabase —
    // if this regresses back onto ctx.supabase, adminUpdates stays empty.
    const sibling = adminUpdates.find((u) => u.scope === 'siblings');
    expect(sibling).toBeDefined();
    expect(sibling!.payload.unit_cost).toBe(469.95);
    expect(sibling!.payload).not.toHaveProperty('charter_id');
    // Crown-jewel invariant: the sibling fan-out UPDATE is org- and
    // sku-scoped, so it can never touch another tenant's rows (or an
    // unrelated SKU's rows) even though it runs on the service-role client
    // that bypasses RLS. RED if either .eq() is dropped.
    expect(sibling!.filterOrg).toBe('org-1');
    expect(sibling!.filterSku).toBe('SP-X');

    // ctx.supabase never saw a sibling-shaped update (no double-write, and
    // no accidental fallback to the RLS-scoped client for this call).
    expect(ctxUpdates.some((u) => u.scope === 'siblings')).toBe(false);

    // Target row update is unchanged: still on ctx.supabase.
    const target = ctxUpdates.find((u) => u.scope === 'target');
    expect(target).toBeDefined();
    expect(target!.payload.unit_cost).toBe(469.95);
    expect(target!.payload.charter_id).toBe('chr-1');

    // Audited with the propagated sku.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ extra: expect.objectContaining({ propagated_to_sku: 'SP-X' }) }),
      expect.anything(),
    );
  });

  it('editing sku re-keys the whole group via the admin client (all placements move to the new sku)', async () => {
    const { svc, adminUpdates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { sku: 'SP-Y' });
    const sibling = adminUpdates.find((u) => u.scope === 'siblings');
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

  it('a per-placement-only edit (charter/qty) does NOT touch siblings on either client', async () => {
    const { svc, ctxUpdates, adminUpdates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { charterId: 'chr-2' });
    expect(adminUpdates.length).toBe(0);
    expect(ctxUpdates.some((u) => u.scope === 'siblings')).toBe(false);

    // No propagated_to_sku on the audit extra when siblings weren't touched.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.not.objectContaining({ propagated_to_sku: expect.anything() }),
      }),
      expect.anything(),
    );
  });

  // Owner report 2026-07-15: the edit form submits the FULL patch, so
  // changed_keys built from submitted keys made every save read as
  // "Fields changed: <all 19 fields>". changed_keys must reflect VALUE
  // changes only.
  it('audit changed_keys lists only keys whose VALUE actually changed — not every submitted key', async () => {
    const { svc } = harness({ targetSku: 'SP-X' });
    // name actually changes; status is submitted with its unchanged value.
    await svc.update('row-a', { name: 'Chromebook 2', status: 'active' });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({ changed_keys: ['name'] }),
        before: { name: 'Chromebook' },
        after: { name: 'Chromebook 2' },
      }),
      expect.anything(),
    );
  });

  it('a no-op save (submitted values identical to the row) audits EMPTY changed_keys and no before/after wall', async () => {
    const { svc } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { name: 'Chromebook', status: 'active' });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({ changed_keys: [] }),
        before: {},
        after: {},
      }),
      expect.anything(),
    );
  });

  // Model B says one SKU is ONE product. A variant's identity — its size, its
  // width, its number, and the variant_key derived from them — is therefore a
  // PRODUCT fact, not a per-rack one. Leaving the variant columns out of the
  // fan-out meant editing a size on the rack you were standing at forked that
  // SKU's identity: the other bins kept the old size and the old key, so the
  // group roll-up counted two variants and the next import created a third row
  // for a size that already existed twice.
  it('fans a size edit out to every placement of the SKU — size, original AND key', async () => {
    const { svc, adminUpdates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { variantSize: 'L' });

    const sibling = adminUpdates.find((u) => u.scope === 'siblings');
    expect(sibling).toBeDefined();
    expect(sibling!.payload.variant_size).toBe('L');
    expect(sibling!.payload.variant_size_original).toBe('L');
    // The DERIVED key travels in the SAME statement as the size it is derived
    // from — a fan-out that moved the size but not the key would leave every
    // sibling keyed under the size it no longer has.
    expect(sibling!.payload.variant_key).toBe('size=l');
    // Still org- and sku-scoped on the service-role client.
    expect(sibling!.filterOrg).toBe('org-1');
    expect(sibling!.filterSku).toBe('SP-X');
  });

  it('never fans out a per-placement field alongside the variant identity', async () => {
    const { svc, adminUpdates } = harness({ targetSku: 'SP-X' });
    await svc.update('row-a', { variantSize: 'L', binLocation: 'A-9', charterId: 'chr-3' });

    const sibling = adminUpdates.find((u) => u.scope === 'siblings');
    expect(sibling!.payload.variant_size).toBe('L');
    expect(sibling!.payload).not.toHaveProperty('bin_location');
    expect(sibling!.payload).not.toHaveProperty('charter_id');
    expect(sibling!.payload).not.toHaveProperty('quantity_on_hand');
  });

  it('a sibling-update 23505 (re-keying into a colliding group) surfaces as a friendly conflict', async () => {
    const { svc } = harness({ targetSku: 'SP-X', siblingFails23505: true });
    const err = await svc.update('row-a', { unitCost: 1 }).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('conflict');
    expect((err as Error).message).toMatch(/already uses that SKU/i);
  });
});
