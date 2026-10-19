'use client';

import { ChevronRight } from 'lucide-react';

import {
  BOOK_REPORT_BY_CHARTER_TITLE,
  BOOK_REPORT_BY_CHARTER_UNITS_NOTE,
  BOOK_REPORT_NO_CHARTER,
  bookReportByCharterApplyLabel,
  bookReportByCharterTotalLine,
  bookReportByCharterValue,
  bookReportCharterOptionLabel,
  type BookReportCharterTotal,
  type BookReportQuery,
} from '@stockpilot/core';

import { bookReportPageHref, withBookReportFilter } from './hrefs';
import { bookReportCharterLabelsFor, useLoadedBookReportOptions } from './options';
import { BookReportLink, useCurrentBookReportQuery } from './report-navigation';

/**
 * BOOKS ORDERED BY CHARTER (brief 14, plan 4.2 and 7): shown only with All
 * charters chosen, collapsed by default, a plain list and not a chart.
 *
 * The rows come from the SAME statement as the summary (0382's byCharter),
 * so they partition it: every order has one charter or none, the copies add
 * up to Total books ordered and the orders to Orders containing books (the
 * closing line states the summary's own figures). No charter comes last.
 * Distinct book entries do not add across charters, so they are not listed.
 *
 * Each row applies its charter (page 1), built from the latest requested
 * query like every other control, so a change still loading is kept.
 */
export function BookReportByCharter({
  rows,
  summary,
  query,
  organizationId,
  userId,
}: {
  rows: readonly BookReportCharterTotal[];
  summary: { copies: string; orders: number; unresolved: { entries: number } };
  /** The query the answer was read for (resolved). */
  query: BookReportQuery;
  organizationId: string;
  userId: string;
}) {
  const current = useCurrentBookReportQuery(query);
  const options = useLoadedBookReportOptions(organizationId, userId);
  const labels = bookReportCharterLabelsFor(
    options,
    rows.flatMap((r) => (r.id ? [{ id: r.id, name: r.name, code: r.code, status: r.status }] : [])),
  );
  const otherUnits = summary.unresolved.entries > 0;
  return (
    <details data-by-charter className="border-border bg-card group rounded-lg border">
      {/* A card header (DESIGN-SPEC 6.7) that opens the list; the chevron
          turns while it is open. The words are the summary's own. */}
      <summary className="hover:bg-muted flex cursor-pointer list-none items-center gap-2 rounded-lg px-[18px] py-3.5 text-[13.5px] font-medium transition-colors group-open:rounded-b-none [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90"
          strokeWidth={1.8}
        />
        {BOOK_REPORT_BY_CHARTER_TITLE}
      </summary>
      <div className="border-border border-t px-[18px] pb-3.5 pt-2.5">
        <ul className="space-y-0.5 text-[13px]">
          {rows.map((r) => {
            const label = r.id
              ? (labels.get(r.id) ?? bookReportCharterOptionLabel(r))
              : BOOK_REPORT_NO_CHARTER;
            const next = withBookReportFilter(current, { charter: r.id ?? 'none' });
            const value = bookReportByCharterValue(r.copies, r.orders, otherUnits);
            return (
              <li key={r.id ?? 'none'} data-charter-row={r.id ?? 'none'}>
                <BookReportLink
                  href={bookReportPageHref(next)}
                  query={next}
                  aria-label={`${bookReportByCharterApplyLabel(label)}, ${value}`}
                  className="hover:bg-muted hover:text-foreground focus-visible:ring-ring -mx-1.5 flex min-h-8 items-baseline gap-2 rounded-md px-1.5 py-1.5 focus-visible:outline-none focus-visible:ring-2 max-sm:min-h-11"
                >
                  <span className="min-w-0 underline-offset-2 [overflow-wrap:anywhere] hover:underline">
                    {label}
                  </span>
                  <span
                    aria-hidden
                    className="border-line-strong min-w-4 flex-1 translate-y-[-0.25em] border-b border-dotted"
                  />
                  <span className="text-ink-2 shrink-0 tabular-nums">{value}</span>
                </BookReportLink>
              </li>
            );
          })}
        </ul>
        <p className="border-border mt-2.5 border-t pt-2.5 text-[13px] font-medium">
          {bookReportByCharterTotalLine(summary)}
        </p>
        {otherUnits ? (
          <p className="text-muted-foreground mt-1 text-[12px]">
            {BOOK_REPORT_BY_CHARTER_UNITS_NOTE}
          </p>
        ) : null}
      </div>
    </details>
  );
}
