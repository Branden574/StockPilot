import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import {
  BOOK_REPORT_NO_STORE,
  bookReportApiQuery,
  bookReportErrorResponse,
  bookReportItemIdParam,
  bookReportPageParam,
  bookReportUnauthenticatedResponse,
} from '@/lib/reports/book-order-totals/http';
import {
  BookOrderTotalsService,
  warehouseFromResolvedQuery,
} from '@/server/services/book-order-totals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/reports/book-order-totals/items/[itemId]/orders?warehouse=all|<uuid>&range&from&to&status&page
 *
 * The orders behind one book's total, 25 per page, newest first, with the
 * book's FULL totals (never the page's). Duplicate lines of one order are
 * combined into one row with their line ids. `openable` says whether the
 * caller may open the order (orders:approve, or their own request); no
 * requester data is returned. Search and category do not apply (they are
 * item filters). 404 for a book the caller cannot see, a product or a
 * missing id alike; 400 for a malformed id, page or query.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const ctx = await withApiContext(req);
  if (!ctx) return bookReportUnauthenticatedResponse();
  const { itemId } = await params;
  try {
    const svc = new BookOrderTotalsService(ctx);
    svc.gate();
    const url = new URL(req.url);
    const id = bookReportItemIdParam(itemId);
    const query = bookReportApiQuery(url);
    const page = bookReportPageParam(url.searchParams.get('page'));
    const result = await svc.orders(id, query, warehouseFromResolvedQuery(query), page);
    return NextResponse.json(result, { headers: BOOK_REPORT_NO_STORE });
  } catch (e) {
    return bookReportErrorResponse(e, 'api.v1.reports.book_order_totals.orders', ctx);
  }
}
