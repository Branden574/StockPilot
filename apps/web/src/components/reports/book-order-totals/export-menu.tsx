import { Download } from 'lucide-react';

import { PdfDownloadDropdown } from '@/components/reports/pdf-download-dropdown';
import { Button } from '@/components/ui/button';

import {
  BOOK_REPORT_CSV_MAX_ROWS,
  BOOK_REPORT_EXPORT_COVER_CAP_NOTE,
  BOOK_REPORT_EXPORT_CSV,
  BOOK_REPORT_EXPORT_PDF_COVERS,
  BOOK_REPORT_EXPORT_PDF_PLAIN,
  BOOK_REPORT_PDF_COVER_CAP,
  BOOK_REPORT_PDF_MAX_ROWS,
  bookReportTooManyText,
  type BookReportQuery,
} from '@stockpilot/core';

import { bookReportExportHref } from './hrefs';

/**
 * The export controls, rendered only for reports:export holders (the page
 * decides; the route checks again, with the MFA step-up, before its rate
 * limit). Each link carries the resolved query, so the file covers exactly
 * the report on screen, with its concrete warehouse, but EVERY row of it,
 * not the visible page.
 *
 * A file above its format's ceiling is refused by the server rather than
 * cut short, so the control is disabled beforehand with the reason. The PDF
 * embeds covers for the first 500 books; that is said in the menu before
 * anyone downloads when the report has more. The CSV is data only.
 */
export function BookReportExportMenu({
  query,
  totalCount,
}: {
  query: BookReportQuery;
  totalCount: number;
}) {
  const csvTooMany = totalCount > BOOK_REPORT_CSV_MAX_ROWS;
  const pdfTooMany = totalCount > BOOK_REPORT_PDF_MAX_ROWS;
  const csvReasonId = 'book-report-csv-too-many';
  return (
    <div className="flex flex-wrap items-start gap-2">
      {csvTooMany ? (
        <div className="flex max-w-xs flex-col items-start gap-1">
          <Button variant="outline" disabled aria-describedby={csvReasonId}>
            <Download className="h-4 w-4" /> {BOOK_REPORT_EXPORT_CSV}
          </Button>
          <p id={csvReasonId} className="text-muted-foreground text-xs">
            {bookReportTooManyText(totalCount, BOOK_REPORT_CSV_MAX_ROWS)}
          </p>
        </div>
      ) : (
        <Button asChild variant="outline">
          <a href={bookReportExportHref(query, 'csv')} download>
            <Download className="h-4 w-4" /> {BOOK_REPORT_EXPORT_CSV}
          </a>
        </Button>
      )}
      <PdfDownloadDropdown
        baseUrl={bookReportExportHref(query, 'pdf')}
        labels={{
          withImages: BOOK_REPORT_EXPORT_PDF_COVERS,
          withoutImages: BOOK_REPORT_EXPORT_PDF_PLAIN,
        }}
        note={totalCount > BOOK_REPORT_PDF_COVER_CAP ? BOOK_REPORT_EXPORT_COVER_CAP_NOTE : null}
        disabledReason={pdfTooMany ? bookReportTooManyText(totalCount, BOOK_REPORT_PDF_MAX_ROWS) : null}
      />
    </div>
  );
}
