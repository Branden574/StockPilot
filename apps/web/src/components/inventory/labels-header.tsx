import Link from 'next/link';
import type { ReactNode } from 'react';

import { LABELS_MAX_ITEMS } from '@/lib/inventory/labels-selection';

/** "N items selected · C copies each = L labels." — the page's summary line. */
export function labelsSummary(itemCount: number, copies: number): string {
  if (itemCount === 0) {
    return 'Pick items from the inventory list and click "Print labels" — or pass ?items=id1,id2 to this URL.';
  }
  const labels = itemCount * copies;
  return `${itemCount} item${itemCount === 1 ? '' : 's'} selected · ${copies} cop${copies === 1 ? 'y' : 'ies'} each = ${labels} label${labels === 1 ? '' : 's'}.`;
}

/**
 * Title block of the labels page, shared by the server-rendered ?items= path
 * and the ?selection= handoff from the bulk bar.
 *
 * `selectedCount` is how many items were asked for. One sheet prints at most
 * LABELS_MAX_ITEMS; when more were selected the page says so instead of
 * quietly printing the first ones.
 */
export function LabelsHeader({
  summary,
  selectedCount = 0,
}: {
  summary: ReactNode;
  selectedCount?: number;
}) {
  return (
    <div className="mb-6 print:hidden">
      <Link
        href="/dashboard/inventory"
        className="text-muted-foreground hover:text-foreground text-sm"
      >
        ← Back to inventory
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Print labels</h1>
      <p className="text-muted-foreground mt-1 text-sm">{summary}</p>
      {selectedCount > LABELS_MAX_ITEMS ? (
        <p className="mt-1 text-sm text-amber-700 dark:text-amber-400" role="status">
          {`${selectedCount} items were selected; one sheet prints at most ${LABELS_MAX_ITEMS}. These are the first ${LABELS_MAX_ITEMS}. Print them, then select the rest.`}
        </p>
      ) : null}
    </div>
  );
}
