import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withContext } from '@/server/services/context';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * "Add kit" on the New order page puts a bundle's items into the cart as
 * ordinary lines; the order is those lines and nothing else. Which kits were
 * used travels with the submit only for the order_request.created audit entry
 * (owner decision 8, 2026-09-27). This runs the REAL action and the REAL
 * OrderRequestsService.create against a Supabase stub.
 */

vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn(async () => undefined) }));
const { audit } = vi.hoisted(() => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/audit', () => ({ audit }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { OrderRequestsService } from '@/server/services/order-requests';

import { createOrderRequestAction } from './order-requests';

const WH = 'aaaaaaaa-0000-4000-8000-000000000001';
const BACKPACK = 'bbbbbbbb-0000-4000-8000-00000000000a';
const MUG = 'bbbbbbbb-0000-4000-8000-00000000000b';
const BUNDLE = 'dddddddd-0000-4000-8000-000000000001';

function arrange() {
  const stub = makeSupabaseStub({
    'inventory_items.select': {
      data: [BACKPACK, MUG].map((id) => ({
        id,
        name: id === BACKPACK ? 'Backpack' : 'Coffee mug',
        warehouse_id: WH,
        unit_cost: 5,
        awaiting_first_receipt: false,
        is_rental: false,
        is_bundle: false,
      })),
      error: null,
    },
    'rpc:create_order_request': {
      data: { id: 'order-1', order_number: 7, organization_id: 'org-1', warehouse_id: WH },
      error: null,
    },
  });
  vi.mocked(withContext).mockResolvedValue(
    makeServiceContext(stub.client, {
      role: 'viewer',
      userId: 'lillian',
      enabledModules: new Set<ModuleId>(['orders', 'bundles']),
    }) as never,
  );
  return stub;
}

const base = {
  warehouseId: WH,
  fulfillmentType: 'pickup' as const,
  lines: [
    { itemId: BACKPACK, quantity: 3 },
    { itemId: MUG, quantity: 3 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(
    OrderRequestsService.prototype as unknown as { notifyEmail: () => Promise<void> },
    'notifyEmail',
  ).mockResolvedValue(undefined);
});

describe('createOrderRequestAction: kits are recorded in the audit entry only', () => {
  it('writes the kits and their counts into order_request.created', async () => {
    const stub = arrange();
    const res = await createOrderRequestAction({ ...base, kits: [{ bundleId: BUNDLE, count: 3 }] });
    expect(res.ok).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'order_request.created',
        after: { lineCount: 2, warehouseId: WH, kits: [{ bundleId: BUNDLE, count: 3 }] },
      }),
      expect.anything(),
    );
    // The order itself is the item lines, exactly as a hand-built order.
    const call = stub.rpcCalls.find((c) => c.name === 'create_order_request');
    expect((call?.args as { p_lines: unknown }).p_lines).toEqual([
      { item_id: BACKPACK, quantity: 3, notes: null },
      { item_id: MUG, quantity: 3, notes: null },
    ]);
    expect(JSON.stringify(call?.args)).not.toContain(BUNDLE);
  });

  it('an order without kits (and an older page that sends none) records no kits key', async () => {
    arrange();
    await createOrderRequestAction(base);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ after: { lineCount: 2, warehouseId: WH } }),
      expect.anything(),
    );
    await createOrderRequestAction({ ...base, kits: [] });
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: { lineCount: 2, warehouseId: WH } }),
      expect.anything(),
    );
  });

  it('refuses a malformed kits list before anything is written', async () => {
    const stub = arrange();
    for (const kits of [
      [{ bundleId: 'not-a-uuid', count: 1 }],
      [{ bundleId: BUNDLE, count: 0 }],
      [{ bundleId: BUNDLE, count: 1.5 }],
    ]) {
      const res = await createOrderRequestAction({ ...base, kits });
      expect(res.ok).toBe(false);
    }
    expect(stub.rpcCalls.map((c) => c.name)).not.toContain('create_order_request');
  });
});
