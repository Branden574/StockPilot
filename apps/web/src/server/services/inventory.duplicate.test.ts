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

function makeCtx(
  rpcImpl: (name: string, args: Record<string, unknown>) => unknown,
  opts?: { originalSku?: string; rpcError?: { code: string; message: string } | null },
) {
  const originalSku = opts?.originalSku ?? 'SP-ABC';
  const rpcError = opts?.rpcError ?? null;
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (rpcError) return { data: null, error: rpcError };
      const data = await rpcImpl(name, args);
      return { data, error: null };
    }),
    // Mock matches a single query shape used by duplicateItem:
    //   .from('inventory_items').select('sku').eq('organization_id').eq('id').maybeSingle()
    // The (org, sku, bin_location) constraint from migration 0126 means
    // we no longer need a collision-check round-trip — the RPC's insert
    // either succeeds or 23505s, and the service maps the latter to a
    // user-friendly ServiceError.
    from(table: string) {
      if (table !== 'inventory_items') {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { sku: originalSku }, error: null }),
            }),
          }),
        }),
      };
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

  it('passes the original SKU through and forwards rack overrides', async () => {
    const { ctx, rpcCalls } = makeCtx(async () => 'new-item-id', {
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
    const call = rpcCalls[0]!;
    expect(call.name).toBe('duplicate_inventory_item');
    expect(call.args.p_original_id).toBe('00000000-0000-0000-0000-000000000001');
    const overrides = call.args.p_overrides as Record<string, unknown>;
    expect(overrides.sku).toBe('SP-ABC');
    expect(overrides.quantity).toBe(5);
    expect(overrides.rack_number).toBe('38');
    expect(overrides.rack_row).toBe('A');
    expect(overrides.bin_location).toBe('38-A');
  });

  it('maps 23505 from the RPC to a friendly "already at this rack" error', async () => {
    const { ctx } = makeCtx(async () => null, {
      originalSku: 'SP-ABC',
      rpcError: { code: '23505', message: 'duplicate key' },
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
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  // Migration 0299. The RPC tells an ABSENT key (inherit) apart from a key
  // PRESENT WITH null (clear), so the service must not manufacture keys.
  it('omits every variant override the caller did not supply', async () => {
    const { ctx, rpcCalls } = makeCtx(async () => 'new-item-id');
    const svc = new InventoryService(ctx);
    await svc.duplicateItem({
      originalId: '00000000-0000-0000-0000-000000000001',
      itemType: 'product',
      rackNumber: '38',
      rackRow: 'A',
      quantity: 1,
    });
    const overrides = rpcCalls[0]!.args.p_overrides as Record<string, unknown>;
    for (const key of [
      'variant_size',
      'variant_size_original',
      'variant_size_system',
      'variant_width',
      'variant_fit',
      'variant_color',
      'jersey_number',
      'player_name',
      'variant_key',
    ]) {
      expect(Object.hasOwn(overrides, key)).toBe(false);
    }
  });

  it('forwards supplied variant overrides, and a null CLEARS rather than being dropped', async () => {
    const { ctx, rpcCalls } = makeCtx(async () => 'new-item-id');
    const svc = new InventoryService(ctx);
    await svc.duplicateItem({
      originalId: '00000000-0000-0000-0000-000000000001',
      itemType: 'product',
      rackNumber: '38',
      rackRow: 'A',
      quantity: 1,
      variantSize: '11',
      variantKey: 'size=11|system=US_MENS',
      jerseyNumber: null,
    });
    const overrides = rpcCalls[0]!.args.p_overrides as Record<string, unknown>;
    expect(overrides.variant_size).toBe('11');
    expect(overrides.variant_key).toBe('size=11|system=US_MENS');
    expect(Object.hasOwn(overrides, 'jersey_number')).toBe(true);
    expect(overrides.jersey_number).toBeNull();
    // Untouched neighbours must still be absent, not null.
    expect(Object.hasOwn(overrides, 'player_name')).toBe(false);
  });

  it('book branch sends crate fields and book_ bin label', async () => {
    const { ctx, rpcCalls } = makeCtx(async () => 'new-id', {
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
    const overrides = rpcCalls[0]!.args.p_overrides as Record<string, unknown>;
    expect(overrides.sku).toBe('BK-XYZ');
    expect(overrides.book_rack_number).toBe('12');
    expect(overrides.book_rack_row).toBe('C');
    expect(overrides.book_crate_color).toBe('red');
    expect(overrides.book_crate_number).toBe('4');
    expect(overrides.bin_location).toBe('12-C · red4');
  });
});
