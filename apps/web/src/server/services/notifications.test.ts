import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeSupabaseStub } from '@/test/supabase-mock';

/**
 * createNotification is the ONE insert path for every push + in-app
 * notification in the product (see the doc comment on the function) — the
 * AFTER-INSERT trigger from 0028_push_dispatch.sql fans out to the
 * recipient's push tokens on every row it writes, and it runs as
 * service-role, so it never consulted RLS or `disabled_at` on its own.
 *
 * A user disabled for suspected compromise (account-disable program,
 * migs 0308-0311) kept getting lock-screen push banners carrying PO
 * numbers, low-stock SKUs and deep links, because nothing at this single
 * choke point checked whether the recipient was disabled before inserting.
 *
 * Fixed HERE rather than at each of the ~10 call sites (purchase-orders,
 * order-requests, auto-archive, the daily-briefing/recurring-pos/
 * auto-reorder/schedule-reminders crons, …) because this is the one
 * canonical insert path they all funnel through — one predicate here closes
 * the gap for every current and future caller.
 */

vi.mock('@/lib/error-reporter', () => ({
  reportError: vi.fn(),
}));

const adminHolder = { client: null as unknown };
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => adminHolder.client,
}));

import { createNotification } from './notifications';

beforeEach(() => {
  vi.clearAllMocks();
});

function baseArgs(userId: string) {
  return {
    organizationId: 'org-1',
    userId,
    type: 'purchase_order.updated',
    title: 'Purchase order updated',
    body: 'PO 1042 was edited (3 item(s)).',
    link: '/dashboard/purchase-orders/po-1',
  };
}

describe('createNotification — disabled accounts', () => {
  it('never inserts a notification row for a disabled recipient', async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: { disabled_at: '2026-07-30T00:00:00Z' }, error: null },
    });
    adminHolder.client = stub.client;

    const id = await createNotification(baseArgs('user-disabled'));

    expect(id).toBeNull();
    // The real teeth of this test: the insert (and therefore the 0028
    // AFTER-INSERT push trigger) must never fire for a disabled recipient.
    expect(stub.chains.has('notifications.insert')).toBe(false);
  });

  it('still inserts for an active recipient in the same batch', async () => {
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: { disabled_at: null }, error: null },
      'notifications.insert': { data: { id: 'notif-1' }, error: null },
    });
    adminHolder.client = stub.client;

    const id = await createNotification(baseArgs('user-active'));

    expect(id).toBe('notif-1');
    expect(stub.chains.has('notifications.insert')).toBe(true);
  });

  it('fails OPEN (still inserts) when the disabled_at check itself errors', async () => {
    // This function's contract is "never throws, best-effort delivery" — an
    // unreadable profile is a read error, not evidence the account is
    // disabled, so it must not silently swallow every notification in the
    // product the moment user_profiles is unreachable.
    const stub = makeSupabaseStub({
      'user_profiles.select': { data: null, error: { message: 'boom' } },
      'notifications.insert': { data: { id: 'notif-2' }, error: null },
    });
    adminHolder.client = stub.client;

    const id = await createNotification(baseArgs('user-unknown'));

    expect(id).toBe('notif-2');
  });
});
