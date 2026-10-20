import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  access: vi.fn(),
  can: vi.fn(),
  gather: vi.fn(),
  summarize: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('@/lib/modules/module-gate', () => ({ checkModuleAccess: () => h.access() }));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ role: 'staff' })),
}));
vi.mock('@stockpilot/core', () => ({ can: (...a: unknown[]) => h.can(...a) }));
vi.mock('@/server/services/insights', () => ({
  gatherInsights: () => h.gather(),
  summarizeInsights: (...a: unknown[]) => h.summarize(...a),
}));
vi.mock('@/components/dashboard/module-not-enabled', () => ({
  ModuleNotEnabled: ({ moduleId }: { moduleId: string }) => <p>module {moduleId} is off</p>,
}));
vi.mock('next/navigation', () => ({ redirect: (to: string) => h.redirect(to) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import InsightsPage from './page';

const SIGNALS = [
  {
    key: 'approvals',
    count: 3,
    label: 'orders awaiting approval',
    severity: 'urgent',
    href: '/dashboard/orders?status=needs_approval',
  },
  {
    key: 'overdue',
    count: 2,
    label: 'overdue inbound POs',
    severity: 'warn',
    href: '/dashboard/purchase-orders',
  },
  {
    key: 'counts',
    count: 1,
    label: 'cycle counts in progress',
    severity: 'info',
    href: '/dashboard/cycle-counts',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.access.mockResolvedValue({ enabled: true, canManage: false });
  h.can.mockReturnValue(true);
  h.summarize.mockResolvedValue(null);
  h.gather.mockResolvedValue({
    signals: SIGNALS,
    lowStock: [{ id: 'i1', name: 'L4L Mug', sku: 'MUG-12', qty: 4, reorderPoint: 10 }],
  });
});

describe('Briefing', () => {
  it('lists the signals in the server order, each a link with its severity in words', async () => {
    render(await InsightsPage());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent("Today's briefing");
    const links = screen.getAllByRole('link').filter((a) => a.hasAttribute('data-severity'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/dashboard/orders?status=needs_approval',
      '/dashboard/purchase-orders',
      '/dashboard/cycle-counts',
    ]);
    expect(within(links[0]!).getByText('Act now')).toBeInTheDocument();
    expect(within(links[1]!).getByText('Review')).toBeInTheDocument();
    expect(within(links[2]!).getByText('FYI')).toBeInTheDocument();
    expect(links[0]).toHaveTextContent('3orders awaiting approval');
    expect(screen.getByRole('link', { name: '← Back to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('keeps the low-stock lines word for word', async () => {
    render(await InsightsPage());
    expect(screen.getByRole('heading', { name: 'Low stock' })).toBeInTheDocument();
    expect(screen.getByText('4 on hand · reorder at 10')).toBeInTheDocument();
    expect(screen.getByText('· MUG-12')).toBeInTheDocument();
  });

  it('shows the AI summary card only when the provider produced one', async () => {
    render(await InsightsPage());
    expect(screen.queryByText('AI summary')).toBeNull();
    h.summarize.mockResolvedValue('Approve the three orders first.');
    render(await InsightsPage());
    expect(screen.getByRole('heading', { name: 'AI summary' })).toBeInTheDocument();
    expect(screen.getByText('Approve the three orders first.')).toBeInTheDocument();
  });

  it('says All clear with an icon and the same words, no emoji (CONFLICTS D22)', async () => {
    h.gather.mockResolvedValue({ signals: [], lowStock: [] });
    const { container } = render(await InsightsPage());
    const heading = screen.getByRole('heading', { name: 'All clear' });
    expect(heading.textContent).toBe('All clear');
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(
      screen.getByText('No orders awaiting approval, overdue POs, or low-stock items right now.'),
    ).toBeInTheDocument();
    expect(container.querySelector('[data-state-kind="empty"] svg')).not.toBeNull();
  });

  it('keeps its gates: module off, then items:update or back to the dashboard', async () => {
    h.access.mockResolvedValue({ enabled: false, canManage: true });
    render(await InsightsPage());
    expect(screen.getByText('module ai is off')).toBeInTheDocument();
    expect(h.gather).not.toHaveBeenCalled();

    h.access.mockResolvedValue({ enabled: true, canManage: false });
    h.can.mockReturnValue(false);
    await expect(InsightsPage()).rejects.toThrow('NEXT_REDIRECT /dashboard');
    expect(h.can).toHaveBeenCalledWith(expect.anything(), 'items:update');
  });
});
