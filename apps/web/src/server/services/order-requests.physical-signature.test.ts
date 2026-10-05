import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * L91: the paper (physical) signature path sent the partly-fulfilled and the
 * backorder-shipped notices without the order number they accept, so they
 * named the order "#XXXXXXXX" while the app names it SO-000049. Both now get
 * it, as on the digital sign route.
 */

const notify = vi.hoisted(() => ({
  backordered: vi.fn(async (_a: Record<string, unknown>) => undefined),
  shipped: vi.fn(async (_a: Record<string, unknown>) => undefined),
}));
vi.mock('@/server/lib/order-handover-notify', () => ({
  notifyRequesterBackordered: (a: Record<string, unknown>) => notify.backordered(a),
  notifyRequesterBackorderShipped: (a: Record<string, unknown>) => notify.shipped(a),
  sendPartialReceiptEmail: vi.fn(async () => undefined),
  fetchOrderLineItems: vi.fn(async () => []),
}));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: vi.fn(async () => {}) }));
vi.mock('@/server/email/return-prompt', () => ({ maybeSendReturnPrompt: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
// The service-role reads the paper path makes: the requester's profile and
// their email opt-out (L94). Each test sets the answers it needs.
const admin = vi.hoisted(() => ({ results: {} as Record<string, unknown> }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => makeSupabaseStub(admin.results as never).client,
}));
const reportErrorMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: reportErrorMock,
  isNextControlFlowError: () => false,
}));
vi.mock('./lib/defer', () => ({ defer: vi.fn() }));

import { OrderRequestsService } from './order-requests';

function service(row: Record<string, unknown>, lines: { prior: number; requested: number; fulfilled: number }) {
  let lineReads = 0;
  const stub = makeSupabaseStub({
    'order_request_lines.select': () => {
      lineReads += 1;
      return lineReads === 1
        ? { data: [{ quantity_fulfilled: lines.prior }], error: null }
        : {
            data: [{ quantity_requested: lines.requested, quantity_fulfilled: lines.fulfilled }],
            error: null,
          };
    },
    'rpc:confirm_physical_signature': { data: row, error: null },
  });
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'manager',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

const ROW = {
  id: 'ord-1',
  requester_user_id: null,
  requester_email: null,
  requester_name: 'Pat',
};

beforeEach(() => {
  vi.clearAllMocks();
  admin.results = {};
});

describe('confirmPhysicalSignature: hand-over notices name the order by its number (L91)', () => {
  it('a partial hand-over tells the requester about SO-000049', async () => {
    await service({ ...ROW, status: 'backordered', order_number: 49 }, { prior: 0, requested: 5, fulfilled: 2 })
      .confirmPhysicalSignature('ord-1', 'Pat');

    expect(notify.backordered).toHaveBeenCalledWith(
      expect.objectContaining({ orderNumber: 'SO-000049' }),
    );
  });

  it('a backorder remainder handed over tells the requester about SO-000049', async () => {
    await service({ ...ROW, status: 'completed', order_number: 49 }, { prior: 2, requested: 5, fulfilled: 5 })
      .confirmPhysicalSignature('ord-1', 'Pat');

    expect(notify.shipped).toHaveBeenCalledWith(expect.objectContaining({ orderNumber: 'SO-000049' }));
  });

  it('an order without a number passes none (the notice falls back to the short id)', async () => {
    await service({ ...ROW, status: 'backordered', order_number: null }, { prior: 0, requested: 5, fulfilled: 2 })
      .confirmPhysicalSignature('ord-1', 'Pat');

    expect(notify.backordered).toHaveBeenCalledWith(expect.objectContaining({ orderNumber: null }));
  });
});

/**
 * L94: a member who places their own order has requester_user_id set and the
 * requester_email column empty (SP-020). The sign route resolves their address
 * from user_profiles (resolveRequesterContact), but the paper path passed the
 * empty column, so after a paper hand-over the requester got the in-app notice
 * and no email; and their opt-out was read only when the empty column was set.
 * Both paths now share one resolver and one opt-out read, with A3's rule
 * unchanged: a requester who deleted their account is never emailed.
 */
describe('confirmPhysicalSignature: the requester is reached at their own address (L94)', () => {
  const MEMBER = { id: 'ord-1', requester_user_id: 'user-req', requester_email: null, requester_name: null };
  const PROFILE = { email: 'reggie@example.org', full_name: 'Reggie Requester' };

  it('a partial hand-over emails the member at their profile address', async () => {
    admin.results = {
      'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
      'notification_preferences.select.maybeSingle': { data: null, error: null },
    };
    await service({ ...MEMBER, status: 'backordered', order_number: 49 }, { prior: 0, requested: 5, fulfilled: 2 })
      .confirmPhysicalSignature('ord-1', 'Dock Signer');

    expect(notify.backordered).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterUserId: 'user-req',
        requesterEmail: 'reggie@example.org',
        requesterName: 'Reggie Requester',
        emailOptedOut: false,
      }),
    );
  });

  it('a backorder remainder handed over emails the member at their profile address', async () => {
    admin.results = {
      'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
      'notification_preferences.select.maybeSingle': { data: { email_order_completed: true }, error: null },
    };
    await service({ ...MEMBER, status: 'completed', order_number: 49 }, { prior: 2, requested: 5, fulfilled: 5 })
      .confirmPhysicalSignature('ord-1', 'Dock Signer');

    expect(notify.shipped).toHaveBeenCalledWith(
      expect.objectContaining({ requesterEmail: 'reggie@example.org', emailOptedOut: false }),
    );
  });

  it("honours the member's opt-out, which was never read for an empty address column", async () => {
    admin.results = {
      'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
      'notification_preferences.select.maybeSingle': { data: { email_order_completed: false }, error: null },
    };
    await service({ ...MEMBER, status: 'backordered', order_number: 49 }, { prior: 0, requested: 5, fulfilled: 2 })
      .confirmPhysicalSignature('ord-1', 'Dock Signer');

    expect(notify.backordered).toHaveBeenCalledWith(expect.objectContaining({ emailOptedOut: true }));
  });

  it('a failed opt-out read counts as opted out and is reported, as on the sign route', async () => {
    admin.results = {
      'user_profiles.select.maybeSingle': { data: PROFILE, error: null },
      'notification_preferences.select.maybeSingle': { data: null, error: { message: 'boom' } },
    };
    await service({ ...MEMBER, status: 'backordered', order_number: 49 }, { prior: 0, requested: 5, fulfilled: 2 })
      .confirmPhysicalSignature('ord-1', 'Dock Signer');

    expect(notify.backordered).toHaveBeenCalledWith(expect.objectContaining({ emailOptedOut: true }));
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'orders.physical_signature.pref_read' }),
    );
  });

  it('A3 unchanged: a requester who deleted their account gets no address, even one the order kept', async () => {
    admin.results = { 'user_profiles.select.maybeSingle': { data: PROFILE, error: null } };
    await service(
      {
        id: 'ord-1',
        requester_user_id: null,
        requester_email: 'kept@example.org',
        requester_name: 'Kept',
        requester_deleted_at: '2026-10-04T12:00:00.000Z',
        status: 'backordered',
        order_number: 49,
      },
      { prior: 0, requested: 5, fulfilled: 2 },
    ).confirmPhysicalSignature('ord-1', 'Dock Signer');

    expect(notify.backordered).toHaveBeenCalledWith(
      expect.objectContaining({ requesterEmail: null, requesterName: null }),
    );
  });

  it('an on-behalf-of order keeps the address it recorded', async () => {
    await service(
      {
        id: 'ord-1',
        requester_user_id: null,
        requester_email: 'guest@example.org',
        requester_name: 'Guest',
        requester_deleted_at: null,
        status: 'backordered',
        order_number: 49,
      },
      { prior: 0, requested: 5, fulfilled: 2 },
    ).confirmPhysicalSignature('ord-1', 'Dock Signer');

    expect(notify.backordered).toHaveBeenCalledWith(
      expect.objectContaining({ requesterEmail: 'guest@example.org', requesterName: 'Guest', emailOptedOut: false }),
    );
  });
});
