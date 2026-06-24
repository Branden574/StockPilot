import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { mockCreate, mockUpsert } = vi.hoisted(() => ({
  mockCreate: vi.fn(async () => ({ id: 'new-item-1' })),
  mockUpsert: vi.fn(async () => {}),
}));

vi.mock('@/server/services/inventory', () => ({
  InventoryService: { forCurrentUser: vi.fn(async () => ({ create: mockCreate })) },
}));
vi.mock('@/server/services/vendor-item-mappings', () => ({
  VendorItemMappingsService: { forCurrentUser: vi.fn(async () => ({ upsert: mockUpsert })) },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ organizationId: 'org-test', userId: 'user-test', role: 'admin' })),
}));

const { mockSupabaseRef } = vi.hoisted(() => ({ mockSupabaseRef: { client: null as unknown } }));
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => mockSupabaseRef.client) }));

import { createItemsFromPoLinesAction } from './po-imports';

const PO_IMPORT_ID = '11111111-1111-1111-1111-111111111111';
const LINE_ID = '22222222-2222-2222-2222-222222222222';
const VENDOR_ID = '33333333-3333-3333-3333-333333333333';
const WAREHOUSE_ID = '44444444-4444-4444-4444-444444444444';
const CHARTER_ID = '55555555-5555-5555-5555-555555555555';
const LOCATION_ID = '66666666-6666-6666-6666-666666666666';

function baseLine(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    po_import_id: PO_IMPORT_ID,
    line_number: 1,
    line_type: 'inventory',
    description: 'Widget (ABC123)',
    qty_ordered_original: 2,
    uom_original: 'EA',
    unit_cost: 5,
    vendor_item_number: 'V1',
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
  /** Row the inventory_items lookup returns (use_existing check + book ISBN match). */
  inventoryItemRow?: { id: string } | null;
}): SupabaseStub {
  // Use presence checks, not ??, so an explicit `null` (charter not in org) is
  // honoured rather than silently replaced by the default row.
  const charterRow = 'charterRow' in opts ? opts.charterRow : { id: CHARTER_ID };
  const locationRow = 'locationRow' in opts ? opts.locationRow : { id: 'loc-1' };
  const inventoryItemRow = 'inventoryItemRow' in opts ? opts.inventoryItemRow : { id: 'existing-1' };
  const stub = makeSupabaseStub({
    'po_imports.select': { data: { id: PO_IMPORT_ID }, error: null }, // import-belongs-to-org guard
    'charters.select': { data: charterRow ?? null, error: null },
    'locations.select': { data: locationRow ?? null, error: null },
    'po_import_lines.select': { data: opts.lines ?? [baseLine()], error: null },
    'po_import_lines.update': { data: null, error: null },
    'inventory_items.select': { data: inventoryItemRow ?? null, error: null },
  });
  mockSupabaseRef.client = stub.client;
  return stub;
}

const ISBN13 = '9780306406157';

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue({ id: 'new-item-1' });
});

describe('createItemsFromPoLinesAction — charter + location + item_created (Fix #3 / #2)', () => {
  it('verifies the charter, tags the created item with it + the chosen location, and flags item_created', async () => {
    const stub = installStub({});

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      charterId: CHARTER_ID,
      locationId: LOCATION_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.created).toBe(1);

    // create() tagged with the verified charter + resolved primary location.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const createArg = (mockCreate.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(createArg.charterId).toBe(CHARTER_ID);
    expect(createArg.primaryLocationId).toBe('loc-1');
    expect(createArg.warehouseId).toBe(WAREHOUSE_ID);

    // The line was flagged item_created=true so a later cancel can clean it up.
    const updatePayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload?.item_created).toBe(true);
    expect(updatePayload?.item_id).toBe('new-item-1');
    expect(updatePayload?.match_status).toBe('mapped');
    // Defaults to a product when no itemType is supplied.
    expect(createArg.itemType).toBe('product');
  });

  it('creates books (item_type=book) when itemType: "book" is chosen for the import', async () => {
    // No ISBN on the line → no auto-match → straight create as a book.
    installStub({ lines: [baseLine({ vendor_item_number: 'V1' })], inventoryItemRow: null });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      itemType: 'book',
    });

    expect(result.ok).toBe(true);
    const createArg = (mockCreate.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(createArg.itemType).toBe('book');
  });

  it('book import: links a line to an existing book by ISBN (adds to its count, no duplicate)', async () => {
    // Line carries an ISBN-13; an existing book matches it → link, do not create.
    const stub = installStub({
      lines: [baseLine({ vendor_item_number: ISBN13 })],
      inventoryItemRow: { id: 'existing-book-1' },
    });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      itemType: 'book',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(0);
      expect(result.data.linked).toBe(1);
    }
    // No new item created — the PO line points at the existing book so receiving
    // tops up its count.
    expect(mockCreate).not.toHaveBeenCalled();
    const updatePayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload?.item_id).toBe('existing-book-1');
    // Must NOT be flagged item_created — it's a pre-existing book.
    expect(updatePayload?.item_created).toBe(false);
    // The book lookup was org-scoped and filtered to books, matching on barcode.
    const lookupArgs = (stub.chainArgsAll.get('inventory_items.select') ?? []).flat(Infinity);
    expect(lookupArgs).toContain('organization_id');
    expect(lookupArgs).toContain('item_type');
    expect(lookupArgs).toContain('book');
    expect(lookupArgs).toContain('barcode');
    // Both ISBN-10 and ISBN-13 forms were used as match candidates.
    expect(lookupArgs).toContain(ISBN13);
    expect(lookupArgs).toContain('0306406152');
  });

  it('book import: creates a new book with barcode=ISBN when no existing book matches', async () => {
    const stub = installStub({
      lines: [baseLine({ vendor_item_number: ISBN13 })],
      inventoryItemRow: null, // no existing book with that ISBN
    });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      itemType: 'book',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.created).toBe(1);
    const createArg = (mockCreate.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(createArg.itemType).toBe('book');
    // New book stores the ISBN as its barcode so the NEXT book PO matches it.
    expect(createArg.barcode).toBe(ISBN13);
    const updatePayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload?.item_created).toBe(true);
    void stub;
  });

  it('product import does NOT ISBN-match even if a vendor number looks like an ISBN', async () => {
    // itemType defaults to product → the book ISBN lookup is skipped entirely.
    installStub({ lines: [baseLine({ vendor_item_number: ISBN13 })] });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      // no itemType → 'product'
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.created).toBe(1); // created, not linked
    const createArg = (mockCreate.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(createArg.itemType).toBe('product');
  });

  it('drops a charter that does not belong to the org (tenant isolation) — never tags items with it', async () => {
    installStub({ charterRow: null }); // verification finds no matching charter in this org

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      charterId: CHARTER_ID, // spoofed / cross-tenant id
    });

    expect(result.ok).toBe(true);
    const createArg = (mockCreate.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(createArg.charterId).toBeNull();
  });

  it('fails closed (not_found) and creates nothing when the import is not in the active org', async () => {
    const stub = makeSupabaseStub({
      'po_imports.select': { data: null, error: null }, // guard: import not in this org
    });
    mockSupabaseRef.client = stub.client;

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(stub.chainsAll.get('po_import_lines.update')).toBeUndefined();
  });

  it('does not create or flag when the line decision is skip', async () => {
    const stub = installStub({});

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      decisions: { [LINE_ID]: { mode: 'skip' } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(0);
      expect(result.data.skipped).toBe(1);
    }
    expect(mockCreate).not.toHaveBeenCalled();
    expect(stub.chainsAll.get('po_import_lines.update')).toBeUndefined();
  });

  it('linking an existing item flags item_created=false (never auto-archived on cancel)', async () => {
    const stub = installStub({});

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      decisions: { [LINE_ID]: { mode: 'use_existing', itemId: '77777777-7777-7777-7777-777777777777' } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.linked).toBe(1);
    expect(mockCreate).not.toHaveBeenCalled();
    const updatePayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload?.item_created).toBe(false);
  });
});
