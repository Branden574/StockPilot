import Link from 'next/link';

import { Button } from '@/components/ui/button';

import { RECEIVING_CHECKLIST_COPY } from '@stockpilot/core';

/**
 * A receiving checklist page whose read failed (F4-1). The page renders this
 * instead of throwing into the dashboard error boundary (recurring bug
 * pattern #1), and it never reads as "no checklist" (pattern #28): it says
 * the checklist did not load and offers the same page again. Server-safe: no
 * 'use client', so either page may render it.
 */
export function ReceivingChecklistLoadFailed({ retryHref }: { retryHref: string }) {
  const c = RECEIVING_CHECKLIST_COPY;
  return (
    <div
      role="alert"
      data-testid="receiving-checklist-load-failed"
      className="bg-card border-destructive/40 rounded-xl border p-6 text-center"
    >
      <h2 className="text-destructive text-sm font-medium">{c.loadFailed}</h2>
      <p className="text-muted-foreground mx-auto mt-1 max-w-md text-sm">{c.loadFailedBody}</p>
      <Button asChild variant="outline" className="mt-4">
        <Link href={retryHref}>{c.tryAgain}</Link>
      </Button>
    </div>
  );
}
