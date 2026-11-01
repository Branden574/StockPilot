import Link from 'next/link';

import { StatePanel } from '@/components/patterns/state-panel';
import { Button } from '@/components/ui/button';

import { RECEIVING_CHECKLIST_COPY } from '@stockpilot/core';

/**
 * A receiving checklist page whose read failed (F4-1). The page renders this
 * instead of throwing into the dashboard error boundary (recurring bug
 * pattern #1), and it never reads as "no checklist" (pattern #28): it says
 * the checklist did not load and offers the same page again, in the shared
 * failed-read panel (StatePanel, matrix W-SH-33). Server-safe: no
 * 'use client', so either page may render it.
 */
export function ReceivingChecklistLoadFailed({ retryHref }: { retryHref: string }) {
  const c = RECEIVING_CHECKLIST_COPY;
  return (
    <StatePanel
      kind="failed"
      live="assertive"
      data-testid="receiving-checklist-load-failed"
      title={c.loadFailed}
      description={c.loadFailedBody}
      action={
        <Button asChild variant="outline">
          <Link href={retryHref}>{c.tryAgain}</Link>
        </Button>
      }
    />
  );
}
