import { beforeEach, describe, expect, it, vi } from 'vitest';

// The action imports the inventory-list loader for cache invalidation, whose
// module graph builds unstable_cache wrappers at import time.
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => {}),
}));

const WAREHOUSE_A = '11111111-1111-4111-8111-111111111111';
const WAREHOUSE_B = '22222222-2222-4222-8222-222222222222';

const {
  mockCreate,
  mockWithContext,
  mockAssertPermission,
  mockListNames,
  mockFindLiveBatch,
  mockClaim,
  mockRecordOutcome,
  mockRelease,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'itm-1' })),
  // enabledModules carries 'sports' so the sports half of the mapping
  // vocabulary is live; the module gate is read from the CONTEXT, never from
  // the client's payload.
  mockWithContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'usr-1',
    enabledModules: new Set(['sports']),
  })),
  mockAssertPermission: vi.fn(),
  mockFindLiveBatch: vi.fn(async (_sha: string) => null as unknown),
  mockClaim: vi.fn(async (_input: Record<string, unknown>) => 'batch-1'),
  mockRecordOutcome: vi.fn(async () => {}),
  mockRelease: vi.fn(async () => {}),
  // The org's ACTIVE warehouses, as WarehousesService.listNames() returns them.
  // Two rows share a case-folded name on purpose: name lookup must refuse an
  // ambiguous match rather than pick one.
  mockListNames: vi.fn(async () => [
    { id: WAREHOUSE_A, name: 'Main Warehouse' },
    { id: WAREHOUSE_B, name: 'Demo Distribution Center' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Twin' },
    { id: '44444444-4444-4444-8444-444444444444', name: 'twin' },
  ]),
}));

vi.mock('@/server/services/context', async () => {
  const actual = await vi.importActual<typeof import('@/server/services/context')>(
    '@/server/services/context',
  );
  return {
    ...actual,
    withContext: mockWithContext,
    assertPermission: mockAssertPermission,
  };
});
vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    create = mockCreate;
  },
}));
vi.mock('@/server/services/warehouses', () => ({
  WarehousesService: class {
    listNames = mockListNames;
  },
}));
// The dedupe chassis is mocked at the SERVICE boundary, but `fingerprint` stays
// REAL — it is a pure function and the tests below assert what it hashes.
vi.mock('@/server/services/item-imports', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/server/services/item-imports')>();
  return {
    ItemImportBatchesService: class {
      static fingerprint = actual.ItemImportBatchesService.fingerprint;
      findLiveBatch = mockFindLiveBatch;
      claim = mockClaim;
      recordOutcome = mockRecordOutcome;
      release = mockRelease;
    },
  };
});

import { ItemImportBatchesService } from '@/server/services/item-imports';

import { importItemsAction, prepareItemImportAction } from './import';

function row(extra: Record<string, string> = {}) {
  return { name: 'Falcons Home Jersey', sku: 'FHJ-M', ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('importItemsAction — sports variant columns', () => {
  it('passes the variant columns through to item creation', async () => {
    const res = await importItemsAction({
      rows: [
        row({
          size: '10.5',
          size_system: 'US_MENS',
          width: '2E',
          fit: 'mens',
          color: 'Black/White',
          jersey_number: '07',
          player_name: 'A. Rosas',
        }),
      ],
    });

    expect(res.ok).toBe(true);
    const input = mockCreate.mock.calls[0]![0];
    expect(input.variantSize).toBe('10.5');
    expect(input.variantSizeSystem).toBe('US_MENS');
    expect(input.variantWidth).toBe('2E');
    expect(input.variantFit).toBe('mens');
    expect(input.variantColor).toBe('Black/White');
    expect(input.playerName).toBe('A. Rosas');
  });

  it('keeps a leading-zero jersey number as text (07 is not 7)', async () => {
    await importItemsAction({ rows: [row({ jersey_number: '07' })] });

    const input = mockCreate.mock.calls[0]![0];
    expect(input.jerseyNumber).toBe('07');
    expect(typeof input.jerseyNumber).toBe('string');
  });

  it('a plain non-sports row is unchanged — no variant values invented', async () => {
    const res = await importItemsAction({
      rows: [{ name: 'Wireless Mouse', sku: 'SP-MOUSE-001', quantity_on_hand: '5' }],
    });

    expect(res.ok).toBe(true);
    const input = mockCreate.mock.calls[0]![0];
    expect(input.name).toBe('Wireless Mouse');
    expect(input.quantityOnHand).toBe(5);
    for (const key of [
      'variantSize',
      'variantSizeSystem',
      'variantWidth',
      'variantFit',
      'variantColor',
      'jerseyNumber',
      'playerName',
    ]) {
      expect(input[key] ?? null).toBeNull();
    }
  });

  it('accepts a lower-case size_system but still refuses an unknown one', async () => {
    await importItemsAction({ rows: [row({ size: '10', size_system: 'us_mens' })] });
    expect(mockCreate.mock.calls[0]![0].variantSizeSystem).toBe('US_MENS');

    vi.clearAllMocks();
    const res = await importItemsAction({ rows: [row({ size_system: 'metric-ish' })] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.failed).toBe(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects a malformed jersey number instead of silently importing it', async () => {
    const res = await importItemsAction({ rows: [row({ jersey_number: '12A' })] });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.created).toBe(0);
      expect(res.data.failed).toBe(1);
    }
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

/**
 * LIVE-VERIFIED BLOCKER (Demo Co, 2026-07-28): every CSV row failed with
 * "A warehouse must be selected before creating an item.", 0 imported / 4
 * failed, twice — including a retry that filled `warehouse_name` with the exact
 * name the app itself offers.
 *
 * PROVENANCE: pre-existing, not a sports regression. `InventoryService.create()`
 * has demanded a warehouse since d4550449 (2026-05-04), and this action has
 * never passed one — `git show 09dfb52a:.../import.ts` calls `svc.create()` with
 * no `warehouseId` at all. The sports branch only added `warehouse_name` to the
 * row schema (b1b3fb5a), where it was validated and then ignored. So CSV item
 * import has been dead for every manager/admin since May; only a
 * warehouse-SCOPED user (staff/viewer), whose `forcedWarehouseId` supplies one
 * regardless of input, could ever have used it.
 *
 * The fix resolves a warehouse two ways, matching what the screen offers: the
 * import screen's destination picker for the file, and the template's own
 * `warehouse_name` column as a per-row override, resolved ORG-SCOPED by name.
 */
describe('importItemsAction — the destination warehouse', () => {
  it('PROBE: passes the screen-picked warehouse to every created item', async () => {
    const res = await importItemsAction({ rows: [row()], warehouseId: WAREHOUSE_A });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.created).toBe(1);
    expect(mockCreate.mock.calls[0]![0].warehouseId).toBe(WAREHOUSE_A);
  });

  it('a per-row warehouse_name resolves by name and beats the screen pick', async () => {
    await importItemsAction({
      rows: [row({ warehouse_name: 'Demo Distribution Center' })],
      warehouseId: WAREHOUSE_A,
    });

    expect(mockCreate.mock.calls[0]![0].warehouseId).toBe(WAREHOUSE_B);
  });

  it('matches the name case- and whitespace-insensitively', async () => {
    await importItemsAction({
      rows: [row({ warehouse_name: '  demo distribution center  ' })],
      warehouseId: WAREHOUSE_A,
    });

    expect(mockCreate.mock.calls[0]![0].warehouseId).toBe(WAREHOUSE_B);
  });

  it('fails only the row whose warehouse_name does not exist in this org', async () => {
    const res = await importItemsAction({
      rows: [row({ warehouse_name: 'Someone Elses Warehouse' }), row({ sku: 'OK-1' })],
      warehouseId: WAREHOUSE_A,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.created).toBe(1);
      expect(res.data.failed).toBe(1);
      expect(res.data.errors[0]!.row).toBe(2);
      expect(res.data.errors[0]!.message).toMatch(/Someone Elses Warehouse/);
    }
    // The good row still landed, and it landed on the screen's pick.
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]![0].warehouseId).toBe(WAREHOUSE_A);
  });

  it('refuses an ambiguous name rather than guessing between two warehouses', async () => {
    const res = await importItemsAction({
      rows: [row({ warehouse_name: 'Twin' })],
      warehouseId: WAREHOUSE_A,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.failed).toBe(1);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('reads the warehouse list ONCE for the whole file, not once per row', async () => {
    await importItemsAction({
      rows: [
        row({ warehouse_name: 'Demo Distribution Center' }),
        row({ sku: 'B', warehouse_name: 'Demo Distribution Center' }),
        row({ sku: 'C', warehouse_name: 'Demo Distribution Center' }),
      ],
      warehouseId: WAREHOUSE_A,
    });

    expect(mockListNames).toHaveBeenCalledTimes(1);
  });

  it('does not read the warehouse list at all when no row names one', async () => {
    await importItemsAction({ rows: [row(), row({ sku: 'B' })], warehouseId: WAREHOUSE_A });

    expect(mockListNames).not.toHaveBeenCalled();
  });

  it('still defers to the service when the screen sent nothing (scoped users)', async () => {
    // A warehouse-scoped user's forcedWarehouseId is applied inside create(),
    // so the action must pass undefined through rather than inventing an id.
    await importItemsAction({ rows: [row()] });

    expect(mockCreate.mock.calls[0]![0].warehouseId ?? null).toBeNull();
  });
});

/**
 * LIVE-VERIFIED FAIL (Demo Co, 2026-07-28, report line 10b): an extra column
 * headed `Number` — which "could be a jersey number, a quantity, a serial, a
 * style number" — was echoed in the header line and then SILENTLY IGNORED, with
 * "Import 4 items" enabled immediately. No mapping prompt, no disambiguation.
 *
 * Requirements: "Never silently guess: show candidate mappings + confidence,
 * require confirmation, preserve source values, block import until required
 * mappings resolved."
 *
 * The block lives on the SERVER, not only in the screen: a review step a client
 * can skip by posting straight to the action is not a block.
 */
describe('importItemsAction — ambiguous columns block the write', () => {
  it('PROBE: refuses the import while "Number" is unanswered, and writes nothing', async () => {
    const res = await importItemsAction({
      rows: [{ name: 'Falcons Jersey', Number: '07' }],
      headers: ['name', 'Number'],
      warehouseId: WAREHOUSE_A,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/Number/);
    expect(mockCreate).not.toHaveBeenCalled();
    // Nothing was fingerprinted either: a refused import is not an import.
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('applies the column to the field the human confirmed', async () => {
    const res = await importItemsAction({
      rows: [{ name: 'Falcons Jersey', Number: '07' }],
      headers: ['name', 'Number'],
      headerDecisions: { Number: 'jersey_number' },
      warehouseId: WAREHOUSE_A,
    });

    expect(res.ok).toBe(true);
    expect(mockCreate.mock.calls[0]![0].jerseyNumber).toBe('07');
  });

  it('sends the same column to quantity when that is what it meant', async () => {
    await importItemsAction({
      rows: [{ name: 'Falcons Jersey', Number: '12' }],
      headers: ['name', 'Number'],
      headerDecisions: { Number: 'quantity' },
      warehouseId: WAREHOUSE_A,
    });

    expect(mockCreate.mock.calls[0]![0].quantityOnHand).toBe(12);
    expect(mockCreate.mock.calls[0]![0].jerseyNumber ?? null).toBeNull();
  });

  it('"ignore" applies the column nowhere — the value is never invented into a field', async () => {
    await importItemsAction({
      rows: [{ name: 'Falcons Jersey', Number: '07' }],
      headers: ['name', 'Number'],
      headerDecisions: { Number: 'ignore' },
      warehouseId: WAREHOUSE_A,
    });

    const input = mockCreate.mock.calls[0]![0];
    expect(input.jerseyNumber ?? null).toBeNull();
    expect(input.quantityOnHand).toBe(0);
  });

  it('refuses an answer the header was never offered (a forged decision is no decision)', async () => {
    const res = await importItemsAction({
      rows: [{ name: 'Falcons Jersey', Number: '07' }],
      headers: ['name', 'Number'],
      // 'line_number' is a PO-document meaning, never offered on an items CSV.
      headerDecisions: { Number: 'line_number' },
      warehouseId: WAREHOUSE_A,
    });

    expect(res.ok).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('maps a spreadsheet alias without asking, because "Qty" is not ambiguous', async () => {
    const res = await importItemsAction({
      rows: [{ 'Item Name': 'Wireless Mouse', Qty: '5' }],
      headers: ['Item Name', 'Qty'],
      warehouseId: WAREHOUSE_A,
    });

    expect(res.ok).toBe(true);
    expect(mockCreate.mock.calls[0]![0].name).toBe('Wireless Mouse');
    expect(mockCreate.mock.calls[0]![0].quantityOnHand).toBe(5);
  });

  it('does not resolve a sports meaning for an org without the module', async () => {
    mockWithContext.mockResolvedValueOnce({
      organizationId: 'org-1',
      userId: 'usr-1',
      enabledModules: new Set<string>(),
    } as never);

    const res = await importItemsAction({
      rows: [{ name: 'J', Number: '07' }],
      headers: ['name', 'Number'],
      headerDecisions: { Number: 'jersey_number' },
      warehouseId: WAREHOUSE_A,
    });

    // 'jersey_number' is not among a non-sports org's candidates, so the header
    // is still unanswered and the import is still blocked — the module gate is
    // enforced server-side, not merely hidden in the UI.
    expect(res.ok).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

/**
 * LIVE-VERIFIED FAIL (report line 11): a byte-identical re-upload showed "no
 * duplicate warning, no supersede prompt, no 'already imported' notice" and
 * offered Import again. Migration 0304 + ItemImportBatchesService.
 */
describe('importItemsAction — same-file re-upload', () => {
  const DUP = {
    batchId: 'batch-0',
    fileName: 'verify-sports-import.csv',
    rowCount: 4,
    createdCount: 4,
    importedAt: '2026-07-28T10:00:00.000Z',
  };

  it('PROBE: warns and writes nothing when the same file is uploaded again', async () => {
    mockFindLiveBatch.mockResolvedValueOnce(DUP);

    const res = await importItemsAction({
      rows: [row()],
      warehouseId: WAREHOUSE_A,
      fileName: 'verify-sports-import.csv',
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('conflict');
      expect(res.error.message).toMatch(/already imported|imported before|same file/i);
    }
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('imports it once a human explicitly overrides, superseding the predecessor', async () => {
    mockFindLiveBatch.mockResolvedValueOnce(DUP);

    const res = await importItemsAction({
      rows: [row()],
      warehouseId: WAREHOUSE_A,
      fileName: 'verify-sports-import.csv',
      acknowledgeDuplicate: true,
    });

    expect(res.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockClaim.mock.calls[0]![0].supersedePredecessors).toBe(true);
  });

  it('does not supersede anything when the file is new', async () => {
    await importItemsAction({ rows: [row()], warehouseId: WAREHOUSE_A });

    expect(mockClaim.mock.calls[0]![0].supersedePredecessors).toBe(false);
  });

  it('fingerprints the file SERVER-side, and column order does not change it', () => {
    const a = ItemImportBatchesService.fingerprint([{ name: 'A', sku: 'S1' }]);
    const b = ItemImportBatchesService.fingerprint([{ sku: 'S1', name: 'A' }]);
    const c = ItemImportBatchesService.fingerprint([{ name: 'A', sku: 'S2' }]);

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('records what the batch actually did', async () => {
    await importItemsAction({
      rows: [row(), row({ name: '' })],
      warehouseId: WAREHOUSE_A,
    });

    expect(mockRecordOutcome).toHaveBeenCalledWith('batch-1', {
      createdCount: 1,
      failedCount: 1,
    });
  });

  it('releases a batch that created NOTHING, so a corrected re-upload is not blocked', async () => {
    mockCreate.mockRejectedValueOnce(new Error('A warehouse must be selected'));

    const res = await importItemsAction({ rows: [row()], warehouseId: WAREHOUSE_A });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.created).toBe(0);
    expect(mockRelease).toHaveBeenCalledWith('batch-1');
  });

  it('keeps the fingerprint of a batch that DID create something', async () => {
    await importItemsAction({ rows: [row()], warehouseId: WAREHOUSE_A });

    expect(mockRelease).not.toHaveBeenCalled();
  });
});

/**
 * The review step the screen renders. Server-derived, so the table cannot show
 * one thing and the write do another.
 */
describe('prepareItemImportAction — review before commit', () => {
  it('returns a per-row Result from the shared LineResult vocabulary', async () => {
    const res = await prepareItemImportAction({
      rows: [
        { name: 'Pegasus 41', brand: 'Nike', model: 'Pegasus 41', size: '10' },
        { sku: 'NO-NAME' },
      ],
      headers: ['name', 'brand', 'model', 'size', 'sku'],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.rows.map((r) => r.result)).toEqual([
      'add_new_variant',
      'missing_required_attribute',
    ]);
    // Group / Variant columns, which the live run found entirely absent.
    expect(res.data.rows[0]!.group).toBe('Nike Pegasus 41');
    expect(res.data.rows[0]!.variant).toBe('Size 10');
  });

  it('reports the ambiguous header with its candidate meanings', async () => {
    const res = await prepareItemImportAction({
      rows: [{ name: 'J', Number: '07' }],
      headers: ['name', 'Number'],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.unresolvedHeaders).toEqual(['Number']);
    const ambiguous = res.data.mappings.find((m) => m.header === 'Number');
    expect(ambiguous?.candidates).toContain('jersey_number');
    expect(ambiguous?.candidates).toContain('quantity');
    expect(ambiguous?.candidates).toContain('ignore');
  });

  it('surfaces the duplicate warning before anything is imported', async () => {
    mockFindLiveBatch.mockResolvedValueOnce({
      batchId: 'batch-0',
      fileName: 'items.csv',
      rowCount: 4,
      createdCount: 4,
      importedAt: '2026-07-28T10:00:00.000Z',
    });

    const res = await prepareItemImportAction({
      rows: [row()],
      headers: ['name', 'sku'],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.duplicate?.createdCount).toBe(4);
  });

  it('shows no group or variant to an org without the sports module', async () => {
    mockWithContext.mockResolvedValueOnce({
      organizationId: 'org-1',
      userId: 'usr-1',
      enabledModules: new Set<string>(),
    } as never);

    const res = await prepareItemImportAction({
      rows: [{ name: 'Pegasus 41', brand: 'Nike', size: '10' }],
      headers: ['name', 'brand', 'size'],
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.sportsEnabled).toBe(false);
    expect(res.data.rows[0]!.group).toBeNull();
    expect(res.data.rows[0]!.variant).toBeNull();
    expect(res.data.rows[0]!.result).toBe('ready');
  });

  it('never writes an item — preparing is a read', async () => {
    await prepareItemImportAction({ rows: [row()], headers: ['name', 'sku'] });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });
});
