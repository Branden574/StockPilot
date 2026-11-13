import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, servedLikePostgrest } from '@/test/supabase-mock';

/**
 * Docket S36 (review of #440): the app-written notices about an order go to
 * the order's stored requester id. 0422 stops the database's own notices to
 * someone who is no longer a member of the organization; these four paths
 * write through createNotification instead, and the 0028 trigger pushes every
 * row it writes. Each path runs here for real (createNotification is NOT
 * mocked; only the database is a stub), twice: with the requester still a
 * member (one notice, the control) and after they were removed or left (none).
 */

const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
// No email leaves: every requester here has no address, and the senders are stubs.
vi.mock('@/lib/email/resend', () => ({ sendEmail: vi.fn(async () => ({ sent: true })) }));
vi.mock('@/server/email/return-update', () => ({
  sendReturnUpdateEmail: vi.fn(async () => ({ sent: true })),
}));
vi.mock('@/server/lib/order-secrets', () => ({ resolveReturnToken: vi.fn(async () => 'tok-1') }));
// The line edits' own gates, as order-requests.edit-lines.test.ts stubs them.
vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));

import { reportError } from '@/lib/error-reporter';
import {
  notifyRequesterBackordered,
  notifyRequesterBackorderShipped,
} from '@/server/lib/order-handover-notify';

import { OrderRequestsService } from './order-requests';
import { notifyRequesterReturnEvent } from './returns-notify';

const ORG = 'org-1';
const REQUESTER = 'requester-1';
const APPROVER = 'approver-1';
const ACCEPTED_AT = '2026-01-05T00:00:00Z';
const APP_URL = 'https://app.example.com';

/** One order row carrying every column the four paths read. */
const ORDER = {
  id: 'order-1',
  organization_id: ORG,
  status: 'approved',
  warehouse_id: 'wh-1',
  requester_user_id: REQUESTER,
  pick_slip_generated_at: null,
  order_number: 12,
  source: 'internal',
  customer_id: null,
  requester_email: null,
  requester_name: null,
  requester_deleted_at: null,
};

function wire(requesterIsMember: boolean) {
  const member = (user_id: string) => ({
    organization_id: ORG,
    user_id,
    accepted_at: ACCEPTED_AT,
    impersonation_expires_at: null,
  });
  const stub = makeSupabaseStub({
    // createNotification's reads, then its insert.
    'user_profiles.select': { data: [{ disabled_at: null }], error: null },
    'organization_members.select': servedLikePostgrest([
      member(APPROVER),
      ...(requesterIsMember ? [member(REQUESTER)] : []),
    ]),
    'notifications.insert': { data: { id: 'notif-1' }, error: null },
    // The order, and the return path's preference read (nobody muted). Served
    // by its own filters: the return path reads it as a list in the order's
    // organization (returns-notify.ts readOrder, #454), the line edits as one row.
    'order_requests.select': servedLikePostgrest([ORDER]),
    // announceLineChange's updated_at touch (its answer is not read).
    'order_requests.update': { data: null, error: null },
    'notification_preferences.select': { data: [], error: null },
    // The line edits' reads and writes (order-requests.edit-lines.test.ts).
    'order_request_lines.select.maybeSingle': {
      data: {
        id: 'line-1',
        item_id: 'item-1',
        quantity_requested: 10,
        quantity_fulfilled: 0,
        quantity_picked: null,
        returned_quantity: 0,
      },
      error: null,
    },
    'order_request_lines.select': {
      data: [
        { id: 'line-1', item_id: 'item-1', quantity_requested: 10 },
        { id: 'line-2', item_id: 'item-2', quantity_requested: 5 },
      ],
      error: null,
    },
    'order_request_lines.update': { data: { id: 'line-1' }, error: null },
    'order_request_lines.delete': { data: { id: 'line-1' }, error: null },
    'stock_reservations.select': { data: [], error: null },
    'stock_reservations.update': { data: { id: 'res-1' }, error: null },
    'inventory_items.select': { data: { id: 'item-1', name: 'Widget' }, error: null },
  });
  adminHolder.client = stub.client;
  return stub;
}

/** The approver editing the requester's order. */
function asApprover(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      organizationId: ORG,
      role: 'admin',
      userId: APPROVER,
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

const PATHS: Array<{
  name: string;
  run: (stub: ReturnType<typeof makeSupabaseStub>) => Promise<unknown>;
}> = [
  {
    name: 'partial hand-over (notifyRequesterBackordered)',
    run: () =>
      notifyRequesterBackordered({
        organizationId: ORG,
        orderId: ORDER.id,
        requesterUserId: REQUESTER,
        requesterEmail: null,
        requesterName: null,
        appUrl: APP_URL,
        provided: 2,
        requested: 5,
        owed: 3,
        emailOptedOut: false,
        orderNumber: 'SO-000012',
        replacementForReturnId: null,
        orderSource: 'internal',
      }),
  },
  {
    name: 'backordered items shipped (notifyRequesterBackorderShipped)',
    run: () =>
      notifyRequesterBackorderShipped({
        organizationId: ORG,
        orderId: ORDER.id,
        requesterUserId: REQUESTER,
        requesterEmail: null,
        requesterName: null,
        appUrl: APP_URL,
        emailOptedOut: false,
        unitsShipped: 3,
        orderNumber: 'SO-000012',
        replacementForReturnId: null,
        orderSource: 'internal',
      }),
  },
  {
    name: 'a line quantity changed by someone else (announceLineChange)',
    run: (stub) => asApprover(stub).updateLineQuantity(ORDER.id, 'line-1', 4),
  },
  {
    name: 'a line removed by someone else (announceLineChange)',
    run: (stub) => asApprover(stub).removeLine(ORDER.id, 'line-1'),
  },
  {
    name: 'a return event on their order (notifyRequesterReturnEvent)',
    run: () =>
      notifyRequesterReturnEvent({
        organizationId: ORG,
        returnId: 'ret-1',
        returnNumber: 'RMA-20261101-TEST01',
        orderId: ORDER.id,
        event: 'approved',
        source: 'requester',
        channel: 'staff',
      }),
  },
];

/** The notices written, as [user_id, type]. */
function written(stub: ReturnType<typeof makeSupabaseStub>) {
  return (stub.chainArgsAll.get('notifications.insert') ?? []).map((args) => {
    const row = args[0]?.[0] as { user_id: string; type: string };
    return [row.user_id, row.type];
  });
}

beforeEach(() => vi.clearAllMocks());

describe.each(PATHS)('requester notice: $name', ({ run }) => {
  it('reaches the requester while they are a member of the organization', async () => {
    const stub = wire(true);
    await run(stub);
    const rows = written(stub);
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toBe(REQUESTER);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('writes nothing, so pushes nothing, once they were removed or left', async () => {
    const stub = wire(false);
    await run(stub);
    expect(written(stub)).toEqual([]);
    // Nothing failed on the way: the membership rule, not a broken read, is
    // why nothing was written.
    expect(reportError).not.toHaveBeenCalled();
  });
});
