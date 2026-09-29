import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import {
  BOOK_REPORT_NO_STORE,
  bookReportErrorResponse,
  bookReportUnauthenticatedResponse,
} from '@/lib/reports/book-order-totals/http';
import { BookOrderTotalsService } from '@/server/services/book-order-totals';
import { ServiceError } from '@/server/services/context';

import { BOOK_REPORT_COVERS_MAX, isUuid } from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/reports/book-order-totals/covers?ids=<uuid>,<uuid>,...
 *
 * Covers for one page of books (1 to 25 ids), as { organizationId, covers:
 * { itemId: url }, unresolved: [itemId] }. The books are authorized with the
 * caller's own RLS read before any image is resolved, so a hidden book never
 * yields a URL; only trusted URLs are returned (this project's signed
 * item-images URLs, or an allowlisted cover host). A book with no cover, or
 * one the caller cannot read, is simply absent; `unresolved` names the books
 * whose cover exists but could not be loaded, so the phone says so instead of
 * "No cover". Covers never change a number. The phone loads them after the
 * numbers are shown.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return bookReportUnauthenticatedResponse();
  try {
    const svc = new BookOrderTotalsService(ctx);
    svc.gate();
    const raw = new URL(req.url).searchParams.get('ids') ?? '';
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (ids.length === 0 || ids.length > BOOK_REPORT_COVERS_MAX || !ids.every(isUuid)) {
      throw new ServiceError(
        'validation_error',
        `Ask for 1 to ${BOOK_REPORT_COVERS_MAX} books by id.`,
        {
          reason: 'invalid_ids',
        },
      );
    }
    const { urls, unresolved } = await svc.coverLookup(ids, { max: BOOK_REPORT_COVERS_MAX });
    return NextResponse.json(
      { organizationId: ctx.organizationId, covers: urls, unresolved },
      { headers: BOOK_REPORT_NO_STORE },
    );
  } catch (e) {
    return bookReportErrorResponse(e, 'api.v1.reports.book_order_totals.covers', ctx);
  }
}
