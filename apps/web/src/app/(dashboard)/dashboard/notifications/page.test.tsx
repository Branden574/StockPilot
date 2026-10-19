import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: vi.fn(),
  summary: vi.fn(),
  actions: vi.fn(),
  markOne: vi.fn(async () => ({ ok: true })),
  markAll: vi.fn(async () => ({ ok: true })),
  refresh: vi.fn(),
}));

vi.mock('@/server/services/notifications', () => ({
  NotificationsService: {
    forCurrentUser: vi.fn(async () => ({ list: () => h.rows() })),
  },
}));
vi.mock('@/server/services/movements', () => ({
  getDashboardSummary: () => h.summary(),
  getDashboardActions: () => h.actions(),
}));
vi.mock('@/server/actions/notifications', () => ({
  markNotificationReadAction: (...a: unknown[]) => h.markOne(...(a as [])),
  markAllNotificationsReadAction: () => h.markAll(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import NotificationsPage from './page';

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'po_status_changed',
  title: `Title ${id}`,
  body: `Body ${id}`,
  link: `/dashboard/purchase-orders/${id}`,
  read_at: null,
  created_at: '2026-10-18T10:00:00Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.summary.mockResolvedValue({ lowStockCount: 4, outOfStockCount: 1 });
  h.actions.mockResolvedValue({ openPoCount: 2, openCycleCount: 1 });
  h.rows.mockResolvedValue([
    row('a'),
    // Written with an absolute URL by the order hand-over notifier: text only.
    row('b', { link: 'https://app.example.com/dashboard/orders/1', type: 'order_backordered' }),
    // A protocol-relative link is not an internal path either.
    row('c', { link: '//evil.example.com', read_at: '2026-10-18T11:00:00Z' }),
    row('d', { link: null, read_at: '2026-10-18T11:00:00Z', body: null }),
  ]);
});

describe('Notifications', () => {
  it('derives the live alerts with their links, words and counts', async () => {
    render(await NotificationsPage());
    expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeInTheDocument();
    const live = screen.getByRole('heading', { name: 'Live alerts' }).closest('section')!;
    const links = within(live).getAllByRole('link');
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/dashboard/inventory?stock=low&type=all',
      '/dashboard/purchase-orders',
      '/dashboard/cycle-counts',
    ]);
    expect(links[0]).toHaveTextContent('5 items need restocking');
    expect(links[0]).toHaveTextContent('1 out of stock · 4 below par');
    expect(links[1]).toHaveTextContent('2 purchase orders open');
    expect(links[2]).toHaveTextContent('1 cycle count in progress');
  });

  it('says All clear right now when nothing is live', async () => {
    h.summary.mockResolvedValue({ lowStockCount: 0, outOfStockCount: 0 });
    h.actions.mockResolvedValue({ openPoCount: 0, openCycleCount: 0 });
    render(await NotificationsPage());
    expect(screen.getByText('All clear right now')).toBeInTheDocument();
    expect(
      screen.getByText('No low-stock items, no open POs, no in-progress counts.'),
    ).toBeInTheDocument();
  });

  it('links a title only for an internal stored web path', async () => {
    render(await NotificationsPage());
    const history = screen
      .getByRole('heading', { name: 'Notification history' })
      .closest('section')!;
    expect(within(history).getByRole('link', { name: 'Title a' })).toHaveAttribute(
      'href',
      '/dashboard/purchase-orders/a',
    );
    for (const t of ['Title b', 'Title c', 'Title d']) {
      expect(within(history).getByText(t).closest('a')).toBeNull();
    }
    // Only the first underscore of the type becomes a space.
    expect(within(history).getByText(/^order backordered · /)).toBeInTheDocument();
    expect(within(history).getAllByText(/^po status_changed · /)).toHaveLength(3);
  });

  it('counts unread, marks one or all read, and refreshes', async () => {
    render(await NotificationsPage());
    expect(screen.getByText('2 unread notifications')).toBeInTheDocument();
    const markRead = screen.getAllByRole('button', { name: 'Mark read' });
    expect(markRead).toHaveLength(2);
    fireEvent.click(markRead[0]!);
    await waitFor(() => expect(h.markOne).toHaveBeenCalledWith('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(h.markAll).toHaveBeenCalled());
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(2));
  });

  it('has an honest empty history', async () => {
    h.rows.mockResolvedValue([]);
    render(await NotificationsPage());
    expect(screen.getByRole('heading', { name: 'All caught up' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
  });
});
