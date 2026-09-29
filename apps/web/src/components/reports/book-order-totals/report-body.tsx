import { BookX, ShieldAlert } from 'lucide-react';
import Link from 'next/link';

import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getOrgRowForRequest } from '@/lib/dashboard/request-cache';
import { getActiveWarehouseFilter } from '@/lib/warehouse-filter';
import {
  BookOrderTotalsService,
  resolveBookReportWarehouse,
} from '@/server/services/book-order-totals';
import { ServiceError } from '@/server/services/context';

import {
  BOOK_REPORT_AS_SAVED,
  BOOK_REPORT_EMPTY,
  BOOK_REPORT_EMPTY_CHARTER_WAREHOUSE,
  BOOK_REPORT_EMPTY_DEFAULT_STATUS,
  BOOK_REPORT_EMPTY_SEARCH,
  BOOK_REPORT_FILTERS_RESET,
  BOOK_REPORT_HOW_COUNTED,
  BOOK_REPORT_LIST_NOUN,
  BOOK_REPORT_METRICS,
  BOOK_REPORT_MFA_ENROLL,
  BOOK_REPORT_MFA_VERIFY,
  BOOK_REPORT_PAGE_SIZE,
  BOOK_REPORT_RESTRICTED,
  BOOK_REPORT_TIMEOUT,
  BOOK_REPORT_UI,
  DEFAULT_BOOK_REPORT_STATUS_GROUPS,
  bookReportCategoryLine,
  bookReportCharterLine,
  bookReportWithoutFilter,
  calendarToday,
  bookReportGeneratedLine,
  bookReportGrandTotalLine,
  bookReportQuantityColumnLabel,
  bookReportRangeLine,
  bookReportRowBadges,
  bookReportSearchLine,
  bookReportStatusLabels,
  bookReportStatusLine,
  bookReportTableCaption,
  bookReportWarehouseLine,
  bookReportZoneLine,
  copiesRequestedText,
  formatListFooter,
  formatReportDate,
  formatReportQuantity,
  latestOrderText,
  ordersCountText,
  parseBookReportQuery,
  resolvedBookReportQuery,
  rowQuantityText,
  serializeBookReportQuery,
  totalPagesFor,
  unresolvedUnitsNote,
  type BookOrderTotalsResponse,
  type BookReportQuery,
  type BookReportRow,
  type OrderStatusKey,
  type ResolvedBookReportWarehouse,
} from '@stockpilot/core';

import { BookCover, type BookCoverSource } from './book-cover';
import { BookReportByCharter } from './by-charter';
import { BookReportExportMenu } from './export-menu';
import { BookReportFilterBar } from './filter-bar';
import { BOOK_REPORT_PATH } from './hrefs';
import { BookIdentityLine } from './identity-line';
import { BookOrdersDrawer, ViewOrdersButton } from './orders-drawer';
import {
  BookReportBusyRegion,
  BookReportNavigationProvider,
  BookReportPagerLink,
  BookReportRefreshButton,
} from './report-navigation';
import { BookReportShowingBlock, type BookReportShowingEchoes } from './showing-block';

export type BookReportSearchParams = Record<string, string | string[] | undefined>;

export interface BookOrderTotalsBodyProps {
  searchParams: Promise<BookReportSearchParams>;
  organizationId: string;
  userId: string;
  /** reports:export: the export controls render only for its holders. */
  canExport: boolean;
  /** Whether this person has a warehouse view to speak of (managers and
   *  up); staff never get a "your view changed" notice. */
  hasWarehouseView: boolean;
}

type RefusedFilter = 'invalid_warehouse' | 'invalid_category' | 'invalid_charter';

function filterIdReason(e: unknown): RefusedFilter | null {
  if (!(e instanceof ServiceError) || e.code !== 'validation_error') return null;
  const reason = e.details?.reason;
  return reason === 'invalid_warehouse' ||
    reason === 'invalid_category' ||
    reason === 'invalid_charter'
    ? reason
    : null;
}

/**
 * The query with a refused id dropped (core's own rule, page 1), or null
 * when that key is already at its default, so nothing could change and the
 * refusal is not retried. A charter the caller may not report on (unknown,
 * another organization's, or outside their scope: one refusal for all
 * three, plan D3) goes back to All charters.
 */
function withoutRefused(query: BookReportQuery, reason: RefusedFilter): BookReportQuery | null {
  switch (reason) {
    case 'invalid_warehouse':
      return query.warehouse === 'default' ? null : bookReportWithoutFilter(query, 'warehouse');
    case 'invalid_category':
      return query.category === 'all' ? null : bookReportWithoutFilter(query, 'category');
    case 'invalid_charter':
      return query.charter === 'all' ? null : bookReportWithoutFilter(query, 'charter');
  }
}

/** Refused ids one link can carry (warehouse, category, charter), plus the
 *  read that finally answers. */
const READ_ATTEMPTS = 4;

function mfaReason(e: unknown): 'mfa_required' | 'aal2_required' | null {
  if (!(e instanceof ServiceError) || e.code !== 'forbidden') return null;
  const reason = e.details?.reason;
  return reason === 'mfa_required' || reason === 'aal2_required' ? reason : null;
}

function isTimeout(e: unknown): boolean {
  return e instanceof ServiceError && e.details?.reason === 'timeout';
}

/**
 * BOOK ORDER TOTALS, the page body (a server component inside the page's
 * Suspense boundary, so the header paints first).
 *
 * ONE awaited read decides every number: the service's single statement
 * (summary, total count and one page of grouped rows from one snapshot).
 * The filter lists are NOT awaited here (the filter bar loads them), and the
 * covers start after the numbers and stream into their cells, so neither
 * can hold back or change a total. A failure never renders cards or zeros:
 * an MFA refusal gets its own enroll or verify state, a timeout says so,
 * and anything else goes to the segment's error boundary.
 *
 * The warehouse is resolved once (the URL's own value, else the person's
 * warehouse view, else all) and every link the page renders carries the
 * resolved value, never "default".
 *
 * A warehouse, category or charter in the link that the caller may not use
 * is dropped here, on the server, and the page says so ("Some filters in
 * this link were not valid and were reset."): up to three refusals in one
 * link, so four reads at most. Nothing on the client ever rewrites the
 * address bar (recurring pattern 18); every link on the page is built from
 * the reset query. A refused charter is never shown by name and never as
 * "0 results".
 */
export async function BookOrderTotalsBody(props: BookOrderTotalsBodyProps) {
  const sp = await props.searchParams;
  const parsed = parseBookReportQuery(sp);
  let query = parsed.query;
  let filtersReset = parsed.invalid.length > 0;

  const svc = await BookOrderTotalsService.forCurrentUser();
  // Already in hand from the request's membership bundle (no extra round
  // trip); only the organization's own status labels are read from it.
  const orgRow = getOrgRowForRequest(props.organizationId).catch(() => null);
  // Only when this URL came from the person's warehouse view: has the view
  // moved since? Read beside the numbers, never before them.
  const viewNow =
    props.hasWarehouseView && query.warehouseFromView
      ? getActiveWarehouseFilter().catch(() => undefined)
      : Promise.resolve(undefined);

  let resolved: ResolvedBookReportWarehouse | null = null;
  let answer: BookOrderTotalsResponse | null = null;
  for (let attempt = 0; attempt < READ_ATTEMPTS && !answer; attempt += 1) {
    try {
      resolved = await resolveBookReportWarehouse(query);
      answer = await svc.page(query, resolved);
    } catch (e) {
      const reason = filterIdReason(e);
      const reset = reason && attempt < READ_ATTEMPTS - 1 ? withoutRefused(query, reason) : null;
      if (reset) {
        // A warehouse, category or charter in this link the caller cannot
        // use (or that no longer exists): drop that key, say so, and read
        // again.
        query = reset;
        filtersReset = true;
        continue;
      }
      const mfa = mfaReason(e);
      if (mfa) return <BookReportMfaState reason={mfa} query={query} />;
      if (isTimeout(e) && resolved) {
        // Too slow for these filters: say so, and keep the filters on
        // screen so they can be narrowed. No figure is shown.
        const labels = bookReportStatusLabels((await orgRow)?.order_status_config ?? null);
        return (
          <BookReportNavigationProvider>
            <div className="space-y-6">
              <FiltersResetNote shown={filtersReset} />
              <BookReportFilterBar
                query={resolvedBookReportQuery(query, resolved)}
                organizationId={props.organizationId}
                userId={props.userId}
                statusLabels={labels}
                warehouseEcho={null}
                categoryEcho={null}
                charterEcho={null}
                rangeEcho={null}
                today={null}
                viewNow={null}
              />
              <BookReportProblem message={BOOK_REPORT_TIMEOUT} />
            </div>
          </BookReportNavigationProvider>
        );
      }
      throw e;
    }
  }
  if (!answer || !resolved) {
    throw new ServiceError('internal_error', 'book order totals: filters could not be reset');
  }

  const rows = answer.rows;
  // Covers for this page only, after the numbers, never awaited here. The
  // promise never rejects; each cell gets its own promise: a URL, no cover,
  // or a cover that could not be loaded (a failed lookup counts as that).
  const ids = rows.map((r) => r.itemId);
  const covers = svc
    .coverLookup(ids)
    .catch(() => ({ urls: {} as Record<string, string>, unresolved: ids }));
  const coverFor = (itemId: string): Promise<BookCoverSource> =>
    covers.then((l) => ({
      url: l.urls[itemId] ?? null,
      failed: !(itemId in l.urls) && l.unresolved.includes(itemId),
    }));

  const [row, viewNowId] = await Promise.all([orgRow, viewNow]);
  const statusLabels = bookReportStatusLabels(row?.order_status_config ?? null);

  const rq: BookReportQuery = { ...resolvedBookReportQuery(query, resolved), page: answer.page };
  const pageSize = answer.pageSize ?? BOOK_REPORT_PAGE_SIZE;
  const totalPages = totalPagesFor(answer.totalCount, pageSize);
  const viewChanged =
    resolved.source === 'view' && viewNowId !== undefined && viewNowId !== resolved.id
      ? { id: viewNowId }
      : null;
  // Only the echoes the Showing block reads cross to the client (not rows).
  const showing: BookReportShowingEchoes = {
    range: answer.range,
    summary: {
      firstOrderDate: answer.summary.firstOrderDate,
      lastOrderDate: answer.summary.lastOrderDate,
    },
    filters: answer.filters,
    warehouse: { source: answer.warehouse.source },
  };
  const byCharter = answer.byCharter ?? null;

  return (
    <BookReportNavigationProvider query={rq}>
      <div className="space-y-6">
        <FiltersResetNote shown={filtersReset} />

        <BookReportFilterBar
          query={rq}
          organizationId={props.organizationId}
          userId={props.userId}
          statusLabels={statusLabels}
          warehouseEcho={answer.filters.warehouse}
          categoryEcho={answer.filters.category}
          charterEcho={answer.filters.charter ?? null}
          rangeEcho={answer.range}
          today={calendarToday(answer.generatedAtLocal)}
          viewNow={viewChanged}
        />

        <div className="flex flex-wrap items-start justify-end gap-2">
          <BookReportRefreshButton />
          {props.canExport ? <BookReportExportMenu query={rq} totalCount={answer.totalCount} /> : null}
        </div>

        <BookReportBusyRegion className="space-y-6">
          <BookReportShowingBlock
            echoes={showing}
            query={rq}
            statusLabels={statusLabels}
            organizationId={props.organizationId}
            userId={props.userId}
          />
          <SummaryCards answer={answer} />
          {byCharter && byCharter.length > 0 ? (
            <BookReportByCharter
              rows={byCharter}
              summary={{
                copies: answer.summary.copies,
                orders: answer.summary.orders,
                unresolved: { entries: answer.summary.unresolved.entries },
              }}
              query={rq}
              organizationId={props.organizationId}
              userId={props.userId}
            />
          ) : null}
          <ScopeLines answer={answer} query={rq} statusLabels={statusLabels} />

          {rows.length === 0 ? (
            <EmptyState
              icon={BookX}
              size="sm"
              title={BOOK_REPORT_EMPTY}
              description={[
                // A charter with one warehouse in effect (chosen, or the
                // warehouse view): its orders may be at another warehouse.
                answer.filters.charter && answer.filters.warehouse
                  ? BOOK_REPORT_EMPTY_CHARTER_WAREHOUSE
                  : null,
                sameGroups(rq.statusGroups, DEFAULT_BOOK_REPORT_STATUS_GROUPS)
                  ? BOOK_REPORT_EMPTY_DEFAULT_STATUS
                  : null,
                answer.scope.restricted ? BOOK_REPORT_RESTRICTED : null,
                rq.q ? BOOK_REPORT_EMPTY_SEARCH : null,
              ]
                .filter(Boolean)
                .join(' ')}
            />
          ) : (
            <BooksTable answer={answer} totalPages={totalPages} coverFor={coverFor} />
          )}

          <nav
            aria-label={BOOK_REPORT_UI.pagesNav}
            className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
              {formatListFooter(
                {
                  page: answer.page,
                  pageSize,
                  total: answer.totalCount,
                  totalPages,
                  itemCount: rows.length,
                },
                BOOK_REPORT_LIST_NOUN,
              )}
            </p>
            <div className="flex gap-2">
              <BookReportPagerLink query={rq} step={-1} enabled={answer.page > 1} rel="prev">
                {BOOK_REPORT_UI.previous}
              </BookReportPagerLink>
              <BookReportPagerLink
                query={rq}
                step={1}
                enabled={answer.page < totalPages}
                rel="next"
              >
                {BOOK_REPORT_UI.next}
              </BookReportPagerLink>
            </div>
          </nav>
          <div className="space-y-1">
            <p className="text-sm font-semibold">{bookReportGrandTotalLine(answer.summary, totalPages)}</p>
            <UnresolvedNote answer={answer} />
          </div>
        </BookReportBusyRegion>
      </div>

      <BookOrdersDrawer
        organizationId={props.organizationId}
        query={rq}
        statusLabels={statusLabels}
        titles={Object.fromEntries(rows.map((r) => [r.itemId, r.name]))}
      />
    </BookReportNavigationProvider>
  );
}

/** Said when a key in the link was not valid (or named a warehouse or
 *  category the caller cannot see) and was reset. Rendered in the same place
 *  in every state, so the filter bar keeps its position (and its focus). */
function FiltersResetNote({ shown }: { shown: boolean }) {
  if (!shown) return null;
  return (
    <p role="status" className="border-warning/40 bg-warning/10 rounded-md border px-3 py-2 text-sm">
      {BOOK_REPORT_FILTERS_RESET}
    </p>
  );
}

function sameGroups(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}

function UnresolvedNote({ answer }: { answer: BookOrderTotalsResponse }) {
  const { unresolved } = answer.summary;
  if (unresolved.entries <= 0) return null;
  const onlyOther = answer.rows.filter((r) => !r.countsAsCopies);
  const unit = unresolved.entries === 1 && onlyOther.length === 1 ? onlyOther[0]!.unit : undefined;
  return <p className="text-muted-foreground text-xs">{unresolvedUnitsNote(unresolved, unit)}</p>;
}

function MetricCard({
  id,
  label,
  value,
  unit,
  definition,
  note,
}: {
  id: string;
  label: string;
  value: string;
  unit?: string;
  definition: string;
  note?: React.ReactNode;
}) {
  return (
    <div className="bg-card border-border rounded-md border px-4 py-3" role="group" aria-labelledby={id}>
      <h2 id={id} className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">
        {label}
      </h2>
      <p className="mt-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {unit ? <span className="text-muted-foreground ml-1.5 text-sm">{unit}</span> : null}
      </p>
      <p className="text-muted-foreground mt-1 text-xs">{definition}</p>
      {note}
    </div>
  );
}

function SummaryCards({ answer }: { answer: BookOrderTotalsResponse }) {
  const { summary } = answer;
  const copies = formatReportQuantity(summary.copies);
  const copiesWords = copiesRequestedText(summary.copies).slice(copies.length + 1);
  return (
    <section aria-label={BOOK_REPORT_UI.summaryRegion} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <MetricCard
        id="book-report-metric-copies"
        label={BOOK_REPORT_METRICS.copies.label}
        value={copies}
        unit={copiesWords}
        definition={BOOK_REPORT_METRICS.copies.definition}
        note={<UnresolvedNote answer={answer} />}
      />
      <MetricCard
        id="book-report-metric-entries"
        label={BOOK_REPORT_METRICS.entries.label}
        value={summary.entries.toLocaleString('en-US')}
        definition={BOOK_REPORT_METRICS.entries.definition}
      />
      <MetricCard
        id="book-report-metric-orders"
        label={BOOK_REPORT_METRICS.orders.label}
        value={summary.orders.toLocaleString('en-US')}
        definition={BOOK_REPORT_METRICS.orders.definition}
      />
    </section>
  );
}

function ScopeLines({
  answer,
  query,
  statusLabels,
}: {
  answer: BookOrderTotalsResponse;
  query: BookReportQuery;
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
}) {
  const category = bookReportCategoryLine(answer.filters.category, answer.filters.uncategorized);
  const search = bookReportSearchLine(query.q);
  return (
    <section aria-label={BOOK_REPORT_UI.scopeRegion} className="text-muted-foreground space-y-1 text-sm">
      <p>{bookReportRangeLine(answer.range, answer.summary)}</p>
      <p>{bookReportCharterLine(answer.filters.charter, answer.filters.noCharter)}</p>
      <p>{bookReportStatusLine(query.statusGroups, statusLabels)}</p>
      <p>{bookReportWarehouseLine(answer.filters.warehouse, answer.warehouse.source)}</p>
      {category ? <p>{category}</p> : null}
      {search ? <p>{search}</p> : null}
      <p>
        {bookReportGeneratedLine(answer.generatedAtLocal)} {bookReportZoneLine(answer.range)}
      </p>
      <p>{BOOK_REPORT_AS_SAVED}</p>
      {answer.scope.restricted ? <p className="text-foreground">{BOOK_REPORT_RESTRICTED}</p> : null}
      <details className="pt-1">
        <summary className="text-foreground cursor-pointer text-sm font-medium">
          {BOOK_REPORT_UI.howCounted}
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
          {BOOK_REPORT_HOW_COUNTED.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function BooksTable({
  answer,
  totalPages,
  coverFor,
}: {
  answer: BookOrderTotalsResponse;
  totalPages: number;
  coverFor: (itemId: string) => Promise<BookCoverSource>;
}) {
  return (
    <div className="border-border bg-card rounded-md border">
      <Table>
        <TableCaption className="sr-only">
          {bookReportTableCaption(answer.sort, answer.page, totalPages)}
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="w-14 px-2 sm:px-3">
              {BOOK_REPORT_UI.columnCover}
            </TableHead>
            <TableHead scope="col" className="px-2 sm:px-3">
              {BOOK_REPORT_UI.columnBook}
            </TableHead>
            <TableHead scope="col" className="px-2 text-right sm:px-3">
              {bookReportQuantityColumnLabel(answer.summary.unresolved.entries > 0)}
            </TableHead>
            <TableHead scope="col" className="hidden text-right sm:table-cell">
              {BOOK_REPORT_UI.columnOrders}
            </TableHead>
            <TableHead scope="col" className="hidden md:table-cell">
              {BOOK_REPORT_UI.columnLatest}
            </TableHead>
            <TableHead scope="col" className="hidden sm:table-cell sm:px-3">
              <span className="sr-only">{BOOK_REPORT_UI.columnActions}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {answer.rows.map((row) => (
            <BookRow key={row.itemId} row={row} cover={coverFor(row.itemId)} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function BookRow({ row, cover }: { row: BookReportRow; cover: Promise<BookCoverSource> }) {
  const badges = bookReportRowBadges(row);
  return (
    <TableRow data-item-id={row.itemId}>
      <TableCell className="w-14 px-2 py-2 sm:px-3">
        <BookCover cover={cover} title={row.name} />
      </TableCell>
      <th scope="row" className="px-2 py-2 text-left align-middle font-normal sm:px-3">
        <span className="block font-medium [overflow-wrap:anywhere]">{row.name}</span>
        <BookIdentityLine row={row} className="text-muted-foreground block text-xs" />
        <span className="text-muted-foreground block text-xs sm:hidden">
          {[ordersCountText(row.orders), latestOrderText(row.latestOrderDate)].filter(Boolean).join(' · ')}
        </span>
        {badges.length > 0 ? (
          <span className="mt-1 flex flex-wrap gap-1">
            {badges.map((b) => (
              <Badge key={b} variant="outline" className="text-[10.5px] font-medium">
                {b}
              </Badge>
            ))}
          </span>
        ) : null}
      </th>
      <TableCell className="px-2 text-right font-semibold tabular-nums sm:px-3">
        {row.countsAsCopies ? formatReportQuantity(row.copies) : rowQuantityText(row)}
        {/* At phone width View orders sits under the total, so the Book
            column has room to keep an ISBN whole and the table fits a
            390 px screen; from sm up it has its own column (below). */}
        <span className="mt-2 block sm:hidden">
          <ViewOrdersButton itemId={row.itemId} title={row.name} />
        </span>
      </TableCell>
      <TableCell className="hidden text-right tabular-nums sm:table-cell">
        {row.orders.toLocaleString('en-US')}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap md:table-cell">
        {formatReportDate(row.latestOrderDate)}
      </TableCell>
      <TableCell className="hidden text-right sm:table-cell sm:px-3">
        <ViewOrdersButton itemId={row.itemId} title={row.name} />
      </TableCell>
    </TableRow>
  );
}

/** A figure-free problem state: the reason and Refresh. Never cards.
 *  Rendered inside BookReportNavigationProvider. */
function BookReportProblem({ message }: { message: string }) {
  return (
    <div role="alert" className="border-border bg-card space-y-3 rounded-md border p-4">
      <p className="text-sm">{message}</p>
      <BookReportRefreshButton />
    </div>
  );
}

/**
 * The MFA refusal as a state, not an error page. reports:read here runs the
 * MFA step-up first (stricter than the sibling reports, on purpose), and a
 * thrown server error would reach the browser without its reason.
 */
export function BookReportMfaState({
  reason,
  query,
}: {
  reason: 'mfa_required' | 'aal2_required';
  query: BookReportQuery;
}) {
  const qs = serializeBookReportQuery(query);
  const here = qs ? `${BOOK_REPORT_PATH}?${qs}` : BOOK_REPORT_PATH;
  const enroll = reason === 'mfa_required';
  return (
    <div role="alert" className="border-warning/40 bg-warning/10 flex items-start gap-3 rounded-md border p-4">
      <ShieldAlert aria-hidden className="text-warning mt-0.5 h-5 w-5 shrink-0" />
      <div className="space-y-3">
        <p className="text-sm">{enroll ? BOOK_REPORT_MFA_ENROLL : BOOK_REPORT_MFA_VERIFY}</p>
        <Button asChild size="sm">
          <Link
            href={
              enroll
                ? '/dashboard/settings/security?enroll=1'
                : `/signin/mfa?redirect=${encodeURIComponent(here)}`
            }
          >
            {enroll ? BOOK_REPORT_UI.mfaEnrollAction : BOOK_REPORT_UI.mfaVerifyAction}
          </Link>
        </Button>
      </div>
    </div>
  );
}
