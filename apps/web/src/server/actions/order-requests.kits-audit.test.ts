import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { withContext } from '@/server/services/context';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * "Add kit" on the New order page puts a bundle's items into the cart as
 * ordinary lines; the order is those lines and nothing else. Which kits were
 * used travels with the submit only for the order_request.created audit entry
 * (owner decision 8, 2026-09-27), beside the surface the order came from
 * (phone ordering PO-2). This runs the REAL action and the REAL
 * OrderRequestsService.create against a Supabase stub.
 */

vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
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

const USER = 'eeeeeeee-0000-4000-8000-0000000000aa';
const SUMMARY = {
  id: 'ffffffff-0000-4000-8000-000000000001',
  order_number: 7,
  status: 'pending_approval',
  warehouse_id: WH,
  fulfillment_type: 'pickup',
  delivery_charter_id: null,
  needed_by: null,
  created_at: '2026-10-04T10:00:00+00:00',
  requester_user_id: USER,
  requester_name: null,
  requester_email: null,
  line_count: 2,
  unit_count: 6,
};

function arrange() {
  const stub = makeSupabaseStub({
    'rpc:place_order_request': { data: { outcome: 'placed', replay: false, order: SUMMARY }, error: null },
  });
  vi.mocked(withContext).mockResolvedValue(
    makeServiceContext(stub.client, {
      role: 'viewer',
      userId: USER,
      enabledModules: new Set<ModuleId>(['orders', 'bundles']),
    }) as never,
  );
  return stub;
}

let keyN = 0;
function body(extra: Record<string, unknown> = {}) {
  keyN += 1;
  return {
    idempotencyKey: `eeeeeeee-0000-4000-8000-${String(keyN).padStart(12, '0')}`,
    placerUserId: USER,
    warehouseId: WH,
    fulfillmentType: 'pickup' as const,
    deliveryCharterId: null,
    onBehalfOf: null,
    notes: null,
    neededByLocal: null,
    lines: [
      { itemId: BACKPACK, quantity: 3 },
      { itemId: MUG, quantity: 3 },
    ],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(
    OrderRequestsService.prototype as unknown as { notifyEmail: () => Promise<void> },
    'notifyEmail',
  ).mockResolvedValue(undefined);
});

describe('createOrderRequestAction: kits are recorded in the audit entry only', () => {
  it('writes the kits and their counts into order_request.created (with the surface)', async () => {
    const stub = arrange();
    const res = await createOrderRequestAction(body({ kits: [{ bundleId: BUNDLE, count: 3 }] }));
    expect(res.ok).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'order_request.created',
        after: { lineCount: 2, warehouseId: WH, surface: 'web', kits: [{ bundleId: BUNDLE, count: 3 }] },
      }),
      expect.anything(),
    );
    // The order itself is the item lines, exactly as a hand-built order; the
    // kits never reach the database.
    const call = stub.rpcCalls.find((c) => c.name === 'place_order_request');
    expect((call?.args as { p_request: { lines: unknown } }).p_request.lines).toEqual([
      { item_id: BACKPACK, quantity: 3 },
      { item_id: MUG, quantity: 3 },
    ]);
    expect(JSON.stringify(call?.args)).not.toContain(BUNDLE);
  });

  it('an order without kits (and an older page that sends none) records no kits key', async () => {
    arrange();
    await createOrderRequestAction(body());
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ after: { lineCount: 2, warehouseId: WH, surface: 'web' } }),
      expect.anything(),
    );
    await createOrderRequestAction(body({ kits: [] }));
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: { lineCount: 2, warehouseId: WH, surface: 'web' } }),
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
      const res = await createOrderRequestAction(body({ kits }));
      expect(res).toMatchObject({ ok: false, error: { code: 'validation_error', details: { reason: 'invalid', field: 'kits' } } });
    }
    expect(stub.rpcCalls).toEqual([]);
  });
});
