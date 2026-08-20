import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// ---------------------------------------------------------------------------
// SETTING A RACK ON THE EDIT FORM MUST MOVE THE STOCK — owner report 2026-08-20
//
// It did not. Typing 7 / B on the "6 foot table" wrote bin_location '7-B' and
// custom_fields.rack_number/_row, the detail page then read "DC4 7-B", and all
// ten units stayed in Unplaced with no movement written. The label said one
// thing and the stock said another, and the Exceptions page correctly refused
// to clear the row because it reads HOLDINGS, not labels.
//
// The inconsistency is what made it a trap: the same two boxes already moved
// stock on manual create and in bulk Set rack. Only single-item edit relabelled.
// ---------------------------------------------------------------------------
vi.mock('./context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./context')>();
  return { ...actual, assertPermission: vi.fn(), assertPlanLimit: vi.fn() };
});
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, writableIds: [], readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({ audit: vi.fn() }));

import { InventoryService } from './inventory';

beforeEach(() => vi.clearAllMocks());

const ITEM = 'item-1';

/** True when the placement actually ran a transfer for the item. */
function transferred(stub: ReturnType<typeof makeSupabaseStub>): boolean {
  return (stub.rpcCalls ?? []).some((c) => c.name === 'transfer_stock');
}

function makeSvc(opts: {
  beforeCf?: Record<string, unknown>;
  afterCf?: Record<string, unknown>;
  itemType?: string;
  holdingKind?: string | null;
  holdings?: unknown[];
}) {
  const itemType = opts.itemType ?? 'product';
  const before = {
    id: ITEM,
    organization_id: 'org-test',
    warehouse_id: 'wh-1',
    sku: 'SKU-1',
    name: '6 foot table',
    item_type: itemType,
    tracking_type: 'none',
    status: 'active',
    deleted_at: null,
    quantity_on_hand: 10,
    custom_fields: opts.beforeCf ?? {},
  };
  const after = { ...before, custom_fields: opts.afterCf ?? {} };

  // `inventory_items.select` is hit twice with DIFFERENT expected shapes:
  // update() reads the current row (one object, via maybeSingle), then the
  // placement helper reads the items to place (an array). The stub keys by
  // table.op, so a single canned value cannot serve both — the factory form
  // returns the row first and the array afterwards.
  let itemSelectCalls = 0;
  const stub = makeSupabaseStub({
    'inventory_items.select': () => {
      itemSelectCalls += 1;
      return itemSelectCalls === 1
        ? { data: before, error: null }
        : { data: [{ id: ITEM, warehouse_id: 'wh-1' }], error: null };
    },
    'inventory_items.update': { data: after, error: null },
    // The item's stock: unplaced by default, i.e. "not yet placed".
    'item_stock_levels.select': {
      data:
        opts.holdings ??
        [
          {
            item_id: ITEM,
            location_id: 'unp-1',
            quantity: 10,
            locations: { kind: opts.holdingKind ?? 'unplaced', type: 'other', warehouse_id: 'wh-1' },
          },
        ],
      error: null,
    },
    // An existing rack named "7-B" so no create is needed.
    'locations.select': { data: [{ id: 'rack-7b', name: '7-B' }], error: null },
    'rpc:transfer_stock': { data: null, error: null },
    'categories.select': { data: null, error: null },
    'custom_field_definitions.select': { data: [], error: null },
  });
  const ctx = makeServiceContext(stub.client, { role: 'admin' });
  return { svc: new InventoryService(ctx as never), stub };
}

describe('InventoryService.update — a rack set on the edit form places the stock', () => {
  it('moves unplaced stock onto the newly typed rack', async () => {
    const { svc, stub } = makeSvc({
      beforeCf: {},
      afterCf: { rack_number: '7', rack_row: 'B' },
    });

    await svc.update(ITEM, { customFields: { rack_number: '7', rack_row: 'B' } } as never);

    expect(transferred(stub)).toBe(true);
  });

  it('does NOT re-place when custom fields change but the RACK does not', async () => {
    // THE CASE THAT ACTUALLY PINS THE CHANGE CHECK. An earlier version of this
    // suite compared two identical custom_fields blobs, which never entered the
    // placement block at all — it passed while asserting nothing, and survived
    // a mutation that forced the rack to always count as changed.
    //
    // Here custom_fields genuinely changes (a colour) while the rack stays 7-B,
    // so the block runs and only the rack comparison can stop it. That matters:
    // re-placing on every save would drag stock back onto the label after
    // somebody had deliberately transferred it somewhere else.
    const { svc, stub } = makeSvc({
      beforeCf: { rack_number: '7', rack_row: 'B', colour: 'red' },
      afterCf: { rack_number: '7', rack_row: 'B', colour: 'blue' },
    });

    await svc.update(ITEM, {
      customFields: { rack_number: '7', rack_row: 'B', colour: 'blue' },
    } as never);

    expect(transferred(stub)).toBe(false);
  });

  it('does NOT re-place when an unrelated field changes and custom_fields is untouched', async () => {
    const { svc, stub } = makeSvc({
      beforeCf: { rack_number: '7', rack_row: 'B' },
      afterCf: { rack_number: '7', rack_row: 'B' },
    });

    await svc.update(ITEM, { customFields: { rack_number: '7', rack_row: 'B' } } as never);

    expect(transferred(stub)).toBe(false);
  });

  it('does NOT place when the rack is CLEARED — there is nowhere to move to', async () => {
    const { svc, stub } = makeSvc({
      beforeCf: { rack_number: '7', rack_row: 'B' },
      afterCf: {},
    });

    await svc.update(ITEM, { customFields: {} } as never);

    expect(transferred(stub)).toBe(false);
  });

  it('never auto-places a BOOK — that is the crate-erasure path', async () => {
    // A book records a crate as well as a rack. Silently placing one onto a
    // bare rack from this form is exactly what erased Maus I's crate on
    // 2026-08-17. Books keep their own gated placement path.
    const { svc, stub } = makeSvc({
      itemType: 'book',
      beforeCf: {},
      afterCf: { rack_number: '7', rack_row: 'B' },
    });

    await svc.update(ITEM, { customFields: { rack_number: '7', rack_row: 'B' } } as never);

    expect(transferred(stub)).toBe(false);
  });

  it('does NOT move stock that is SPLIT across placements — it never guesses', async () => {
    // Two racks holding this SKU have no honest answer to "which one did you
    // mean", so the edit relabels and leaves the stock alone. Same rule the
    // bulk path already enforces.
    const { svc, stub } = makeSvc({
      beforeCf: {},
      afterCf: { rack_number: '7', rack_row: 'B' },
      holdings: [
        {
          item_id: ITEM,
          location_id: 'rack-a',
          quantity: 4,
          locations: { kind: 'rack', type: 'bin', warehouse_id: 'wh-1' },
        },
        {
          item_id: ITEM,
          location_id: 'rack-b',
          quantity: 6,
          locations: { kind: 'rack', type: 'bin', warehouse_id: 'wh-1' },
        },
      ],
    });

    await svc.update(ITEM, { customFields: { rack_number: '7', rack_row: 'B' } } as never);

    expect(transferred(stub)).toBe(false);
  });
});
