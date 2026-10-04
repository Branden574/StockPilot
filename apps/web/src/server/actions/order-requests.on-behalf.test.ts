import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ORDER_ON_BEHALF_NOT_PERMITTED_COPY, type ModuleId, type Role } from '@stockpilot/core';

import { withContext } from '@/server/services/context';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * Security slice D (migration 0390): ordering on someone else's behalf
 * follows the EFFECTIVE orders:approve permission, the rule the
 * order_requests_insert policy's on-behalf branch applies once the
 * manager-by-role term is gone. Before, the action asked for manager rank, so
 * a manager whose orders:approve was revoked passed the action and was then
 * refused by the database (42501 from inside create_order_request), and a
 * staff member granted it was refused by the action although the database
 * allowed it. The words are core's (shared with the phone's order flow).
 */

vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn(async () => undefined) }));
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

function arrange(role: Role, permissions?: string[]) {
  const stub = makeSupabaseStub({
    'inventory_items.select': {
      data: [{ id: ITEM, name: 'Backpack', warehouse_id: WH, unit_cost: 5, awaiting_first_receipt: false, is_rental: false, is_bundle: false }],
      error: null,
    },
    'rpc:create_order_request': {
      data: { id: 'order-1', order_number: 7, organization_id: 'org-1', warehouse_id: WH },
      error: null,
    },
  });
  vi.mocked(withContext).mockResolvedValue(
    makeServiceContext(stub.client, {
      role,
      userId: 'placer-1',
      enabledModules: new Set<ModuleId>(['orders']),
      ...(permissions ? { permissions: new Set(permissions) } : {}),
    }) as never,
  );
  return stub;
}

const onBehalf = {
  warehouseId: WH,
  fulfillmentType: 'pickup' as const,
  lines: [{ itemId: ITEM, quantity: 2 }],
  onBehalfOf: { name: 'Maria Lopez', email: 'maria@example.test' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(
    OrderRequestsService.prototype as unknown as { notifyEmail: () => Promise<void> },
    'notifyEmail',
  ).mockResolvedValue(undefined);
});

describe('createOrderRequestAction: on behalf of someone else follows orders:approve', () => {
  it('refuses a manager whose orders:approve was revoked, before any database call', async () => {
    const stub = arrange('manager', ['orders:request', 'orders:assign_delivery']);
    const res = await createOrderRequestAction(onBehalf);
    expect(res).toEqual({ ok: false, error: { code: 'forbidden', message: ORDER_ON_BEHALF_NOT_PERMITTED_COPY } });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('lets a staff member granted orders:approve order on someone else\'s behalf', async () => {
    const stub = arrange('staff', ['orders:request', 'orders:approve']);
    const res = await createOrderRequestAction(onBehalf);
    expect(res).toMatchObject({ ok: true, data: { id: 'order-1', orderNumber: 7 } });
    expect(stub.rpcCalls.map((c) => c.name)).toContain('create_order_request');
  });

  it('refuses staff without the grant, and lets a manager by role default through', async () => {
    const staff = arrange('staff');
    expect(await createOrderRequestAction(onBehalf)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(staff.rpcCalls).toHaveLength(0);

    const mgr = arrange('manager');
    expect(await createOrderRequestAction(onBehalf)).toMatchObject({ ok: true });
    expect(mgr.rpcCalls.map((c) => c.name)).toContain('create_order_request');
  });

  it('says who may do it in core\'s words, not "Only managers"', () => {
    expect(ORDER_ON_BEHALF_NOT_PERMITTED_COPY).toBe('Only someone who can approve orders can order for someone else.');
  });
});
