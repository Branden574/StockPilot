'use client';

import { ArrowRight, CalendarDays } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { RangeCalendar } from '@/components/ui/range-calendar';
import { cn } from '@/lib/utils';

import {
  BOOK_REPORT_RANGE_LABELS,
  BOOK_REPORT_RANGES,
  BOOK_REPORT_UI,
  CALENDAR_COPY,
  CALENDAR_MIN_MONTH,
  EMPTY_CALENDAR_RANGE,
  bookReportZoneLine,
  calendarDraftFrom,
  calendarEnsureVisible,
  formatReportDate,
  rangeEdit,
  rangePick,
  validateCustomDate,
  type BookReportQuery,
  type BookReportRange,
  type BookReportRangeEcho,
  type CalendarEditing,
  type CalendarMonth,
  type CalendarRangeDraft,
} from '@stockpilot/core';

import { FILTER_CONTROL, FILTER_LABEL } from './filter-classes';
import { withBookReportFilter } from './hrefs';
import { useCommittedSelect } from './use-committed-select';

export interface OrdersPlacedControlProps {
  /** The query to show and build from (the latest requested one). */
  query: BookReportQuery;
  /** The answer's range: its resolved days and the organization's zone.
   *  Null when there is no answer (a timeout). */
  rangeEcho: Pick<
    BookReportRangeEcho,
    'key' | 'from' | 'to' | 'timeZone' | 'timeZoneFallback'
  > | null;
  /** The organization's today, from the answer (never the device's clock). */
  today: string | null;
  onChange: (next: BookReportQuery) => void;
}

/** The days the two fields show: a custom range's own days, else the
 *  preset's resolved days from the answer when the answer is for that
 *  preset, else none (All time, or a preset still loading). */
function ordersPlacedShownDays(
  query: Pick<BookReportQuery, 'range' | 'from' | 'to'>,
  echo: Pick<BookReportRangeEcho, 'key' | 'from' | 'to'> | null,
): { from: string | null; to: string | null } {
  if (query.range === 'custom') return { from: query.from, to: query.to };
  if (echo && echo.key === query.range) return { from: echo.from, to: echo.to };
  return { from: null, to: null };
}

const SM_QUERY = '(min-width: 640px)';

/** Two months side by side from `sm`, one below it. */
function useTwoMonths(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const mq = window.matchMedia(SM_QUERY);
      mq.addEventListener?.('change', onChange);
      return () => mq.removeEventListener?.('change', onChange);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(SM_QUERY).matches : false),
    () => false,
  );
}

/**
 * ORDERS PLACED: the date preset select and the two date fields, over one
 * calendar popover (plan 4.3).
 *
 *   - A preset other than Custom range requests at once (one request per
 *     committed choice: keyboard browsing of the select is not a choice,
 *     use-committed-select.ts). Choosing Custom range (a pick, a click or
 *     Enter) opens the calendar and requests nothing; leaving the select
 *     while it rests on Custom range opens nothing.
 *   - The two fields show the RESOLVED days of the range on screen (This
 *     month reads Sep 1, 2026 to Sep 29, 2026), muted "Start date" and "End
 *     date" for All time. Either field opens the calendar editing that end.
 *   - In the popover: two typed date fields (for exact typing; the browser's
 *     own calendar button is hidden where it can be, so there is one
 *     calendar), the month calendar, the zone, Cancel and Apply. Typing,
 *     hovering and paging months never request anything; Apply requests the
 *     range once, on page 1. Cancel and Escape change nothing and return
 *     focus to what opened the popover.
 */
export function OrdersPlacedControl({
  query,
  rangeEcho,
  today,
  onChange,
}: OrdersPlacedControlProps) {
  const id = React.useId();
  const twoMonths = useTwoMonths();
  const count = twoMonths ? 2 : 1;
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<CalendarRangeDraft>({ ...EMPTY_CALENDAR_RANGE });
  // Set each time the popover opens (the range's first month, else today's).
  const [month, setMonth] = React.useState<CalendarMonth>({ ...CALENDAR_MIN_MONTH });
  const [error, setError] = React.useState<string | null>(null);
  const opener = React.useRef<HTMLElement | null>(null);
  const selectRef = React.useRef<HTMLSelectElement>(null);
  const startRef = React.useRef<HTMLButtonElement>(null);
  const endRef = React.useRef<HTMLButtonElement>(null);
  const anchorRef = React.useRef<HTMLDivElement>(null);

  const shown = ordersPlacedShownDays(query, rangeEcho);

  const openCalendar = (editing: CalendarEditing, from: HTMLElement | null) => {
    opener.current = from;
    if (open) {
      // Already open: the other field only changes which end is picked next.
      setDraft((d) => rangeEdit(d, editing));
      return;
    }
    const start = calendarDraftFrom(shown, today);
    setDraft(rangeEdit(start.draft, editing));
    setMonth(start.month ?? deviceMonth());
    setError(null);
    setOpen(true);
  };

  const preset = useCommittedSelect<BookReportRange>(query.range, (next, how) => {
    if (next === 'custom') {
      // Only a real choice (a pick in the list, a click, Enter) opens the
      // calendar and moves focus into it; leaving the select while it rests
      // on Custom range opens nothing and puts the select back.
      if (how === 'blur') return false;
      openCalendar('start', selectRef.current);
      return;
    }
    onChange(withBookReportFilter(query, { range: next, from: null, to: null }));
  });

  const close = () => {
    setOpen(false);
    setError(null);
    preset.reset();
  };

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const { start, end } = draft;
    if (
      !validateCustomDate(start) ||
      !validateCustomDate(end) ||
      (start as string) > (end as string)
    ) {
      setError(BOOK_REPORT_UI.customRangeInvalid);
      return;
    }
    setOpen(false);
    setError(null);
    if (query.range === 'custom' && query.from === start && query.to === end) {
      preset.reset();
      return;
    }
    onChange(withBookReportFilter(query, { range: 'custom', from: start, to: end }));
  };

  const typed = (which: 'start' | 'end') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setError(null);
    setDraft((d) => ({ ...d, [which]: value === '' ? null : value }));
    // A whole, real day moves the calendar to it.
    if (validateCustomDate(value)) setMonth((m) => calendarEnsureVisible(m, count, value));
  };

  const errorId = `${id}-error`;
  const zoneLine = rangeEcho ? bookReportZoneLine(rangeEcho) : null;
  const waitingForEnd = draft.start !== null && draft.end === null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1.5" data-orders-placed>
        <label htmlFor={`${id}-range`} className={FILTER_LABEL}>
          {BOOK_REPORT_UI.dateRange}
        </label>
        {/* The preset and the date pair share a line only from lg, where the
            column is wide enough; below it the pair gets its own full line. */}
        <div data-orders-placed-row className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <select
            id={`${id}-range`}
            ref={selectRef}
            className={cn(FILTER_CONTROL, 'lg:w-44 lg:shrink-0')}
            {...preset.props}
          >
            {BOOK_REPORT_RANGES.map((r) => (
              <option key={r} value={r}>
                {BOOK_REPORT_RANGE_LABELS[r]}
              </option>
            ))}
          </select>
          {/* One group that never wraps apart: a start date is never left on
              one line and its end on the next. */}
          <PopoverAnchor asChild>
            <div
              ref={anchorRef}
              data-date-pair
              className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5"
            >
              <DateFieldButton
                ref={startRef}
                label={BOOK_REPORT_UI.startDate}
                ymd={shown.from}
                expanded={open}
                onClick={() => openCalendar('start', startRef.current)}
              />
              <ArrowRight aria-hidden className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <DateFieldButton
                ref={endRef}
                label={BOOK_REPORT_UI.endDate}
                ymd={shown.to}
                expanded={open}
                onClick={() => openCalendar('end', endRef.current)}
              />
            </div>
          </PopoverAnchor>
        </div>
      </div>
      <PopoverContent
        aria-label={BOOK_REPORT_UI.dateRange}
        className="w-auto max-w-[calc(100vw-2rem)] p-3"
        // The calendar puts focus on its day; closing returns it to the
        // field (or the select) that opened the popover.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
        onInteractOutside={(e) => {
          // A click on the other date field switches the end being picked
          // instead of closing (and reopening) the popover.
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
      >
        <form noValidate onSubmit={apply} className="space-y-3" data-custom-range>
          <div className="flex gap-2">
            <TypedDate
              id={`${id}-from`}
              label={BOOK_REPORT_UI.startDate}
              value={draft.start}
              invalid={error !== null}
              errorId={errorId}
              onFocus={() => setDraft((d) => rangeEdit(d, 'start'))}
              onChange={typed('start')}
            />
            <TypedDate
              id={`${id}-to`}
              label={BOOK_REPORT_UI.endDate}
              value={draft.end}
              invalid={error !== null}
              errorId={errorId}
              onFocus={() => setDraft((d) => rangeEdit(d, 'end'))}
              onChange={typed('end')}
            />
          </div>
          <RangeCalendar
            month={month}
            onMonthChange={setMonth}
            count={count}
            draft={draft}
            today={today}
            autoFocus
            onPick={(ymd) => {
              setError(null);
              setDraft((d) => rangePick(d, ymd));
            }}
          />
          <p aria-live="polite" className="text-muted-foreground min-h-4 text-xs">
            {waitingForEnd ? CALENDAR_COPY.chooseEndDate : ''}
          </p>
          {error ? (
            <p id={errorId} role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            {zoneLine ? (
              <p className="text-muted-foreground max-w-[16rem] text-xs">{zoneLine}</p>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={close}>
                {BOOK_REPORT_UI.cancel}
              </Button>
              <Button type="submit" size="sm" disabled={draft.start === null || draft.end === null}>
                {BOOK_REPORT_UI.apply}
              </Button>
            </div>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** Where the calendar opens with no range and no answer (a timeout): the
 *  device's month. Only which month is shown; no day is marked today. */
function deviceMonth(): CalendarMonth {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
}

const DateFieldButton = React.forwardRef<
  HTMLButtonElement,
  { label: string; ymd: string | null; expanded: boolean; onClick: () => void }
>(function DateFieldButton({ label, ymd, expanded, onClick }, ref) {
  const text = ymd ? formatReportDate(ymd) : label;
  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={ymd ? `${label}: ${text}` : label}
      onClick={onClick}
      className={cn(FILTER_CONTROL, 'flex min-w-0 flex-1 items-center gap-2 text-left')}
    >
      <CalendarDays aria-hidden className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
      <span className={cn('truncate', !ymd && 'text-muted-foreground')}>{text}</span>
    </button>
  );
});

function TypedDate({
  id,
  label,
  value,
  invalid,
  errorId,
  onFocus,
  onChange,
}: {
  id: string;
  label: string;
  value: string | null;
  invalid: boolean;
  errorId: string;
  onFocus: () => void;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <label htmlFor={id} className={FILTER_LABEL}>
        {label}
      </label>
      <input
        id={id}
        type="date"
        min="2000-01-01"
        max="2100-12-31"
        // One calendar: WebKit and Blink hide their own picker button here
        // (Firefox keeps a small one that sets the same value).
        className={cn(
          FILTER_CONTROL,
          '[color-scheme:light] dark:[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:hidden',
        )}
        value={value ?? ''}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : undefined}
        onFocus={onFocus}
        onChange={onChange}
      />
    </div>
  );
}
