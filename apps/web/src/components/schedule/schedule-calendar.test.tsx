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
    render(<ScheduleCalendar year={2026} month={7} events={[EVENT]} canManage={false} />);
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

// The redesign (P4.F2, row W-WS-04): status chips moved to the tokens, and the
// hover-only "+ Add" link shows on keyboard focus and on touch screens too
// (CONFLICTS D18), where there is no hover to reveal it.
describe('ScheduleCalendar redesign', () => {
  // One event a day (a day shows three chips and then "+N more").
  const at = (
    status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled',
    id: string,
    day: number,
  ) => ({
    ...EVENT,
    id,
    title: `Job ${status}`,
    status,
    startsAt: `2026-07-${String(day).padStart(2, '0')}T16:00:00Z`,
  });

  it('"+ Add" is revealed on focus (its own and its day\'s) and on coarse pointers, not by hover alone', () => {
    render(<ScheduleCalendar year={2026} month={7} events={[]} canManage />);
    const add = screen.getAllByLabelText(/Add event on/)[0]!;
    expect(add).toHaveClass('opacity-0', 'group-hover:opacity-100');
    expect(add).toHaveClass(
      'focus-visible:opacity-100',
      'group-focus-within:opacity-100',
      'pointer-coarse:opacity-100',
    );
  });

  it('every chip says its status in words, keeps the strike-through on finished ones, and uses no raw palette colour', async () => {
    const t0 = Date.parse('2026-07-15T12:00:00.000Z');
    const run = await hydrateAcrossClockShift(
      () => (
        <ScheduleCalendar
          year={2026}
          month={7}
          events={[
            at('scheduled', 'a', 13),
            at('in_progress', 'b', 14),
            at('completed', 'c', 15),
            at('cancelled', 'd', 16),
          ]}
        />
      ),
      { serverNow: t0, browserNow: t0 },
    );
    try {
      const chip = (title: string) =>
        within(run.container).getByText(title).closest('a') as HTMLAnchorElement;
      expect(chip('Job scheduled')).toHaveTextContent('Job scheduled, Scheduled');
      expect(chip('Job in_progress')).toHaveTextContent('Job in_progress, In progress');
      expect(chip('Job completed')).toHaveTextContent('Job completed, Completed');
      expect(chip('Job cancelled')).toHaveTextContent('Job cancelled, Cancelled');
      expect(chip('Job completed')).toHaveClass('line-through');
      expect(chip('Job cancelled')).toHaveClass('line-through');
      expect(chip('Job scheduled')).not.toHaveClass('line-through');
      for (const a of run.container.querySelectorAll('a[data-status]')) {
        expect(a.className).not.toMatch(/\b(sky|amber|emerald|rose)-\d/);
      }
    } finally {
      run.unmount();
    }
  });

  // DESIGN-SPEC 2.4: the chip's words sit on a status wash in that status's
  // tone, which only just clears 4.5:1 in light (4.64 to 4.88). opacity-80 on
  // the time dropped it to 3.28-3.39 in light and the cancelled chip's to 4.21
  // in dark (axe color-contrast, serious), so every part of a chip keeps the
  // full tone and the title's weight sets the time apart instead.
  it('keeps every chip, its time and its title at full tone (no opacity), with the title in medium weight', async () => {
    const t0 = Date.parse('2026-07-15T12:00:00.000Z');
    const run = await hydrateAcrossClockShift(
      () => (
        <ScheduleCalendar
          year={2026}
          month={7}
          events={[
            at('scheduled', 'a', 13),
            at('in_progress', 'b', 14),
            at('completed', 'c', 15),
            at('cancelled', 'd', 16),
          ]}
        />
      ),
      { serverNow: t0, browserNow: t0 },
    );
    try {
      const chips = Array.from(run.container.querySelectorAll<HTMLElement>('a[data-status]'));
      expect(chips.map((a) => a.dataset.status)).toEqual([
        'scheduled',
        'in_progress',
        'completed',
        'cancelled',
      ]);
      for (const chip of chips) {
        const time = within(chip).getByText('9:00 AM');
        expect(time).toHaveClass('tabular-nums');
        expect(time.className).not.toMatch(/opacity-/);
        expect(within(chip).getByText(/^Job /)).toHaveClass('font-medium');
        expect(chip.className).not.toMatch(/opacity-/);
        expect(chip.querySelectorAll('[class*="opacity-"]')).toHaveLength(0);
      }
    } finally {
      run.unmount();
    }
  });
});
