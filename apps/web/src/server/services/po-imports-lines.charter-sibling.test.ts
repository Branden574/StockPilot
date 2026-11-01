import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const { mockAudit } = vi.hoisted(() => ({ mockAudit: vi.fn(async () => {}) }));
vi.mock('./audit', () => ({ audit: mockAudit }));

import { createItemsFromPoLines } from './po-imports-lines';

/**
 * A `use_existing` line under a STATED charter that differs from the chosen
 * item's charter resolves to the same-SKU instance under the stated charter,
 * creating it at qty 0 when none exists (the charter sibling). The sibling is
 * a clone of the chosen item, so it copies the item's ordering visibility
 * (0413, design 2.3): a hidden product's sibling is born hidden, and it stays
 * hidden after its first receipt, which clears only awaiting_first_receipt.
 * A shown item's sibling takes the default and sends no visibility option.
 */

const IMPORT_ID = '11111111-1111-4111-8111-111111111111';
const LINE_ID = '22222222-2222-4222-8222-222222222222';
const VENDOR_ID = '33333333-3333-4333-8333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-8444-444444444444';
const EXISTING_ID = '55555555-5555-4555-8555-555555555555';
const CHARTER_STATED = '66666666-6666-4666-8666-666666666666';
const CHARTER_OTHER = '77777777-7777-4777-8777-777777777777';

function line() {
  return {
    id: LINE_ID,
    po_import_id: IMPORT_ID,
    line_number: 1,
    line_type: 'inventory',
    description: 'Field Guide to Example Birds',
    qty_ordered_original: 4,
    uom_original: 'EA',
    unit_cost: 12,
    vendor_item_number: null,
    vendor_product_number: null,
    auxiliary_number: null,
    item_id: null,
    variant_size: null,
    variant_size_original: null,
    variant_size_system: null,
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: null,
    player_name: null,
    group_hint: null,
    serial_hint: null,
    suggested_group_id: null,
    mapping_confidence: null,
  };
}

function existingItem(over: Record<string, unknown> = {}) {
  return {
    id: EXISTING_ID,
    sku: 'SKU-EXAMPLE-1',
    name: 'Field Guide to Example Birds',
    barcode: null,
    charter_id: CHARTER_OTHER,
    unit_cost: 12,
    retail_price: 20,
    category_id: null,
    supplier_id: null,
    warehouse_id: WAREHOUSE_ID,
    unit_of_measure: 'unit',
    item_type: 'book',
    tracking_type: 'none',
    group_id: null,
    variant_size: null,
    variant_size_original: null,
    variant_size_system: null,
    variant_width: null,
    variant_fit: null,
    variant_color: null,
    jersey_number: null,
    player_name: null,
    ...over,
  };
}

function stubFor(existing: Record<string, unknown>, sibling: { id: string } | null = null) {
  let itemRead = 0;
  return makeSupabaseStub({
    'po_imports.select': { data: { id: IMPORT_ID, status: 'parsed' }, error: null },
    'po_import_lines.select': { data: [line()], error: null },
    'po_import_lines.update': { data: [{ id: LINE_ID }], error: null },
    'locations.select': { data: null, error: null },
    'charters.select': { data: { id: CHARTER_STATED }, error: null },
    'categories.select': { data: null, error: null },
    // 1st = the chosen item (identity and charter), 2nd = the same-SKU
    // instance under the stated charter.
    'inventory_items.select.maybeSingle': () => {
      itemRead += 1;
      return { data: itemRead === 1 ? existing : sibling, error: null };
    },
  });
}

function depsFor(stub: ReturnType<typeof makeSupabaseStub>) {
  const create = vi.fn(
    async (_input: Record<string, unknown>, _opts?: Record<string, unknown>) => ({
      id: 'item-sibling-new',
    }),
  );
  const ctx = makeServiceContext(stub.client, {
    organizationId: 'org-test',
    role: 'admin',
    enabledModules: new Set<ModuleId>(['inventory', 'po_imports']),
  });
  return {
    create,
    deps: {
      supabase: stub.client,
      organizationId: 'org-test',
      inventorySvc: { create } as never,
      mappingsSvc: { upsert: vi.fn(async () => {}) } as never,
      ctx,
    },
  };
}

const INPUT = {
  poImportId: IMPORT_ID,
  lineIds: [LINE_ID],
  vendorId: VENDOR_ID,
  warehouseId: WAREHOUSE_ID,
  charterId: CHARTER_STATED,
  decisions: { [LINE_ID]: { mode: 'use_existing' as const, itemId: EXISTING_ID } },
};

beforeEach(() => vi.clearAllMocks());

describe('createItemsFromPoLines: a charter sibling copies the ordering visibility', () => {
  it('reads the chosen item\'s ordering visibility with the rest of its identity', async () => {
    const stub = stubFor(existingItem());
    const { deps } = depsFor(stub);
    await createItemsFromPoLines(deps, INPUT);
    const selects = (stub.chainArgsAll.get('inventory_items.select') ?? []).map(
      (chain) => chain[0]?.[0] as string,
    );
    expect(selects[0]).toContain('order_catalog_visible');
  });

  it('a sibling of an item hidden from ordering is born hidden', async () => {
    const stub = stubFor(existingItem({ order_catalog_visible: false }));
    const { create, deps } = depsFor(stub);
    const r = await createItemsFromPoLines(deps, INPUT);
    expect(r.created).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    const [input, opts] = create.mock.calls[0]!;
    expect(input.charterId).toBe(CHARTER_STATED);
    expect(input.sku).toBe('SKU-EXAMPLE-1');
    expect(opts).toEqual({
      awaitingFirstReceipt: true,
      source: 'import',
      orderCatalogVisible: false,
    });
  });

  it('a sibling of a shown item sends no visibility option', async () => {
    for (const visible of [true, undefined]) {
      const stub = stubFor(
        visible === undefined ? existingItem() : existingItem({ order_catalog_visible: visible }),
      );
      const { create, deps } = depsFor(stub);
      await createItemsFromPoLines(deps, INPUT);
      const [, opts] = create.mock.calls[0]!;
      expect(opts).toEqual({ awaitingFirstReceipt: true, source: 'import' });
    }
  });

  it('an existing sibling is linked as it is: nothing is created', async () => {
    const stub = stubFor(existingItem({ order_catalog_visible: false }), { id: 'item-sibling-old' });
    const { create, deps } = depsFor(stub);
    const r = await createItemsFromPoLines(deps, INPUT);
    expect(create).not.toHaveBeenCalled();
    expect(r.linked).toBe(1);
  });
});
