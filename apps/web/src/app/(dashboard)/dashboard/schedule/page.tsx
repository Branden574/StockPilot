import { Calendar } from 'lucide-react';
import { redirect } from 'next/navigation';

import { checkModuleAccess } from '@/lib/modules/module-gate';
import { ModuleNotEnabled } from '@/components/dashboard/module-not-enabled';
import { ScheduleCalendar } from '@/components/schedule/schedule-calendar';
import { requireOrgContext } from '@/lib/auth/session';
import { ScheduleService } from '@/server/services/schedule';

import { can } from '@stockpilot/core';

export const metadata = { title: 'Schedule' };

/**
 * Team calendar landing. ?m=YYYY-MM picks which month is shown;
 * defaults to the current month. The calendar itself uses search
 * params to navigate prev/next/today, so this page just resolves
 * the month and hands events to the client component.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string }>;
}) {
  const moduleAccess = await checkModuleAccess('schedule');
  if (!moduleAccess.enabled) {
    return <ModuleNotEnabled moduleId="schedule" canManage={moduleAccess.canManage} />;
  }
  // Schedule is manager+ — viewers can't add events and don't see the
  // surface. Sidebar already filters this out for them; redirect on
  // direct URL access.
  const ctx = await requireOrgContext();
  if (!can(ctx, 'schedule:manage')) {
    redirect('/dashboard');
  }
  const params = await searchParams;
  const today = new Date();
  let year = today.getFullYear();
  let month = today.getMonth() + 1;
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

  // 6-week grid: Sunday before the 1st through Saturday after the
  // last → up to 42 cells. Pad the range a few days on each side so
  // multi-day events that overlap the visible window still load.
  const gridStart = new Date(year, month - 1, 1);
  gridStart.setDate(1 - gridStart.getDay());
  const gridEnd = new Date(gridStart);
  gridEnd.setDate(gridStart.getDate() + 42);

  const svc = await ScheduleService.forCurrentUser();
  const events = await svc.listInRange(gridStart, gridEnd);

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
    <div className="container mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--ed-ink-4)]">
            <Calendar className="mr-1 inline h-3 w-3" />
            Workspace · Schedule
          </p>
          <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">
            Team calendar
          </h1>
          <p className="text-muted-foreground mt-1 text-[13.5px]">
            Jobs, deliveries, pickups, drops — anything time + location based.
            Each event is scoped to its warehouse: only staff assigned to
            that warehouse can see it. Click a date to add an event.
          </p>
        </div>
      </div>

      <ScheduleCalendar year={year} month={month} events={calendarEvents} />
    </div>
  );
}
