'use client';

import { X } from 'lucide-react';

import {
  BOOK_REPORT_UI,
  bookReportActiveFilters,
  bookReportClearedQuery,
  type BookReportFilterEchoes,
  type BookReportQuery,
  type OrderStatusKey,
} from '@stockpilot/core';

import { bookReportPageHref } from './hrefs';
import { BookReportLink, useCurrentBookReportQuery } from './report-navigation';

/**
 * The active-filter chips and Clear filters (brief 8, plan 4.2).
 *
 * WHICH chips show, and their words, come from the answer on screen: the
 * rendered query decides which filters are set, and core's
 * bookReportActiveFilters words them from the answer's echoes (never the
 * URL). WHERE each one leads is built from the LATEST REQUESTED query (plan
 * trap 23): removing the dates while a charter change is still loading keeps
 * the new charter, as every other control does (report-navigation.tsx).
 *
 * Each chip is its text and a separate remove link (a real link: it works
 * before the script loads and opens in a new tab), named "Remove charter
 * filter" and at least 24 px square. Clear filters resets charter, dates,
 * status, warehouse (back to the warehouse view), category and search, and
 * keeps the sort. Every link starts at page 1.
 */
export function BookReportShowingChips({
  query,
  echoes,
  statusLabels,
  charterLabels,
}: {
  /** The query the answer on screen was read for. */
  query: BookReportQuery;
  echoes: BookReportFilterEchoes;
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  charterLabels: ReadonlyMap<string, string>;
}) {
  const current = useCurrentBookReportQuery(query);
  const chips = bookReportActiveFilters(query, echoes, statusLabels, {
    base: current,
    charterLabels,
  });
  if (chips.length === 0) return null;
  const cleared = bookReportClearedQuery(current);
  return (
    <div data-filter-chips className="mt-3 flex flex-wrap items-center gap-2">
      <ul className="flex min-w-0 flex-wrap gap-2">
        {chips.map((chip) => (
          <li
            key={chip.key}
            data-chip={chip.key}
            className="border-border bg-muted/50 inline-flex min-w-0 max-w-full items-center gap-0.5 rounded-full border py-0.5 pl-3 pr-0.5 text-xs"
          >
            <span className="min-w-0 truncate" title={chip.text}>
              {chip.text}
            </span>
            <BookReportLink
              href={bookReportPageHref(chip.cleared)}
              query={chip.cleared}
              aria-label={chip.removeLabel}
              className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2"
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </BookReportLink>
          </li>
        ))}
      </ul>
      <BookReportLink
        href={bookReportPageHref(cleared)}
        query={cleared}
        className="text-foreground focus-visible:ring-ring rounded text-xs font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2"
      >
        {BOOK_REPORT_UI.clearFilters}
      </BookReportLink>
    </div>
  );
}
