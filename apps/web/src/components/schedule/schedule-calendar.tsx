'use client';

import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';

import { textActionTouchMarginTop, touchTargetClass } from '@/components/patterns/touch-target';
import { Button } from '@/components/ui/button';
import { IntentLink } from '@/components/ui/intent-link';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatOrgDate, formatOrgTime } from '@/lib/timezone';
import { cn } from '@/lib/utils';

import { formatCalendarDate, orgDayOf, plainSpaces } from '@stockpilot/core';

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
  /**
   * The organization's zone (organizations.timezone, resolved): each event
   * sits on its start day there and prints its time there. Defaults to the
   * documented default zone (core ORG_TIMEZONE_DEFAULT); the page passes the
   * organization's.
   */
  timeZone?: string;
  /**
   * The organization's today, "YYYY-MM-DD", as the page worked it out: the
   * cell that is marked today. Null marks none.
   */
  todayYmd?: string | null;
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

function formatHeader(year: number, month: number, timeZone: string | undefined): string {
  // Use noon UTC on the 15th so neither local-tz nor org-tz shifts
  // the rendered month (DST transitions can shift a midnight date by
  // ±1 day; noon-on-15 is safely inside the target calendar month).
  return formatOrgDate(
    new Date(Date.UTC(year, month - 1, 15, 12)),
    { month: 'long', year: 'numeric' },
    timeZone,
  );
}

/** One cell of the 6-week grid: a calendar day, with no time and no zone. */
interface GridDay {
  /** "YYYY-MM-DD". */
  ymd: string;
  /** Day of the month. */
  day: number;
  /** Inside the month being viewed. */
  inMonth: boolean;
}

/**
 * The 42 days of a month's grid, Sunday before the 1st onward: calendar
 * arithmetic in UTC, so the same days on the server and in any browser.
 * Module-private: this is a 'use client' module, and a plain function a
 * server component imported from it would be a client reference (recurring
 * pattern #8); the schedule page works its range out from the same rule.
 */
function monthGridDays(year: number, month: number): GridDay[] {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0 = Sunday
  const days: GridDay[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(year, month - 1, 1 - firstWeekday + i));
    days.push({
      ymd: d.toISOString().slice(0, 10),
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month - 1,
    });
  }
  return days;
}

/**
 * What an event says on the calendar: its time, its title and, for screen
 * readers, its status word. The cell's chip and the row in a busy day's list
 * both say it, each in its STATUS_TONE, so the two cannot drift apart
 * (recurring pattern 26). Only the words and the tone are shared: each keeps
 * its own layout (the chip is one truncated line with its title as a
 * tooltip; the row wraps).
 */
function ChipWords({ ev, timeZone }: { ev: CalendarEvent; timeZone: string | undefined }) {
  // Plain spaces: this text is rendered on the server and again in the
  // browser, and newer ICU (and Hermes) put a narrow no-break space before
  // AM/PM, so an engine that does it on one side only would not hydrate.
  const time = ev.allDay
    ? null
    : plainSpaces(
        formatOrgTime(new Date(ev.startsAt), { hour: 'numeric', minute: '2-digit' }, timeZone),
      );
  return (
    <>
      {/* The time at the chip's full tone: on a status wash a faded time fell
          under 4.5:1. The title's weight sets it apart instead. The time and
          its space are one text node: as `{time} ` they were two, and Chrome
          drops a space-only text node at the end of an inline element when it
          names the link ("9:00 AMDelivery run", B100). */}
      {time ? <span className="tabular-nums">{`${time} `}</span> : null}
      <span className="font-medium">{ev.title}</span>
      <span className="sr-only">, {STATUS_LABEL[ev.status]}</span>
    </>
  );
}

/** A busy day's date in its "+N more" name and on its list: "Tuesday, July 14". */
const DAY_LABEL: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' };

/**
 * Brings a row of a busy day's list into the list's view when the keyboard
 * moves focus to it. Radix keeps Tab inside the list, and its wrap from Close
 * back to the last row (Shift+Tab) focuses with preventScroll
 * (@radix-ui/react-focus-scope), which leaves that row out of view in a list
 * that scrolls.
 *
 * Only when the focus ring shows (:focus-visible), as the report filter's
 * calendar (orders-placed-control.tsx) and the storefront's kit strip
 * (storefront-kit-card.tsx) do. Chrome and Edge, and Chrome on Android on a
 * tap, focus a link when it is pressed, before the release: scrolling then
 * would move a row that is partly out of view from under the pointer, and a
 * press near the list's edge would end outside the row and open nothing. A
 * browser that cannot answer :focus-visible (none that this app supports)
 * scrolls nothing, as the report filter's calendar.
 */
function revealKeyboardFocusedRow(e: React.FocusEvent<HTMLUListElement>): void {
  const row: Element = e.target;
  if (row === e.currentTarget) return;
  let ring = false;
  try {
    ring = row.matches(':focus-visible');
  } catch {
    return;
  }
  if (ring) row.scrollIntoView({ block: 'nearest' });
}

interface DayMoreProps {
  /** The day, "YYYY-MM-DD". */
  ymd: string;
  /** Every event that starts that day, in the order the page passed them (by start). */
  events: CalendarEvent[];
  /** How many of them the cell does not show. */
  overflow: number;
  timeZone: string | undefined;
}

/**
 * A busy day's "+N more" (B46): a button that opens a list of every event
 * that starts that day, each row opening its event. It was a link to
 * ?m=...&day=..., and the page reads only ?m=, so it drew the same month
 * again: the fourth and later events of a busy day could not be opened from
 * the calendar. The list needs no read: the page passes every event of the
 * grid's days, and byDay keeps all of a day's.
 *
 * The list is a popover in a portal, so the grid's sideways scroller cannot
 * clip it. Radix gives the keyboard and screen-reader parts: the button says
 * it opens a dialog, opening it puts focus on Close, Tab goes through the
 * events (and stays in the list), and Escape or Close shuts it and returns
 * focus to the button. A row does not close the list: a modified click opens
 * the event in a new tab and the list stays.
 */
function DayMore({ ymd, events, overflow, timeZone }: DayMoreProps) {
  const [open, setOpen] = React.useState(false);
  const titleId = React.useId();
  // The day in UTC words (core formatCalendarDate): the same on the server
  // and in any browser, so the button's name hydrates. Closed, the button has
  // no id either (Radix sets aria-controls only while open).
  const day = formatCalendarDate(ymd, DAY_LABEL);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* The link's look across its cell: a button shrinks to its text
            without w-full, and keeps the arrow cursor without cursor-pointer.
            Below sm and on coarse pointers its target grows to 44 px, and it
            keeps 14 px from the chip above so the target ends at that chip
            (components/patterns/touch-target.ts). Each busy cell names its own
            day; "N more" stays in the name for voice control. */}
        <button
          type="button"
          aria-label={`${overflow} more ${overflow === 1 ? 'event' : 'events'} on ${day}`}
          className={cn(
            touchTargetClass,
            textActionTouchMarginTop,
            'text-muted-foreground hover:text-foreground focus-visible:ring-ring block w-full cursor-pointer rounded-[4px] px-1.5 text-left text-[11px] leading-4 focus-visible:outline-none focus-visible:ring-2',
          )}
        >
          +{overflow} more
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-labelledby={titleId}
        collisionPadding={8}
        // Never taller than the room Radix measures on the side it opens on,
        // so on a short or landscape screen a long day scrolls inside it.
        className="flex max-h-[min(24rem,var(--radix-popover-content-available-height))] w-72 flex-col p-3"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p id={titleId} className="text-foreground text-[13.5px] font-medium">
              {day}
            </p>
            <p className="text-muted-foreground text-[12px]">{events.length} events</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Close"
            onClick={() => setOpen(false)}
          >
            <X aria-hidden />
          </Button>
        </div>
        {/* role="list" keeps it a list for VoiceOver in Safari. The padding,
            and the rows' scroll margin when one is scrolled to, leave room
            inside the scroller for a row's focus ring. */}
        <ul
          role="list"
          // A row the keyboard reaches is brought into the list's view; a row
          // pressed with a mouse or a tap stays under the pointer.
          onFocus={revealKeyboardFocusedRow}
          className="-mx-1 mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain p-1"
        >
          {events.map((ev) => (
            <li key={ev.id}>
              {/* 32 px rows, 44 px below sm and on coarse pointers, as the
                  other popovers' rows. */}
              <IntentLink
                href={`/dashboard/schedule/${ev.id}`}
                data-status={ev.status}
                className={cn(
                  'focus-visible:ring-ring pointer-coarse:min-h-11 flex min-h-8 scroll-my-1 items-center rounded-[4px] border px-2 py-1.5 text-[13px] leading-5 focus-visible:outline-none focus-visible:ring-2 max-sm:min-h-11',
                  STATUS_TONE[ev.status],
                )}
              >
                {/* One span: a flex item drops a trailing space, which would
                    run the time into the title. */}
                <span className="min-w-0 break-words">
                  <ChipWords ev={ev} timeZone={timeZone} />
                </span>
              </IntentLink>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function ScheduleCalendar({
  year,
  month,
  events,
  canManage = false,
  timeZone,
  todayYmd = null,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Each event sits in the cell of its start day in the ORGANIZATION's zone,
  // and today is the organization's today (small fixes slice 8). Both used to
  // come from the clock's local day, the server's (UTC on Vercel) and then the
  // viewer's, drawn once hydrated (#331): a viewer outside the organization's
  // zone saw events on other days, and could open the organization's month
  // with their own today outside its grid, with no Today mark. Fixed props
  // draw the same calendar on the server and in the browser.
  //
  // Events spanning multiple days render only on their start day (keeps the
  // cells uncluttered; multi-day rendering is a polish-pass concern).
  const byDay = React.useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const ev of events) {
      const key = orgDayOf(ev.startsAt, timeZone);
      if (key === null) continue;
      const list = m.get(key) ?? [];
      list.push(ev);
      m.set(key, list);
    }
    return m;
  }, [events, timeZone]);

  const cells = monthGridDays(year, month);

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
          {formatHeader(year, month, timeZone)}
        </h2>
        {canManage && (
          <Button asChild variant="gradient">
            <Link href="/dashboard/schedule/new">+ New event</Link>
          </Button>
        )}
      </div>

      {/* The month grid. Below about 640 px the seven columns scroll inside
          the card (the page itself never scrolls sideways), so every day keeps
          its chips, its "+ Add" link and its "+N more" button, which lists the
          whole day, at phone width. It never scrolls up and down: the last
          row's cells leave room for a "+N more" touch target (below), and
          overflow-y-hidden keeps anything else that reaches past the grid
          from scrolling the card. */}
      <div className="border-border bg-card overflow-hidden rounded-lg border">
        <div className="overflow-x-auto overflow-y-hidden">
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
                const inMonth = d.inMonth;
                const isToday = d.ymd === todayYmd;
                const dayEvents = byDay.get(d.ymd) ?? [];
                const visible = dayEvents.slice(0, 3);
                const overflow = dayEvents.length - visible.length;
                return (
                  <div
                    key={i}
                    className={cn(
                      'border-border group relative min-h-[112px] min-w-0 border-b border-r p-1.5',
                      i % 7 === 6 && 'border-r-0',
                      i >= 35 && 'border-b-0',
                      // Below sm and on coarse pointers a "+N more" target
                      // reaches 14 px below its 16 px line (touchTargetClass,
                      // 44 px). In the last row nothing is below it, so the
                      // cell keeps those 14 px itself; with 6 px the target
                      // hung 8 px past the grid and a script's scrollIntoView
                      // could scroll the card (B100).
                      i >= 35 && 'pointer-coarse:pb-3.5 max-sm:pb-3.5',
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
                        {d.day}
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
                          href={`/dashboard/schedule/new?date=${d.ymd}`}
                          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring pointer-coarse:opacity-100 rounded px-1 text-[11px] leading-6 opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 group-hover:opacity-100 [.group:focus-within_&]:opacity-100"
                          aria-label={`Add event on ${d.ymd}`}
                        >
                          + Add
                        </Link>
                      )}
                    </div>
                    <div className="mt-1 space-y-1">
                      {visible.map((ev) => (
                        <Link
                          key={ev.id}
                          href={`/dashboard/schedule/${ev.id}`}
                          data-status={ev.status}
                          // `relative`: the status word is sr-only, which is
                          // absolutely positioned. Positioned by the chip, it
                          // is cut by the chip's clip; positioned by the day
                          // cell, it sat at the end of the uncut title and
                          // widened the grid past Saturday (B100).
                          className={cn(
                            'focus-visible:ring-ring relative block truncate rounded-[4px] border px-1.5 py-0.5 text-[11px] leading-4 focus-visible:outline-none focus-visible:ring-2',
                            STATUS_TONE[ev.status],
                          )}
                          title={ev.title}
                        >
                          <ChipWords ev={ev} timeZone={timeZone} />
                        </Link>
                      ))}
                      {overflow > 0 ? (
                        // Keyed by the day, so a month change closes the list.
                        <DayMore
                          key={d.ymd}
                          ymd={d.ymd}
                          events={dayEvents}
                          overflow={overflow}
                          timeZone={timeZone}
                        />
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
