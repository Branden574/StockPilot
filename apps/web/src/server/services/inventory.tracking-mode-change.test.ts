// InventoryService.update() and the tracking_type column.
//
// TWO defects this file is the regression for.
//
// (1) THE CARVE-OUT THAT NEVER SHIPPED TO update(). Task 8 gave create() a
//     category-driven exception: a SPORTS subcategory that stamps 'serial' or
//     'serial_optional' is granted by the `sports` module, NOT by `lot_serial`
//     (owner decision: sports carries no lot_serial dependency). update() kept
//     the old unconditional gate, so in a sports-only org every serial_optional
//     item was UNEDITABLE — the item form submits the row's own tracking_type
//     back on every save, and that patch tripped `module_disabled` before the
//     first column was written.
//
// (2) TRACKING_MODE_CHANGE_REQUIRES_MIGRATION WAS DEAD VOCABULARY. The code was
//     declared in SPORTS_ERROR_CODES and rendered in SPORTS_ERROR_META, and
//     nothing on the branch threw it. Meanwhile any `items:update` caller could
//     rewrite tracking_type freely — 'none' had no gate at all — on an item with
//     a stock history, changing what receiving demands of units already counted
//     under the old contract. Plan open question 5's default: a product WITH
//     stock_movements cannot change tracking mode in place.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { InventoryService } from './inventory';
import { audit } from './audit';
import { createAdminClient } from '@/lib/supabase/admin';

const SPORTS_ONLY = new Set<ModuleId>(['inventory', 'sports']);
const LOT_SERIAL_ONLY = new Set<ModuleId>(['inventory', 'lot_serial']);
const SPORTS_AND_LOT = new Set<ModuleId>(['inventory', 'sports', 'lot_serial']);

function categoryRow(over: Record<string, unknown> = {}) {
  return {
    id: 'cat-1',
    parent_id: null,
    tracking_mode: null,
    size_scale_id: null,
    default_unit_of_measure: null,
    sports_subcategory_key: null,
    tracking_profile: null,
    deleted_at: null,
    ...over,
  };
}

interface HarnessOpts {
  item?: Record<string, unknown>;
  category?: Record<string, unknown> | null;
  /** How many stock_movements the item already has. */
  movementCount?: number;
  movementCountError?: { message: string; code?: string } | null;
  modules?: Set<ModuleId>;
}

/**
 * Models the four reads/writes update() makes on this path:
 *   inventory_items SELECT (get)  → the row
 *   item_stock_levels SELECT      → [] (placement derivation)
 *   categories SELECT             → the profile source
 *   stock_movements SELECT (head, count) → the migration guard's evidence
 *   inventory_items UPDATE        → the patched row
 *
 * `movementReads` is asserted directly: a patch that does not MOVE the
 * tracking_type must never pay for the count query.
 */
function harness(opts: HarnessOpts = {}) {
  const ITEM = {
    id: 'itm-1',
    organization_id: 'org-1',
    sku: 'SHOE-10',
    name: 'Team Trainer',
    barcode: null,
    warehouse_id: 'wh-1',
    bin_location: null,
    charter_id: null,
    category_id: 'cat-1',
    custom_fields: {},
    status: 'active',
    item_type: 'product',
    tracking_type: 'serial_optional',
    quantity_on_hand: 4,
    variant_size: '10',
    variant_size_original: '10',
    variant_size_system: 'US_MENS',
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: null,
    player_name: null,
    group_id: null,
    variant_key: 'size=10|system=us_mens',
    ...(opts.item ?? {}),
  };

  const itemUpdates: Array<Record<string, unknown>> = [];
  const movementReads: string[] = [];

  const supabase = {
    from: (table: string) => {
      const p: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'neq', 'gt', 'order', 'limit']) {
        p[m] = () => p;
      }

      if (table === 'inventory_items') {
        let isUpdate = false;
        p.update = (payload: Record<string, unknown>) => {
          itemUpdates.push(payload);
          isUpdate = true;
          return p;
        };
        const resolve = () =>
          isUpdate
            ? { data: { ...ITEM, ...itemUpdates[itemUpdates.length - 1] }, error: null }
            : { data: ITEM, error: null };
        p.single = async () => resolve();
        p.maybeSingle = async () => resolve();
        (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res(resolve());
        return p;
      }

      if (table === 'categories') {
        const result = { data: opts.category === undefined ? categoryRow() : opts.category, error: null };
        p.maybeSingle = async () => result;
        p.single = async () => result;
        (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res(result);
        return p;
      }

      if (table === 'stock_movements') {
        p.select = (...args: unknown[]) => {
          movementReads.push(JSON.stringify(args));
          return p;
        };
        const result = {
          data: null,
          error: opts.movementCountError ?? null,
          count: opts.movementCount ?? 0,
        };
        p.single = async () => result;
        p.maybeSingle = async () => result;
        (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res(result);
        return p;
      }

      p.update = () => p;
      p.single = async () => ({ data: null, error: null });
      p.maybeSingle = async () => ({ data: null, error: null });
      (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
        res({ data: [], error: null });
      return p;
    },
  };

  // Only reached when the patch touches a SHARED_ITEM_FIELD.
  const adminChain: Record<string, unknown> = {};
  for (const m of ['update', 'eq', 'is', 'neq', 'select']) adminChain[m] = () => adminChain;
  (adminChain as { then: unknown }).then = (res: (v: unknown) => unknown) =>
    res({ data: null, error: null });
  vi.mocked(createAdminClient).mockReturnValue({ from: () => adminChain } as never);

  const ctx = {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    mfaRequired: false,
    mfaSatisfied: true,
    supabase,
    enabledModules: opts.modules ?? SPORTS_ONLY,
  } as never;

  return { svc: new InventoryService(ctx), itemUpdates, movementReads };
}

const shoes = () =>
  categoryRow({ sports_subcategory_key: 'shoes', tracking_mode: 'OPTIONAL_SERIALIZED' });

describe('InventoryService.update — sports carve-out on the lot_serial gate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets a SPORTS serial_optional item be edited in an org with no lot_serial', async () => {
    // The bug: the item form re-submits the row's own tracking_type on every
    // save, so this patch made the whole item uneditable.
    const { svc, itemUpdates } = harness({ category: shoes(), modules: SPORTS_ONLY });
    await svc.update('itm-1', { name: 'Team Trainer v2', trackingType: 'serial_optional' });

    expect(itemUpdates[0]?.name).toBe('Team Trainer v2');
  });

  it('grants a sports SERIAL patch through the sports module too', async () => {
    const { svc } = harness({
      category: categoryRow({
        sports_subcategory_key: 'protective_equipment',
        tracking_mode: 'INDIVIDUALLY_TAGGED',
      }),
      item: { tracking_type: 'serial' },
      modules: SPORTS_ONLY,
    });
    await expect(
      svc.update('itm-1', { name: 'Helmet', trackingType: 'serial' }),
    ).resolves.toBeTruthy();
  });

  it('still refuses LOT on a sports category without lot_serial', async () => {
    // 'lot' is never sports-granted — only the two serial modes are.
    const { svc } = harness({ category: shoes(), modules: SPORTS_ONLY });
    await expect(svc.update('itm-1', { trackingType: 'lot' })).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('still refuses serial_optional on a NON-sports category without lot_serial', async () => {
    const { svc } = harness({ category: categoryRow(), modules: SPORTS_ONLY });
    await expect(
      svc.update('itm-1', { trackingType: 'serial_optional' }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('still refuses a sports serial patch when the SPORTS module itself is off', async () => {
    // The carve-out exists because `sports` grants the mode. With sports off
    // nothing grants it, so the gate falls back to lot_serial exactly as before.
    const { svc } = harness({ category: shoes(), modules: new Set<ModuleId>(['inventory']) });
    await expect(
      svc.update('itm-1', { trackingType: 'serial_optional' }),
    ).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('keeps the shelf-life / expiry half of the gate on lot_serial, sports or not', async () => {
    const { svc } = harness({ category: shoes(), modules: SPORTS_ONLY });
    await expect(svc.update('itm-1', { expiryPolicy: 'block' })).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });
});

describe('InventoryService.update — tracking-mode change guard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('REFUSES a tracking_type change on an item that already has stock movements', async () => {
    const { svc, itemUpdates } = harness({
      category: shoes(),
      movementCount: 3,
      modules: SPORTS_AND_LOT,
    });
    const err = await svc
      .update('itm-1', { trackingType: 'none' })
      .catch((e: unknown) => e as { code: string; details?: Record<string, unknown> });

    expect(err.code).toBe('validation_error');
    expect(err.details?.code).toBe('TRACKING_MODE_CHANGE_REQUIRES_MIGRATION');
    // Refused BEFORE any write.
    expect(itemUpdates).toHaveLength(0);
  });

  it("refuses a change to 'none' too — the value that had no gate at all", async () => {
    const { svc } = harness({
      item: { tracking_type: 'serial' },
      category: categoryRow(),
      movementCount: 1,
      modules: LOT_SERIAL_ONLY,
    });
    await expect(svc.update('itm-1', { trackingType: 'none' })).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  it('allows the change on an item with NO movements, and audits it', async () => {
    const { svc, itemUpdates } = harness({
      category: shoes(),
      movementCount: 0,
      modules: SPORTS_AND_LOT,
    });
    await svc.update('itm-1', { trackingType: 'none' });

    expect(itemUpdates[0]?.tracking_type).toBe('none');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'item.tracking_type.changed',
        entityId: 'itm-1',
        before: { tracking_type: 'serial_optional' },
        after: { tracking_type: 'none' },
      }),
      expect.anything(),
    );
  });

  it('FAILS CLOSED when the movement count cannot be read', async () => {
    const { svc, itemUpdates } = harness({
      category: shoes(),
      movementCountError: { message: 'boom' },
      modules: SPORTS_AND_LOT,
    });
    await expect(svc.update('itm-1', { trackingType: 'none' })).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(itemUpdates).toHaveLength(0);
  });

  it('validates the new value against the SPORTS subcategory allowedModes', async () => {
    // shoes allows QUANTITY_BY_VARIANT / QUANTITY / OPTIONAL_SERIALIZED →
    // tracking types 'none' and 'serial_optional'. A mandatory 'serial' is not
    // reachable from this subcategory at all.
    const { svc } = harness({ category: shoes(), movementCount: 0, modules: SPORTS_AND_LOT });
    const err = await svc
      .update('itm-1', { trackingType: 'serial' })
      .catch((e: unknown) => e as { code: string; details?: Record<string, unknown> });

    expect(err.code).toBe('validation_error');
    expect(err.details?.code).toBe('TRACKING_MODE_NOT_ALLOWED');
  });

  it('leaves a NON-sports category unvalidated — existing behaviour, unchanged', async () => {
    const { svc, itemUpdates } = harness({
      item: { tracking_type: 'none', category_id: 'cat-1' },
      category: categoryRow(),
      movementCount: 0,
      modules: LOT_SERIAL_ONLY,
    });
    await svc.update('itm-1', { trackingType: 'serial' });
    expect(itemUpdates[0]?.tracking_type).toBe('serial');
  });

  it('never reads stock_movements when the submitted tracking_type is unchanged', async () => {
    // The edit form submits the full patch on every save. Re-sending the row's
    // own value is not a change and must cost nothing.
    const { svc, movementReads } = harness({ category: shoes(), modules: SPORTS_ONLY });
    await svc.update('itm-1', { trackingType: 'serial_optional', name: 'Same tracking' });

    expect(movementReads).toHaveLength(0);
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'item.tracking_type.changed' }),
      expect.anything(),
    );
  });

  it('never reads stock_movements when the patch omits trackingType entirely', async () => {
    const { svc, movementReads } = harness({ category: shoes(), modules: SPORTS_ONLY });
    await svc.update('itm-1', { binLocation: 'A-1' });
    expect(movementReads).toHaveLength(0);
  });
});
