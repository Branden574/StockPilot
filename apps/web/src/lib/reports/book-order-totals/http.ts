import { NextResponse } from 'next/server';

import { reportError } from '@/lib/error-reporter';
import { ServiceError, serviceErrorStatus, type ServiceContext } from '@/server/services/context';

import {
  BOOK_REPORT_LOAD_ERROR,
  BOOK_REPORT_TIMEOUT,
  isUuid,
  parseBookReportQuery,
  type BookReportQuery,
} from '@stockpilot/core';

export const BOOK_REPORT_NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * The Book Order Totals routes' one error shape: `{ error: <code>, message,
 * details? }`, never cached. A refusal the service authored keeps its words
 * and `details` (the phone branches on details.reason: aal2_required,
 * mfa_required, too_many_rows, ...). A statement timeout says so. Anything
 * else is a read that did not complete and says exactly that: it is never
 * answered as an empty report, and raw database text never leaves the
 * server.
 */
export function bookReportErrorResponse(
  e: unknown,
  tag: string,
  ctx: Pick<ServiceContext, 'organizationId'>,
): NextResponse {
  if (e instanceof ServiceError && e.code !== 'internal_error') {
    return NextResponse.json(
      { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
      { status: serviceErrorStatus(e.code), headers: BOOK_REPORT_NO_STORE },
    );
  }
  if (e instanceof ServiceError && e.details?.reason === 'timeout') {
    return NextResponse.json(
      { error: 'internal_error', message: BOOK_REPORT_TIMEOUT, details: { reason: 'timeout' } },
      { status: 503, headers: BOOK_REPORT_NO_STORE },
    );
  }
  // A ServiceError('internal_error') was already reported where it arose.
  if (!(e instanceof ServiceError))
    void reportError(e, { tag, organizationId: ctx.organizationId });
  return NextResponse.json(
    { error: 'internal_error', message: BOOK_REPORT_LOAD_ERROR },
    { status: 500, headers: BOOK_REPORT_NO_STORE },
  );
}

/** No session: 401 in the same shape. */
export function bookReportUnauthenticatedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'unauthenticated', message: 'Your session ended. Sign in again.' },
    { status: 401, headers: BOOK_REPORT_NO_STORE },
  );
}

/**
 * A v1 request's report query. Strict: any invalid key is a 400 naming the
 * keys, and `warehouse` must be present ('all' or a uuid). A route never
 * falls back to the person's warehouse view (a cookie the phone does not
 * send), so a row, its drill-down and its export always agree.
 */
export function bookReportApiQuery(url: URL): BookReportQuery {
  const { query, invalid } = parseBookReportQuery(url.searchParams);
  if (invalid.length > 0) {
    throw new ServiceError(
      'validation_error',
      `These filters are not valid: ${invalid.join(', ')}.`,
      {
        reason: 'invalid_query',
        keys: invalid,
      },
    );
  }
  if (query.warehouse === 'default') {
    throw new ServiceError('validation_error', 'Name a warehouse, or all.', {
      reason: 'warehouse_required',
    });
  }
  return query;
}

/** A 1-based page number (1 when absent); anything else is a 400. */
export function bookReportPageParam(raw: string | null): number {
  if (raw === null) return 1;
  if (!/^[1-9]\d{0,5}$/.test(raw)) {
    throw new ServiceError('validation_error', 'The page must be a whole number from 1.', {
      reason: 'invalid_page',
    });
  }
  return Number(raw);
}

/** A path item id: a uuid, else 400. */
export function bookReportItemIdParam(raw: string): string {
  if (!isUuid(raw)) {
    throw new ServiceError('validation_error', 'Choose a book.', { reason: 'invalid_item' });
  }
  return raw.toLowerCase();
}
