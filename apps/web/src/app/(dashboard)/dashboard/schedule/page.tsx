import { Calendar } from 'lucide-react';
import { redirect } from 'next/navigation';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleUnavailable } from '@/components/dashboard/module-unavailable';
import { PageHeader } from '@/components/patterns/page-header';
import { ScheduleCalendar } from '@/components/schedule/schedule-calendar';
import { requireOrgContext } from '@/lib/auth/session';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { reportError } from '@/lib/error-reporter';
import { navLabelFromOverrides } from '@/lib/nav-labels';
import { ScheduleService } from '@/server/services/schedule';

import { can, resolveOrgTimezone, zonedParts } from '@stockpilot/core';

export const metadata = { title: 'Schedule' };

/**
 * Team calendar landing. ?m=YYYY-MM picks which month is shown;
 * defaults to the organization's current month. The calendar itself uses
 * search params to navigate prev/next/today (Today drops ?m=), so this page
 * just resolves the month and hands events to the client component.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('schedule');
  if (!moduleAccess.enabled) {
    return <ModuleUnavailable moduleId="schedule" access={moduleAccess} />;
  }
  // Visibility gates on schedule:read (manager+ by default, grantable to
  // read-only members). schedule:manage holders keep access even if an org
  // revokes the read perm from a managing role. Adding/editing events stays
  // gated on schedule:manage (page gates on /new + /[id]/edit, plus the
  // calendar's canManage prop below).
  const ctx = await requireOrgContext();
  if (!can(ctx, 'schedule:read') && !can(ctx, 'schedule:manage')) {
    redirect('/dashboard');
  }
  const canManage = can(ctx, 'schedule:manage');
  const params = await searchParams;
  // The current month is the ORGANIZATION's, never the server's: Vercel's
  // clock reads UTC, which on the last day of a month is already the next
  // month from 5 PM Pacific (4 PM in standard time), so the calendar and its
  // Today button opened a month whose grid can leave today out entirely. The
  // zone is the request-cached org row the layout reads (normally already in
  // hand from the membership bundle); an unreadable row falls back to the
  // documented default zone, as every org-time surface does, and is reported
  // instead of taking the calendar down (getOrgRowForRequest throws on a read
  // error). The calendar draws every day in this zone too (small fixes slice
  // 8): each event on its start day here, its time here, and this today
  // marked, so a viewer elsewhere never opens this month without a mark.
  // The same cached row gives the eyebrow the organization's name for this
  // page in the sidebar (Settings > Navigation renames; PLAN rule 10), with no
  // read of its own.
  const { timeZone, navLabel } = await getOrgRowForRequest(ctx.organizationId)
    .then((org) => ({
      timeZone: resolveOrgTimezone(org?.timezone),
      navLabel: navLabelFromOverrides(
        org?.nav_overrides ?? null,
        '/dashboard/schedule',
        'Schedule',
      ),
    }))
    .catch((e: unknown) => {
      void reportError(e, { tag: 'schedule.calendar.org_timezone_failed', level: 'warning' });
      return { timeZone: resolveOrgTimezone(null), navLabel: 'Schedule' };
    });
  const today = zonedParts(new Date(), timeZone);
  const todayYmd = `${String(today.year).padStart(4, '0')}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
  let year = today.year;
  let month = today.month;
  if (params.m) {
    const match = params.m.match(/^(\d{4})-(\d{1,2})$/);
    if (match) {
      const y = Number(match[1]);
      const m = Number(match[2]);
      if (Number.isFinite(y) && y > 1970 && y < 2100 && m >= 1 && m <= 12) {
        year = y;
        month = m;
      }
    }
  }

  // 6-week grid: Sunday before the 1st through Saturday after the last, 42
  // calendar days (the calendar's monthGridDays). The events to read are
  // those starting from the organization's midnight on the first day to its
  // midnight after the last. That range was the SERVER's midnights (UTC on
  // Vercel), never padded, so an event late in the evening of the grid's last
  // day in a US zone (already the next day in UTC) was never read (small
  // fixes slice 8). Two days of padding on each side cover every zone (none
  // is more than 14 hours from UTC); an event read outside the grid has no
  // cell and is not drawn. Multi-day events overlapping the window still
  // load (listInRange matches on the end too).
  const DAY_MS = 24 * 60 * 60 * 1000;
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const gridFirstDay = Date.UTC(year, month - 1, 1 - firstWeekday);
  const rangeFrom = new Date(gridFirstDay - 2 * DAY_MS);
  const rangeTo = new Date(gridFirstDay + (42 + 2) * DAY_MS);

  const svc = await ScheduleService.forCurrentUser();
  const events = await svc.listInRange(rangeFrom, rangeTo);

  const calendarEvents = events.map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    allDay: e.allDay,
    status: e.status,
    locationText: e.locationText,
  }));

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <Calendar aria-hidden className="h-3 w-3" />
            Workspace · {navLabel}
          </span>
        }
        title="Team calendar"
        subline={
          <>
            Jobs, deliveries, pickups, drops — anything time + location based. Each event is scoped
            to its warehouse: only staff assigned to that warehouse can see it.
            {canManage ? ' Click a date to add an event.' : ''}
          </>
        }
      />

      <ScheduleCalendar
        year={year}
        month={month}
        events={calendarEvents}
        canManage={canManage}
        timeZone={timeZone}
        todayYmd={todayYmd}
      />
    </div>
  );
}
