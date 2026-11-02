import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reportError } from '@/lib/error-reporter';
import { NOT_A_LIST } from '@/test/postgrest-answers';
import { makeSupabaseStub } from '@/test/supabase-mock';

const adminHolder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminHolder.client }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));
const createNotification = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "n-1"));
vi.mock('./notifications', () => ({ createNotification }));
const sendEmail = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ sent: true })));
vi.mock('@/server/email/return-update', () => ({ sendReturnUpdateEmail: sendEmail }));
const resolveReturnToken = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => "tok-uuid"));
vi.mock('@/server/lib/order-secrets', () => ({ resolveReturnToken }));

import {
  notifyRequesterReturnEvent,
  notifyStaffNewReturnRequest,
  requesterHearsEvent,
  resolveReturnStaffAudience,
  returnStaffLink,
} from './returns-notify';

const ORG = 'org-1';
const WH = 'wh-1';
const RMA = { organizationId: ORG, returnId: 'ret-1', returnNumber: 'RMA-20261005-ABC123', orderId: 'ord-1' };

function admin(results: Record<string, unknown>) {
  const stub = makeSupabaseStub(results as never);
  adminHolder.client = stub.client;
  return stub;
}

const MEMBERS = [
  { user_id: 'owner', role: 'owner' },
  { user_id: 'admin', role: 'admin' },
  { user_id: 'mgr', role: 'manager' },
  { user_id: 'mgr-revoked', role: 'manager' },
  { user_id: 'staff-granted', role: 'staff' },
  { user_id: 'staff-granted-elsewhere', role: 'staff' },
  { user_id: 'staff-plain', role: 'staff' },
  { user_id: 'viewer', role: 'viewer' },
  { user_id: 'actor', role: 'manager' },
  { user_id: 'muted', role: 'manager' },
];

beforeEach(() => vi.clearAllMocks());

describe('the staff audience (effective returns:manage, warehouse read, actor excluded, preference)', () => {
  it('picks the right people', async () => {
    admin({
      'organization_members.select': { data: MEMBERS, error: null },
      'role_permission_overrides.select': { data: [], error: null },
      'user_permission_overrides.select': {
        data: [
          { user_id: 'mgr-revoked', permission: 'returns:manage', granted: false },
          { user_id: 'staff-granted', permission: 'returns:manage', granted: true },
          { user_id: 'staff-granted-elsewhere', permission: 'returns:manage', granted: true },
        ],
        error: null,
      },
      'user_warehouse_assignments.select': {
        data: [
          { user_id: 'staff-granted', warehouse_id: WH },
          { user_id: 'staff-plain', warehouse_id: WH },
          { user_id: 'staff-granted-elsewhere', warehouse_id: 'wh-other' },
        ],
        error: null,
      },
      'notification_preferences.select': { data: [{ user_id: 'muted', push_return_requested: false }], error: null },
    });
    const ids = await resolveReturnStaffAudience({ organizationId: ORG, warehouseId: WH, actorUserId: 'actor' });
    expect(ids.sort()).toEqual(['admin', 'mgr', 'owner', 'staff-granted'].sort());
  });

  it('never throws: a failed read is reported and nobody is notified', async () => {
    admin({ 'organization_members.select': { data: null, error: { message: 'boom' } } });
    await expect(resolveReturnStaffAudience({ organizationId: ORG, warehouseId: WH, actorUserId: null })).resolves.toEqual([]);
  });

  /**
   * docket S27: an answer with no error that is not a list (postgrest-js
   * resolves an empty body with data null) was read as "no rows". The role
   * override read so answered dropped the organization's revoke, and a manager
   * whose returns:manage it took away was told; the member read so answered
   * told nobody, silently; the assignments read so answered dropped every
   * assigned staff member, silently, while the managers were still told. Each
   * is a failed read: nobody is told and it is reported, naming the table.
   */
  describe('an answer that is not a list is a failed read', () => {
    const MANAGERS = [
      { user_id: 'mgr', role: 'manager' },
      { user_id: 'staff-granted', role: 'staff' },
    ];
    const listed = (data: unknown) => ({ data, error: null, status: 200 });
    function reads(odd: string, answer: unknown) {
      admin({
        'organization_members.select': listed(MANAGERS),
        'role_permission_overrides.select': listed([]),
        'user_permission_overrides.select': listed([
          { user_id: 'staff-granted', permission: 'returns:manage', granted: true },
        ]),
        'user_warehouse_assignments.select': listed([
          { user_id: 'staff-granted', warehouse_id: WH },
        ]),
        'notification_preferences.select': listed([]),
        [odd]: answer,
      });
    }
    async function expectNobodyAndOneReport(table: string, status: number) {
      const ids = await resolveReturnStaffAudience({
        organizationId: ORG,
        warehouseId: WH,
        actorUserId: null,
      });
      expect(ids).toEqual([]);
      expect(reportError).toHaveBeenCalledTimes(1);
      const [err, context] = vi.mocked(reportError).mock.calls[0]!;
      expect((err as Error).message).toBe(`${table} answered no list (status ${status})`);
      expect(context).toEqual({
        tag: 'returns_notify.resolve_audience',
        extra: { organizationId: ORG },
      });
    }

    it('with every read a list, the manager and the granted staff member are told (unchanged)', async () => {
      reads('role_permission_overrides.select', listed([]));
      const ids = await resolveReturnStaffAudience({
        organizationId: ORG,
        warehouseId: WH,
        actorUserId: null,
      });
      expect(ids.sort()).toEqual(['mgr', 'staff-granted']);
      // A role override that takes returns:manage from managers stops the manager.
      reads(
        'role_permission_overrides.select',
        listed([{ role: 'manager', permission: 'returns:manage', granted: false }]),
      );
      expect(
        await resolveReturnStaffAudience({
          organizationId: ORG,
          warehouseId: WH,
          actorUserId: null,
        }),
      ).toEqual(['staff-granted']);
      expect(reportError).not.toHaveBeenCalled();
      // Read the same way, an empty body hid that override and told the manager.
      reads('role_permission_overrides.select', NOT_A_LIST[0][1]);
      await expectNobodyAndOneReport('role_permission_overrides', 200);
    });

    it.each(NOT_A_LIST)(
      '%s from the role override read tells nobody and is reported',
      async (_shape, answer) => {
        reads('role_permission_overrides.select', answer);
        await expectNobodyAndOneReport('role_permission_overrides', answer.status);
      },
    );

    it.each(NOT_A_LIST)(
      '%s from the member override read tells nobody and is reported',
      async (_shape, answer) => {
        reads('user_permission_overrides.select', answer);
        await expectNobodyAndOneReport('user_permission_overrides', answer.status);
      },
    );

    it.each(NOT_A_LIST)(
      '%s from the member read tells nobody and is reported, never silently',
      async (_shape, answer) => {
        reads('organization_members.select', answer);
        await expectNobodyAndOneReport('organization_members', answer.status);
      },
    );

    it.each(NOT_A_LIST)(
      '%s from the assignments read is a refusal, not a quiet drop of the assigned staff',
      async (_shape, answer) => {
        reads('user_warehouse_assignments.select', answer);
        await expectNobodyAndOneReport('user_warehouse_assignments', answer.status);
      },
    );
  });
});

describe('notifyStaffNewReturnRequest', () => {
  it('sends "New return request" with the requester, RMA and SO, on the dual link (C-3)', async () => {
    admin({
      'order_requests.select': {
        data: [{ warehouse_id: WH, order_number: 103, requester_name: 'Pat Lee', requester_email: 'pat@example.com' }],
        error: null,
      },
      'organization_members.select': { data: [{ user_id: 'mgr', role: 'manager' }], error: null },
      'role_permission_overrides.select': { data: [], error: null },
      'user_permission_overrides.select': { data: [], error: null },
      'user_warehouse_assignments.select': { data: [], error: null },
      'notification_preferences.select': { data: [], error: null },
    });
    await notifyStaffNewReturnRequest({ ...RMA, actorUserId: null });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: 'mgr',
      type: 'return.requested',
      title: 'New return request',
      body: 'Pat Lee · RMA-20261005-ABC123 · SO-000103',
      link: '/dashboard/returns/ret-1?order=/dashboard/orders/ord-1',
      metadata: { return_id: 'ret-1', order_request_id: 'ord-1', return_number: 'RMA-20261005-ABC123' },
    });
  });

  it('the dual link opens the RMA on new bundles and embeds the original order path for old ones', () => {
    expect(returnStaffLink('r', 'o')).toBe('/dashboard/returns/r?order=/dashboard/orders/o');
  });
});

describe('the requester messages', () => {
  it('only requester-sourced RMAs, and no approval or receipt message for a counter exchange', () => {
    expect(requesterHearsEvent('approved', { source: 'internal' })).toBe(false);
    expect(requesterHearsEvent('approved', { source: 'requester', channel: 'counter' })).toBe(false);
    expect(requesterHearsEvent('received', { source: 'requester', channel: 'counter' })).toBe(false);
    expect(requesterHearsEvent('approved', { source: 'requester', channel: 'staff' })).toBe(true);
    expect(requesterHearsEvent('denied', { source: 'requester' })).toBe(true);
  });

  it('a member requester hears in the app, linked to their order, under their order-status preference', async () => {
    admin({
      'order_requests.select': {
        data: [{ source: 'internal', customer_id: null, requester_user_id: 'req-1', requester_email: 'r@example.com', requester_name: 'R', order_number: 103 }],
        error: null,
      },
      'notification_preferences.select': { data: [], error: null },
    });
    await notifyRequesterReturnEvent({ ...RMA, event: 'approved', source: 'requester', channel: 'staff' });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'req-1', type: 'return.approved', title: 'Your return was approved.', link: '/dashboard/orders/ord-1' }),
    );
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a member who muted order-status messages hears nothing', async () => {
    admin({
      'order_requests.select': {
        data: [{ source: 'internal', customer_id: null, requester_user_id: 'req-1', requester_email: null, requester_name: null, order_number: 1 }],
        error: null,
      },
      'notification_preferences.select': { data: [{ user_id: 'req-1', email_order_status_changed: false }], error: null },
    });
    await notifyRequesterReturnEvent({ ...RMA, event: 'denied', source: 'requester' });
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('an email-only requester gets one email linking their return page (the side-table token)', async () => {
    admin({
      'order_requests.select': {
        data: [{ source: 'internal', customer_id: null, requester_user_id: null, requester_email: 'pat@example.com', requester_name: 'Pat', order_number: 103 }],
        error: null,
      },
    });
    await notifyRequesterReturnEvent({ ...RMA, event: 'request_received', source: 'requester', channel: 'token' });
    expect(resolveReturnToken).toHaveBeenCalledWith(expect.anything(), 'ord-1');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [, args] = sendEmail.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(args).toMatchObject({
      event: 'request_received',
      to: 'pat@example.com',
      isAccountHolder: false,
      returnNumber: 'RMA-20261005-ABC123',
      orderNumber: 'SO-000103',
    });
    expect(String(args.viewUrl)).toMatch(/\/returns\/request\/tok-uuid$/);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('a B2B portal requester gets an email pointing at the portal, never an in-app row', async () => {
    admin({
      'order_requests.select': {
        data: [{ source: 'portal', customer_id: 'c-1', requester_user_id: 'portal-user', requester_email: 'buyer@c.example.com', requester_name: 'B', order_number: 7 }],
        error: null,
      },
    });
    await notifyRequesterReturnEvent({ ...RMA, event: 'cancelled', source: 'requester' });
    expect(createNotification).not.toHaveBeenCalled();
    expect(resolveReturnToken).not.toHaveBeenCalled();
    const [, args] = sendEmail.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(args).toMatchObject({ event: 'cancelled', isAccountHolder: true });
    expect(String(args.viewUrl)).toMatch(/\/portal$/);
  });

  it('a requester who deleted their account hears nothing, not even at the address the order kept (A3, 0393)', async () => {
    const stub = admin({
      'order_requests.select': {
        data: [{ source: 'internal', customer_id: null, requester_user_id: null, requester_email: 'kept@example.com', requester_name: 'Kept', requester_deleted_at: '2026-10-04T00:00:00Z', order_number: 103 }],
        error: null,
      },
    });
    for (const event of ['request_received', 'approved', 'received', 'denied', 'cancelled'] as const) {
      await notifyRequesterReturnEvent({ ...RMA, event, source: 'requester', channel: 'token' });
    }
    expect(sendEmail).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(resolveReturnToken).not.toHaveBeenCalled();
    expect(String(stub.chainArgs.get('order_requests.select')?.[0]?.[0] ?? '')).toContain('requester_deleted_at');
  });

  it('a staff-created return tells the requester nothing', async () => {
    admin({});
    await notifyRequesterReturnEvent({ ...RMA, event: 'approved', source: 'internal' });
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('the exchange messages (returns RX-2, plan 3.6.8)', () => {
  it('a counter exchange approval is silent; changes and cancels reach the requester of a requester-sourced RMA', () => {
    expect(requesterHearsEvent('exchange_approved', { source: 'requester', channel: 'counter' })).toBe(false);
    expect(requesterHearsEvent('exchange_approved_short', { source: 'requester', channel: 'counter' })).toBe(false);
    expect(requesterHearsEvent('exchange_approved', { source: 'requester', channel: 'staff' })).toBe(true);
    expect(requesterHearsEvent('replacement_changed', { source: 'requester' })).toBe(true);
    expect(requesterHearsEvent('replacement_cancelled', { source: 'requester' })).toBe(true);
    expect(requesterHearsEvent('replacement_changed', { source: 'internal' })).toBe(false);
    // RX-2 review fix P28: the staff-added approval is silent at the counter too.
    expect(requesterHearsEvent('return_approved_replacement_added', { source: 'requester', channel: 'counter' })).toBe(false);
    expect(requesterHearsEvent('return_approved_replacement_added_short', { source: 'requester', channel: 'counter' })).toBe(false);
    expect(requesterHearsEvent('return_approved_replacement_added', { source: 'requester', channel: 'staff' })).toBe(true);
  });

  it('a member hears "replacement reserved" linked to the replacement order', async () => {
    admin({
      'order_requests.select': {
        data: [{ source: 'internal', customer_id: null, requester_user_id: 'req-1', requester_email: null, requester_name: 'R', order_number: 103 }],
        error: null,
      },
      'notification_preferences.select': { data: [], error: null },
    });
    await notifyRequesterReturnEvent({ ...RMA, event: 'exchange_approved', source: 'requester', channel: 'staff', linkOrderId: 'repl-1' });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'return.exchange_approved',
        // Re-pinned by returns RX-2 review fix (P14): core's words now say to
        // bring or send the returned item back. The claim stands: a member
        // hears that the replacement is reserved, linked to it.
        title:
          'Your replacement is reserved. Bring or send the returned item back as arranged with the warehouse; the replacement is prepared once it arrives.',
        link: '/dashboard/orders/repl-1',
        metadata: expect.objectContaining({ order_request_id: 'repl-1', return_id: 'ret-1' }),
      }),
    );
  });

  // RX-2 review fix P15: Close as return only after a replacement cancel.
  it('a member hears that no replacement will be sent; only a requester-sourced RMA', async () => {
    expect(requesterHearsEvent('replacement_closed_return_only', { source: 'requester' })).toBe(true);
    expect(requesterHearsEvent('replacement_closed_return_only', { source: 'internal' })).toBe(false);
    admin({
      'order_requests.select': {
        data: [{ source: 'internal', customer_id: null, requester_user_id: 'req-1', requester_email: null, requester_name: 'R', order_number: 103 }],
        error: null,
      },
      'notification_preferences.select': { data: [], error: null },
    });
    await notifyRequesterReturnEvent({ ...RMA, event: 'replacement_closed_return_only', source: 'requester' });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'return.replacement_closed_return_only',
        title: 'No replacement will be sent. Your return goes on as a return only.',
      }),
    );
  });

  it('an email-only requester gets the reworded email on their RMA page, never a reason', async () => {
    admin({
      'order_requests.select': {
        data: [{ source: 'internal', customer_id: null, requester_user_id: null, requester_email: 'pat@example.com', requester_name: 'Pat', order_number: 103 }],
        error: null,
      },
    });
    await notifyRequesterReturnEvent({ ...RMA, event: 'replacement_cancelled', source: 'requester' });
    const [, args] = sendEmail.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(args).toMatchObject({ event: 'replacement_cancelled', to: 'pat@example.com' });
    expect(String(args.viewUrl)).toMatch(/\/returns\/request\/tok-uuid$/);
    expect(Object.keys(args)).not.toContain('reason');
  });
});

// Returns RX-3: the requester's own exchange request, and an approval that
// declined every exchange line they asked for.
describe("the requester's exchange messages (returns RX-3)", () => {
  it('an exchange request is received in its own words; a member hears it in the app on their order', async () => {
    admin({
      'order_requests.select': {
        data: [{ source: 'internal', customer_id: null, requester_user_id: 'req-1', requester_email: null, requester_name: 'R', order_number: 103 }],
        error: null,
      },
      'notification_preferences.select': { data: [], error: null },
    });
    await notifyRequesterReturnEvent({ ...RMA, event: 'exchange_request_received', source: 'requester', channel: 'member' });
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'return.exchange_request_received',
        title: 'We received your exchange request.',
        link: '/dashboard/orders/ord-1',
      }),
    );
  });

  it('an email-only requester gets one email linking their return page; a portal requester the portal', async () => {
    admin({
      'order_requests.select': {
        data: [{ source: 'internal', customer_id: null, requester_user_id: null, requester_email: 'pat@example.com', requester_name: 'Pat', order_number: 103 }],
        error: null,
      },
    });
    await notifyRequesterReturnEvent({ ...RMA, event: 'exchange_request_received', source: 'requester', channel: 'token' });
    const [, args] = sendEmail.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(args).toMatchObject({ event: 'exchange_request_received', to: 'pat@example.com' });
    expect(String(args.viewUrl)).toMatch(/\/returns\/request\/tok-uuid$/);

    vi.clearAllMocks();
    admin({
      'order_requests.select': {
        data: [{ source: 'portal', customer_id: 'c-1', requester_user_id: 'portal-user', requester_email: 'buyer@c.example.com', requester_name: 'B', order_number: 7 }],
        error: null,
      },
    });
    await notifyRequesterReturnEvent({ ...RMA, event: 'exchange_declined', source: 'requester', channel: 'staff' });
    expect(createNotification).not.toHaveBeenCalled();
    const [, portalArgs] = sendEmail.mock.calls[0]! as unknown as [unknown, Record<string, unknown>];
    expect(portalArgs).toMatchObject({ event: 'exchange_declined' });
    expect(String(portalArgs.viewUrl)).toMatch(/\/portal$/);
  });

  it('a declined exchange at a counter approval is silent (G11); elsewhere the requester hears it; staff returns never', () => {
    expect(requesterHearsEvent('exchange_declined', { source: 'requester', channel: 'counter' })).toBe(false);
    expect(requesterHearsEvent('exchange_declined', { source: 'requester', channel: 'staff' })).toBe(true);
    expect(requesterHearsEvent('exchange_request_received', { source: 'requester', channel: 'portal' })).toBe(true);
    expect(requesterHearsEvent('exchange_request_received', { source: 'internal' })).toBe(false);
  });

  it('the staff ping names an exchange request', async () => {
    admin({
      'order_requests.select': { data: [{ id: 'ord-1', warehouse_id: WH, order_number: 103, requester_name: 'Pat', requester_email: null }], error: null },
      'organization_members.select': { data: [{ user_id: 'mgr', role: 'manager' }], error: null },
      'role_permission_overrides.select': { data: [], error: null },
      'user_permission_overrides.select': { data: [], error: null },
      'user_warehouse_assignments.select': { data: [], error: null },
      'notification_preferences.select': { data: [], error: null },
    });
    await notifyStaffNewReturnRequest({ ...RMA, actorUserId: null, kind: 'exchange' });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'New exchange request', type: 'return.requested' }));
  });
});
