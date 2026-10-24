import { within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hydrateAcrossClockShift } from '@/test/hydration';

/**
 * The team calendar opens on the month the page picks when the address names
 * none (a plain visit, and the Today button, which drops ?m=). The page picked
 * it from the server's clock in the server's zone: UTC on Vercel, where the
 * last day of a month is already the next month from 5 PM Pacific in daylight
 * time (4 PM in standard time). At 5:30 PM on Oct 31 in Los Angeles the
 * calendar opened on November 2026, a grid that starts on Sunday Nov 1, so
 * today (Oct 31) was not on it at all. It now picks the month in the
 * organization's time zone, read the way every page reads it
 * (getOrgRowForRequest, resolveOrgTimezone).
 *
 * The today mark is the organization's today, which the page passes (small
 * fixes slice 8; #331 drew the viewer's own day once hydrated); each case
 * below renders the page in UTC at the server's clock and hydrates it in Los
 * Angeles a minute later, as a reload does, and checks the mark lands in the
 * month the page opened.
 */

const getOrgRowForRequest = vi.fn();
const reportError = vi.fn();
const listInRange = vi.fn(async () => []);

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard/schedule',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/modules/module-gate', () => ({
  checkModuleAccess: vi.fn(async () => ({ enabled: true, canManage: true })),
}));
vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    organizationId: 'org-1',
    userId: 'u1',
    role: 'owner',
    permissions: null,
  })),
}));
vi.mock('@/lib/dashboard/request-cache', () => ({
  getOrgRowForRequest: (...args: unknown[]) => getOrgRowForRequest(...args),
}));
vi.mock('@/lib/error-reporter', () => ({
  reportError: (...args: unknown[]) => reportError(...args),
}));
vi.mock('@/server/services/schedule', () => ({
  ScheduleService: { forCurrentUser: vi.fn(async () => ({ listInRange })) },
}));

import SchedulePage from './page';

/** The page as the server builds it: its zone, its clock. */
async function pageAt(at: number, serverZone: string, m?: string) {
  const previousZone = process.env.TZ;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
  process.env.TZ = serverZone;
  try {
    return await SchedulePage({ searchParams: Promise.resolve(m ? { m } : {}) });
  } finally {
    vi.useRealTimers();
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
}

/** Server render in UTC at `at`, hydrated in Los Angeles a minute later. */
async function openCalendar(at: number, m?: string) {
  const page = await pageAt(at, 'UTC', m);
  return hydrateAcrossClockShift(() => page, { serverNow: at, browserNow: at + 60_000 });
}

const heading = (container: HTMLElement) =>
  within(container)
    .getAllByRole('heading', { level: 2 })
    .map((h) => h.textContent);

const todayCells = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.bg-foreground')).map((mark) =>
    mark
      .closest('.group')
      ?.querySelector('[aria-label^="Add event on"]')
      ?.getAttribute('aria-label'),
  );

describe('the team calendar opens on the organization’s current month', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listInRange.mockResolvedValue([]);
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  // Half an hour before UTC's date turns: October on both clocks, which the
  // page got right before this change too. Kept as the edge of the window.
  it('4:30 PM on Oct 31 in Los Angeles (23:30 UTC): October, with Oct 31 marked today', async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'America/Los_Angeles' });
    const run = await openCalendar(Date.parse('2026-10-31T23:30:00.000Z'));
    try {
      expect(run.errors).toEqual([]);
      expect(heading(run.container)).toEqual(['October 2026']);
      expect(todayCells(run.container)).toEqual(['Add event on 2026-10-31']);
    } finally {
      run.unmount();
    }
    expect(getOrgRowForRequest).toHaveBeenCalledWith('org-1');
  });

  // The window: Nov 1 in UTC, still Oct 31 in Los Angeles (daylight time
  // ends on Nov 1, so the window opens at 5 PM).
  it('5:30 PM on Oct 31 in Los Angeles (00:30 UTC on Nov 1): October, with Oct 31 marked today', async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'America/Los_Angeles' });
    const run = await openCalendar(Date.parse('2026-11-01T00:30:00.000Z'));
    try {
      expect(run.errors).toEqual([]);
      expect(heading(run.container)).toEqual(['October 2026']);
      expect(todayCells(run.container)).toEqual(['Add event on 2026-10-31']);
    } finally {
      run.unmount();
    }
  });

  // In standard time the window opens an hour earlier, at 4 PM.
  it('4:30 PM on Nov 30 in Los Angeles (00:30 UTC on Dec 1): November, with Nov 30 marked today', async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'America/Los_Angeles' });
    const run = await openCalendar(Date.parse('2026-12-01T00:30:00.000Z'));
    try {
      expect(run.errors).toEqual([]);
      expect(heading(run.container)).toEqual(['November 2026']);
      expect(todayCells(run.container)).toEqual(['Add event on 2026-11-30']);
    } finally {
      run.unmount();
    }
  });

  it('an organization east of UTC: 1:30 AM on Nov 1 in Sydney is November, though UTC still says Oct 31', async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'Australia/Sydney' });
    const page = await pageAt(Date.parse('2026-10-31T14:30:00.000Z'), 'UTC');
    const run = await hydrateAcrossClockShift(() => page, {
      serverNow: Date.parse('2026-10-31T14:30:00.000Z'),
      browserNow: Date.parse('2026-10-31T14:31:00.000Z'),
      browserZone: 'Australia/Sydney',
    });
    try {
      expect(run.errors).toEqual([]);
      expect(heading(run.container)).toEqual(['November 2026']);
      expect(todayCells(run.container)).toEqual(['Add event on 2026-11-01']);
    } finally {
      run.unmount();
    }
  });

  it('a month named in the address still wins (?m=2026-03)', async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'America/Los_Angeles' });
    const run = await openCalendar(Date.parse('2026-10-31T23:30:00.000Z'), '2026-03');
    try {
      expect(heading(run.container)).toEqual(['March 2026']);
      expect(todayCells(run.container)).toEqual([]);
    } finally {
      run.unmount();
    }
  });

  it("an unreadable organization row falls back to the documented default zone (Pacific), not the server's, and is reported", async () => {
    getOrgRowForRequest.mockRejectedValue(new Error('getOrgRowForRequest: boom'));
    const run = await openCalendar(Date.parse('2026-11-01T00:30:00.000Z'));
    try {
      expect(heading(run.container)).toEqual(['October 2026']);
    } finally {
      run.unmount();
    }
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tag: 'schedule.calendar.org_timezone_failed' }),
    );
  });
});

// PLAN rule 10: a renamed sidebar destination shows its name in the page's
// eyebrow. The name comes from the same request-cached org row the page
// already reads for its time zone, so the rename adds no request.
describe('the eyebrow follows a Settings > Navigation rename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listInRange.mockResolvedValue([]);
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('prints the org’s label for Schedule, from the one org-row read', async () => {
    getOrgRowForRequest.mockResolvedValue({
      timezone: 'America/Los_Angeles',
      nav_overrides: { v: 1, labels: { '/dashboard/schedule': 'Dispatch' } },
    });
    const run = await openCalendar(Date.parse('2026-10-15T18:00:00.000Z'));
    try {
      expect(run.container).toHaveTextContent('Workspace · Dispatch');
      expect(within(run.container).getByRole('heading', { level: 1 })).toHaveTextContent(
        'Team calendar',
      );
    } finally {
      run.unmount();
    }
    expect(getOrgRowForRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps "Schedule" without a rename, and when the org row cannot be read', async () => {
    getOrgRowForRequest.mockRejectedValue(new Error('getOrgRowForRequest: boom'));
    const run = await openCalendar(Date.parse('2026-10-15T18:00:00.000Z'));
    try {
      expect(run.container).toHaveTextContent('Workspace · Schedule');
    } finally {
      run.unmount();
    }
  });
});

/**
 * The calendar in the organization's zone (small fixes slice 8, item F):
 *   - the events the grid's first and last days hold in the organization's
 *     zone are loaded: the range was the server's midnights (UTC on Vercel),
 *     so an evening event in the grid's last cell (after midnight UTC) was
 *     never read, whatever the comment above it promised ("Pad the range a
 *     few days on each side");
 *   - event times print in the organization's zone, not Pacific;
 *   - today is the organization's today, so a viewer outside its zone never
 *     opens the organization's month without a Today mark.
 */
describe('the team calendar reads and draws the organization’s days', () => {
  type Ev = {
    id: string;
    title: string;
    startsAt: string;
    endsAt: string | null;
    allDay: boolean;
    status: string;
    locationText: null;
  };
  const ev = (id: string, title: string, startsAt: string): Ev => ({
    id,
    title,
    startsAt,
    endsAt: null,
    allDay: false,
    status: 'scheduled',
    locationText: null,
  });
  /** schedule_events as listInRange reads them: starts before `to`, and no end or an end at or after `from`. */
  function servedFrom(events: Ev[]) {
    listInRange.mockImplementation((async (from: Date, to: Date) =>
      events.filter(
        (e) =>
          Date.parse(e.startsAt) < to.getTime() &&
          (e.endsAt === null || Date.parse(e.endsAt) >= from.getTime()),
      )) as never);
  }
  const cellOf = (container: HTMLElement, ymd: string) =>
    within(container).getByLabelText(`Add event on ${ymd}`).closest('.group') as HTMLElement;

  beforeEach(() => {
    vi.clearAllMocks();
    listInRange.mockResolvedValue([]);
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("loads the grid's last evening in the organization's zone: 8 PM on Nov 7 in Los Angeles (Nov 8 in UTC) shows on Nov 7", async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'America/Los_Angeles' });
    // October 2026's grid runs Sun Sep 27 to Sat Nov 7.
    servedFrom([
      ev('ev-late', 'Late pickup', '2026-11-08T04:00:00Z'),
      ev('ev-early', 'Early drop', '2026-09-27T08:00:00Z'),
    ]);
    const run = await openCalendar(Date.parse('2026-10-15T19:00:00.000Z'), '2026-10');
    try {
      expect(run.errors).toEqual([]);
      expect(
        within(cellOf(run.container, '2026-11-07')).getByText('Late pickup'),
      ).toBeInTheDocument();
      expect(
        within(cellOf(run.container, '2026-09-27')).getByText('Early drop'),
      ).toBeInTheDocument();
    } finally {
      run.unmount();
    }
    // The range covers the organization's first and last grid days, padded.
    const [from, to] = listInRange.mock.calls[0] as unknown as [Date, Date];
    expect(from.getTime()).toBeLessThanOrEqual(Date.parse('2026-09-27T07:00:00.000Z'));
    expect(to.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-11-08T08:00:00.000Z'));
  });

  it("prints event times in the organization's zone: 2 PM in New York, not Pacific's 11 AM", async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'America/New_York' });
    servedFrom([ev('ev-1', 'Pickup', '2026-10-07T18:00:00Z')]);
    const run = await openCalendar(Date.parse('2026-10-15T19:00:00.000Z'));
    try {
      expect(run.errors).toEqual([]);
      const cell = cellOf(run.container, '2026-10-07');
      expect(within(cell).getByText(/2:00\sPM/)).toBeInTheDocument();
      expect(cell.textContent).not.toMatch(/11:00\sAM/);
    } finally {
      run.unmount();
    }
  });

  it('a viewer in Los Angeles of a New York organization at 10 PM on Oct 31 (Nov 1 in New York): November, with Nov 1 marked today', async () => {
    getOrgRowForRequest.mockResolvedValue({ timezone: 'America/New_York' });
    const at = Date.parse('2026-11-01T05:00:00.000Z');
    const page = await pageAt(at, 'UTC');
    const run = await hydrateAcrossClockShift(() => page, {
      serverNow: at,
      browserNow: at + 60_000,
      browserZone: 'America/Los_Angeles',
    });
    try {
      expect(run.errors).toEqual([]);
      expect(heading(run.container)).toEqual(['November 2026']);
      expect(todayCells(run.container)).toEqual(['Add event on 2026-11-01']);
    } finally {
      run.unmount();
    }
  });
});
