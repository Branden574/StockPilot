'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { reportError } from '@/lib/error-reporter';

import { BOOK_REPORT_LOAD_ERROR, BOOK_REPORT_TITLE, BOOK_REPORT_UI } from '@stockpilot/core';

/**
 * Book Order Totals could not be read. Shown in place of the whole report:
 * never cards, never zeros, never an empty table that looks like "no
 * orders". Try again re-reads the report.
 */
export default function BookOrderTotalsError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset?: () => void;
}) {
  React.useEffect(() => {
    void reportError(error, {
      tag: 'reports.book_order_totals.render',
      level: 'error',
      extra: { digest: error.digest ?? null },
    });
  }, [error]);

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Link href="/dashboard/reports" className="text-muted-foreground hover:text-foreground text-sm">
        ← Back to reports
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{BOOK_REPORT_TITLE}</h1>
      <div role="alert" className="border-border bg-card mt-6 flex items-start gap-3 rounded-md border p-4">
        <AlertTriangle aria-hidden className="text-destructive mt-0.5 h-5 w-5 shrink-0" />
        <div className="space-y-3">
          <p className="text-sm">{BOOK_REPORT_LOAD_ERROR}</p>
          {error.digest ? (
            <p className="text-muted-foreground font-mono text-[11px]">Error id: {error.digest}</p>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => (retry ?? reset)?.()}>
            <RefreshCw aria-hidden /> {BOOK_REPORT_UI.tryAgain}
          </Button>
        </div>
      </div>
    </div>
  );
}
