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

const { mockCreate, mockWithContext, mockAssertPermission } = vi.hoisted(() => ({
  mockCreate: vi.fn(async (_input: Record<string, unknown>) => ({ id: 'itm-1' })),
  mockWithContext: vi.fn(async () => ({ organizationId: 'org-1' })),
  mockAssertPermission: vi.fn(),
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
