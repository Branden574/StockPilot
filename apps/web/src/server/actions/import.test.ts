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

const { mockCreate, mockWithContext, mockAssertPermission, mockListNames } = vi.hoisted(() => ({
  mockCreate: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'itm-1' })),
  mockWithContext: vi.fn(async () => ({ organizationId: 'org-1' })),
  mockAssertPermission: vi.fn(),
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

import { importItemsAction } from './import';

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
