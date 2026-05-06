'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
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
}

const WEEK_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STATUS_TONE: Record<CalendarEvent['status'], string> = {
  scheduled: 'border-foreground/30 bg-foreground/5 text-foreground',
  in_progress: 'border-warning/40 bg-warning/10 text-warning-foreground',
  completed: 'border-success/40 bg-success/10 text-success line-through opacity-70',
  cancelled: 'border-destructive/40 bg-destructive/10 text-destructive line-through opacity-60',
};

function formatHeader(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, {
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

export function ScheduleCalendar({ year, month, events }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const today = React.useMemo(() => new Date(), []);

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
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navMonth(-1)}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navMonth(1)}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={goToToday}
            className="ml-1"
          >
            Today
          </Button>
        </div>
        <h2 className="font-display text-[20px] font-medium tracking-tight">
          {formatHeader(year, month)}
        </h2>
        <Button asChild variant="gradient" size="sm">
          <Link href="/dashboard/schedule/new">+ New event</Link>
        </Button>
      </div>

      <div className="border-border bg-card overflow-hidden rounded-xl border">
        <div className="grid grid-cols-7 border-b border-border bg-muted/40">
          {WEEK_HEADERS.map((h) => (
            <div
              key={h}
              className="text-muted-foreground py-1.5 text-center text-[10.5px] font-medium uppercase tracking-[0.1em]"
            >
              {h}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((d, i) => {
            const inMonth = d.getMonth() === month - 1;
            const isToday = isSameDay(d, today);
            const dayEvents = byDay.get(ymd(d)) ?? [];
            const visible = dayEvents.slice(0, 3);
            const overflow = dayEvents.length - visible.length;
            return (
              <div
                key={i}
                className={cn(
                  'group relative min-h-[110px] border-b border-r border-border p-1.5',
                  i % 7 === 6 && 'border-r-0',
                  i >= 35 && 'border-b-0',
                  !inMonth && 'bg-muted/20',
                )}
              >
                <div className="flex items-start justify-between">
                  <span
                    className={cn(
                      'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] tabular-nums',
                      isToday
                        ? 'bg-foreground text-background font-medium'
                        : inMonth
                          ? 'text-foreground'
                          : 'text-muted-foreground',
                    )}
                  >
                    {d.getDate()}
                  </span>
                  <Link
                    href={`/dashboard/schedule/new?date=${ymd(d)}`}
                    className="text-muted-foreground hover:text-foreground text-[10px] opacity-0 transition group-hover:opacity-100"
                    aria-label={`Add event on ${ymd(d)}`}
                  >
                    + Add
                  </Link>
                </div>
                <div className="mt-1 space-y-1">
                  {visible.map((ev) => {
                    const time = ev.allDay
                      ? null
                      : new Date(ev.startsAt).toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                        });
                    return (
                      <Link
                        key={ev.id}
                        href={`/dashboard/schedule/${ev.id}`}
                        className={cn(
                          'block truncate rounded border px-1.5 py-0.5 text-[10.5px] leading-tight',
                          STATUS_TONE[ev.status],
                        )}
                        title={ev.title}
                      >
                        {time ? <span className="opacity-70">{time} </span> : null}
                        {ev.title}
                      </Link>
                    );
                  })}
                  {overflow > 0 ? (
                    <Link
                      href={`/dashboard/schedule?m=${year}-${String(month).padStart(2, '0')}&day=${ymd(d)}`}
                      className="text-muted-foreground hover:text-foreground block px-1.5 text-[10px]"
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
  );
}
