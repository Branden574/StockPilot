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
// (the gated twin — module + purchase_orders:manage), which constructs these two
// services with `new` and passes the withContext ctx. The behavior under test is
// unchanged (same shared createItemsFromPoLines implementation); only the mock
// seam moved from the static forCurrentUser to the constructor + withContext.
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
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => mockSupabaseRef.client) }));
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
  /**
   * Rows the inventory_items lookup returns. Used as an ARRAY for the
   * book ISBN candidate query AND, via the mock's maybeSingle (returns
   * the first element), for the use_existing check.
   */
  inventoryItems?: Array<Record<string, unknown>>;
}): SupabaseStub {
  // Use presence checks, not ??, so an explicit `null` (charter not in org) is
  // honoured rather than silently replaced by the default row.
  const charterRow = 'charterRow' in opts ? opts.charterRow : { id: CHARTER_ID };
  const locationRow = 'locationRow' in opts ? opts.locationRow : { id: 'loc-1' };
  const inventoryItems = 'inventoryItems' in opts ? (opts.inventoryItems ?? []) : [{ id: 'existing-1' }];
  const stub = makeSupabaseStub({
    'po_imports.select': { data: { id: PO_IMPORT_ID }, error: null }, // import-belongs-to-org guard
    'charters.select': { data: charterRow ?? null, error: null },
    'locations.select': { data: locationRow ?? null, error: null },
    'po_import_lines.select': { data: opts.lines ?? [baseLine()], error: null },
    'po_import_lines.update': { data: null, error: null },
    'inventory_items.select': { data: inventoryItems, error: null },
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
    // No existing item shares the line's vendor number as barcode — otherwise
    // the product barcode auto-link would (correctly) link instead of create.
    const stub = installStub({ inventoryItems: [] });

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

  it('marks every PO-created item awaitingFirstReceipt (mig 0277 — hidden as "Expected" until stock arrives)', async () => {
    installStub({ inventoryItems: [] });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
    });

    expect(result.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // The options bag is a SECOND argument, deliberately outside
    // CreateItemInput so form/API payloads can never set the flag.
    const [createInput, createOpts] = mockCreate.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(createOpts).toEqual({ awaitingFirstReceipt: true, source: 'import' });
    // And the item itself is born at zero stock, so the flag is valid.
    expect(createInput.quantityOnHand).toBe(0);
  });

  it('creates books (item_type=book) when itemType: "book" is chosen for the import', async () => {
    // No ISBN on the line → no auto-match → straight create as a book.
    installStub({ lines: [baseLine({ vendor_item_number: 'V1' })], inventoryItems: [] });

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

  it('book import: an ISBN match to an existing book is a SUGGESTION only — still creates a new book (matching is advisory, never auto-links)', async () => {
    // Line carries an ISBN-13 matching an existing book. Matching is advisory
    // only (see the charter-per-instance test suite) — this creates a NEW
    // book and records the existing one as suggested_item_id instead of
    // linking to it.
    const stub = installStub({
      lines: [baseLine({ vendor_item_number: ISBN13 })],
      inventoryItems: [{ id: 'existing-book-1', custom_fields: {} }],
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
      expect(result.data.created).toBe(1);
      expect(result.data.linked).toBe(0);
    }
    // A NEW book is created — the ISBN match never auto-links.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const updatePayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload?.item_id).toBe('new-item-1');
    expect(updatePayload?.item_id).not.toBe('existing-book-1');
    // Flagged item_created — WE created this item.
    expect(updatePayload?.item_created).toBe(true);
    // The existing book is recorded only as a suggestion for a human to review.
    expect(updatePayload?.suggested_item_id).toBe('existing-book-1');
    // The book lookup still ran org-scoped and filtered to books, matching on barcode.
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
      inventoryItems: [], // no existing book with that ISBN
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

  it('a same-ISBN book match is suggested regardless of rack — still creates a new book (advisory, never auto-linked)', async () => {
    // existing book with barcode = ISBN, on a rack; import line has the same ISBN, no rack.
    // Rack differences must not block the suggestion from being recorded, but
    // matching is advisory only, so this still creates a new book.
    const stub = installStub({
      lines: [baseLine({ vendor_item_number: ISBN13 })],
      inventoryItems: [
        { id: 'book-1', item_type: 'book', barcode: ISBN13, custom_fields: { book_rack_number: '41', book_rack_row: 'B' } },
      ],
    });
    const res = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      charterId: null,
      locationId: null,
      itemType: 'book',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // created, not linked — the ISBN match is advisory only
      expect(res.data.created).toBe(1);
      expect(res.data.linked).toBe(0);
    }
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const updatePayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload?.item_id).not.toBe('book-1');
    expect(updatePayload?.item_created).toBe(true);
    expect(updatePayload?.suggested_item_id).toBe('book-1');
  });

  it('product import does NOT ISBN-match even if a vendor number looks like an ISBN', async () => {
    // itemType defaults to product → the book ISBN lookup is skipped entirely.
    // The product barcode lookup DOES run, but matches nothing here — and it
    // must use the RAW vendor number only, never expanded ISBN variants.
    const stub = installStub({
      lines: [baseLine({ vendor_item_number: ISBN13 })],
      inventoryItems: [],
    });

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
    // The barcode lookup used the vendor number verbatim: no ISBN-10 variant
    // expansion, no book item_type filter.
    const lookupArgs = (stub.chainArgsAll.get('inventory_items.select') ?? []).flat(Infinity);
    expect(lookupArgs).toContain(ISBN13);
    expect(lookupArgs).not.toContain('0306406152');
    expect(lookupArgs).not.toContain('item_type');
  });

  // REWRITTEN 2026-07-22, not weakened. This asserted that a foreign charter
  // was silently DROPPED to null and the create proceeded. Tenant isolation was
  // preserved, but null on this field is not "unknown" — it is the explicit
  // "Generic" ownership instruction, so the silent drop quietly re-homed the
  // items the user was trying to place under a specific charter. That is the
  // silent substitution of an operational value the bill-to decoupling work
  // set out to eliminate. Refusing proves tenant isolation MORE strongly: the
  // foreign id never reaches an item, and the user is told their pick was
  // invalid instead of discovering Generic stock later.
  it('REFUSES a charter that does not belong to the org (tenant isolation) — never tags items with it, and never silently downgrades it to Generic', async () => {
    // charter verification finds no matching charter in this org.
    installStub({ charterRow: null, inventoryItems: [] });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      charterId: CHARTER_ID, // spoofed / cross-tenant id
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation_error');
    // The decisive assertion: no item was created at all, so the foreign
    // charter cannot have been written and nothing was re-homed to Generic.
    expect(mockCreate).not.toHaveBeenCalled();
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

describe('createItemsFromPoLinesAction — product barcode match (advisory suggestion, never auto-links)', () => {
  it('a product line whose barcode matches an existing item creates a NEW item; the match is only a suggestion', async () => {
    const stub = installStub({
      lines: [baseLine({ vendor_item_number: 'V1' })],
      inventoryItems: [{ id: 'existing-prod-1' }],
    });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      // no decision → mode 'create'; no itemType → 'product'
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(1);
      expect(result.data.linked).toBe(0);
    }
    // A NEW item is created — a barcode match never auto-links.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const updatePayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload?.item_id).not.toBe('existing-prod-1');
    expect(updatePayload?.match_status).toBe('mapped');
    // Flagged item_created — WE created this item.
    expect(updatePayload?.item_created).toBe(true);
    // The existing item is recorded only as a suggestion, never auto-linked.
    expect(updatePayload?.suggested_item_id).toBe('existing-prod-1');
    // The lookup was org-scoped, matched on barcode, and excluded deleted rows.
    const lookupArgs = (stub.chainArgsAll.get('inventory_items.select') ?? []).flat(Infinity);
    expect(lookupArgs).toContain('organization_id');
    expect(lookupArgs).toContain('barcode');
    expect(lookupArgs).toContain('V1');
    expect(lookupArgs).toContain('deleted_at');
  });

  it('matches on ANY of the vendor numbers (vendor_product_number / auxiliary_number too) — still only a suggestion', async () => {
    const stub = installStub({
      lines: [baseLine({ vendor_item_number: null, vendor_product_number: 'VP-9', auxiliary_number: 'AUX-3' })],
      inventoryItems: [{ id: 'existing-prod-2' }],
    });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.created).toBe(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const lookupArgs = (stub.chainArgsAll.get('inventory_items.select') ?? []).flat(Infinity);
    expect(lookupArgs).toContain('VP-9');
    expect(lookupArgs).toContain('AUX-3');
    const updatePayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload?.item_id).not.toBe('existing-prod-2');
    expect(updatePayload?.suggested_item_id).toBe('existing-prod-2');
  });

  it('creates as before when the line has NO vendor numbers (no lookup issued)', async () => {
    const stub = installStub({
      lines: [baseLine({ vendor_item_number: null, vendor_product_number: null, auxiliary_number: null })],
      inventoryItems: [{ id: 'existing-prod-1' }], // would match if (wrongly) queried
    });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(1);
      expect(result.data.linked).toBe(0);
    }
    expect(mockCreate).toHaveBeenCalledTimes(1);
    // No inventory_items lookup ran at all — nothing to match against.
    expect(stub.chainsAll.get('inventory_items.select')).toBeUndefined();
    const updatePayload = stub.chainArgs.get('po_import_lines.update')?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload?.item_created).toBe(true);
  });

  it('an explicit use_existing decision wins even when a different barcode candidate exists', async () => {
    // The barcode lookup is gated on mode==='create' — an explicit decision
    // must never be overridden by the auto-match.
    const stub = installStub({
      lines: [baseLine({ vendor_item_number: 'V1' })],
      inventoryItems: [{ id: 'chosen-item-1' }],
    });

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
    // Exactly ONE inventory_items query ran — the use_existing org check, not
    // the barcode auto-match (its chain ends in maybeSingle, not limit).
    const allChains = stub.chainsAll.get('inventory_items.select') ?? [];
    expect(allChains).toHaveLength(1);
    expect(allChains[0]).not.toContain('limit');
  });

  it('an explicit skip decision wins even when a barcode candidate exists', async () => {
    const stub = installStub({
      lines: [baseLine({ vendor_item_number: 'V1' })],
      inventoryItems: [{ id: 'existing-prod-1' }],
    });

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
      decisions: { [LINE_ID]: { mode: 'skip' } },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skipped).toBe(1);
      expect(result.data.linked).toBe(0);
    }
    expect(mockCreate).not.toHaveBeenCalled();
    expect(stub.chainsAll.get('inventory_items.select')).toBeUndefined();
    expect(stub.chainsAll.get('po_import_lines.update')).toBeUndefined();
  });

  it('falls through to CREATE (and logs) when the barcode lookup errors — creating is the designed fallback', async () => {
    // Same wiring as installStub, but the inventory_items lookup itself fails.
    mockSupabaseRef.client = makeSupabaseStub({
      'po_imports.select': { data: { id: PO_IMPORT_ID }, error: null },
      'charters.select': { data: { id: CHARTER_ID }, error: null },
      'locations.select': { data: { id: 'loc-1' }, error: null },
      'po_import_lines.select': { data: [baseLine({ vendor_item_number: 'V1' })], error: null },
      'po_import_lines.update': { data: null, error: null },
      'inventory_items.select': { data: null, error: { message: 'transient lookup failure' } },
    }).client;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await createItemsFromPoLinesAction({
      poImportId: PO_IMPORT_ID,
      lineIds: [LINE_ID],
      vendorId: VENDOR_ID,
      warehouseId: WAREHOUSE_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.created).toBe(1);
      expect(result.data.linked).toBe(0);
    }
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('barcode candidate lookup failed'),
      expect.objectContaining({ error: 'transient lookup failure' }),
    );
    errSpy.mockRestore();
  });
});
