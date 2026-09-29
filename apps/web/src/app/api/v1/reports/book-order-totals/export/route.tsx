import { Readable } from 'node:stream';

import { renderToStream } from '@react-pdf/renderer';
import { NextResponse, type NextRequest } from 'next/server';

import { withApiContext } from '@/lib/auth/api-context';
import { reportError } from '@/lib/error-reporter';
import { exportRateLimited } from '@/lib/export-rate-limit';
import { sanitizeFilenameSegment } from '@/lib/exports/filename';
import { BookOrderTotalsPdf, type BookPdfRow } from '@/lib/pdf/book-order-totals';
import { prefetchImagesAsDataUris } from '@/lib/pdf/image-prefetch';
import {
  bookReportCsvStream,
  bookReportScopeLines,
  bookReportSummaryLines,
  type BookReportExportInput,
} from '@/lib/reports/book-order-totals/export-content';
import {
  bookReportApiQuery,
  bookReportErrorResponse,
  bookReportUnauthenticatedResponse,
} from '@/lib/reports/book-order-totals/http';
import { audit } from '@/server/services/audit';
import {
  BookOrderTotalsService,
  warehouseFromResolvedQuery,
} from '@/server/services/book-order-totals';
import { assertPermission, ServiceError, type ServiceContext } from '@/server/services/context';

import {
  BOOK_REPORT_PDF_COVER_CAP,
  bookReportPdfCoverNote,
  bookReportStatusLabels,
  type BookReportCharterFilters,
} from '@stockpilot/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One export-mode statement plus, for a PDF, at most 500 downscaled covers
// and the render. The ceilings (core BOOK_REPORT_CSV_MAX_ROWS /
// BOOK_REPORT_PDF_MAX_ROWS) keep the whole call well inside this budget.
export const maxDuration = 60;

/** Longest edge of an embedded cover: a 36 x 54 pt box at 300 dpi or so. */
const PDF_COVER_EDGE_PX = 240;

/**
 * GET /api/v1/reports/book-order-totals/export?format=csv|pdf&photos=0|1&warehouse=all|<uuid>&...
 *
 * The whole filtered Book Order Totals, as a CSV (data only: no covers, no
 * URLs) or a PDF (covers for the first 500 books, disclosed; every row and
 * total printed). Web links (cookie) and the phone (Bearer, iOS) both use it.
 *
 * In order: a session (401); reports:export with the MFA step-up (403),
 * BEFORE the rate limit, so a refused caller does not spend the shared
 * budget; reports:read and the orders and books modules; the query (400,
 * `warehouse` required); the shared export limit (429). Then ONE export-mode
 * statement: every row and the summary from one snapshot, refused with 400
 * too_many_rows above the format's ceiling before any byte is written, never
 * truncated. The audit row is written before the body streams. The file
 * carries its own generation time (org-local), not the on-screen answer's.
 * Nothing is stored, public or emailed.
 *
 * The charter (0382) narrows the file exactly as it narrows the page: every
 * row of that charter's orders, never the page. The ORDER of the checks is
 * deliberate and pinned by the route test: a charter id the caller may not
 * report on is judged by the database inside the export statement, so a
 * hand-edited link with such an id spends one of the caller's OWN hourly
 * exports and then gets the 400 invalid_charter (as an unknown warehouse or
 * category id already does). No pre-check is added: it would put another
 * serial round trip in front of every chartered export, the page never builds
 * such a link, and the budget stays in front of the statement so it still
 * accounts for every expensive statement. The filename never carries the
 * charter's name.
 */
export async function GET(req: NextRequest) {
  const ctx = await withApiContext(req);
  if (!ctx) return bookReportUnauthenticatedResponse();
  try {
    assertPermission(ctx, 'reports:export');
    const svc = new BookOrderTotalsService(ctx);
    svc.gate();

    const url = new URL(req.url);
    const format = url.searchParams.get('format');
    if (format !== 'csv' && format !== 'pdf') {
      throw new ServiceError('validation_error', 'Choose csv or pdf.', {
        reason: 'invalid_format',
      });
    }
    const photosRaw = url.searchParams.get('photos');
    if (photosRaw !== null && photosRaw !== '0' && photosRaw !== '1') {
      throw new ServiceError('validation_error', 'photos must be 0 or 1.', {
        reason: 'invalid_photos',
      });
    }
    const photos = format === 'pdf' && photosRaw !== '0';
    const query = bookReportApiQuery(url);

    const limited = await exportRateLimited(ctx.userId, ctx.organizationId);
    if (limited) return limited;

    const answer = await svc.exportRows(query, warehouseFromResolvedQuery(query), format);
    const org = await readOrgForExport(ctx);
    const input: BookReportExportInput = {
      answer,
      statusGroups: query.statusGroups,
      statusLabels: bookReportStatusLabels(org.orderStatusConfig),
      q: query.q,
    };

    const filename = `${sanitizeFilenameSegment('book-order-totals')}_${sanitizeFilenameSegment(
      answer.generatedAtLocal.slice(0, 10),
    )}.${format}`;

    let body: ReadableStream<Uint8Array>;
    let coverCounts: { shown: number; failed: number; pastCap: number } | null = null;
    if (format === 'csv') {
      await auditExport(ctx, 'csv', false, input, query.category, query.q);
      body = bookReportCsvStream(input);
    } else {
      const ids = answer.rows.map((r) => r.itemId);
      let coverByItem = new Map<string, string | null>();
      // Books whose cover lookup failed (not books with no cover): counted
      // as "could not be loaded" in the note and the audit row.
      let lookupFailed = 0;
      if (photos && ids.length > 0) {
        const lookup = await svc.pdfCovers(ids);
        lookupFailed = lookup.unresolved.length;
        coverByItem = await prefetchImagesAsDataUris(Object.entries(lookup.urls), {
          maxEdgePx: PDF_COVER_EDGE_PX,
        });
      }
      const withinCap = Math.min(ids.length, BOOK_REPORT_PDF_COVER_CAP);
      let shown = 0;
      let failed = lookupFailed;
      for (const [, uri] of coverByItem) {
        if (uri) shown += 1;
        else failed += 1;
      }
      coverCounts = { shown, failed, pastCap: photos ? ids.length - withinCap : 0 };
      const rows: BookPdfRow[] = answer.rows.map((row) => ({
        row,
        cover: coverByItem.get(row.itemId) ?? null,
      }));
      const logo = org.logoUrl
        ? ((await prefetchImagesAsDataUris([['logo', org.logoUrl] as const])).get('logo') ?? null)
        : null;
      await auditExport(ctx, 'pdf', photos, input, query.category, query.q, coverCounts);
      const stream = await renderToStream(
        // eslint-disable-next-line react-hooks/error-boundaries -- react-pdf renderToStream in a route handler; the rule targets client error boundaries
        <BookOrderTotalsPdf
          orgName={org.name}
          orgLogo={logo}
          generatedAtLocal={answer.generatedAtLocal}
          timeZone={answer.range.timeZone}
          scopeLines={bookReportScopeLines(input)}
          summary={answer.summary}
          summaryNotes={bookReportSummaryLines(input).slice(3)}
          coverNote={bookReportPdfCoverNote({ photos, rows: ids.length, ...coverCounts })}
          photos={photos}
          rows={rows}
        />,
      );
      body = Readable.toWeb(stream as unknown as Readable) as ReadableStream<Uint8Array>;
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf',
        'Content-Disposition': `${format === 'csv' ? 'attachment' : 'inline'}; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    return bookReportErrorResponse(e, 'api.v1.reports.book_order_totals.export', ctx);
  }
}

interface ExportOrg {
  name: string;
  logoUrl: string | null;
  orderStatusConfig: unknown;
}

/** The organization's name, logo and status labels for the file, read with
 *  the caller's client. Cosmetic: a failed read prints "StockPilot" and the
 *  default status labels, and is reported. */
async function readOrgForExport(ctx: ServiceContext): Promise<ExportOrg> {
  const { data, error } = await ctx.supabase
    .from('organizations')
    .select('name, logo_url, order_status_config')
    .eq('id', ctx.organizationId)
    .maybeSingle();
  if (error || !data) {
    void reportError(
      new Error(`book order totals export: organization read failed (${error?.code ?? 'no row'})`),
      {
        tag: 'api.v1.reports.book_order_totals.export',
        level: 'warning',
        organizationId: ctx.organizationId,
      },
    );
    return { name: 'StockPilot', logoUrl: null, orderStatusConfig: null };
  }
  const row = data as {
    name?: string | null;
    logo_url?: string | null;
    order_status_config?: unknown;
  };
  return {
    name: row.name?.trim() || 'StockPilot',
    logoUrl: row.logo_url?.trim() || null,
    orderStatusConfig: row.order_status_config ?? null,
  };
}

/** The charter a file covers, for its audit row: the charter's id, 'none'
 *  for No charter, else 'all'. */
function auditCharter(filters: BookReportCharterFilters): string {
  return filters.charter?.id ?? (filters.noCharter === true ? 'none' : 'all');
}

/** The audit row, awaited before the body streams (on Vercel the function
 *  may wind down once the body is consumed). The search text itself is not
 *  stored, only its length. */
async function auditExport(
  ctx: ServiceContext,
  format: 'csv' | 'pdf',
  photos: boolean,
  input: BookReportExportInput,
  category: string,
  q: string,
  covers?: { shown: number; failed: number; pastCap: number },
): Promise<void> {
  const { answer } = input;
  await audit(
    {
      event: format === 'pdf' ? 'pdf.exported' : 'report.exported',
      entityType: 'report',
      entityId: null,
      extra: {
        slug: 'book-order-totals',
        format,
        photos,
        rows: answer.rows.length,
        copies: answer.summary.copies,
        orders: answer.summary.orders,
        range: answer.range.key,
        from: answer.range.from,
        to: answer.range.to,
        statuses: answer.statuses,
        warehouse: answer.warehouse.id,
        warehouseSource: answer.warehouse.source,
        // The ORDER's charter the file covers, from the answer's echo (an id,
        // 'none' or 'all'); never its name.
        charter: auditCharter(answer.filters),
        category,
        searchLength: q.length,
        generatedAt: answer.generatedAt,
        ...(covers
          ? {
              coversShown: covers.shown,
              coversFailed: covers.failed,
              coversPastCap: covers.pastCap,
            }
          : {}),
      },
    },
    ctx,
  );
}
