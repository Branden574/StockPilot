import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import {
  BOOK_REPORT_NO_STORE,
  bookReportApiQuery,
  bookReportErrorResponse,
  bookReportUnauthenticatedResponse,
} from '@/lib/reports/book-order-totals/http';
import {
  BookOrderTotalsService,
  warehouseFromResolvedQuery,
} from '@/server/services/book-order-totals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/reports/book-order-totals?warehouse=all|<uuid>&range&from&to&status&wview&category&q&sort&page
 *
 * One page (25) of Book Order Totals with the summary and total count for the
 * WHOLE filtered result, from one statement (migration 0379). Cookie or
 * Bearer (withApiContext); the phone calls it with Bearer and
 * X-Organization-Id. Gates first: reports:read with the MFA step-up, then the
 * orders and books modules (403), before the query is judged (400: an
 * invalid key, or no `warehouse`: the route never reads the web's warehouse
 * view cookie). The organization is the verified context's, never the
 * client's. `organizationId` is echoed so a client can drop an answer for
 * another workspace. Never cached; a failure is an error, never zeros.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return bookReportUnauthenticatedResponse();
  try {
    const svc = new BookOrderTotalsService(ctx);
    svc.gate();
    const query = bookReportApiQuery(new URL(req.url));
    const result = await svc.page(query, warehouseFromResolvedQuery(query));
    return NextResponse.json(result, { headers: BOOK_REPORT_NO_STORE });
  } catch (e) {
    return bookReportErrorResponse(e, 'api.v1.reports.book_order_totals', ctx);
  }
}
