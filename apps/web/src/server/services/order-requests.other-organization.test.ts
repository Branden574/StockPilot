// Security invariant (S39, listed in scripts/security-test.sh): a write named by
// a row id never runs on a row of another organization.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId, Role } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => 'notif-1') }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
// The service-role reads answer as PostgREST does for nobody: the current-member
// check's list reads (docket S36) find no row, so no own address is used.
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () =>
    makeSupabaseStub({
      'organization_members.select': { data: [], error: null },
      'user_profiles.select': { data: [], error: null },
    }).client,
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
vi.mock('@/server/lib/order-handover-notify', () => ({
  notifyRequesterBackordered: vi.fn(async () => undefined),
  notifyRequesterBackorderShipped: vi.fn(async () => undefined),
  sendPartialReceiptEmail: vi.fn(async () => undefined),
  fetchOrderLineItems: vi.fn(async () => []),
}));
vi.mock('@/server/email/return-prompt', () => ({ maybeSendReturnPrompt: vi.fn(async () => {}) }));
vi.mock('./lib/defer', () => ({ defer: vi.fn() }));

import { broadcastOrderChanged } from '@/lib/realtime/broadcast';
import {
  notifyRequesterBackordered,
  notifyRequesterBackorderShipped,
} from '@/server/lib/order-handover-notify';

import { audit } from './audit';
import { dispatchEvent } from './integration-events';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';
import { createNotification } from './notifications';
import { OrderRequestsService } from './order-requests';

/**
 * S39: an order of organization B, changed from a page left open while the
 * person works in organization A. cancel_order_request and
 * confirm_physical_signature decide on the ORDER's own organization, so for a
 * member of both the function ran in B while this service wrote the audit row,
 * the webhook, the notices and the cache invalidation into A. The order is now
 * read in A first, for every caller, and a miss refuses before anything runs.
 *
 * The stub answers reads like PostgREST (servedLikePostgrest): the order row
 * carries organization_id 'org-B', so a read filtered to 'org-A' finds nothing,
 * exactly as the real read would.
 */

const ORDER_ID = 'ord-b-1';
const PERSON = 'u-in-both';

const B_ORDER = {
  id: ORDER_ID,
  organization_id: 'org-B',
  status: 'pending_approval',
  requester_user_id: PERSON,
  replacement_for_return_id: null,
  warehouse_id: 'wh-b',
};

function stubFor(rpc: Record<string, { data: unknown; error: null }>) {
  return makeSupabaseStub({
    'order_requests.select': servedLikePostgrest([B_ORDER]),
    'order_request_lines.select': { data: [], error: null },
    ...rpc,
  });
}

const CANCELLED = {
  'rpc:cancel_order_request': {
    data: { ...B_ORDER, status: 'cancelled', order_number: 12 },
    error: null,
  },
};

const SIGNED = {
  'rpc:confirm_physical_signature': {
    data: {
      ...B_ORDER,
      status: 'completed',
      order_number: 12,
      requester_email: null,
      requester_name: null,
    },
    error: null,
  },
};

function svc(
  stub: ReturnType<typeof makeSupabaseStub>,
  opts: { org: string; role: Role; permissions?: ReadonlySet<string> },
) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      organizationId: opts.org,
      userId: PERSON,
      role: opts.role,
      enabledModules: new Set<ModuleId>(['orders']),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    }),
  );
}

/** The order read's filters: organization A and this order's id. */
function expectReadInA(stub: ReturnType<typeof makeSupabaseStub>) {
  const reads = stub.chainArgsAll.get('order_requests.select') ?? [];
  expect(reads.length).toBeGreaterThan(0);
  expect(reads[0]).toEqual(
    expect.arrayContaining([
      ['organization_id', 'org-A'],
      ['id', ORDER_ID],
    ]),
  );
}

/** Nothing ran and nothing was recorded anywhere. */
function expectNothingRan(stub: ReturnType<typeof makeSupabaseStub>) {
  expect(stub.rpcCalls).toHaveLength(0);
  expect(audit).not.toHaveBeenCalled();
  expect(dispatchEvent).not.toHaveBeenCalled();
  expect(invalidateInventoryListAfterWrite).not.toHaveBeenCalled();
  expect(stub.chains.get('delivery_locations.delete')).toBeUndefined();
}

beforeEach(() => vi.clearAllMocks());

describe('cancel: an order of another organization is not found, whoever asks', () => {
  it('a manager of A cancelling an order that is not in A', async () => {
    const stub = stubFor(CANCELLED);

    await expect(
      svc(stub, { org: 'org-A', role: 'manager' }).cancel(ORDER_ID, 'not needed'),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'Order request not found',
    });

    expectReadInA(stub);
    expectNothingRan(stub);
  });

  it('a staff member of A granted orders:approve', async () => {
    const stub = stubFor(CANCELLED);
    const approver = new Set(['orders:request', 'orders:approve']);

    await expect(
      svc(stub, { org: 'org-A', role: 'staff', permissions: approver }).cancel(ORDER_ID, null),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Order request not found' });

    expectReadInA(stub);
    expectNothingRan(stub);
  });

  it('the person who placed it, without orders:approve', async () => {
    const stub = stubFor(CANCELLED);

    await expect(
      svc(stub, { org: 'org-A', role: 'staff' }).cancel(ORDER_ID, null),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'Order request not found',
    });

    expectReadInA(stub);
    expectNothingRan(stub);
  });

  it('the same person working in B cancels it once, recorded in B', async () => {
    const stub = stubFor(CANCELLED);

    await svc(stub, { org: 'org-B', role: 'manager' }).cancel(ORDER_ID, 'not needed');

    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['cancel_order_request']);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'order_request.cancelled', entityId: ORDER_ID }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
    expect(dispatchEvent).toHaveBeenCalledWith(
      'org-B',
      'order.cancelled',
      expect.objectContaining({ id: ORDER_ID, orderNumber: 'SO-000012' }),
    );
    expect(invalidateInventoryListAfterWrite).toHaveBeenCalledWith('org-B', 'order.cancel');
  });
});

describe('confirmPhysicalSignature: an order of another organization is not found', () => {
  it('a manager of A recording a paper signature on an order that is not in A', async () => {
    const stub = stubFor(SIGNED);

    await expect(
      svc(stub, { org: 'org-A', role: 'manager' }).confirmPhysicalSignature(
        ORDER_ID,
        'Signer Example',
      ),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Order not found.' });

    expectReadInA(stub);
    expectNothingRan(stub);
    expect(createNotification).not.toHaveBeenCalled();
    expect(notifyRequesterBackordered).not.toHaveBeenCalled();
    expect(notifyRequesterBackorderShipped).not.toHaveBeenCalled();
    expect(broadcastOrderChanged).not.toHaveBeenCalled();
  });

  it('the same manager working in B records it, and it is announced in B', async () => {
    const stub = stubFor(SIGNED);

    await svc(stub, { org: 'org-B', role: 'manager' }).confirmPhysicalSignature(
      ORDER_ID,
      'Signer Example',
    );

    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['confirm_physical_signature']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: ORDER_ID }),
      expect.objectContaining({ organizationId: 'org-B' }),
    );
    expect(dispatchEvent).toHaveBeenCalledWith(
      'org-B',
      'order.completed',
      expect.objectContaining({ id: ORDER_ID }),
    );
    expect(broadcastOrderChanged).toHaveBeenCalledWith('org-B', ORDER_ID);
  });
});
