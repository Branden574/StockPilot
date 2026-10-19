import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ tickets: vi.fn() }));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({ userId: 'user-1', organizationId: 'org-1' })),
}));
vi.mock('@/server/services/support-tickets', () => ({
  listMyTickets: (...a: unknown[]) => h.tickets(...a),
}));
vi.mock('@/server/actions/support-tickets', () => ({
  submitDashboardTicketAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import DashboardSupportPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  h.tickets.mockResolvedValue([
    {
      id: 't1',
      subject: 'Scanner froze',
      category: 'bug',
      status: 'in_progress',
      // An evening ticket west of Greenwich: 03:30 UTC on the 19th.
      createdAt: '2026-10-19T03:30:00.000+00:00',
    },
    {
      id: 't2',
      subject: 'Invoice copy',
      category: 'account',
      status: 'closed',
      createdAt: '2026-10-10T15:00:00.000+00:00',
    },
  ]);
});

describe('Support & feedback', () => {
  it('reads only this member’s tickets in this workspace', async () => {
    render(await DashboardSupportPage());
    expect(h.tickets).toHaveBeenCalledWith({ userId: 'user-1', organizationId: 'org-1' });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Support & feedback' }),
    ).toBeInTheDocument();
  });

  it('lists each submission with its category and status words', async () => {
    render(await DashboardSupportPage());
    const list = screen.getByRole('heading', { name: 'My submissions' }).closest('section')!;
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Scanner froze')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Problem')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('In progress')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Account')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Closed')).toBeInTheDocument();
  });

  it('dates a ticket in the viewer’s own zone, not the server’s', async () => {
    const { container } = render(await DashboardSupportPage());
    // A <time> carrying the exact instant, filled in on the client by
    // LocalDate; the server-side toLocaleDateString printed the UTC day.
    const time = container.querySelector('time[datetime="2026-10-19T03:30:00.000+00:00"]');
    expect(time).not.toBeNull();
    const expected = new Date('2026-10-19T03:30:00.000+00:00').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    expect(time).toHaveTextContent(expected);
  });

  it('keeps the empty line word for word', async () => {
    h.tickets.mockResolvedValue([]);
    render(await DashboardSupportPage());
    expect(
      screen.getByText('Nothing yet — your submissions will show up here.'),
    ).toBeInTheDocument();
  });

  it('keeps the request type radiogroup, defaulting to Report a problem', async () => {
    render(await DashboardSupportPage());
    const group = screen.getByRole('radiogroup', { name: 'Request type' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'Report a problem',
      'Request a feature',
      'Billing question',
      'Something else',
    ]);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radios[2]!);
    expect(radios[2]).toHaveAttribute('aria-checked', 'true');
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByLabelText('Subject')).toHaveAttribute('maxLength', '140');
    expect(screen.getByLabelText('Details')).toHaveAttribute('maxLength', '4000');
    expect(screen.getByRole('button', { name: 'Send to StockPilot' })).toBeInTheDocument();
  });
});
