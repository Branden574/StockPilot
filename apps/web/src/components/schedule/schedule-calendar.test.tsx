import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Read-only rendering contract (auditor visibility): a visitor holding
// schedule:read but NOT schedule:manage gets canManage=false, which must
// hide the "+ New event" header button and every per-day "+ Add" link.
// Event chips (read affordances) stay.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/schedule',
  useSearchParams: () => new URLSearchParams(),
}));
// Deterministic org-time formatting regardless of the test host TZ.
vi.mock('@/lib/timezone', () => ({
  formatOrgDate: () => 'July 2026',
  formatOrgTime: () => '9:00 AM',
}));

import { ScheduleCalendar } from './schedule-calendar';

const EVENT = {
  id: 'ev-1',
  title: 'Delivery run',
  startsAt: '2026-07-15T16:00:00Z',
  endsAt: null,
  allDay: false,
  status: 'scheduled' as const,
  locationText: null,
};

describe('ScheduleCalendar canManage gating', () => {
  it('canManage=false hides "+ New event" and every per-day "+ Add" link', () => {
    render(
      <ScheduleCalendar year={2026} month={7} events={[EVENT]} canManage={false} />,
    );
    expect(screen.queryByText('+ New event')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Add event on/)).not.toBeInTheDocument();
    // Read affordances stay: the event chip still links to its detail page.
    expect(screen.getByText('Delivery run')).toBeInTheDocument();
  });

  it('defaults to read-only when canManage is omitted (fail closed)', () => {
    render(<ScheduleCalendar year={2026} month={7} events={[]} />);
    expect(screen.queryByText('+ New event')).not.toBeInTheDocument();
  });

  it('canManage=true keeps the add affordances (unchanged for managers)', () => {
    render(<ScheduleCalendar year={2026} month={7} events={[]} canManage />);
    expect(screen.getByText('+ New event')).toBeInTheDocument();
    // 42 grid cells → 42 per-day add links.
    expect(screen.getAllByLabelText(/Add event on/)).toHaveLength(42);
  });
});
