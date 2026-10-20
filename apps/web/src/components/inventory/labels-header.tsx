import type { ReactNode } from 'react';

import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
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
  // The shared page header, on screen only: printing shows the labels alone.
  return (
    <PageHeader
      className="print:hidden"
      back={
        <PageHeaderBackLink href="/dashboard/inventory">← Back to inventory</PageHeaderBackLink>
      }
      title="Print labels"
      subline={summary}
    >
      {selectedCount > LABELS_MAX_ITEMS ? (
        <p
          className="border-warning/40 bg-warning-wash text-foreground mt-3 rounded-md border px-3 py-2 text-[13px]"
          role="status"
        >
          {`${selectedCount} items were selected; one sheet prints at most ${LABELS_MAX_ITEMS}. These are the first ${LABELS_MAX_ITEMS}. Print them, then select the rest.`}
        </p>
      ) : null}
    </PageHeader>
  );
}
