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
 * The today mark is drawn in the browser once the page has hydrated (#331),
 * on the viewer's own day; each case below renders the page in UTC at the
 * server's clock and hydrates it in Los Angeles a minute later, as a reload
 * does, and checks the mark lands in the month the page opened.
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
