import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// ═══════════════════════════════════════════════════════════════════════════
// THE PHONE'S ITEM-SCREEN ADJUSTMENT, THROUGH THE REAL SERVICE.
//
// route.test.ts spies on InventoryService.adjustStock and mocks the permission
// gate, which pins the route's own branches. This file does neither: the
// request runs through the real route, the real assertPermission (with the MFA
// gate in front of it) and the real InventoryService.adjustStock, down to the
// adjust_stock RPC call on a stub client. It pins what the phone relies on
// since the item screen stopped calling that RPC itself (2026-09-25):
//
//   • the body the phone sends, online or replayed from its outbox, is the
//     one the service writes (notes included);
//   • a -1 with no location draws in mode 'any' (the web's manual-removal
//     mode), a +1 lands on the item's rack, never in Staging;
//   • the stock:adjust permission and the MFA step-up are enforced before
//     anything is written, with the `details.reason` the phone keys its
//     "sign in again" copy on;
//   • the audit row is written.
// ═══════════════════════════════════════════════════════════════════════════

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetAt: Date.now() + 60_000 })),
}));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'staff',
  })),
}));
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({
    written: payloads.length,
    lost: 0,
  })),
}));

import { withApiContext } from '@/lib/auth/api-context';
import { revalidateInventoryList } from '@/server/loaders/inventory-list';
import { audit } from '@/server/services/audit';
import { InventoryService } from '@/server/services/inventory';

import { POST } from './route';

const ITEM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ITEM = {
  id: ITEM_ID,
  organization_id: 'org-test',
  warehouse_id: 'wh-a',
  status: 'active',
  quantity_on_hand: 4,
  reorder_point: 0,
  name: 'Polo S',
  sku: 'POLO-S',
};

/** The body the phone's outbox replays for a -1 queued with no connection
 *  (apps/mobile/src/lib/adjust-outbox.ts queuedAdjustPayload). */
const QUEUED_MINUS_ONE = {
  quantityChange: -1,
  movementType: 'remove',
  reason: 'Mobile detail',
  notes: 'Queued offline on the phone at 2026-09-25T17:02:03.000Z (phone clock).',
};

function stubFor(levels: unknown[] = []) {
  return makeSupabaseStub({
    'inventory_items.select': { data: ITEM, error: null },
    'item_stock_levels.select': { data: levels, error: null },
    'rpc:adjust_stock': { data: { ...ITEM, quantity_on_hand: 3 }, error: null },
  });
}

function asCaller(
  stub: ReturnType<typeof makeSupabaseStub>,
  overrides: Parameters<typeof makeServiceContext>[1] & { mfaEnrolled?: boolean } = {},
) {
  const { mfaEnrolled, ...rest } = overrides;
  vi.mocked(withApiContext).mockResolvedValue({
    ...makeServiceContext(stub.client, { role: 'staff', ...rest }),
    ...(mfaEnrolled === undefined ? {} : { mfaEnrolled }),
  } as never);
}

async function post(body: unknown) {
  const res = await POST(
    new NextRequest(`http://localhost/api/v1/items/${ITEM_ID}/adjust`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ITEM_ID }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/v1/items/[id]/adjust — the phone item screen, end to end through the service', () => {
  it("a queued -1 draws in mode 'any' at no location, keeps its notes, and answers the new total", async () => {
    const stub = stubFor();
    asCaller(stub);

    const { status, body } = await post(QUEUED_MINUS_ONE);

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, quantityOnHand: 3 });
    const rpc = stub.rpcCalls.filter((c) => c.name === 'adjust_stock');
    expect(rpc).toHaveLength(1);
    expect(rpc[0]!.args).toEqual({
      p_item_id: ITEM_ID,
      p_quantity_change: -1,
      p_movement_type: 'remove',
      p_location_id: null,
      p_reason: 'Mobile detail',
      p_notes: QUEUED_MINUS_ONE.notes,
      p_mode: 'any',
    });
    expect(revalidateInventoryList).toHaveBeenCalledWith('org-test');
  });

  it('writes the audit row the direct RPC call never wrote', async () => {
    const stub = stubFor();
    asCaller(stub);

    await post(QUEUED_MINUS_ONE);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'stock.removed',
        entityType: 'inventory_item',
        entityId: ITEM_ID,
        before: { quantity_on_hand: 4 },
        after: { quantity_on_hand: 3 },
        reason: 'Mobile detail',
      }),
      expect.anything(),
    );
  });

  it("a +1 lands on the item's rack, never in Staging, and passes no draw mode", async () => {
    const stub = stubFor([
      {
        location_id: 'loc-rack-17a',
        quantity: 4,
        locations: { kind: 'rack', type: null, deleted_at: null },
      },
    ]);
    asCaller(stub);

    const { status } = await post({ quantityChange: 1, movementType: 'add', reason: 'Mobile detail' });

    expect(status).toBe(200);
    const rpc = stub.rpcCalls.find((c) => c.name === 'adjust_stock');
    expect(rpc!.args).toMatchObject({ p_quantity_change: 1, p_location_id: 'loc-rack-17a' });
    expect(rpc!.args).not.toHaveProperty('p_mode');
  });

  it('a member whose stock:adjust was revoked is refused 403 before anything is written', async () => {
    const stub = stubFor();
    // A staffer with a 0207 override: the effective set lacks stock:adjust.
    asCaller(stub, { permissions: new Set(['items:read']) });

    const { status, body } = await post(QUEUED_MINUS_ONE);

    expect(status).toBe(403);
    expect(body).toEqual({ error: 'forbidden', message: 'Missing permission: stock:adjust' });
    expect(stub.rpcCalls).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
    expect(revalidateInventoryList).not.toHaveBeenCalled();
  });

  it('the service itself refuses without stock:adjust (the gate is not only the route’s)', async () => {
    const stub = stubFor();
    const svc = new InventoryService(
      makeServiceContext(stub.client, { role: 'staff', permissions: new Set(['items:read']) }),
    );

    await expect(
      svc.adjustStock({ itemId: ITEM_ID, quantityChange: -1, movementType: 'remove' }),
    ).rejects.toMatchObject({ code: 'forbidden', message: 'Missing permission: stock:adjust' });
    expect(stub.rpcCalls).toEqual([]);
  });

  it("an enrolled session at AAL1 gets 403 with details.reason 'aal2_required', and nothing is written", async () => {
    const stub = stubFor();
    asCaller(stub, { mfaRequired: true, mfaSatisfied: false, mfaEnrolled: true });

    const { status, body } = await post(QUEUED_MINUS_ONE);

    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
    expect(body.details).toEqual({ reason: 'aal2_required' });
    expect(typeof body.message).toBe('string');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a -1 the holdings cannot cover is a 400 with the holdings sentence, never a 500', async () => {
    const stub = makeSupabaseStub({
      'inventory_items.select': { data: ITEM, error: null },
      'item_stock_levels.select': { data: [], error: null },
      'rpc:adjust_stock': { data: null, error: { message: 'insufficient_placed_stock' } },
    });
    asCaller(stub);

    const { status, body } = await post(QUEUED_MINUS_ONE);

    expect(status).toBe(400);
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/stock by location does not cover/);
  });
});
