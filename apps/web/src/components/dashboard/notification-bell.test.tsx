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

function makeBuilder() {
  const builder = {
    select: () => builder,
    eq: (col: string, val: string) => {
      eqCalls.push([col, val]);
      return builder;
    },
    is: () => builder,
    order: () => builder,
    limit: () =>
      Promise.resolve({ data: unreadRows, error: null }),
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
