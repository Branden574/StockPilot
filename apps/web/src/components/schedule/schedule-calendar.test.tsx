import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

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

// The schedule page server-renders the calendar, which puts each event on
// the day of its start and marks today, both from the clock's LOCAL day: the
// server's (UTC on Vercel) while it renders, the viewer's while the browser
// hydrates. An event at 7:30 PM in Los Angeles is the next day in UTC, so the
// server drew it in another cell and React threw error #418 (and the server's
// "today", tomorrow in UTC every evening, stayed marked, since React does not
// patch a class while hydrating). Events and the today mark are drawn once
// the page has hydrated.
describe('ScheduleCalendar hydrates with the server in UTC and the browser in Los Angeles', () => {
  it("draws an evening event on the viewer's day and marks the viewer's today, with no hydration error", async () => {
    // 8 PM on Oct 5 in Los Angeles; already Oct 6 in UTC.
    const t0 = Date.parse('2026-10-06T03:00:00.000Z');
    const evening = {
      ...EVENT,
      id: 'ev-2',
      title: 'Evening delivery',
      startsAt: '2026-10-06T02:30:00Z',
    };
    const run = await hydrateAcrossClockShift(
      () => <ScheduleCalendar year={2026} month={10} events={[evening]} canManage />,
      { serverNow: t0, browserNow: t0 + 60_000 },
    );
    try {
      expect(run.errors).toEqual([]);
      expect(run.html).not.toContain('Evening delivery');
      const cellOf = (ymd: string) =>
        within(run.container)
          .getByLabelText(`Add event on ${ymd}`)
          .closest('.group') as HTMLElement;
      expect(within(cellOf('2026-10-05')).getByText('Evening delivery')).toBeInTheDocument();
      expect(within(cellOf('2026-10-06')).queryByText('Evening delivery')).toBeNull();
      expect(cellOf('2026-10-05').querySelector('.bg-foreground')).not.toBeNull();
      expect(run.container.querySelectorAll('.bg-foreground')).toHaveLength(1);
    } finally {
      run.unmount();
    }
  });
});
