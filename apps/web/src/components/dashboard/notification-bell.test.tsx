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
const isCalls: Array<[string, unknown]> = [];
const selectOptions: Array<{ count?: string; head?: boolean } | undefined> = [];
let unreadRows: Array<Record<string, unknown>> = [];
// Total matching rows behind the LIMIT. PostgREST only reports this when the
// caller asks for it via `.select(cols, { count: 'exact' })`, so the stub
// mirrors that: no request, no count — exactly like the real client.
let unreadTotal: number | null = null;
// When set, every read waits for it: lets a test look at the bell BEFORE its
// first read has landed.
let readGate: Promise<void> | null = null;

function makeBuilder() {
  let countRequested = false;
  const builder = {
    select: (_cols?: string, options?: { count?: string; head?: boolean }) => {
      selectOptions.push(options);
      if (options?.count === 'exact') countRequested = true;
      return builder;
    },
    eq: (col: string, val: string) => {
      eqCalls.push([col, val]);
      return builder;
    },
    is: (col: string, val: unknown) => {
      isCalls.push([col, val]);
      return builder;
    },
    order: () => builder,
    limit: async () => {
      if (readGate) await readGate;
      return {
        data: unreadRows,
        error: null,
        count: countRequested ? unreadTotal : null,
      };
    },
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
  isCalls.length = 0;
  selectOptions.length = 0;
  unreadRows = [];
  unreadTotal = null;
  readGate = null;
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
      <NotificationBell userId="u1" organizationId="org-1" />,
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
    // The bell starts at 0 (no server seed since 2026-09-22), so the badge can
    // only read 35 if the CLIENT refetch produced it.
    render(
      <NotificationBell userId="u1" organizationId="org-1" />,
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
      <NotificationBell userId="u1" organizationId="org-1" />,
    );
    await waitFor(() => {
      expect(screen.getByText('99+')).toBeInTheDocument();
    });
    expect(screen.queryByText('20')).not.toBeInTheDocument();
  });

  // 2026-09-22: (dashboard)/layout.tsx no longer seeds the badge with a head
  // count it awaited before first byte; the bell's own mount read is the only
  // source. It must count exactly what that head count did (this user, this
  // org, unread, exact total), and show nothing rather than a guess until then.
  it('reads its own count on mount: no badge until the read lands, then the exact unread total', async () => {
    let openGate!: () => void;
    readGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    unreadRows = [
      { id: 'n1', type: 'order', title: 'Order', body: null, link: null, created_at: 'x' },
    ];
    unreadTotal = 7;
    render(<NotificationBell userId="u1" organizationId="org-1" />);

    await waitFor(() => expect(selectOptions.length).toBeGreaterThan(0));
    expect(screen.getByLabelText('Notifications')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();

    openGate();
    await waitFor(() => {
      expect(screen.getByLabelText('Notifications (7 unread)')).toBeInTheDocument();
    });
    // The same predicate and the same total the layout's
    // `select('id', { count: 'exact', head: true })` used to compute.
    expect(selectOptions.every((o) => o?.count === 'exact')).toBe(true);
    expect(eqCalls).toContainEqual(['user_id', 'u1']);
    expect(eqCalls).toContainEqual(['organization_id', 'org-1']);
    expect(isCalls).toContainEqual(['read_at', null]);
  });

  it('does not toast rows that were already unread on first mount', async () => {
    unreadRows = [
      { id: 'n1', type: 'order', title: 'Old news', body: null, link: null, created_at: 'x' },
    ];
    render(
      <NotificationBell userId="u1" organizationId="org-1" />,
    );
    await waitFor(() => {
      expect(eqCalls.length).toBeGreaterThan(0);
    });
    expect(queueLiveNotification).not.toHaveBeenCalled();
  });
});
