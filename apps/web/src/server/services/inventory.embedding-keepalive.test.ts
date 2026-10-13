import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * An item's search data (its embedding) is written after the item itself, so a
 * slow embedding call never holds up a create or an edit. create() and update()
 * started it as a bare `void (async () => ...)()`, which held nothing once the
 * response was sent. They now hand it to keepAlive, the mechanism #352 added
 * for audit rows: it gives the running work to the platform's waitUntil, so the
 * response is not delayed and the work is not cut off if the instance is
 * suspended.
 *
 * Hardening, not the cause of the 12 Learn4Life items found without an
 * embedding on 2026-10-13: every item created through create() since
 * 2026-09-28 has one. Those 12 were size runs (bulkCreateSizedVariants), which
 * never embedded at all; the owner backfilled them from Settings > AI.
 */

const h = vi.hoisted(() => ({ kept: [] as Promise<unknown>[] }));

vi.mock('./lib/defer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/defer')>()),
  keepAlive: vi.fn((work: Promise<unknown>) => {
    h.kept.push(work);
  }),
}));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({ hasAllAccess: true, readableIds: [], writableIds: [] })),
  forcedWarehouseId: vi.fn(async () => null),
  assertWarehouseAccess: vi.fn(async () => undefined),
  ForbiddenError: class extends Error {},
}));
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));
// update() copies product-level fields to the SKU's other rack records with the
// server-key client (the edit fan-out); here it answers with no rows.
vi.mock('@/lib/supabase/admin', () => {
  const chain = () => {
    const p: Record<string, unknown> = {};
    for (const m of ['from', 'update', 'select', 'eq', 'neq', 'is', 'in']) p[m] = () => p;
    (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
      res({ data: [], error: null });
    return p;
  };
  return { createAdminClient: () => chain() };
});

import { embedInventoryItem } from '@/lib/ai/embeddings';

import { InventoryService } from './inventory';
import { keepAlive } from './lib/defer';

beforeEach(() => {
  vi.clearAllMocks();
  h.kept = [];
});

const CREATE = {
  name: 'Chromebook',
  unitCost: 0,
  retailPrice: 0,
  quantityOnHand: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
  trackingType: 'none' as const,
  itemType: 'product' as const,
  customFields: {},
  status: 'active' as const,
  expiryPolicy: 'warn' as const,
  warehouseId: 'wh-1',
};

const ITEM = {
  id: 'itm-1',
  organization_id: 'org-1',
  sku: 'OLD-SKU',
  barcode: null,
  name: 'Widget',
  warehouse_id: null,
  bin_location: null,
  charter_id: null,
  custom_fields: {},
  status: 'active',
  item_type: 'product',
  tracking_type: 'none',
  quantity_on_hand: 5,
};

/** update() reads the item (a SELECT), then writes it; every other table is empty. */
function updateCtx(updated: Record<string, unknown>) {
  const chain = (result: { data: unknown; error: unknown }) => {
    const p: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'eq', 'is', 'in', 'order', 'limit']) p[m] = () => p;
    p.single = async () => result;
    p.maybeSingle = async () => result;
    (p as { then: unknown }).then = (res: (v: unknown) => unknown) => res(result);
    return p;
  };
  const supabase = {
    from: (table: string) => {
      if (table !== 'inventory_items') return chain({ data: [], error: null });
      let isUpdate = false;
      const p: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit']) p[m] = () => p;
      p.update = () => {
        isUpdate = true;
        return p;
      };
      const answer = () =>
        isUpdate ? { data: updated, error: null } : { data: ITEM, error: null };
      p.single = async () => answer();
      p.maybeSingle = async () => answer();
      (p as { then: unknown }).then = (res: (v: unknown) => unknown) =>
        res(isUpdate ? { data: updated, error: null } : { data: [ITEM], error: null });
      return p;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return {
    organizationId: 'org-1',
    userId: 'u-1',
    role: 'admin',
    supabase,
    enabledModules: new Set<string>(),
  } as never;
}

describe("an item's search data is written without being cut off by the response", () => {
  it('a new item hands its embedding to keepAlive, and the embedding is for that item', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: null, error: null, count: 0 },
      'organizations.select': { data: { plan: 'enterprise' }, error: null },
      'custom_field_definitions.select': { data: [], error: null },
      'inventory_items.insert': { data: { id: 'itm-new', quantity_on_hand: 0 }, error: null },
      'item_stock_levels.select': { data: [], error: null },
    });
    const svc = new InventoryService(makeServiceContext(stub.client));

    await expect(svc.create({ ...CREATE })).resolves.toMatchObject({ id: 'itm-new' });

    expect(keepAlive).toHaveBeenCalledTimes(1);
    await Promise.all(h.kept);
    expect(embedInventoryItem).toHaveBeenCalledTimes(1);
    expect(vi.mocked(embedInventoryItem).mock.calls[0]?.[0]).toBe('itm-new');
  });

  it('an edit to a searched field hands the re-embedding to keepAlive', async () => {
    const svc = new InventoryService(updateCtx({ ...ITEM, name: 'Widget Pro' }));

    await svc.update('itm-1', { name: 'Widget Pro' });

    expect(keepAlive).toHaveBeenCalledTimes(1);
    await Promise.all(h.kept);
    expect(embedInventoryItem).toHaveBeenCalledTimes(1);
    expect(vi.mocked(embedInventoryItem).mock.calls[0]?.[0]).toBe('itm-1');
  });

  it('an edit to a field that search does not read embeds nothing', async () => {
    const svc = new InventoryService(updateCtx({ ...ITEM, reorder_point: 3 }));

    await svc.update('itm-1', { reorderPoint: 3 });

    expect(keepAlive).not.toHaveBeenCalled();
    expect(embedInventoryItem).not.toHaveBeenCalled();
  });

  it('no embedding in the service is fired and forgotten', () => {
    const code = readFileSync(resolve(__dirname, 'inventory.ts'), 'utf8');
    // Every place that embeds an item hands the work to keepAlive.
    const sites = code.split('embedInventoryItem(').length - 1;
    expect(sites).toBeGreaterThanOrEqual(2);
    expect(code).not.toMatch(/void \(async \(\) => \{[^}]*embedInventoryItem/);
  });
});
