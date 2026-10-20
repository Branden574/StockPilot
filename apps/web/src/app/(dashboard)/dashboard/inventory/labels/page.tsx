import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { LabelSheet } from '@/components/inventory/label-sheet';
import { parseTemplate, type LabelFormat } from '@/components/inventory/label-templates';
import { LabelsFromSelection } from '@/components/inventory/labels-from-selection';
import { LabelsHeader, labelsSummary } from '@/components/inventory/labels-header';
import { cleanLabelIds, LABELS_MAX_ITEMS } from '@/lib/inventory/labels-selection';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';

// A tab title of its own (CONFLICTS D16): the page used to inherit the
// dashboard's.
export const metadata: Metadata = { title: 'Print labels' };

interface LabelItem {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
}

/**
 * Two ways in:
 *  - ?selection=<key> — the Items bulk bar. The ids stay in this tab's
 *    sessionStorage and reach the server in a POST body (LabelsFromSelection
 *    → loadLabelItemsAction), because a request line carrying 443 ids was
 *    16,437 bytes and Node refused it with 431 before this page ran.
 *  - ?items=id1,id2 — one item's "Print label" link, bookmarks, and the bulk
 *    bar's fallback for a small selection when storage is unavailable.
 * Both read the rows with InventoryService.byIds on the caller's own session.
 */
export default async function LabelsPage({
  searchParams,
}: {
  searchParams: Promise<{
    items?: string;
    selection?: string;
    copies?: string;
    template?: string;
    format?: string;
  }>;
}) {
  const params = await searchParams;
  const copies = Math.max(1, Math.min(20, Number(params.copies) || 1));
  const template = parseTemplate(params.template);
  const format: LabelFormat = params.format === 'qr' ? 'qr' : 'barcode';

  if (params.selection !== undefined) {
    return (
      <LabelsContainer>
        <LabelsFromSelection
          selectionKey={params.selection}
          copies={copies}
          template={template}
          format={format}
        />
      </LabelsContainer>
    );
  }

  // Shape-checked before the read: one malformed id in a hand-edited URL
  // would fail its whole batch (22P02), which now fails the page.
  const ids = cleanLabelIds((params.items ?? '').split(',').map((s) => s.trim()));

  const inventorySvc = await InventoryService.forCurrentUser();
  let items: LabelItem[] = [];
  if (ids.length > 0) {
    try {
      // Fetch the REQUESTED ids directly (org-scoped, RLS-applied). The old
      // approach looked the ids up inside list({ limit: 500 }) — which
      // excludes rental items and silently misses anything past the first
      // 500 rows, so "Print label" from a rental item (or a big org's tail)
      // landed on "No items selected" despite a valid ?items= URL.
      const rows = await inventorySvc.byIds(ids.slice(0, LABELS_MAX_ITEMS));
      const byId = new Map(rows.map((i) => [i.id, i]));
      items = ids
        .map((id) => byId.get(id))
        .filter((i): i is NonNullable<typeof i> => Boolean(i))
        .map((i) => ({ id: i.id, name: i.name, sku: i.sku, barcode: i.barcode }));
    } catch (e) {
      // A failed read is not "No items selected": that sent the user back to
      // pick items that were already picked. byIds batches the ids and throws
      // internal_error on a failed batch; that reaches the error boundary.
      if (!(e instanceof ServiceError) || e.code === 'internal_error') throw e;
    }
  }

  return (
    <LabelsContainer>
      <LabelsHeader summary={labelsSummary(items.length, copies)} selectedCount={ids.length} />
      <LabelSheet items={items} copies={copies} template={template} format={format} />
    </LabelsContainer>
  );
}

/** The page area (DESIGN-SPEC 4 and 5.3), the same box every redesigned page
 *  draws; on paper it gives the whole page to the sheet. */
function LabelsContainer({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7 print:max-w-none print:gap-0 print:p-0">
      {children}
    </div>
  );
}
