import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SAGE 50 IMPORT: A FAILED ROW NEVER SHOWS THE ERROR'S TEXT (S31).
 *
 * The Sage 50 wizard showed each failed item's error text as it was ("First
 * errors: SKU: <message>"): Postgres text naming tables and columns, a
 * TypeError, and nothing was reported. A refusal the app wrote (a duplicate
 * SKU, a plan limit) keeps its words; anything else says the fixed sentence,
 * and the run sends one report.
 */

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: vi.fn((fn: unknown) => fn),
}));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryListForCurrentOrg: vi.fn(async () => {}),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'usr-1',
    enabledModules: new Set<string>(),
    permissions: new Set(['items:import']),
  })),
  assertPermission: vi.fn(),
}));
vi.mock('@/server/services/inventory', () => ({
  InventoryService: class {
    create = mockCreate;
  },
}));
vi.mock('@/server/services/suppliers', () => ({ SuppliersService: class {} }));

import { reportError } from '@/lib/error-reporter';
import { ServiceError } from '@/server/services/context';

import { importSage50Action } from './sage50-import';

const WAREHOUSE = '11111111-1111-4111-8111-111111111111';

function item(n: number) {
  return {
    name: `Item ${n}`,
    sku: `SKU-${n}`,
    barcode: null,
    description: null,
    unit_cost: 1,
    retail_price: 2,
    quantity_on_hand: 3,
    reorder_point: 0,
    reorder_quantity: 0,
    unit_of_measure: 'unit',
    inactive: false,
    vendorId: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("importSage50Action — a failed item never shows the error's text (S31)", () => {
  it('three unexpected failures: the fixed sentence on each, ONE report; a refusal keeps its words', async () => {
    const first = new Error(
      'duplicate key value violates unique constraint "inventory_items_org_sku_key"',
    );
    mockCreate.mockImplementation(async (input: { name: string }) => {
      switch (input.name) {
        case 'Item 1':
          throw first;
        case 'Item 2':
          throw new TypeError("Cannot read properties of undefined (reading 'id')");
        case 'Item 3':
          throw new Error('canceling statement due to statement timeout');
        case 'Item 4':
          throw new ServiceError('conflict', 'An item with that SKU already exists.');
        default:
          return { id: 'itm-1' };
      }
    });

    const res = await importSage50Action({
      warehouseId: WAREHOUSE,
      items: [1, 2, 3, 4, 5].map(item),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.items.created).toBe(1);
    expect(res.data.items.failed).toBe(4);
    expect(res.data.items.errors.map((e) => e.message)).toEqual([
      'Could not import this row.',
      'Could not import this row.',
      'Could not import this row.',
      'An item with that SKU already exists.',
    ]);
    expect(JSON.stringify(res)).not.toMatch(/inventory_items|statement timeout|undefined/);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(first, {
      tag: 'actions.sage50_import.rows',
      organizationId: 'org-1',
      extra: { failed: 3 },
    });
  });
});
