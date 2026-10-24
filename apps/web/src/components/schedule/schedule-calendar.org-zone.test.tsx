import { within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

/**
 * The team calendar in the ORGANIZATION's time zone (small fixes slice 8,
 * item F; found by #335).
 *
 * Event times printed through formatOrgTime with no zone, so in its default
 * (Pacific), whatever the organization's zone. Each event went in the cell of
 * its start day in the viewer's zone, and today was the viewer's today, both
 * drawn once hydrated (#331): a viewer outside the organization's zone saw
 * another day's events in a cell, and could open the organization's month
 * with their own today outside its grid, so no Today mark at all.
 *
 * Now the page gives the calendar the organization's zone and today: each
 * event sits on its start day there, prints its time there, and today is the
 * organization's today. Fixed props, so the server and the browser draw the
 * same calendar (no hydration gate, no React #418). No mock of the zone
 * helpers here: these are the real words.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/schedule',
  useSearchParams: () => new URLSearchParams(),
}));

import { ScheduleCalendar } from './schedule-calendar';

const NEW_YORK = 'America/New_York';

const event = (id: string, title: string, startsAt: string, allDay = false) => ({
  id,
  title,
  startsAt,
  endsAt: null,
  allDay,
  status: 'scheduled' as const,
  locationText: null,
});

const cellOf = (container: HTMLElement, ymd: string) =>
  within(container).getByLabelText(`Add event on ${ymd}`).closest('.group') as HTMLElement;

const todayCells = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.bg-foreground')).map((mark) =>
    mark
      .closest('.group')
      ?.querySelector('[aria-label^="Add event on"]')
      ?.getAttribute('aria-label'),
  );

describe("ScheduleCalendar draws the organization's days and times", () => {
  it('a New York organization: an event at 10:30 PM on Oct 5 there sits on Oct 5 and reads 10:30 PM, for a viewer in Los Angeles too', async () => {
    // 10:30 PM on Oct 5 in New York; 7:30 PM in Los Angeles; Oct 6 in UTC.
    const late = event('ev-1', 'Evening delivery', '2026-10-06T02:30:00Z');
    // 2 PM on Oct 7 in New York (11 AM in Los Angeles).
    const afternoon = event('ev-2', 'Pickup', '2026-10-07T18:00:00Z');
    const t0 = Date.parse('2026-10-06T03:00:00.000Z');
    const run = await hydrateAcrossClockShift(
      () => (
        <ScheduleCalendar
          year={2026}
          month={10}
          events={[late, afternoon]}
          canManage
          timeZone={NEW_YORK}
          todayYmd="2026-10-05"
        />
      ),
      { serverNow: t0, browserNow: t0 + 60_000, browserZone: 'America/Los_Angeles' },
    );
    try {
      expect(run.errors).toEqual([]);
      // Drawn on the server already: the same on both sides.
      expect(run.html).toContain('Evening delivery');
      expect(
        within(cellOf(run.container, '2026-10-05')).getByText('Evening delivery'),
      ).toBeInTheDocument();
      expect(
        within(cellOf(run.container, '2026-10-06')).queryByText('Evening delivery'),
      ).toBeNull();
      expect(
        within(cellOf(run.container, '2026-10-05')).getByText(/10:30\sPM/),
      ).toBeInTheDocument();
      expect(within(cellOf(run.container, '2026-10-07')).getByText(/2:00\sPM/)).toBeInTheDocument();
      expect(run.container.textContent).not.toMatch(/7:30\sPM|11:00\sAM/);
    } finally {
      run.unmount();
    }
  });

  it("marks the organization's today, whatever the viewer's day: one mark, on that cell", async () => {
    // 10 PM on Oct 31 in Los Angeles is already Nov 1 in New York, the
    // organization's zone: the page opens November and today is Nov 1.
    const t0 = Date.parse('2026-11-01T05:00:00.000Z');
    const run = await hydrateAcrossClockShift(
      () => (
        <ScheduleCalendar
          year={2026}
          month={11}
          events={[]}
          canManage
          timeZone={NEW_YORK}
          todayYmd="2026-11-01"
        />
      ),
      { serverNow: t0, browserNow: t0 + 60_000, browserZone: 'America/Los_Angeles' },
    );
    try {
      expect(run.errors).toEqual([]);
      expect(todayCells(run.container)).toEqual(['Add event on 2026-11-01']);
    } finally {
      run.unmount();
    }
  });

  it("a month without the organization's today has no mark", async () => {
    const t0 = Date.parse('2026-10-06T03:00:00.000Z');
    const run = await hydrateAcrossClockShift(
      () => (
        <ScheduleCalendar
          year={2026}
          month={3}
          events={[]}
          canManage
          timeZone={NEW_YORK}
          todayYmd="2026-10-05"
        />
      ),
      { serverNow: t0, browserNow: t0 + 60_000 },
    );
    try {
      expect(todayCells(run.container)).toEqual([]);
    } finally {
      run.unmount();
    }
  });
});
