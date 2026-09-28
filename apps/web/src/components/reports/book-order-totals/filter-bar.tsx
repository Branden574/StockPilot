'use client';

import { Loader2, Search, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import {
  BOOK_REPORT_ALL_CATEGORIES,
  BOOK_REPORT_ALL_WAREHOUSES,
  BOOK_REPORT_NO_CATEGORY,
  BOOK_REPORT_OPTIONS_ERROR,
  BOOK_REPORT_RANGE_LABELS,
  BOOK_REPORT_RANGES,
  BOOK_REPORT_SEARCH_MAX,
  BOOK_REPORT_SORT_LABELS,
  BOOK_REPORT_SORTS,
  BOOK_REPORT_STATUS_GROUP_KEYS,
  BOOK_REPORT_UI,
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
  bookReportCategoryOptionLabel,
  bookReportInProgressDetail,
  bookReportShowViewLabel,
  bookReportStatusGroupLabel,
  bookReportViewChangedLine,
  bookReportWarehouseOptionLabel,
  validateCustomDate,
  type BookOrderOptionsResponse,
  type BookReportCategoryEcho,
  type BookReportQuery,
  type BookReportRange,
  type BookReportSort,
  type BookReportStatusGroup,
  type BookReportWarehouseEcho,
  type OrderStatusKey,
} from '@stockpilot/core';

import { bookReportPageHref, withBookReportFilter } from './hrefs';
import { bookReportOptionsKey, cachedBookReportOptions, loadBookReportOptions } from './options';
import { BookReportLink, useBookReportNavigation } from './report-navigation';

/** Typing settles for this long before the report is asked for again. */
export const BOOK_REPORT_SEARCH_DEBOUNCE_MS = 300;

const CONTROL =
  'border-input bg-background focus-visible:ring-ring focus-visible:ring-offset-background h-9 w-full rounded-md border px-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';
const LABEL = 'text-muted-foreground text-xs font-medium';

export interface BookReportFilterBarProps {
  /** The RESOLVED query (a concrete warehouse or all, never 'default'). */
  query: BookReportQuery;
  organizationId: string;
  userId: string;
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  /** The totals answer's own echo, so the selects can name the current
   *  choice while the lists load (or if they fail). */
  warehouseEcho: BookReportWarehouseEcho | null;
  categoryEcho: BookReportCategoryEcho | null;
  /** Set when this report came from the person's warehouse view and the
   *  view has changed since (id null: the view now covers all). */
  viewNow: { id: string | null } | null;
}

/**
 * The filter bar. The URL is the report's state: every change except typing
 * PUSHES a new URL with the page reset, so Back and Forward walk filter
 * states; typing REPLACES it once the search settles, so history is not
 * flooded. Every URL is built from the resolved query, so it keeps the
 * concrete warehouse. The server applies each filter before it adds or
 * pages anything.
 *
 * The warehouse and category lists are loaded here, once per session and
 * never with the numbers (./options.ts): while they load, those two selects
 * show the current choice by name and wait; if they fail, only those two are
 * disabled, with Retry. Dates, statuses, search and sort are fixed
 * vocabularies and always work.
 */
export function BookReportFilterBar(props: BookReportFilterBarProps) {
  const { query, organizationId, userId } = props;
  const { navigate } = useBookReportNavigation();
  const key = bookReportOptionsKey(organizationId, userId);
  const [lists, setLists] = React.useState<{
    key: string;
    options: BookOrderOptionsResponse | null;
    failed: boolean;
  }>(() => ({ key, options: cachedBookReportOptions(key), failed: false }));
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const ctrl = new AbortController();
    loadBookReportOptions(organizationId, userId, ctrl.signal).then(
      (options) => setLists({ key, options, failed: false }),
      () => {
        if (!ctrl.signal.aborted) setLists({ key, options: null, failed: true });
      },
    );
    return () => ctrl.abort();
  }, [key, organizationId, userId, attempt]);

  const options = lists.key === key ? lists.options : null;
  const failed = lists.key === key && lists.failed && !options;
  const listsId = React.useId();

  const go = (next: BookReportQuery) => navigate(bookReportPageHref(next));

  return (
    <section aria-label={BOOK_REPORT_UI.filters} className="space-y-3">
      {props.viewNow && props.warehouseEcho ? (
        <ViewChangedNotice
          query={query}
          shown={props.warehouseEcho}
          nowId={props.viewNow.id}
          nowName={
            props.viewNow.id
              ? (options?.warehouses.find((w) => w.id === props.viewNow!.id)?.name ?? null)
              : null
          }
        />
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))]">
        <DateRangeControl
          key={`${query.range}|${query.from ?? ''}|${query.to ?? ''}`}
          query={query}
          onChange={go}
        />
        <StatusControl query={query} statusLabels={props.statusLabels} onChange={go} />
        <WarehouseControl
          query={query}
          options={options}
          echo={props.warehouseEcho}
          describedBy={listsId}
          onChange={go}
        />
        <CategoryControl
          query={query}
          options={options}
          echo={props.categoryEcho}
          describedBy={listsId}
          onChange={go}
        />
        <SortControl query={query} onChange={go} />
      </div>
      <ListsProblem
        id={listsId}
        loading={!options && !failed}
        failed={failed}
        onRetry={() => {
          setLists({ key, options: null, failed: false });
          setAttempt((a) => a + 1);
        }}
      />
      <SearchControl query={query} />
    </section>
  );
}

function ViewChangedNotice({
  query,
  shown,
  nowId,
  nowName,
}: {
  query: BookReportQuery;
  shown: BookReportWarehouseEcho;
  nowId: string | null;
  nowName: string | null;
}) {
  const now = { id: nowId, name: nowName };
  return (
    <p
      role="status"
      className="border-warning/40 bg-warning/10 text-foreground rounded-md border px-3 py-2 text-sm"
    >
      {bookReportViewChangedLine(now, bookReportWarehouseOptionLabel(shown))}{' '}
      <BookReportLink
        className="font-medium underline underline-offset-2"
        href={bookReportPageHref(
          withBookReportFilter(query, { warehouse: 'default', warehouseFromView: false }),
        )}
      >
        {bookReportShowViewLabel(now)}
      </BookReportLink>
    </p>
  );
}

function DateRangeControl({
  query,
  onChange,
}: {
  query: BookReportQuery;
  onChange: (next: BookReportQuery) => void;
}) {
  const [choice, setChoice] = React.useState<BookReportRange>(query.range);
  const [from, setFrom] = React.useState(query.from ?? '');
  const [to, setTo] = React.useState(query.to ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();

  return (
    <div className={cn('flex flex-col gap-1.5', choice === 'custom' && 'sm:col-span-2')}>
      <label htmlFor={`${id}-range`} className={LABEL}>
        {BOOK_REPORT_UI.dateRange}
      </label>
      <select
        id={`${id}-range`}
        className={CONTROL}
        value={choice}
        onChange={(e) => {
          const next = e.target.value as BookReportRange;
          setChoice(next);
          setError(null);
          if (next !== 'custom') onChange(withBookReportFilter(query, { range: next, from: null, to: null }));
        }}
      >
        {BOOK_REPORT_RANGES.map((r) => (
          <option key={r} value={r}>
            {BOOK_REPORT_RANGE_LABELS[r]}
          </option>
        ))}
      </select>
      {choice === 'custom' ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!validateCustomDate(from) || !validateCustomDate(to) || from > to) {
              setError(BOOK_REPORT_UI.customRangeInvalid);
              return;
            }
            setError(null);
            onChange(withBookReportFilter(query, { range: 'custom', from, to }));
          }}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-from`} className={LABEL}>
              {BOOK_REPORT_UI.from}
            </label>
            <input
              id={`${id}-from`}
              type="date"
              min="2000-01-01"
              max="2100-12-31"
              className={cn(CONTROL, 'w-[10.5rem]')}
              value={from}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-to`} className={LABEL}>
              {BOOK_REPORT_UI.to}
            </label>
            <input
              id={`${id}-to`}
              type="date"
              min="2000-01-01"
              max="2100-12-31"
              className={cn(CONTROL, 'w-[10.5rem]')}
              value={to}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" className="h-9">
            {BOOK_REPORT_UI.apply}
          </Button>
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-destructive w-full text-xs">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

function StatusControl({
  query,
  statusLabels,
  onChange,
}: {
  query: BookReportQuery;
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  onChange: (next: BookReportQuery) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [chosen, setChosen] = React.useState<BookReportStatusGroup[]>(query.statusGroups);
  const id = React.useId();
  const summary = BOOK_REPORT_STATUS_GROUP_KEYS.filter((g) => query.statusGroups.includes(g))
    .map((g) => bookReportStatusGroupLabel(g, statusLabels))
    .join(', ');

  return (
    <div className="flex flex-col gap-1.5">
      <span id={`${id}-label`} className={LABEL}>
        {BOOK_REPORT_UI.status}
      </span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setChosen([...query.statusGroups]);
          setOpen(next);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-labelledby={`${id}-label ${id}-value`}
            className={cn(CONTROL, 'flex items-center text-left')}
          >
            <span id={`${id}-value`} className="truncate">
              {summary}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">{BOOK_REPORT_UI.status}</legend>
            {BOOK_REPORT_STATUS_GROUP_KEYS.map((g) => (
              <label key={g} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={chosen.includes(g)}
                  onChange={(e) =>
                    setChosen((prev) =>
                      e.target.checked
                        ? BOOK_REPORT_STATUS_GROUP_KEYS.filter((k) => k === g || prev.includes(k))
                        : prev.filter((k) => k !== g),
                    )
                  }
                />
                <span>
                  {bookReportStatusGroupLabel(g, statusLabels)}
                  {g === 'in_progress' ? (
                    <span className="text-muted-foreground block text-xs">
                      {bookReportInProgressDetail(statusLabels)}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </fieldset>
          {chosen.length === 0 ? (
            <p role="alert" className="text-destructive mt-2 text-xs">
              {BOOK_REPORT_UI.statusNoneChosen}
            </p>
          ) : null}
          <div className="mt-3 flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                onChange(
                  withBookReportFilter(query, { statusGroups: [...DEFAULT_BOOK_REPORT_STATUS_GROUPS] }),
                );
              }}
            >
              {BOOK_REPORT_UI.statusReset}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={chosen.length === 0}
              onClick={() => {
                setOpen(false);
                onChange(withBookReportFilter(query, { statusGroups: chosen }));
              }}
            >
              {BOOK_REPORT_UI.apply}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** The one line under the selects when the lists are loading (spoken
 *  only) or could not be loaded (with Retry). */
function ListsProblem({
  id,
  loading,
  failed,
  onRetry,
}: {
  id: string;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  if (failed) {
    const message = BOOK_REPORT_OPTIONS_ERROR.replace(/\s+Retry$/, '');
    return (
      <p id={id} role="status" className="text-destructive text-xs">
        {message}{' '}
        <button
          type="button"
          className="font-medium underline underline-offset-2"
          onClick={onRetry}
        >
          {BOOK_REPORT_UI.retry}
        </button>
      </p>
    );
  }
  if (loading) {
    return (
      <p id={id} className="sr-only">
        {BOOK_REPORT_UI.listsLoading}
      </p>
    );
  }
  return null;
}

function WarehouseControl({
  query,
  options,
  echo,
  describedBy,
  onChange,
}: {
  query: BookReportQuery;
  options: BookOrderOptionsResponse | null;
  echo: BookReportWarehouseEcho | null;
  describedBy: string;
  onChange: (next: BookReportQuery) => void;
}) {
  const id = React.useId();
  const value = query.warehouse === 'all' ? 'all' : query.warehouse;
  const choices: { value: string; label: string }[] = [
    { value: 'all', label: BOOK_REPORT_ALL_WAREHOUSES },
  ];
  for (const w of options?.warehouses ?? []) {
    choices.push({ value: w.id, label: bookReportWarehouseOptionLabel(w) });
  }
  if (value !== 'all' && !choices.some((c) => c.value === value)) {
    choices.push({ value, label: echo ? bookReportWarehouseOptionLabel(echo) : value });
  }
  const disabled = !options;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-warehouse`} className={LABEL}>
        {BOOK_REPORT_UI.warehouse}
      </label>
      <select
        id={`${id}-warehouse`}
        className={CONTROL}
        value={value}
        disabled={disabled}
        aria-describedby={disabled ? describedBy : undefined}
        onChange={(e) => {
          const next = e.target.value;
          onChange(
            withBookReportFilter(query, {
              warehouse: next === 'all' ? 'all' : next,
              warehouseFromView: false,
            }),
          );
        }}
      >
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CategoryControl({
  query,
  options,
  echo,
  describedBy,
  onChange,
}: {
  query: BookReportQuery;
  options: BookOrderOptionsResponse | null;
  echo: BookReportCategoryEcho | null;
  describedBy: string;
  onChange: (next: BookReportQuery) => void;
}) {
  const id = React.useId();
  const value = query.category;
  const choices: { value: string; label: string }[] = [
    { value: 'all', label: BOOK_REPORT_ALL_CATEGORIES },
  ];
  for (const c of options?.categories ?? []) {
    choices.push({ value: c.id, label: bookReportCategoryOptionLabel(c) });
  }
  if (options?.uncategorized || value === 'none') {
    choices.push({ value: 'none', label: BOOK_REPORT_NO_CATEGORY });
  }
  if (value !== 'all' && !choices.some((c) => c.value === value)) {
    choices.push({ value, label: echo ? bookReportCategoryOptionLabel(echo) : value });
  }
  const disabled = !options;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-category`} className={LABEL}>
        {BOOK_REPORT_UI.category}
      </label>
      <select
        id={`${id}-category`}
        className={CONTROL}
        value={value}
        disabled={disabled}
        aria-describedby={disabled ? describedBy : undefined}
        onChange={(e) => onChange(withBookReportFilter(query, { category: e.target.value }))}
      >
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SortControl({
  query,
  onChange,
}: {
  query: BookReportQuery;
  onChange: (next: BookReportQuery) => void;
}) {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-sort`} className={LABEL}>
        {BOOK_REPORT_UI.sort}
      </label>
      <select
        id={`${id}-sort`}
        className={CONTROL}
        value={query.sort}
        onChange={(e) =>
          onChange(withBookReportFilter(query, { sort: e.target.value as BookReportSort }))
        }
      >
        {BOOK_REPORT_SORTS.map((s) => (
          <option key={s} value={s}>
            {BOOK_REPORT_SORT_LABELS[s]}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The search box. Typing settles for BOOK_REPORT_SEARCH_DEBOUNCE_MS, then
 * REPLACES the history entry (a burst of keystrokes is one entry); Enter and
 * the clear button search at once. The box is not re-keyed on the URL (that
 * would drop focus mid-word): it remembers the last query it applied and
 * adopts the URL's `q` only when that changes from outside (Back, Forward, a
 * link, another filter).
 */
function SearchControl({ query }: { query: BookReportQuery }) {
  const { navigate, pending } = useBookReportNavigation();
  const [q, setQ] = React.useState(query.q);
  const applied = React.useRef(query.q.trim());
  const inputRef = React.useRef<HTMLInputElement>(null);
  const id = React.useId();

  React.useEffect(() => {
    if (query.q.trim() !== applied.current) {
      applied.current = query.q.trim();
      setQ(query.q);
    }
  }, [query.q]);

  const apply = React.useCallback(
    (value: string) => {
      const next = value.trim().slice(0, BOOK_REPORT_SEARCH_MAX);
      if (next === applied.current) return;
      applied.current = next;
      navigate(bookReportPageHref(withBookReportFilter(query, { q: next })), { replace: true });
    },
    [navigate, query],
  );

  React.useEffect(() => {
    if (q.trim() === applied.current) return;
    const t = setTimeout(() => apply(q), BOOK_REPORT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, apply]);

  return (
    <form
      role="search"
      aria-label={BOOK_REPORT_UI.search}
      onSubmit={(e) => {
        e.preventDefault();
        apply(q);
      }}
      className="flex w-full flex-col gap-1.5 sm:max-w-md"
    >
      <label htmlFor={`${id}-q`} className={LABEL}>
        {BOOK_REPORT_UI.search}
      </label>
      <div className="relative">
        <Search
          aria-hidden
          className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
        />
        <Input
          ref={inputRef}
          id={`${id}-q`}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={BOOK_REPORT_SEARCH_MAX}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={BOOK_REPORT_UI.searchPlaceholder}
          className="h-9 pl-8 pr-16 text-[13px] [&::-webkit-search-cancel-button]:hidden"
        />
        <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {pending ? (
            <Loader2 aria-hidden className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
          ) : null}
          {q ? (
            <button
              type="button"
              onClick={() => {
                setQ('');
                apply('');
                inputRef.current?.focus();
              }}
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded p-1 focus-visible:outline-none focus-visible:ring-2"
              aria-label={BOOK_REPORT_UI.clearSearch}
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {pending ? BOOK_REPORT_UI.searching : ''}
      </p>
    </form>
  );
}
