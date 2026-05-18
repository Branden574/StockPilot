// apps/web/src/server/services/inventory.duplicate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./context', () => ({
  withContext: vi.fn(),
  ServiceError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
  assertPermission: vi.fn(),
  assertPlanLimit: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
}));

import { InventoryService } from './inventory';

function makeCtx(rpcImpl: (name: string, args: Record<string, unknown>) => unknown, opts?: {
  existingSkus?: Set<string>;
  originalSku?: string;
}) {
  const existingSkus = opts?.existingSkus ?? new Set<string>();
  const originalSku = opts?.originalSku ?? 'SP-ABC';
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const data = await rpcImpl(name, args);
      return { data, error: null };
    }),
    from(table: string) {
      if (table === 'inventory_items') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { sku: originalSku }, error: null }),
                in: (_col: string, skus: string[]) => ({
                  then: (cb: (v: { data: Array<{ sku: string }>; error: null }) => void) =>
                    cb({
                      data: skus.filter((s) => existingSkus.has(s)).map((s) => ({ sku: s })),
                      error: null,
                    }),
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown;
  return {
    ctx: {
      supabase,
      organizationId: 'org-1',
      userId: 'user-1',
      role: 'admin',
    } as unknown as ConstructorParameters<typeof InventoryService>[0],
    rpcCalls,
  };
}

describe('InventoryService.duplicateItem', () => {
  beforeEach(() => vi.clearAllMocks());

  it('suffixes the SKU and calls duplicate_inventory_item RPC', async () => {
    const { ctx, rpcCalls } = makeCtx(async () => 'new-item-id', {
      existingSkus: new Set(),
      originalSku: 'SP-ABC',
    });
    const svc = new InventoryService(ctx);
    const newId = await svc.duplicateItem({
      originalId: '00000000-0000-0000-0000-000000000001',
      itemType: 'product',
      rackNumber: '38',
      rackRow: 'A',
      quantity: 5,
    });
    expect(newId).toBe('new-item-id');
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].name).toBe('duplicate_inventory_item');
    expect(rpcCalls[0].args.p_original_id).toBe('00000000-0000-0000-0000-000000000001');
    const overrides = rpcCalls[0].args.p_overrides as Record<string, unknown>;
    expect(overrides.sku).toBe('SP-ABC-2');
    expect(overrides.quantity).toBe(5);
    expect(overrides.rack_number).toBe('38');
    expect(overrides.rack_row).toBe('A');
    expect(overrides.bin_location).toBe('38-A');
  });

  it('bumps suffix past collisions until -99, then throws', async () => {
    // -2 and -3 are taken; -4 should be chosen.
    const { ctx, rpcCalls } = makeCtx(async () => 'new-id', {
      existingSkus: new Set(['SP-ABC-2', 'SP-ABC-3']),
      originalSku: 'SP-ABC',
    });
    const svc = new InventoryService(ctx);
    await svc.duplicateItem({
      originalId: '00000000-0000-0000-0000-000000000001',
      itemType: 'product',
      rackNumber: '38',
      rackRow: null,
      quantity: 0,
    });
    expect((rpcCalls[0].args.p_overrides as { sku: string }).sku).toBe('SP-ABC-4');
  });

  it('throws too_many_duplicates when -2..-99 are all taken', async () => {
    const all = new Set<string>();
    for (let i = 2; i <= 99; i += 1) all.add(`SP-ABC-${i}`);
    const { ctx } = makeCtx(async () => 'new-id', {
      existingSkus: all,
      originalSku: 'SP-ABC',
    });
    const svc = new InventoryService(ctx);
    await expect(
      svc.duplicateItem({
        originalId: '00000000-0000-0000-0000-000000000001',
        itemType: 'product',
        rackNumber: '38',
        rackRow: null,
        quantity: 0,
      }),
    ).rejects.toThrow(/too_many_duplicates|conflict/);
  });

  it('book branch sends crate fields and book_ bin label', async () => {
    const { ctx, rpcCalls } = makeCtx(async () => 'new-id', {
      existingSkus: new Set(),
      originalSku: 'BK-XYZ',
    });
    const svc = new InventoryService(ctx);
    await svc.duplicateItem({
      originalId: '00000000-0000-0000-0000-000000000002',
      itemType: 'book',
      rackNumber: '12',
      rackRow: 'C',
      crateColor: 'red',
      crateNumber: '4',
      quantity: 0,
    });
    const overrides = rpcCalls[0].args.p_overrides as Record<string, unknown>;
    expect(overrides.book_rack_number).toBe('12');
    expect(overrides.book_rack_row).toBe('C');
    expect(overrides.book_crate_color).toBe('red');
    expect(overrides.book_crate_number).toBe('4');
    expect(overrides.bin_location).toBe('12-C · red4');
  });
});
