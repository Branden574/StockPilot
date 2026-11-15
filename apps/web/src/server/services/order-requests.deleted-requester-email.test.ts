import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const { sendMock, resendMock, reportErrorMock, prefsResult, adminStubs } = vi.hoisted(() => ({
  // Every service client a test created: export events are recorded through
  // one (server/lib/outbox-events.ts), so the event is read from these.
  adminStubs: [] as Array<{ rpcCalls: Array<{ name: string; args: unknown }> }>,
  sendMock: vi.fn(async () => {}),
  // The hand-over notices (order-handover-notify.ts) send through Resend
  // directly, not through sendOrderRequestEmail.
  resendMock: vi.fn(async (_args: { to: string }) => ({ id: 'email-1' })),
  reportErrorMock: vi.fn(async () => {}),
  prefsResult: { value: { data: null as unknown, error: null as unknown } },
}));

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('./notifications', () => ({ createNotification: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: sendMock }));
vi.mock('@/lib/email/resend', () => ({ sendEmail: resendMock }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderChanged: vi.fn(async () => {}) }));
// The return prompt makes its own deleted-requester decision (return-prompt.test.ts).
vi.mock('@/server/email/return-prompt', () => ({
  maybeSendReturnPrompt: vi.fn(async () => ({ sent: false, reason: 'requester_deleted' })),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: reportErrorMock,
  isNextControlFlowError: () => false,
}));
vi.mock('@/lib/supabase/admin', async () => {
  const { makeSupabaseStub: stub, servedLikePostgrest } = await import('@/test/supabase-mock');
  return {
    createAdminClient: () => {
      const made = stub({
        'notification_preferences.select.maybeSingle': prefsResult.value as never,
        // S36: the live requester is still a current member of the order's
        // organization, on an account that is not disabled
        // (order-requests.member-email.test.ts covers the rest).
        'user_profiles.select': { data: [{ disabled_at: null }], error: null },
        'organization_members.select': servedLikePostgrest([
          {
            organization_id: 'org-test',
            user_id: 'u-live',
            accepted_at: '2026-01-05T00:00:00Z',
            impersonation_expires_at: null,
          },
        ]),
      });
      adminStubs.push(made);
      return made.client;
    },
  };
});

import { OrderRequestsService } from './order-requests';

/**
 * A requester who deleted their account is never emailed again (A3, the
 * orchestrator's rule over the A2 What's New review): the order keeps the
 * address it recorded (O-A3-6), but neither resolveRecipient nor wantsEmail
 * may send to it. Before A3 a legacy row with requester_email set reached
 * the copy first, and wantsEmail read the null requester id as a public-link
 * requester ("always email"), so the deleted person's opt-out no longer
 * applied.
 */

type NotifyKind = 'approved' | 'completed' | 'cancelled';

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, {
      role: 'manager',
      userId: 'mgr-1',
      enabledModules: new Set<ModuleId>(['orders']),
    }),
  );
}

/** The private sender every status change goes through. */
async function notify(
  service: OrderRequestsService,
  row: Record<string, unknown>,
  kind: NotifyKind = 'approved',
): Promise<void> {
  await (service as unknown as {
    notifyEmail: (r: unknown, k: NotifyKind) => Promise<void>;
  }).notifyEmail(row, kind);
}

const base = {
  id: 'ord-1',
  organization_id: 'org-test',
  order_number: 7,
  status: 'approved',
  requester_name: 'Pat Example',
};

beforeEach(() => {
  vi.clearAllMocks();
  prefsResult.value = { data: null, error: null };
  adminStubs.length = 0;
});

describe('order status email: a deleted requester is never emailed (A3)', () => {
  it.each<NotifyKind>(['approved', 'completed', 'cancelled'])(
    'sends nothing to the kept address when requester_deleted_at is on the row (%s)',
    async (kind) => {
      const stub = makeSupabaseStub();
      await notify(
        svc(stub),
        {
          ...base,
          requester_user_id: null,
          requester_email: 'pat@example.org',
          requester_deleted_at: '2026-10-04T12:00:00.000Z',
        },
        kind,
      );
      expect(sendMock).not.toHaveBeenCalled();
      // Decided from the row: no extra read, no profile lookup.
      expect(stub.fromCalls).toEqual([]);
    },
  );

  it('reads the marker when the row came from a narrow select, and sends nothing when it is set', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': {
        data: { requester_deleted_at: '2026-10-04T12:00:00.000Z' },
        error: null,
      },
    });
    await notify(svc(stub), { ...base, requester_user_id: null, requester_email: 'pat@example.org' });
    expect(sendMock).not.toHaveBeenCalled();
    expect(stub.fromCalls).toEqual(['order_requests']);
    const args = stub.chainArgsAll.get('order_requests.select')?.[0] ?? [];
    expect(args).toEqual(expect.arrayContaining([['requester_deleted_at'], ['id', 'ord-1']]));
  });

  it('a failed marker read sends nothing and is reported (fail closed)', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: null, error: { message: 'timeout' } },
    });
    await notify(svc(stub), { ...base, requester_user_id: null, requester_email: 'pat@example.org' });
    expect(sendMock).not.toHaveBeenCalled();
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tag: 'order-requests.email.requester_deleted_read', level: 'warning' }),
    );
  });

  it('a public-link requester (no account, marker null) is still emailed: transactional', async () => {
    const stub = makeSupabaseStub();
    await notify(svc(stub), {
      ...base,
      requester_user_id: null,
      requester_email: 'guest@example.org',
      requester_deleted_at: null,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approved', recipientEmail: 'guest@example.org' }),
    );
  });

  it('a row with no kept address reads nothing more (no email can go out anyway)', async () => {
    // The cancel and approve RPCs answer a narrow row (id, status, number):
    // no requester column, no address. No extra order read for it.
    const stub = makeSupabaseStub();
    await notify(svc(stub), { id: 'ord-1', status: 'cancelled', order_number: 7 }, 'cancelled');
    expect(sendMock).not.toHaveBeenCalled();
    expect(stub.fromCalls).not.toContain('order_requests');
  });

  it('a narrow-select public row whose marker reads null is emailed', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { requester_deleted_at: null }, error: null },
    });
    await notify(svc(stub), { ...base, requester_user_id: null, requester_email: 'guest@example.org' });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('a live requester is emailed without the marker read, and their opt-out still applies', async () => {
    const live = makeSupabaseStub({
      'user_profiles.select.maybeSingle': {
        data: { email: 'live@example.org', full_name: 'Live Person' },
        error: null,
      },
    });
    await notify(svc(live), { ...base, requester_user_id: 'u-live', requester_email: null });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ recipientEmail: 'live@example.org', recipientName: 'Live Person' }),
    );
    expect(live.fromCalls).not.toContain('order_requests');

    sendMock.mockClear();
    prefsResult.value = { data: { email_order_status_changed: false }, error: null };
    await notify(svc(live), { ...base, requester_user_id: 'u-live', requester_email: null });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

/** Let the deferred tail work (defer() falls back to fire-and-forget in vitest) run. */
async function flushDeferred(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('paper hand-over notices: a deleted requester is never emailed (A3 desk check F-1)', () => {
  // confirm_physical_signature returns the whole order_requests row, so the
  // marker is on it. Before the fix the paper path passed requester_email
  // straight to the backorder notices, whose only gate is
  // `requesterEmail && !emailOptedOut`, and emailOptedOut stays false for a
  // row with no requester id.
  const deletedRow = {
    ...base,
    requester_user_id: null,
    requester_email: 'pat@example.org',
    requester_deleted_at: '2026-10-04T12:00:00.000Z',
  };

  function paperStub(row: Record<string, unknown>) {
    return makeSupabaseStub({
      // The order, read in the organization before the function (S39).
      'order_requests.select.maybeSingle': { data: { id: 'ord-1' }, error: null },
      'rpc:confirm_physical_signature': { data: row, error: null },
      // Read twice (prior shipped, then the totals): 2 of 5 already shipped.
      'order_request_lines.select': {
        data: [{ quantity_requested: 5, quantity_fulfilled: 2 }],
        error: null,
      },
    });
  }

  it('backordered: no partial-fulfilment email to the kept address', async () => {
    const stub = paperStub({ ...deletedRow, status: 'backordered' });
    await svc(stub).confirmPhysicalSignature('ord-1', 'Dock Signer');
    await flushDeferred();
    expect(resendMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('remainder handed over (completed after a backorder): no backorder-shipped email', async () => {
    const stub = paperStub({ ...deletedRow, status: 'completed' });
    await svc(stub).confirmPhysicalSignature('ord-1', 'Dock Signer');
    await flushDeferred();
    expect(resendMock).not.toHaveBeenCalled();
    // The completion receipt goes through notifyEmail, which already skips them.
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('a public-link requester (marker null) still gets the partial-fulfilment email', async () => {
    const stub = paperStub({
      ...base,
      status: 'backordered',
      requester_user_id: null,
      requester_email: 'guest@example.org',
      requester_deleted_at: null,
    });
    await svc(stub).confirmPhysicalSignature('ord-1', 'Dock Signer');
    await flushDeferred();
    expect(resendMock).toHaveBeenCalledTimes(1);
    expect(resendMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'guest@example.org' }));
  });

  it('a public-link requester (marker null) still gets the backorder-shipped email', async () => {
    const stub = paperStub({
      ...base,
      status: 'completed',
      requester_user_id: null,
      requester_email: 'guest@example.org',
      requester_deleted_at: null,
    });
    await svc(stub).confirmPhysicalSignature('ord-1', 'Dock Signer');
    await flushDeferred();
    expect(resendMock).toHaveBeenCalledWith(expect.objectContaining({ to: 'guest@example.org' }));
  });
});

describe('denied order ticket: a deleted requester is not handed to Zendesk (A3 desk check F-1 sweep)', () => {
  // The Zendesk connector makes the payload's requesterEmail the ticket's
  // requester, and Zendesk's default triggers email the requester when a
  // ticket is created. So the outbox payload is an email path too.
  function denyStub(row: Record<string, unknown>) {
    return makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      // The organization's warehouses: the order's is one of them.
      'warehouses.select': { data: [{ id: 'wh-1' }], error: null },
      'order_requests.update': { data: row, error: null },
    });
  }

  /** The order.problem event: recorded once, through a service client, never the member's. */
  function outboxPayload(stub: ReturnType<typeof makeSupabaseStub>): Record<string, unknown> {
    expect(stub.rpcCalls.filter((c) => c.name === 'publish_outbox')).toHaveLength(0);
    const calls = adminStubs.flatMap((a) => a.rpcCalls).filter((c) => c.name === 'publish_outbox');
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args as Record<string, unknown> & { p_payload: Record<string, unknown> };
    // Everything but the payload, as it has always been sent.
    expect({ ...args, p_payload: undefined }).toEqual({
      p_org_id: 'org-test',
      p_topic: 'order.problem',
      p_aggregate_type: 'order_request',
      p_aggregate_id: 'ord-1',
      p_payload: undefined,
      p_dedupe_key: 'order.problem:ord-1',
    });
    return args.p_payload;
  }

  it('omits the kept address and name when requester_deleted_at is set', async () => {
    const stub = denyStub({
      ...base,
      status: 'denied',
      requester_user_id: null,
      requester_email: 'pat@example.org',
      requester_deleted_at: '2026-10-04T12:00:00.000Z',
    });
    await svc(stub).deny('ord-1', 'Out of stock');
    await flushDeferred();
    const payload = outboxPayload(stub);
    expect(payload.requesterEmail).toBeNull();
    expect(payload.requesterName).toBeNull();
    expect(payload.reason).toBe('Out of stock');
    expect(JSON.stringify(payload)).toBe(
      JSON.stringify({
        orderRequestId: 'ord-1',
        requesterEmail: null,
        requesterName: null,
        reason: 'Out of stock',
      }),
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('keeps a public-link requester on the ticket (marker null)', async () => {
    const stub = denyStub({
      ...base,
      status: 'denied',
      requester_user_id: null,
      requester_email: 'guest@example.org',
      requester_deleted_at: null,
    });
    await svc(stub).deny('ord-1', 'Out of stock');
    const payload = outboxPayload(stub);
    expect(payload.requesterEmail).toBe('guest@example.org');
    expect(payload.requesterName).toBe('Pat Example');
    expect(JSON.stringify(payload)).toBe(
      JSON.stringify({
        orderRequestId: 'ord-1',
        requesterEmail: 'guest@example.org',
        requesterName: 'Pat Example',
        reason: 'Out of stock',
      }),
    );
  });

  it('a member without orders:approve is refused before anything, and no event is recorded', async () => {
    const stub = denyStub({
      ...base,
      status: 'denied',
      requester_user_id: null,
      requester_email: 'guest@example.org',
    });
    const staff = new (
      OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService
    )(
      makeServiceContext(stub.client, {
        role: 'staff',
        userId: 'staff-1',
        enabledModules: new Set<ModuleId>(['orders']),
      }),
    );
    await expect(staff.deny('ord-1', 'Out of stock')).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.chainsAll.get('order_requests.update')).toBeUndefined();
    expect(
      adminStubs.flatMap((a) => a.rpcCalls).filter((c) => c.name === 'publish_outbox'),
    ).toHaveLength(0);
    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('a denial that did not land (no longer pending) records no event', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { warehouse_id: 'wh-1' }, error: null },
      'warehouses.select': { data: [{ id: 'wh-1' }], error: null },
      'order_requests.update': { data: null, error: null },
    });
    await expect(svc(stub).deny('ord-1', 'Out of stock')).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(
      adminStubs.flatMap((a) => a.rpcCalls).filter((c) => c.name === 'publish_outbox'),
    ).toHaveLength(0);
  });
});
