import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('a staff-created return tells the requester nothing', async () => {
    admin({});
    await notifyRequesterReturnEvent({ ...RMA, event: 'approved', source: 'internal' });
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
