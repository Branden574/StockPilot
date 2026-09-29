'use client';

import { Download, Loader2 } from 'lucide-react';
import * as React from 'react';

import { PdfDownloadDropdown } from '@/components/reports/pdf-download-dropdown';
import { Button } from '@/components/ui/button';

import {
  BOOK_REPORT_CSV_MAX_ROWS,
  BOOK_REPORT_EXPORT_CONNECTION,
  BOOK_REPORT_EXPORT_COVER_CAP_NOTE,
  BOOK_REPORT_EXPORT_CSV,
  BOOK_REPORT_EXPORT_PDF_COVERS,
  BOOK_REPORT_EXPORT_PDF_PLAIN,
  BOOK_REPORT_EXPORT_PREPARING,
  BOOK_REPORT_PDF_COVER_CAP,
  BOOK_REPORT_PDF_MAX_ROWS,
  bookReportExportRefusalText,
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
 *
 * The page fetches each file itself (a plain click; the links keep their
 * real hrefs for a new tab or a copied link). A refusal the browser would
 * otherwise swallow (a failed download for the CSV, a tab of raw JSON for
 * the PDF) is said here in core's words: the hourly export budget with its
 * wait, a report that grew past the ceiling since the page loaded, a
 * timeout, a lost session. A good file is saved under the server's name.
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
  const [busy, setBusy] = React.useState<'csv' | 'pdf' | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);

  async function download(href: string, format: 'csv' | 'pdf') {
    if (busy) return;
    setBusy(format);
    setProblem(null);
    try {
      let res: Response;
      try {
        res = await fetch(href, { credentials: 'same-origin', cache: 'no-store' });
      } catch {
        setProblem(BOOK_REPORT_EXPORT_CONNECTION);
        return;
      }
      if (!res.ok) {
        setProblem(await refusalText(res));
        return;
      }
      let blob: Blob;
      try {
        blob = await res.blob();
      } catch {
        setProblem(BOOK_REPORT_EXPORT_CONNECTION);
        return;
      }
      saveFile(blob, fileNameFrom(res.headers.get('content-disposition'), format));
    } finally {
      setBusy(null);
    }
  }

  const csvHref = bookReportExportHref(query, 'csv');
  return (
    <div className="flex flex-col items-end gap-1.5">
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
            <a
              href={csvHref}
              download
              aria-disabled={busy !== null || undefined}
              onClick={(e) => {
                if (
                  e.defaultPrevented ||
                  e.button !== 0 ||
                  e.metaKey ||
                  e.ctrlKey ||
                  e.shiftKey ||
                  e.altKey
                ) {
                  return;
                }
                e.preventDefault();
                void download(csvHref, 'csv');
              }}
            >
              {busy === 'csv' ? (
                <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}{' '}
              {BOOK_REPORT_EXPORT_CSV}
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
          disabledReason={
            pdfTooMany ? bookReportTooManyText(totalCount, BOOK_REPORT_PDF_MAX_ROWS) : null
          }
          busy={busy !== null}
          onDownload={(href) => void download(href, 'pdf')}
        />
      </div>
      <p aria-live="polite" className="text-muted-foreground text-xs empty:hidden">
        {busy ? `${BOOK_REPORT_EXPORT_PREPARING}…` : ''}
      </p>
      {problem ? (
        <p role="alert" className="text-destructive max-w-sm text-right text-xs">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** The route's refusal ({ error, message, details }) in core's words. */
async function refusalText(res: Response): Promise<string> {
  let body: { error?: unknown; message?: unknown; details?: unknown } = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      body = parsed as typeof body;
  } catch {
    body = {};
  }
  const details =
    body.details && typeof body.details === 'object' && !Array.isArray(body.details)
      ? (body.details as Record<string, unknown>)
      : {};
  const retry = Number(res.headers.get('retry-after'));
  return bookReportExportRefusalText({
    status: res.status,
    code: typeof body.error === 'string' ? body.error : null,
    reason: typeof details.reason === 'string' ? details.reason : null,
    count: typeof details.count === 'number' ? details.count : null,
    limit: typeof details.limit === 'number' ? details.limit : null,
    message: typeof body.message === 'string' ? body.message : null,
    retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : null,
  });
}

/** The server's file name (reduced to safe characters), else a default. */
function fileNameFrom(contentDisposition: string | null, format: 'csv' | 'pdf'): string {
  const m = contentDisposition ? /filename="?([^";]+)"?/i.exec(contentDisposition) : null;
  const base = (m?.[1] ?? '')
    .trim()
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80);
  return `${base || 'book-order-totals'}.${format}`;
}

/** Hand a fetched file to the browser as a download. */
function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for the browser to start reading the object URL.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
