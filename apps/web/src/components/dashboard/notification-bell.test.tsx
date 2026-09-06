import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationBell } from './notification-bell';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
}));

const queueLiveNotification = vi.fn();
vi.mock('@/lib/notifications/live-toast', () => ({
  queueLiveNotification: (...args: unknown[]) => queueLiveNotification(...args),
}));

// Chainable supabase stub. Records every .eq() filter so the test can assert
// the query is scoped to BOTH the user and the active org.
const eqCalls: Array<[string, string]> = [];
let unreadRows: Array<Record<string, unknown>> = [];
// Total matching rows behind the LIMIT. PostgREST only reports this when the
// caller asks for it via `.select(cols, { count: 'exact' })`, so the stub
// mirrors that: no request, no count — exactly like the real client.
let unreadTotal: number | null = null;

function makeBuilder() {
  let countRequested = false;
  const builder = {
    select: (_cols?: string, options?: { count?: string; head?: boolean }) => {
      if (options?.count === 'exact') countRequested = true;
      return builder;
    },
    eq: (col: string, val: string) => {
      eqCalls.push([col, val]);
      return builder;
    },
    is: () => builder,
    order: () => builder,
    limit: () =>
      Promise.resolve({
        data: unreadRows,
        error: null,
        count: countRequested ? unreadTotal : null,
      }),
  };
  return builder;
}

const channelStub = {
  on: () => channelStub,
  subscribe: (cb?: (status: string) => void) => {
    cb?.('SUBSCRIBED');
    return channelStub;
  },
};

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => makeBuilder(),
    channel: () => channelStub,
    removeChannel: () => undefined,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  eqCalls.length = 0;
  unreadRows = [];
  unreadTotal = null;
});

describe('NotificationBell', () => {
  // The multi-org regression: the client refetch must scope to the ACTIVE
  // org, not just the user — otherwise other workspaces' notifications
  // bleed into the badge and toasts.
  it('queries unread rows scoped to the active organization', async () => {
    unreadRows = [
      { id: 'n1', type: 'order', title: 'Order', body: null, link: null, created_at: 'x' },
      { id: 'n2', type: 'order', title: 'Order 2', body: null, link: null, created_at: 'x' },
    ];
    render(
      <NotificationBell userId="u1" organizationId="org-1" initialUnread={0} />,
    );
    await waitFor(() => {
      expect(eqCalls).toContainEqual(['user_id', 'u1']);
      expect(eqCalls).toContainEqual(['organization_id', 'org-1']);
    });
    // Badge reflects the org-scoped unread set.
    await waitFor(() => {
      expect(
        screen.getByLabelText('Notifications (2 unread)'),
      ).toBeInTheDocument();
    });
  });

  // SP-117: the badge used to be `data.length` from a LIMIT 20 query, so a
  // user with 35 unread watched the server-rendered 35 collapse to 20 on the
  // first client refetch — and the '99+' label was unreachable. The refetch
  // now asks PostgREST for the exact total alongside the same 20-row page.
  it('keeps the badge at the true unread total when more than one page is unread', async () => {
    unreadRows = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      type: 'order',
      title: `Order ${i}`,
      body: null,
      link: null,
      created_at: 'x',
    }));
    unreadTotal = 35;
    // initialUnread starts at 0 on purpose: the badge can only read 35 if the
    // CLIENT refetch produced it, so this can't pass on the server-seeded
    // value alone (that would make the test a tautology).
    render(
      <NotificationBell userId="u1" organizationId="org-1" initialUnread={0} />,
    );
    await waitFor(() => {
      expect(
        screen.getByLabelText('Notifications (35 unread)'),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText('Notifications (20 unread)'),
    ).not.toBeInTheDocument();
  });

  // The '99+' cap is only reachable because the count no longer comes from
  // the 20-row page.
  it('renders 99+ once the unread total passes 99', async () => {
    unreadRows = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      type: 'order',
      title: `Order ${i}`,
      body: null,
      link: null,
      created_at: 'x',
    }));
    unreadTotal = 140;
    render(
      <NotificationBell userId="u1" organizationId="org-1" initialUnread={0} />,
    );
    await waitFor(() => {
      expect(screen.getByText('99+')).toBeInTheDocument();
    });
    expect(screen.queryByText('20')).not.toBeInTheDocument();
  });

  it('does not toast rows that were already unread on first mount', async () => {
    unreadRows = [
      { id: 'n1', type: 'order', title: 'Old news', body: null, link: null, created_at: 'x' },
    ];
    render(
      <NotificationBell userId="u1" organizationId="org-1" initialUnread={1} />,
    );
    await waitFor(() => {
      expect(eqCalls.length).toBeGreaterThan(0);
    });
    expect(queueLiveNotification).not.toHaveBeenCalled();
  });
});
