import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import {
  BOOK_REPORT_NO_STORE,
  bookReportErrorResponse,
  bookReportUnauthenticatedResponse,
} from '@/lib/reports/book-order-totals/http';
import { BookOrderTotalsService } from '@/server/services/book-order-totals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/reports/book-order-totals/options
 *
 * The filter lists for Book Order Totals: the warehouses (any status) and
 * categories (deleted ones included, and whether "No category" applies) that
 * occur in the caller's own eligible order lines; the charters the caller may
 * report on (`charters`: id, name, code and status only) and whether orders
 * with no charter are visible (`noCharter`); plus the organization's status
 * labels. Same gates as the report. Loaded once per session by the web filter
 * bar and the phone, never awaited with the numbers.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return bookReportUnauthenticatedResponse();
  try {
    const result = await new BookOrderTotalsService(ctx).options();
    return NextResponse.json(result, { headers: BOOK_REPORT_NO_STORE });
  } catch (e) {
    return bookReportErrorResponse(e, 'api.v1.reports.book_order_totals.options', ctx);
  }
}
