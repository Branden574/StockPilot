// Security invariant (listed in scripts/security-test.sh): a warehouse must
// belong to the active organization. A new item (POST /api/v1/items and the
// dashboard's New item action) and an item moved to another warehouse name a
// warehouse of the active organization, or nothing is written: the route
// answers 403 with the words a member outside the warehouse gets. Runs the
// real InventoryService and the real assertWarehouseAccess over a stubbed
// client that answers like PostgREST.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import {
  makeServiceContext,
  makeSupabaseStub,
  servedLikePostgrest,
  type SupabaseStub,
} from '@/test/supabase-mock';

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => {
    throw new Error('requireOrgContext must not be reached');
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => {
    throw new Error('createClient must not be reached: the ctx carries its client');
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock('@/server/loaders/inventory-list', () => ({
  revalidateInventoryList: vi.fn(),
  revalidateInventoryListForCurrentOrg: vi.fn(async () => undefined),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({ written: payloads.length, lost: 0 })),
}));
vi.mock('@/lib/ai/embeddings', () => ({ embedInventoryItem: vi.fn(async () => undefined) }));

import { withApiContext } from '@/lib/auth/api-context';
import { checkRateLimit } from '@/lib/rate-limit';
import { createItemAction } from '@/server/actions/inventory';
import { InventoryService } from '@/server/services/inventory';

import { POST } from './route';

// Made-up ids only.
const ORG_A = '0000000a-0000-4000-8000-000000000000';
const ORG_B = '0000000b-0000-4000-8000-000000000000';
const WH_A1 = '0000000a-0000-4000-8000-0000000000a1';
const WH_A2 = '0000000a-0000-4000-8000-0000000000a2';
const WH_B1 = '0000000b-0000-4000-8000-0000000000b1';
const ITEM_A = '0000000a-0000-4000-8000-00000000f001';

/** What a member of both organizations' client can see. */
const WAREHOUSES = [
  { id: WH_A1, organization_id: ORG_A, name: 'A one', status: 'active' },
  { id: WH_A2, organization_id: ORG_A, name: 'A two', status: 'active' },
  { id: WH_B1, organization_id: ORG_B, name: 'B one', status: 'active' },
];

const BODY = {
  name: 'Example item',
  unitCost: 1,
  retailPrice: 2,
  quantityOnHand: 0,
  reorderPoint: 0,
  reorderQuantity: 0,
};

function buildStub(): SupabaseStub {
  return makeSupabaseStub({
    // Plan-limit head count + the org's plan (enterprise = unlimited).
    'inventory_items.select': { data: null, error: null, count: 0 },
    'organizations.select': { data: { plan: 'enterprise' }, error: null },
    'custom_field_definitions.select': { data: [], error: null },
    'inventory_items.insert': { data: { id: 'item-new' }, error: null },
    'stock_movements.insert': { data: null, error: null },
    'locations.select': { data: [], error: null },
    'warehouses.select': servedLikePostgrest(WAREHOUSES),
    'item_stock_levels.select': { data: [], error: null },
  });
}

function ctxFor(stub: SupabaseStub, role: 'owner' | 'admin' | 'manager' = 'admin') {
  return {
    ...makeServiceContext(stub.client, { organizationId: ORG_A, role }),
    enabledModules: new Set<ModuleId>(),
  };
}

function request(body: unknown) {
  return new Request('https://test.local/api/v1/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

/** Every write the service sent: table writes and database functions. */
function writes(stub: SupabaseStub): string[] {
  return [
    ...[...stub.chainsAll.keys()].filter((k) => !k.endsWith('.select')),
    ...stub.rpcCalls.map((c) => `rpc:${c.name}`),
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now() + 60_000,
  });
});

describe('POST /api/v1/items: the warehouse must belong to the active organization', () => {
  it.each(['owner', 'admin', 'manager'] as const)(
    'a %s naming a warehouse of another organization gets 403 and nothing is written',
    async (role) => {
      const stub = buildStub();
      vi.mocked(withApiContext).mockResolvedValue(ctxFor(stub, role) as never);

      const res = await POST(request({ ...BODY, warehouseId: WH_B1 }));

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'forbidden',
        message: `User does not have write access to warehouse ${WH_B1}.`,
      });
      expect(stub.chainsAll.has('inventory_items.insert')).toBe(false);
      expect(writes(stub)).toEqual([]);
    },
  );

  it('a warehouse of the active organization still creates the item (201)', async () => {
    const stub = buildStub();
    vi.mocked(withApiContext).mockResolvedValue(ctxFor(stub) as never);

    const res = await POST(request({ ...BODY, warehouseId: WH_A1 }));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'item-new' });
    const inserted = stub.chainArgs.get('inventory_items.insert')?.[0]?.[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({ organization_id: ORG_A, warehouse_id: WH_A1 });
  });
});

describe('createItemAction: the warehouse must belong to the active organization', () => {
  it('refuses a warehouse of another organization and writes nothing', async () => {
    const stub = buildStub();
    vi.spyOn(InventoryService, 'forCurrentUser').mockResolvedValue(
      new InventoryService(ctxFor(stub) as never),
    );

    const res = await createItemAction({ ...BODY, warehouseId: WH_B1 } as never);

    expect(res.ok).toBe(false);
    expect(stub.chainsAll.has('inventory_items.insert')).toBe(false);
    expect(writes(stub)).toEqual([]);
  });

  it('creates the item in a warehouse of the active organization', async () => {
    const stub = buildStub();
    vi.spyOn(InventoryService, 'forCurrentUser').mockResolvedValue(
      new InventoryService(ctxFor(stub) as never),
    );

    const res = await createItemAction({ ...BODY, warehouseId: WH_A1 } as never);

    expect(res).toEqual({ ok: true, data: { id: 'item-new' } });
    expect(stub.chainsAll.has('inventory_items.insert')).toBe(true);
  });
});

describe('InventoryService.update: a new warehouse must belong to the active organization', () => {
  function updateStub(): SupabaseStub {
    return makeSupabaseStub({
      'inventory_items.select': {
        data: {
          id: ITEM_A,
          organization_id: ORG_A,
          warehouse_id: WH_A1,
          charter_id: null,
          category_id: null,
          name: 'Example item',
          sku: 'EX-1',
          quantity_on_hand: 0,
          status: 'active',
          item_type: 'product',
          custom_fields: {},
          deleted_at: null,
        },
        error: null,
      },
      'warehouses.select': servedLikePostgrest(WAREHOUSES),
      'custom_field_definitions.select': { data: [], error: null },
      'inventory_items.update': { data: { id: ITEM_A }, error: null },
    });
  }

  it('moving an item to a warehouse of another organization is refused before any write', async () => {
    const stub = updateStub();
    const svc = new InventoryService(ctxFor(stub) as never);

    await expect(svc.update(ITEM_A, { warehouseId: WH_B1 })).rejects.toMatchObject({
      name: 'ForbiddenError',
      message: `User does not have write access to warehouse ${WH_B1}.`,
    });
    expect(writes(stub)).toEqual([]);
  });

  it('moving it to another warehouse of the active organization passes the warehouse check', async () => {
    const stub = updateStub();
    const svc = new InventoryService(ctxFor(stub) as never);

    await svc.update(ITEM_A, { warehouseId: WH_A2 }).catch(() => undefined);
    const update = stub.chainArgs.get('inventory_items.update')?.[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(update).toMatchObject({ warehouse_id: WH_A2 });
  });
});
