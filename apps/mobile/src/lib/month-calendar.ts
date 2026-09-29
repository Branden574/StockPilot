import {
  BOOK_REPORT_RANGE_LABELS,
  CALENDAR_COPY,
  CALENDAR_WEEKDAYS_LONG,
  CALENDAR_WEEKDAYS_SHORT,
  addMonths,
  calendarDayLabel,
  calendarDayState,
  calendarMonthTitle,
  canShowNextMonth,
  canShowPreviousMonth,
  monthGrid,
  type CalendarMonth,
  type CalendarRangeDraft,
} from '@stockpilot/core';

/**
 * THE PHONE'S MONTH CALENDAR, as data (plan 5, D7): what each of the 42
 * cells shows and says, kept out of the component so it can be tested (the
 * mobile suite has no React Native renderer).
 *
 * Everything comes from core's zone-free calendar model (report-calendar.ts):
 * the Sunday-first 6 x 7 grid, the range state of each day and the spoken
 * day names. No Date and no Intl here either (Hermes ships a reduced set of
 * weekday and month names, and a device zone would move a day across
 * midnight). "Today" is the organization's day from an answer, never the
 * phone's clock; without one no day is marked.
 */

/** Every day cell is at least this tall and, on a phone in portrait, about
 *  this wide (7 columns across a sheet), so a finger and VoiceOver's outline
 *  get a full target. */
export const CALENDAR_CELL_MIN = 44;

export interface MonthCalendarDay {
  ymd: string;
  /** '1' .. '31'. */
  text: string;
  /** 'Tuesday, September 1, 2026'. */
  label: string;
  /** 'Start date', 'End date', 'In the chosen range', 'Today', joined; null
   *  when none applies. */
  hint: string | null;
  /** The start or the end (filled). */
  selected: boolean;
  /** Strictly between the start and the end (the tinted band). */
  inRange: boolean;
  isToday: boolean;
}

/** A week: seven cells, Sunday first, null outside the month. */
export type MonthCalendarWeek = (MonthCalendarDay | null)[];

export interface MonthCalendarView {
  /** 'September 2026' (the grid's header). */
  title: string;
  weekdays: readonly { short: string; long: string }[];
  weeks: MonthCalendarWeek[];
  /** Each month button: its name, whether it can go further, the month it
   *  shows, and what VoiceOver says once it has (that month's title: the
   *  header is not announced when it changes). */
  previous: { label: string; enabled: boolean; month: CalendarMonth; announce: string };
  next: { label: string; enabled: boolean; month: CalendarMonth; announce: string };
}

export function monthCalendarView(
  month: CalendarMonth,
  draft: CalendarRangeDraft,
  today: string | null,
): MonthCalendarView {
  const weeks = monthGrid(month.y, month.m).map((week) =>
    week.map((cell): MonthCalendarDay | null => {
      if (!cell) return null;
      const st = calendarDayState(cell.ymd, draft, { today });
      const hint = [
        st.isStart ? CALENDAR_COPY.startDate : null,
        st.isEnd ? CALENDAR_COPY.endDate : null,
        st.inRange ? CALENDAR_COPY.inRange : null,
        st.isToday ? BOOK_REPORT_RANGE_LABELS.today : null,
      ].filter((x): x is string => x !== null);
      return {
        ymd: cell.ymd,
        text: String(cell.day),
        label: calendarDayLabel(cell.ymd),
        hint: hint.length > 0 ? hint.join('. ') : null,
        selected: st.selected,
        inRange: st.inRange,
        isToday: st.isToday,
      };
    }),
  );
  return {
    title: calendarMonthTitle(month),
    weekdays: CALENDAR_WEEKDAYS_SHORT.map((short, i) => ({
      short,
      long: CALENDAR_WEEKDAYS_LONG[i]!,
    })),
    weeks,
    previous: {
      label: CALENDAR_COPY.previousMonth,
      enabled: canShowPreviousMonth(month),
      month: addMonths(month, -1),
      announce: calendarMonthTitle(addMonths(month, -1)),
    },
    next: {
      label: CALENDAR_COPY.nextMonth,
      enabled: canShowNextMonth(month),
      month: addMonths(month, 1),
      announce: calendarMonthTitle(addMonths(month, 1)),
    },
  };
}
