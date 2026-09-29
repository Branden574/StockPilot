'use client';

import * as React from 'react';

import {
  BOOK_REPORT_SHOWING,
  bookReportCharterLine,
  bookReportShowingParts,
  type BookReportCharterEcho,
  type BookReportCharterFilters,
  type BookReportCategoryEcho,
  type BookReportQuery,
  type BookReportRangeEcho,
  type BookReportWarehouseEcho,
  type BookReportWarehouseSource,
  type OrderStatusKey,
} from '@stockpilot/core';

import { bookReportCharterLabelsFor, useLoadedBookReportOptions } from './options';
import { BookReportShowingChips } from './showing-chips';

/** The slice of the totals answer the Showing block reads (its echoes). */
export interface BookReportShowingEchoes {
  range: Pick<BookReportRangeEcho, 'key' | 'from' | 'to'>;
  summary: { firstOrderDate: string | null; lastOrderDate: string | null };
  filters: BookReportCharterFilters & {
    warehouse: BookReportWarehouseEcho | null;
    category: BookReportCategoryEcho | null;
    uncategorized: boolean;
  };
  warehouse: { source: BookReportWarehouseSource };
}

/**
 * SHOWING (brief 8, plan 4.2): what the figures under it are for, so no one
 * has to wonder whether they are looking at every charter or one, all time
 * or one month.
 *
 *   Showing
 *   Charter Alder · CH-A · Sep 1 – Sep 30, 2026        (announced when it changes)
 *   Warehouse: DC4 (your warehouse view)               (whenever one warehouse is in effect)
 *   Eligible orders
 *   [chips]  Clear filters
 *
 * Every word comes from the ANSWER's echoes through core's
 * bookReportShowingParts, never from the URL, so the block always describes
 * the numbers below it. The warehouse line appears whenever the report
 * covers one warehouse, the warehouse view included (plan D20): a view on a
 * warehouse with no orders would otherwise read "All charters, All time"
 * over zeros. A view warehouse is not a chip (Clear filters goes back to it).
 *
 * A charter is named with the same label the Charter select uses, once the
 * lists have loaded (core's id tie-break for two same-named charters);
 * until then, from the answer's echo.
 */
export function BookReportShowingBlock({
  echoes,
  query,
  statusLabels,
  organizationId,
  userId,
}: {
  echoes: BookReportShowingEchoes;
  /** The query the answer was read for (resolved). */
  query: BookReportQuery;
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  organizationId: string;
  userId: string;
}) {
  const headingId = React.useId();
  const options = useLoadedBookReportOptions(organizationId, userId);
  const charterLabels = bookReportCharterLabelsFor(options, [echoes.filters.charter]);
  const parts = bookReportShowingParts(echoes, query.statusGroups, { charterLabels });
  const part = (key: string) => parts.find((p) => p.key === key)?.text ?? null;
  const charter = part('charter');
  const range = part('range');
  const warehouse = part('warehouse');
  const status = part('status');

  return (
    <section
      aria-labelledby={headingId}
      data-showing
      className="border-border bg-card rounded-md border px-4 py-3"
    >
      <h2
        id={headingId}
        className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wider"
      >
        {BOOK_REPORT_SHOWING}
      </h2>
      <p
        role="status"
        data-showing-scope
        className="mt-1 text-base font-medium [overflow-wrap:anywhere]"
      >
        <span>{charter}</span>
        <span aria-hidden className="text-muted-foreground mx-1.5">
          ·
        </span>
        <span className="sr-only">, </span>
        <span>{range}</span>
      </p>
      {warehouse ? <p className="text-muted-foreground mt-0.5 text-sm">{warehouse}</p> : null}
      {status ? <p className="text-muted-foreground mt-0.5 text-sm">{status}</p> : null}
      <BookReportShowingChips
        query={query}
        echoes={echoes}
        statusLabels={statusLabels}
        charterLabels={charterLabels}
      />
    </section>
  );
}

/**
 * The scope lines' Charter line ("Charter: Charter Alder · CH-A"), named
 * with the same label as the Charter select, the chips and the Showing
 * block once the lists have loaded (core's id tie-break for two same-named
 * charters); until then from the answer's echo. A client piece of the
 * server-rendered scope lines, for that reason only.
 */
export function BookReportCharterScopeLine({
  charter,
  noCharter,
  organizationId,
  userId,
}: {
  charter: BookReportCharterEcho | null;
  noCharter: boolean;
  organizationId: string;
  userId: string;
}) {
  const options = useLoadedBookReportOptions(organizationId, userId);
  const labels = bookReportCharterLabelsFor(options, [charter]);
  return <p>{bookReportCharterLine(charter, noCharter, labels)}</p>;
}
