'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { formatOrgDate, formatOrgTime } from '@/lib/timezone';
import { useHydrated } from '@/lib/use-hydrated';
import { cn } from '@/lib/utils';

interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  locationText: string | null;
}

interface Props {
  /** Year/month being viewed (1-12 for month). */
  year: number;
  month: number;
  events: CalendarEvent[];
  /** Whether the current user holds schedule:manage. When false (a read-only
      grantee of schedule:read), every add-event affordance — the "+ New
      event" header button and the per-day "+ Add" links — is hidden.
      Defaults to false (fail closed); the server page passes the real
      value. */
  canManage?: boolean;
}

const WEEK_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Status tones from the redesign tokens (DESIGN-SPEC 6.10): scheduled is the
// neutral pill on the card colour, in progress the warning wash, completed
// the success wash and cancelled the destructive wash. Completed and
// cancelled keep the strike-through, and every chip also carries its status
// word for screen readers, so colour is never the only cue. The washes are
// tuned per theme, so one class reads in light and dark.
const STATUS_TONE: Record<CalendarEvent['status'], string> = {
  scheduled: 'border-line-strong bg-card text-foreground',
  in_progress: 'border-transparent bg-warning-wash text-warning',
  completed: 'border-transparent bg-success-wash text-success line-through',
  cancelled: 'border-transparent bg-destructive-wash text-destructive line-through',
};

/** The status words the event page prints, read after a chip's title. */
const STATUS_LABEL: Record<CalendarEvent['status'], string> = {
  scheduled: 'Scheduled',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function formatHeader(year: number, month: number): string {
  // Use noon UTC on the 15th so neither local-tz nor org-tz shifts
  // the rendered month (DST transitions can shift a midnight date by
  // ±1 day; noon-on-15 is safely inside the target calendar month).
  return formatOrgDate(new Date(Date.UTC(year, month - 1, 15, 12)), {
    month: 'long',
    year: 'numeric',
  });
}

function startOfMonthGrid(year: number, month: number): Date {
  const first = new Date(year, month - 1, 1);
  const day = first.getDay(); // 0 = Sunday
  return new Date(year, month - 1, 1 - day);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function ScheduleCalendar({ year, month, events, canManage = false }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const today = React.useMemo(() => new Date(), []);
  // Which cell an event sits in, and which is today, come from the clock's
  // LOCAL day: the server's (UTC on Vercel) while it renders, the viewer's in
  // the browser. An evening event is the next day in UTC, so the server drew
  // it in another cell (React error #418), and the server's today stayed
  // marked. Both are drawn once hydrated; the grid itself is the same on both.
  const hydrated = useHydrated();

  // Bucket events by ymd of start date (events spanning multiple days
  // currently render only on their start day — keeps the cells uncluttered;
  // multi-day rendering is a polish-pass concern).
  const byDay = React.useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const key = ymd(new Date(ev.startsAt));
      const list = m.get(key) ?? [];
      list.push(ev);
      m.set(key, list);
    }
    return m;
  }, [events]);

  const gridStart = startOfMonthGrid(year, month);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    cells.push(d);
  }

  function navMonth(delta: number) {
    const next = new Date(year, month - 1 + delta, 1);
    const params = new URLSearchParams(searchParams.toString());
    params.set('m', `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`);
    router.push(`${pathname}?${params.toString()}`);
  }

  function goToToday() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('m');
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => navMonth(-1)}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => navMonth(1)}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={goToToday} className="ml-1">
            Today
          </Button>
        </div>
        <h2 className="text-foreground font-display text-[20px] font-medium leading-[30px] tracking-[-0.02em]">
          {formatHeader(year, month)}
        </h2>
        {canManage && (
          <Button asChild variant="gradient">
            <Link href="/dashboard/schedule/new">+ New event</Link>
          </Button>
        )}
      </div>

      {/* The month grid. Below about 640 px the seven columns scroll inside
          the card (the page itself never scrolls sideways), so every day keeps
          its chips, its "+ Add" link and its "+N more" link at phone width. */}
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="border-border bg-sunk grid grid-cols-7 border-b">
              {WEEK_HEADERS.map((h) => (
                <div
                  key={h}
                  className="text-muted-foreground px-2 py-2.5 text-center text-[11px] font-medium uppercase leading-[16.5px] tracking-[0.06em]"
                >
                  {h}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {cells.map((d, i) => {
                const inMonth = d.getMonth() === month - 1;
                const isToday = hydrated && isSameDay(d, today);
                const dayEvents = hydrated ? (byDay.get(ymd(d)) ?? []) : [];
                const visible = dayEvents.slice(0, 3);
                const overflow = dayEvents.length - visible.length;
                return (
                  <div
                    key={i}
                    className={cn(
                      'border-border group relative min-h-[112px] min-w-0 border-b border-r p-1.5',
                      i % 7 === 6 && 'border-r-0',
                      i >= 35 && 'border-b-0',
                      !inMonth && 'bg-sunk',
                    )}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <span
                        className={cn(
                          'inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[12px] tabular-nums',
                          isToday
                            ? 'bg-foreground text-background font-medium'
                            : inMonth
                              ? 'text-foreground'
                              : 'text-muted-foreground',
                        )}
                      >
                        {d.getDate()}
                      </span>
                      {canManage && (
                        // Revealed on hover, and always when it or anything in
                        // its day holds the keyboard focus, and on touch
                        // screens, where there is no hover (CONFLICTS D18).
                        // Focus in the day is the descendant selector, not
                        // Tailwind's group-focus-within variant, which Safari
                        // pays for on every focus change of every page
                        // (lib/group-focus-variants.guard.test.ts).
                        <Link
                          href={`/dashboard/schedule/new?date=${ymd(d)}`}
                          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring pointer-coarse:opacity-100 rounded px-1 text-[11px] leading-6 opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 group-hover:opacity-100 [.group:focus-within_&]:opacity-100"
                          aria-label={`Add event on ${ymd(d)}`}
                        >
                          + Add
                        </Link>
                      )}
                    </div>
                    <div className="mt-1 space-y-1">
                      {visible.map((ev) => {
                        const time = ev.allDay
                          ? null
                          : formatOrgTime(new Date(ev.startsAt), {
                              hour: 'numeric',
                              minute: '2-digit',
                            });
                        return (
                          <Link
                            key={ev.id}
                            href={`/dashboard/schedule/${ev.id}`}
                            data-status={ev.status}
                            className={cn(
                              'focus-visible:ring-ring block truncate rounded-[4px] border px-1.5 py-0.5 text-[11px] leading-4 focus-visible:outline-none focus-visible:ring-2',
                              STATUS_TONE[ev.status],
                            )}
                            title={ev.title}
                          >
                            {/* The time at the chip's full tone: on a status wash a
                                faded time fell under 4.5:1. The title's weight sets
                                it apart instead. */}
                            {time ? <span className="tabular-nums">{time} </span> : null}
                            <span className="font-medium">{ev.title}</span>
                            <span className="sr-only">, {STATUS_LABEL[ev.status]}</span>
                          </Link>
                        );
                      })}
                      {overflow > 0 ? (
                        <Link
                          href={`/dashboard/schedule?m=${year}-${String(month).padStart(2, '0')}&day=${ymd(d)}`}
                          className="text-muted-foreground hover:text-foreground block px-1.5 text-[11px] leading-4"
                        >
                          +{overflow} more
                        </Link>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
