'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

import {
  CALENDAR_COPY,
  CALENDAR_WEEKDAYS_LONG,
  CALENDAR_WEEKDAYS_SHORT,
  calendarDayLabel,
  calendarDayState,
  calendarEnsureVisible,
  calendarMonthTitle,
  calendarVisibleMonths,
  canShowNextMonth,
  canShowPreviousMonth,
  addMonths,
  compareMonths,
  isCalendarDay,
  keyMove,
  monthGrid,
  monthOf,
  type CalendarMonth,
  type CalendarRangeDraft,
} from '@stockpilot/core';

export interface RangeCalendarProps {
  /** The first month shown. */
  month: CalendarMonth;
  onMonthChange: (month: CalendarMonth) => void;
  /** Months side by side: 1 below `sm`, 2 from `sm` (the control decides). */
  count?: number;
  /** The range being picked. */
  draft: CalendarRangeDraft;
  /** A day was chosen (click, Enter or Space). Nothing is requested here:
   *  only the control's Apply sends a range. */
  onPick: (ymd: string) => void;
  /** The organization's today (from the answer, never the device's clock),
   *  outlined. Null: no day is marked. */
  today?: string | null;
  /** Move focus to the active day when the calendar mounts. */
  autoFocus?: boolean;
  className?: string;
}

/**
 * A range calendar over core's zone-free model (report-calendar.ts): every
 * day is an org-local 'YYYY-MM-DD' string, weeks start on Sunday, and no
 * date object of the device's zone is ever built, so a daylight-saving day is
 * an ordinary cell.
 *
 * Semantics follow the WAI-ARIA date picker dialog: each month is a
 * `role="grid"` table labelled by its title, one day holds the roving
 * `tabIndex=0`, the arrow keys move a day or a week, PageUp and PageDown a
 * month (with Shift a year), Home and End the start and end of the week.
 * Each day is a button named like "Tuesday, September 1, 2026"; its cell
 * carries `aria-selected` on the start and the end, and today's button
 * `aria-current="date"`. A mouse hover previews the band while the end is
 * being picked; hover, keys and month paging never request anything.
 */
export function RangeCalendar({
  month,
  onMonthChange,
  count = 1,
  draft,
  onPick,
  today = null,
  autoFocus = false,
  className,
}: RangeCalendarProps) {
  const months = calendarVisibleMonths(month, count);
  const first = months[0]!;
  const last = months[months.length - 1]!;
  const [active, setActive] = React.useState<string | null>(null);
  const [hover, setHover] = React.useState<string | null>(null);
  // Set when a key moved the tab stop (or on mount with autoFocus): the
  // next render's day button takes focus.
  const focusNext = React.useRef(autoFocus);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const baseId = React.useId();

  // A typed field can hold any string a date input allows (a six-digit
  // year, a day outside 2000-2100): such a day is simply not shown.
  const visible = (ymd: string | null): ymd is string => {
    if (!isCalendarDay(ymd)) return false;
    const m = monthOf(ymd);
    return compareMonths(m, first) >= 0 && compareMonths(m, last) <= 0;
  };
  // The day that holds the tab stop: the one last moved to, else the end
  // being picked, else the start, else today, else the first of the month.
  const editingDay = draft.editing === 'end' ? (draft.end ?? draft.start) : draft.start;
  const activeDay =
    [active, editingDay, draft.start, draft.end, today].find(visible) ??
    monthGrid(first.y, first.m)
      .flat()
      .find((cell) => cell !== null)!.ymd;

  React.useEffect(() => {
    if (!focusNext.current) return;
    const btn = gridRef.current?.querySelector<HTMLButtonElement>(
      `button[data-day="${activeDay}"]`,
    );
    if (btn) {
      focusNext.current = false;
      btn.focus();
    }
  });

  const moveTo = (ymd: string) => {
    focusNext.current = true;
    setActive(ymd);
    const nextFirst = calendarEnsureVisible(month, count, ymd);
    if (compareMonths(nextFirst, first) !== 0) onMonthChange(nextFirst);
  };

  const onDayKeyDown = (ymd: string) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const next = keyMove(ymd, e.key, { shift: e.shiftKey });
    if (next === null) return;
    e.preventDefault();
    moveTo(next);
  };

  return (
    <div
      ref={gridRef}
      className={cn('flex flex-col gap-4 sm:flex-row sm:gap-6', className)}
      onPointerLeave={() => setHover(null)}
    >
      {months.map((m, index) => {
        const titleId = `${baseId}-title-${index}`;
        return (
          <div key={`${m.y}-${m.m}`} className="w-[16rem] shrink-0">
            <div className="mb-2 flex h-9 items-center justify-between">
              {index === 0 ? (
                <button
                  type="button"
                  aria-label={CALENDAR_COPY.previousMonth}
                  disabled={!canShowPreviousMonth(first)}
                  onClick={() => onMonthChange(addMonths(first, -1))}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex h-9 w-9 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40"
                >
                  <ChevronLeft aria-hidden className="h-4 w-4" />
                </button>
              ) : (
                <span aria-hidden className="h-9 w-9" />
              )}
              <h3 id={titleId} aria-live="polite" className="text-sm font-medium">
                {calendarMonthTitle(m)}
              </h3>
              {index === months.length - 1 ? (
                <button
                  type="button"
                  aria-label={CALENDAR_COPY.nextMonth}
                  disabled={!canShowNextMonth(last)}
                  onClick={() => onMonthChange(addMonths(first, 1))}
                  className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex h-9 w-9 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-40"
                >
                  <ChevronRight aria-hidden className="h-4 w-4" />
                </button>
              ) : (
                <span aria-hidden className="h-9 w-9" />
              )}
            </div>
            <table role="grid" aria-labelledby={titleId} className="w-full border-collapse">
              <thead>
                <tr>
                  {CALENDAR_WEEKDAYS_SHORT.map((d, i) => (
                    <th
                      key={CALENDAR_WEEKDAYS_LONG[i]}
                      scope="col"
                      abbr={CALENDAR_WEEKDAYS_LONG[i]}
                      className="text-muted-foreground h-8 w-9 text-center text-xs font-medium"
                    >
                      <span aria-hidden>{d}</span>
                      <span className="sr-only">{CALENDAR_WEEKDAYS_LONG[i]}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthGrid(m.y, m.m).map((week, w) => (
                  <tr key={w}>
                    {week.map((cell, c) => {
                      if (!cell) return <td key={c} role="gridcell" className="h-9 w-9 p-0" />;
                      const s = calendarDayState(cell.ymd, draft, { today, hover });
                      const band = s.inRange || s.inPreview;
                      return (
                        <td
                          key={c}
                          role="gridcell"
                          aria-selected={s.selected}
                          className={cn(
                            'h-9 w-9 p-0 text-center',
                            band && 'bg-primary/10',
                            s.isStart &&
                              draft.end !== null &&
                              draft.end !== cell.ymd &&
                              'bg-primary/10 rounded-l-md',
                            s.isEnd &&
                              draft.start !== null &&
                              draft.start !== cell.ymd &&
                              'bg-primary/10 rounded-r-md',
                          )}
                        >
                          <button
                            type="button"
                            data-day={cell.ymd}
                            data-state={s.selected ? 'selected' : band ? 'band' : undefined}
                            tabIndex={cell.ymd === activeDay ? 0 : -1}
                            aria-label={calendarDayLabel(cell.ymd)}
                            aria-current={s.isToday ? 'date' : undefined}
                            onClick={() => {
                              setActive(cell.ymd);
                              onPick(cell.ymd);
                            }}
                            onKeyDown={onDayKeyDown(cell.ymd)}
                            onPointerEnter={(e) => {
                              if (e.pointerType === 'mouse') setHover(cell.ymd);
                            }}
                            className={cn(
                              'focus-visible:ring-ring inline-flex h-9 w-9 items-center justify-center rounded-md text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2',
                              s.selected
                                ? 'bg-primary text-primary-foreground font-semibold'
                                : 'hover:bg-accent hover:text-accent-foreground',
                              s.isToday &&
                                !s.selected &&
                                'ring-muted-foreground/60 ring-1 ring-inset',
                            )}
                          >
                            {cell.day}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
