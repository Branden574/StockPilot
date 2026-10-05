import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

const { sendMock, reportErrorMock, prefsResult } = vi.hoisted(() => ({
  sendMock: vi.fn(async () => {}),
  reportErrorMock: vi.fn(async () => {}),
  prefsResult: { value: { data: null as unknown, error: null as unknown } },
}));

vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));
vi.mock('@/lib/email/order-requests', () => ({ sendOrderRequestEmail: sendMock }));
vi.mock('@/lib/error-reporter', () => ({
  reportError: reportErrorMock,
  isNextControlFlowError: () => false,
}));
vi.mock('@/lib/supabase/admin', async () => {
  const { makeSupabaseStub: stub } = await import('@/test/supabase-mock');
  return {
    createAdminClient: () =>
      stub({ 'notification_preferences.select.maybeSingle': prefsResult.value as never }).client,
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
