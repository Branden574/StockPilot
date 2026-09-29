'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';

import {
  BOOK_REPORT_DRAWER_TERMS,
  BOOK_REPORT_EMPTY,
  BOOK_REPORT_FULFILLED_NOTE,
  BOOK_REPORT_MFA_ENROLL,
  BOOK_REPORT_MFA_VERIFY,
  BOOK_REPORT_NO_CHARTER_HINT,
  BOOK_REPORT_NOT_IN_SCOPE,
  BOOK_REPORT_ORDER_COLUMNS,
  BOOK_REPORT_ORDER_LINK_HINT,
  BOOK_REPORT_ORDERS_LOAD_ERROR,
  BOOK_REPORT_ORDERS_NOUN,
  BOOK_REPORT_TIMEOUT,
  BOOK_REPORT_UI,
  BOOK_REPORT_VIEW_ORDERS,
  bookReportAsOfNote,
  bookReportCharterEchoMatches,
  bookReportCharterLabel,
  bookReportDrawerHeader,
  bookReportOrderCharterText,
  bookReportOrderLink,
  bookReportQuantityWording,
  bookReportRangeLabel,
  bookReportStatusLine,
  bookReportViewOrdersLabel,
  bookReportWarehouseLine,
  combinedLinesText,
  formatListFooter,
  formatOrderNumber,
  formatReportDate,
  formatReportQuantity,
  fulfilledReturnedLine,
  parseBookOrderOrdersResponse,
  totalPagesFor,
  type BookOrderOrdersResponse,
  type BookReportQuery,
  type OrderStatusKey,
} from '@stockpilot/core';

import {
  bookReportDrawerReturnHref,
  bookReportOrdersApiUrl,
  readBookReportDrawer,
  withBookReportDrawer,
} from './hrefs';
import { BookIdentityLine } from './identity-line';

/**
 * VIEW ORDERS: the orders behind one book's total, in a side sheet.
 *
 * The open book and the drill-down page live in the page URL (`view`,
 * `vpage`), written with the History API, which Next's router follows
 * without asking the server for the report again. So Back closes the sheet,
 * a shared link opens it, and returning from an order reopens it on the
 * same page with every report filter intact.
 *
 * The fetch carries the SAME charter, resolved range, statuses and concrete
 * warehouse as the row it was opened from (hrefs.ts), so the sheet's header
 * (the book's FULL totals, never the visible page's) equals the row. Every
 * load has its own AbortController and sequence number, and an answer for
 * another organization, warehouse, charter or book is dropped: a late answer
 * can never fill the sheet for a different book or filter, and figures are
 * never shown under a charter they are not for.
 *
 * The header states the scope (brief 13): Book, Charter, Orders placed and
 * Total requested. The Charter column shows only with All charters chosen;
 * with one charter it would repeat the header on every row.
 *
 * Each order link carries the way back (plan D17): `?return=` this page's
 * URL with the sheet open on the same book and page, so the order page's
 * "Back to Book Order Totals" restores this view (the browser's Back does
 * too).
 *
 * An order number is a link only when the API says the order is `openable`
 * (the caller can approve orders, or placed it). Anyone else sees the number
 * as plain text, as the Orders list would show them only their own requests.
 * No requester is ever shown.
 */

type DrawerResult =
  | { key: string; kind: 'ready'; answer: BookOrderOrdersResponse }
  | { key: string; kind: 'error'; message: string; retry: boolean };

interface ErrorBody {
  message?: unknown;
  details?: { reason?: unknown } | null;
}

/** The sheet's words for a refused or failed load. Never an empty list. */
export function bookOrdersErrorFor(
  status: number,
  body: unknown,
): { message: string; retry: boolean } {
  const reason = (body as ErrorBody | null)?.details?.reason;
  if (status === 404) return { message: BOOK_REPORT_NOT_IN_SCOPE, retry: false };
  if (status === 503) return { message: BOOK_REPORT_TIMEOUT, retry: true };
  if (status === 403 && reason === 'mfa_required') return { message: BOOK_REPORT_MFA_ENROLL, retry: false };
  if (status === 403 && reason === 'aal2_required') return { message: BOOK_REPORT_MFA_VERIFY, retry: false };
  return { message: BOOK_REPORT_ORDERS_LOAD_ERROR, retry: true };
}

function markedByReport(): boolean {
  const state = window.history.state as { bookReportDrawer?: unknown } | null;
  return state?.bookReportDrawer === true;
}

/** The row's action: opens the sheet for this book (a new history entry,
 *  so Back closes it). */
export function ViewOrdersButton({ itemId, title }: { itemId: string; title: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={bookReportViewOrdersLabel(title)}
      onClick={() => {
        window.history.pushState(
          { bookReportDrawer: true },
          '',
          withBookReportDrawer(window.location, itemId, 1),
        );
      }}
    >
      {BOOK_REPORT_VIEW_ORDERS}
    </Button>
  );
}

export interface BookOrdersDrawerProps {
  organizationId: string;
  /** The RESOLVED report query the page rendered. */
  query: BookReportQuery;
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  /** Titles of the books on this page, for the sheet's title while it loads. */
  titles: Readonly<Record<string, string>>;
}

export function BookOrdersDrawer({ organizationId, query, statusLabels, titles }: BookOrdersDrawerProps) {
  const searchParams = useSearchParams();
  const { itemId, page } = readBookReportDrawer(searchParams);
  const warehouseId = query.warehouse === 'all' ? null : query.warehouse;
  const charter = query.charter;
  const url = itemId ? bookReportOrdersApiUrl(itemId, query, page) : null;
  const [nonce, setNonce] = React.useState(0);
  const [result, setResult] = React.useState<DrawerResult | null>(null);
  const seq = React.useRef(0);
  const requestKey = url ? `${url}#${nonce}` : null;

  React.useEffect(() => {
    if (!url || !itemId) return;
    const mine = ++seq.current;
    const key = `${url}#${nonce}`;
    const ctrl = new AbortController();
    const stale = () => ctrl.signal.aborted || mine !== seq.current;
    fetch(url, {
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (stale()) return;
        if (!res.ok) {
          setResult({ key, kind: 'error', ...bookOrdersErrorFor(res.status, body) });
          return;
        }
        let answer: BookOrderOrdersResponse;
        try {
          answer = parseBookOrderOrdersResponse(body);
        } catch {
          setResult({ key, kind: 'error', message: BOOK_REPORT_ORDERS_LOAD_ERROR, retry: true });
          return;
        }
        const sameScope =
          answer.organizationId === organizationId &&
          answer.warehouse.id === warehouseId &&
          (answer.filters.warehouse?.id ?? null) === warehouseId &&
          bookReportCharterEchoMatches({ charter }, answer.filters) &&
          answer.book?.itemId.toLowerCase() === itemId;
        if (!sameScope) {
          setResult({ key, kind: 'error', message: BOOK_REPORT_ORDERS_LOAD_ERROR, retry: true });
          return;
        }
        setResult({ key, kind: 'ready', answer });
      })
      .catch(() => {
        if (stale()) return;
        setResult({ key, kind: 'error', message: BOOK_REPORT_ORDERS_LOAD_ERROR, retry: true });
      });
    return () => ctrl.abort();
  }, [url, nonce, itemId, organizationId, warehouseId, charter]);

  const current = result && result.key === requestKey ? result : null;
  const answer = current?.kind === 'ready' ? current.answer : null;

  const close = () => {
    if (markedByReport()) window.history.back();
    else window.history.replaceState(null, '', withBookReportDrawer(window.location, null));
  };
  const goToPage = (next: number) => {
    window.history.replaceState(
      { bookReportDrawer: markedByReport() },
      '',
      withBookReportDrawer(window.location, itemId, next),
    );
  };

  const title =
    answer?.book?.name ?? (itemId ? titles[itemId] : undefined) ?? BOOK_REPORT_VIEW_ORDERS;

  return (
    <Sheet
      open={itemId !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent side="right" className="flex flex-col gap-0 p-0 sm:max-w-xl md:max-w-2xl">
        <SheetHeader className="pr-12">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {answer?.book
              ? bookReportDrawerHeader(answer.book, answer.totals)
              : current?.kind === 'error'
                ? current.message
                : BOOK_REPORT_UI.loadingOrders}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          {answer && itemId ? (
            <OrdersBody
              answer={answer}
              query={query}
              statusLabels={statusLabels}
              returnTo={bookReportDrawerReturnHref(query, itemId, page)}
              onPage={goToPage}
            />
          ) : current?.kind === 'error' ? (
            <div role="alert" className="space-y-3">
              <p className="text-sm">{current.message}</p>
              {current.retry ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setNonce((n) => n + 1)}>
                  {BOOK_REPORT_UI.tryAgain}
                </Button>
              ) : null}
            </div>
          ) : (
            <div aria-busy="true" className="space-y-3">
              <span className="sr-only">{BOOK_REPORT_UI.loadingOrders}</span>
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" />
              ))}
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function OrdersBody({
  answer,
  query,
  statusLabels,
  returnTo,
  onPage,
}: {
  answer: BookOrderOrdersResponse;
  query: BookReportQuery;
  statusLabels: Readonly<Record<OrderStatusKey, string>>;
  /** This view's URL, for each order link's way back. */
  returnTo: string;
  onPage: (page: number) => void;
}) {
  const book = answer.book!;
  const wording = bookReportQuantityWording(book);
  const fulfilled = fulfilledReturnedLine(answer.totals);
  const totalPages = totalPagesFor(answer.totalCount, answer.pageSize);
  const footer = formatListFooter(
    {
      page: answer.page,
      pageSize: answer.pageSize,
      total: answer.totalCount,
      totalPages,
      itemCount: answer.rows.length,
    },
    BOOK_REPORT_ORDERS_NOUN,
  );

  // With All charters chosen each order's charter differs, so it is a
  // column; with one charter (or No charter) it is the header's line.
  const charterColumn = query.charter === 'all';
  const noCharter = answer.filters.noCharter === true;

  return (
    <div className="space-y-4">
      <dl
        data-drawer-scope
        className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm"
      >
        <dt className="text-muted-foreground">{BOOK_REPORT_DRAWER_TERMS.book}</dt>
        <dd className="min-w-0">
          <span className="block font-medium [overflow-wrap:anywhere]">{book.name}</span>
          <BookIdentityLine row={book} className="text-muted-foreground block text-xs" />
        </dd>
        <dt className="text-muted-foreground">{BOOK_REPORT_DRAWER_TERMS.charter}</dt>
        <dd className="min-w-0 [overflow-wrap:anywhere]">
          {bookReportCharterLabel(answer.filters.charter, answer.filters.noCharter)}
          {noCharter ? (
            <span className="text-muted-foreground block text-xs">
              {BOOK_REPORT_NO_CHARTER_HINT}
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">{BOOK_REPORT_DRAWER_TERMS.ordersPlaced}</dt>
        <dd className="min-w-0">{bookReportRangeLabel(answer.range)}</dd>
        <dt className="text-muted-foreground">{BOOK_REPORT_DRAWER_TERMS.totalRequested}</dt>
        <dd className="min-w-0 font-medium">{bookReportDrawerHeader(book, answer.totals)}</dd>
      </dl>
      <div className="text-muted-foreground space-y-1 text-xs">
        <p>{bookReportStatusLine(query.statusGroups, statusLabels)}</p>
        <p>{bookReportWarehouseLine(answer.filters.warehouse, answer.warehouse.source)}</p>
      </div>
      {fulfilled ? (
        <div className="space-y-1 text-xs">
          <p className="font-medium">{fulfilled}</p>
          <p className="text-muted-foreground">{BOOK_REPORT_FULFILLED_NOTE}</p>
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">{bookReportAsOfNote(answer.generatedAtLocal)}</p>

      {answer.rows.length === 0 ? (
        <p className="text-sm">{BOOK_REPORT_EMPTY}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="sr-only">{bookReportDrawerHeader(book, answer.totals)}</caption>
            <thead className="bg-muted/40 text-muted-foreground text-[11px] uppercase tracking-wider">
              <tr>
                <th scope="col" className="whitespace-nowrap px-3 py-2 text-left font-semibold">
                  {BOOK_REPORT_ORDER_COLUMNS.orderNumber}
                </th>
                <th scope="col" className="whitespace-nowrap px-3 py-2 text-left font-semibold">
                  {BOOK_REPORT_ORDER_COLUMNS.orderDate}
                </th>
                {charterColumn ? (
                  <th scope="col" className="px-3 py-2 text-left font-semibold">
                    {BOOK_REPORT_ORDER_COLUMNS.charter}
                  </th>
                ) : null}
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  {BOOK_REPORT_ORDER_COLUMNS.warehouse}
                </th>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  {BOOK_REPORT_ORDER_COLUMNS.status}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  {wording.column}
                </th>
              </tr>
            </thead>
            <tbody>
              {answer.rows.map((row) => {
                const number = formatOrderNumber(row.orderNumber) ?? BOOK_REPORT_UI.noOrderNumber;
                const href = bookReportOrderLink(row, 'web', returnTo);
                const combined = combinedLinesText(row.lines);
                return (
                  <tr key={row.orderId} className="border-t">
                    {/* An order number is one unit: 'SO-' never sits over
                        '001494' (a browser breaks after the hyphen). A
                        narrow sheet scrolls the table inside its border. */}
                    <th
                      scope="row"
                      className="whitespace-nowrap px-3 py-2 text-left font-mono text-xs font-medium tabular-nums"
                    >
                      {href ? (
                        <Link href={href} prefetch={false} className="text-primary underline-offset-2 hover:underline">
                          {number}
                        </Link>
                      ) : (
                        <span title={BOOK_REPORT_ORDER_LINK_HINT}>
                          {number}
                          <span className="sr-only">. {BOOK_REPORT_ORDER_LINK_HINT}</span>
                        </span>
                      )}
                    </th>
                    <td className="whitespace-nowrap px-3 py-2">{formatReportDate(row.orderDate)}</td>
                    {charterColumn ? (
                      <td className="px-3 py-2 [overflow-wrap:anywhere]">
                        {bookReportOrderCharterText(row) ?? ''}
                      </td>
                    ) : null}
                    <td className="px-3 py-2">{row.warehouseName ?? ''}</td>
                    <td className="px-3 py-2">{statusLabels[row.status as OrderStatusKey] ?? row.status}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatReportQuantity(row.copies)}
                      {combined ? (
                        <span
                          className="text-muted-foreground ml-1 text-xs"
                          title={row.lineIds.join(', ')}
                          data-line-ids={row.lineIds.join(',')}
                        >
                          {combined}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <nav
        aria-label={BOOK_REPORT_UI.ordersPagesNav}
        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
          {footer}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={answer.page <= 1}
            onClick={() => onPage(answer.page - 1)}
          >
            {BOOK_REPORT_UI.previous}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={answer.page >= totalPages}
            onClick={() => onPage(answer.page + 1)}
          >
            {BOOK_REPORT_UI.next}
          </Button>
        </div>
      </nav>
    </div>
  );
}
