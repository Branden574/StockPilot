import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_ON_BEHALF_NOT_PERMITTED_COPY, type ModuleId, type Role } from '@stockpilot/core';

import { withContext } from '@/server/services/context';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Security slice D (migration 0390): ordering on someone else's behalf
 * follows the EFFECTIVE orders:approve permission, the rule the
 * order_requests_insert policy's on-behalf branch applies once the
 * manager-by-role term is gone. Since phone ordering PO-2 (0391) the action
 * no longer asks first: place_order_request checks has_permission(orders:
 * approve) as a floor and RECORDS on_behalf_not_permitted under the key, so a
 * resend or a late original gets the same final answer. The words are core's
 * (shared with the phone's order flow).
 */

vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
vi.mock('@/server/services/audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/server/services/integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('next/cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/cache')>()),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));

import { OrderRequestsService } from '@/server/services/order-requests';

import { createOrderRequestAction } from './order-requests';

const WH = 'aaaaaaaa-0000-4000-8000-000000000001';
const ITEM = 'bbbbbbbb-0000-4000-8000-00000000000a';
const USER = 'eeeeeeee-0000-4000-8000-0000000000aa';
const ORDER = {
  id: 'ffffffff-0000-4000-8000-000000000001',
  order_number: 7,
  status: 'pending_approval',
  warehouse_id: WH,
  fulfillment_type: 'pickup',
  delivery_charter_id: null,
  needed_by: null,
  created_at: '2026-10-04T10:00:00+00:00',
  requester_user_id: null,
  requester_name: 'Maria Lopez',
  requester_email: 'maria@example.test',
  line_count: 1,
  unit_count: 2,
};

function arrange(role: Role, answer: unknown, permissions?: string[]) {
  const stub = makeSupabaseStub({ 'rpc:place_order_request': { data: answer, error: null } });
  vi.mocked(withContext).mockResolvedValue(
    makeServiceContext(stub.client, {
      role,
      userId: USER,
      enabledModules: new Set<ModuleId>(['orders']),
      ...(permissions ? { permissions: new Set(permissions) } : {}),
    }) as never,
  );
  return stub;
}

const onBehalf = {
  idempotencyKey: 'eeeeeeee-0000-4000-8000-000000000001',
  placerUserId: USER,
  warehouseId: WH,
  fulfillmentType: 'pickup' as const,
  deliveryCharterId: null,
  onBehalfOf: { name: 'Maria Lopez', email: 'maria@example.test' },
  notes: null,
  neededByLocal: null,
  lines: [{ itemId: ITEM, quantity: 2 }],
};
const REFUSED = { outcome: 'refused', replay: false, refusal: { reason: 'on_behalf_not_permitted', detail: null } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(
    OrderRequestsService.prototype as unknown as { notifyEmail: () => Promise<void> },
    'notifyEmail',
  ).mockResolvedValue(undefined);
});

describe('createOrderRequestAction: on behalf of someone else follows orders:approve', () => {
  it("a manager whose orders:approve was revoked: the database records on_behalf_not_permitted, answered final in core's words", async () => {
    const stub = arrange('manager', REFUSED, ['orders:request', 'orders:assign_delivery']);
    const res = await createOrderRequestAction(onBehalf, { organizationId: 'org-test' });
    expect(res).toEqual({
      ok: false,
      error: {
        code: 'forbidden',
        message: ORDER_ON_BEHALF_NOT_PERMITTED_COPY,
        details: { reason: 'on_behalf_not_permitted', settled: true, replay: false, organizationId: 'org-test' },
      },
    });
    // One call: the database decides (place_order_request step 7, pgTAP R5),
    // and records it under the key so a late original gets the same answer.
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['place_order_request']);
    expect((stub.rpcCalls[0]?.args as { p_request: Record<string, unknown> }).p_request).toMatchObject({
      on_behalf_name: 'Maria Lopez',
      on_behalf_email: 'maria@example.test',
    });
  });

  it("a staff member granted orders:approve places an order on someone else's behalf", async () => {
    arrange('staff', { outcome: 'placed', replay: false, order: ORDER }, ['orders:request', 'orders:approve']);
    const res = await createOrderRequestAction(onBehalf, { organizationId: 'org-test' });
    expect(res).toMatchObject({
      ok: true,
      data: {
        result: {
          replay: false,
          order: { id: ORDER.id, orderNumber: 7, requestedFor: { self: false, name: 'Maria Lopez', email: 'maria@example.test' } },
        },
      },
    });
  });

  it('plain staff are refused by the database too (no role-rank shortcut in the app)', async () => {
    const staff = arrange('staff', REFUSED);
    expect(await createOrderRequestAction(onBehalf, { organizationId: 'org-test' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden', details: { reason: 'on_behalf_not_permitted' } },
    });
    expect(staff.rpcCalls).toHaveLength(1);
  });

  it('says who may do it in core\'s words, not "Only managers"', () => {
    expect(ORDER_ON_BEHALF_NOT_PERMITTED_COPY).toBe('Only someone who can approve orders can order for someone else.');
  });
});
