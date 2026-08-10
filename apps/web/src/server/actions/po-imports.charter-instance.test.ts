import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

// unstable_cache/revalidateTag: the actions under test import the
// inventory-list loader (cache invalidation helper), whose module graph
// builds unstable_cache wrappers at import time.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));

const { mockCreate, mockUpsert } = vi.hoisted(() => ({
  mockCreate: vi.fn(async () => ({ id: 'new-item-1' })),
  mockUpsert: vi.fn(async () => {}),
}));

// createItemsFromPoLinesAction now routes through PoImportsService.createItemsFromLines
// (the gated twin), which constructs these services with `new` and passes the
// withContext ctx. Behavior under test is unchanged (same shared implementation);
// only the mock seam moved from the static forCurrentUser to constructor + withContext.
vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    create = mockCreate;
  },
}));
vi.mock('@/server/services/vendor-item-mappings', () => ({
  VendorItemMappingsService: class {
    upsert = mockUpsert;
  },
}));

const { mockSupabaseRef } = vi.hoisted(() => ({ mockSupabaseRef: { client: null as unknown } }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => mockSupabaseRef.client),
}));
vi.mock('@/server/services/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/services/context')>();
  return {
    ...actual,
    // Admin so the twin's purchase_orders:manage gate passes via the static role
    // fallback; enabledModules carries only po_imports (sports stays OFF, matching
    // the previous empty-module behavior). supabase is the per-test stub.
    withContext: vi.fn(async () => ({
      organizationId: 'org-test',
      userId: 'user-test',
      role: 'admin',
      supabase: mockSupabaseRef.client,
      mfaRequired: false,
      mfaSatisfied: true,
      enabledModules: new Set(['po_imports']),
    })),
  };
});

import { createItemsFromPoLinesAction } from './po-imports';

const PO_IMPORT_ID = '11111111-1111-1111-1111-111111111111';
const LINE_ID = '22222222-2222-2222-2222-222222222222';
const LINE_ID_2 = '22222222-2222-2222-2222-222222222223';
const VENDOR_ID = '33333333-3333-3333-3333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-4444-444444444444';
const LOCATION_ID = '66666666-6666-6666-6666-666666666666';
// Two distinct charters standing in for the owner's real KVA/CVW/DEF example:
// a KVA import must never land on an existing CVW item just because a
// barcode matches.
const CHARTER_KVA = '55555555-5555-5555-5555-555555555555';
const CHARTER_DEF = '55555555-5555-5555-5555-555555555556';
// Pre-existing item belonging to a DIFFERENT charter (stands in for the
// owner's "CVW" item) whose barcode happens to match the KVA import line.
const ITEM_CVW_ID = '99999999-9999-9999-9999-999999999999';

function baseLine(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    po_import_id: PO_IMPORT_ID,
    line_number: 1,
    line_type: 'inventory',
    description: 'Chromebook (BC-CHROME)',
    qty_ordered_original: 2,
    uom_original: 'EA',
    unit_cost: 5,
    vendor_item_number: 'BC-CHROME',
    vendor_product_number: null,
    auxiliary_number: null,
    item_id: null,
    ...overrides,
  };
}

function installStub(opts: {
  charterRow?: { id: string } | null;
  locationRow?: { id: string } | null;
  lines?: Array<Record<string, unknown>>;
  inventoryItems?: Array<Record<string, unknown>>;
}): SupabaseStub {
  const charterRow = 'charterRow' in opts ? opts.charterRow : null;
  const locationRow = 'locationRow' in opts ? opts.locationRow : { id: 'loc-1' };
  const inventoryItems = opts.inventoryItems ?? [];
  const stub = makeSupabaseStub({
    'po_imports.select': { data: { id: PO_IMPORT_ID }, error: null }, // import-belongs-to-org guard
    'charters.select': { data: charterRow, error: null },
    'locations.select': { data: locationRow ?? null, error: null },
    'po_import_lines.select': { data: opts.lines ?? [baseLine()], error: null },
    'po_import_lines.update': { data: null, error: null },
    'inventory_items.select': { data: inventoryItems, error: null },
  });
  mockSupabaseRef.client = stub.client;
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ id: 'new-item-1' });
});

describe('createItemsFromPoLinesAction — charter-per-instance (advisory match)', () => {
  it('TC2: a KVA import whose barcode matches an existing CVW item creates a NEW KVA item; CVW item untouched', async () => {
    const stub = installStub({
      charterRow: { id: CHARTER_KVA },
      // existing item ITEM_CVW_ID shares this line's barcode but belongs to a
      // different charter (CVW) — a hit here must be advisory only.
      lines: [baseLine({ vendor_item_number: 'BC-CHROME', description: 'Chromebook' })],
      inventoryItems: [{ id: ITEM_CVW_ID }],
    });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      charterId: CHARTER_KVA,
      locationId: LOCATION_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(1);
      expect(result.data.linked).toBe(0);
    }

    // A new item is created under KVA — the CVW barcode match never auto-links.
    // Second arg: PO-born items carry awaitingFirstReceipt (mig 0277).
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ charterId: CHARTER_KVA }),
      { awaitingFirstReceipt: true, source: 'import' },
    );

    // The line points at the NEW item, flagged item_created, with the CVW
    // item recorded only as a suggestion.
    const upd = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(upd.item_created).toBe(true);
    expect(upd.item_id).not.toBe(ITEM_CVW_ID);
    expect(upd.item_id).toBe('new-item-1');
    expect(upd.suggested_item_id).toBe(ITEM_CVW_ID);
    // The existing CVW item was never touched — no second create/link call.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('TC5: two lines, same SKU, charters KVA and DEF → two separate items, each under its own charter', async () => {
    // The action's charterId is a per-call parameter (not per-line), so two
    // charters on the same vendor SKU means two separate approval calls —
    // exactly what happens when the same vendor part is ordered for two
    // different charter schools.
    installStub({
      charterRow: { id: CHARTER_KVA },
      lines: [baseLine({ id: LINE_ID, vendor_item_number: 'SKU-X' })],
      inventoryItems: [],
    });
    const result1 = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      charterId: CHARTER_KVA,
    });
    expect(result1.ok).toBe(true);

    installStub({
      charterRow: { id: CHARTER_DEF },
      lines: [baseLine({ id: LINE_ID_2, vendor_item_number: 'SKU-X' })],
      inventoryItems: [],
    });
    const result2 = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID_2],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      charterId: CHARTER_DEF,
    });
    expect(result2.ok).toBe(true);

    // Both PO-born instances carry awaitingFirstReceipt (mig 0277).
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ charterId: CHARTER_KVA }),
      { awaitingFirstReceipt: true, source: 'import' },
    );
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ charterId: CHARTER_DEF }),
      { awaitingFirstReceipt: true, source: 'import' },
    );
    expect(mockCreate).toHaveBeenCalledTimes(2); // two separate instances, never merged
  });

  it('use_existing under the SAME charter links the chosen item directly (no create)', async () => {
    const stub = installStub({
      charterRow: { id: CHARTER_KVA },
      lines: [baseLine({ vendor_item_number: 'BC-CHROME' })],
      // The chosen item already belongs to the selected charter (KVA).
      inventoryItems: [{ id: ITEM_CVW_ID, sku: 'SKU-X', charter_id: CHARTER_KVA }],
    });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      charterId: CHARTER_KVA,
      decisions: { [LINE_ID]: { mode: 'use_existing', itemId: ITEM_CVW_ID } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.linked).toBe(1);
      expect(result.data.created).toBe(0);
    }
    expect(mockCreate).not.toHaveBeenCalled();
    const upd = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(upd.item_id).toBe(ITEM_CVW_ID);
    expect(upd.item_created).toBe(false);
  });

  it('use_existing under a DIFFERENT charter creates a separate instance under the SELECTED charter (dropdown wins)', async () => {
    // The chosen item is under CVW (CHARTER_DEF), but the import selected KVA.
    // Owner decision: the selected charter wins — a NEW same-SKU instance is
    // created under KVA and the CVW item is left untouched. The two
    // inventory_items.select calls (existing fetch, then the KVA-sibling
    // lookup) are modeled statefully: the sibling doesn't exist yet.
    let sel = 0;
    const stub = makeSupabaseStub({
      'po_imports.select': { data: { id: PO_IMPORT_ID }, error: null },
      'charters.select': { data: { id: CHARTER_KVA }, error: null },
      'locations.select': { data: { id: 'loc-1' }, error: null },
      'po_import_lines.select': {
        data: [baseLine({ vendor_item_number: 'BC-CHROME' })],
        error: null,
      },
      'po_import_lines.update': { data: null, error: null },
      'inventory_items.select': () => {
        sel += 1;
        return sel === 1
          ? {
              data: [
                {
                  id: ITEM_CVW_ID,
                  sku: 'SKU-X',
                  name: 'Chromebook',
                  barcode: 'BC-CHROME',
                  charter_id: CHARTER_DEF,
                  unit_cost: 5,
                  retail_price: 0,
                  category_id: null,
                  supplier_id: null,
                  warehouse_id: WAREHOUSE_ID,
                  unit_of_measure: 'unit',
                  item_type: 'product',
                  tracking_type: 'none',
                },
              ],
              error: null,
            }
          : { data: [], error: null }; // no KVA sibling yet → create one
      },
    });
    mockSupabaseRef.client = stub.client;

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      charterId: CHARTER_KVA,
      decisions: { [LINE_ID]: { mode: 'use_existing', itemId: ITEM_CVW_ID } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(1);
      expect(result.data.linked).toBe(0);
    }
    // A NEW item is created under KVA, copying the CVW item's SKU/name.
    // Second arg: the PO-born sibling instance is also awaitingFirstReceipt
    // (mig 0277) — it has never received stock under ITS charter.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ charterId: CHARTER_KVA, sku: 'SKU-X', name: 'Chromebook' }),
      { awaitingFirstReceipt: true, source: 'import' },
    );
    const upd = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(upd.item_id).toBe('new-item-1'); // the created KVA sibling
    expect(upd.item_id).not.toBe(ITEM_CVW_ID); // never the CVW item
    expect(upd.item_created).toBe(true);
  });

  it('use_existing under a DIFFERENT charter LINKS an already-existing sibling under the selected charter (no duplicate create)', async () => {
    // Same as above but a KVA sibling already exists → link it, don't create.
    const KVA_SIBLING = '99999999-9999-9999-9999-99999999aaaa';
    let sel = 0;
    const stub = makeSupabaseStub({
      'po_imports.select': { data: { id: PO_IMPORT_ID }, error: null },
      'charters.select': { data: { id: CHARTER_KVA }, error: null },
      'locations.select': { data: { id: 'loc-1' }, error: null },
      'po_import_lines.select': {
        data: [baseLine({ vendor_item_number: 'BC-CHROME' })],
        error: null,
      },
      'po_import_lines.update': { data: null, error: null },
      'inventory_items.select': () => {
        sel += 1;
        return sel === 1
          ? { data: [{ id: ITEM_CVW_ID, sku: 'SKU-X', charter_id: CHARTER_DEF }], error: null }
          : { data: [{ id: KVA_SIBLING }], error: null }; // KVA sibling already exists
      },
    });
    mockSupabaseRef.client = stub.client;

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      charterId: CHARTER_KVA,
      decisions: { [LINE_ID]: { mode: 'use_existing', itemId: ITEM_CVW_ID } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.linked).toBe(1);
      expect(result.data.created).toBe(0);
    }
    expect(mockCreate).not.toHaveBeenCalled();
    const upd = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(upd.item_id).toBe(KVA_SIBLING);
    expect(upd.item_created).toBe(false);
  });
});
