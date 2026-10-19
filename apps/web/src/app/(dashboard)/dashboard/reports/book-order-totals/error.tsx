'use client';

import { RefreshCw } from 'lucide-react';
import * as React from 'react';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { StatePanel } from '@/components/patterns/state-panel';
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
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/reports">← Back to reports</PageHeaderBackLink>}
        title={BOOK_REPORT_TITLE}
      />
      {/* The shared failed-read panel (DESIGN-SPEC 6.21 states): the load
          error is the alert, then the error id and Try again. */}
      <StatePanel
        kind="failed"
        live="assertive"
        headingLevel={null}
        title={BOOK_REPORT_LOAD_ERROR}
        description={
          error.digest ? (
            <span className="font-mono text-[11px]">Error id: {error.digest}</span>
          ) : undefined
        }
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => (retry ?? reset)?.()}>
            <RefreshCw aria-hidden /> {BOOK_REPORT_UI.tryAgain}
          </Button>
        }
      />
    </div>
  );
}
