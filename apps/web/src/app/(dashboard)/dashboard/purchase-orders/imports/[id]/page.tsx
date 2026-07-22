import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PoImportDetail } from '@/components/po-imports/po-import-detail';
import { PoImportLineageNotice } from '@/components/po-imports/po-import-lineage-notice';
import { ChartersService } from '@/server/services/charters';
import { ServiceError } from '@/server/services/context';
import { InventoryService } from '@/server/services/inventory';
import { LocationsService } from '@/server/services/locations';
import { PoImportsService } from '@/server/services/po-imports';
import { SuppliersService } from '@/server/services/suppliers';
import { WarehousesService } from '@/server/services/warehouses';

export default async function PoImportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const svc = await PoImportsService.forCurrentUser();

  let header, lines, lineage;
  try {
    ({ header, lines, lineage } = await svc.get(id));
  } catch (e) {
    if (e instanceof ServiceError && e.code === 'not_found') notFound();
    throw e;
  }

  const [suppliers, warehouses, items, charters, locations] = await Promise.all([
    (await SuppliersService.forCurrentUser()).list(),
    (await WarehousesService.forCurrentUser()).listNames(),
    // Uncapped lean listing — list({ limit: 500 }) silently truncated the
    // match dropdown for >500-item orgs.
    (await InventoryService.forCurrentUser()).listForMatching(),
    (await ChartersService.forCurrentUser()).list(),
    (await LocationsService.forCurrentUser()).list({ sitesOnly: true }),
  ]);

  // Prefill the expected-delivery picker from the AI-extracted ship/delivery
  // date stored in parsed_json (scan imports only). Only a clean YYYY-MM-DD is
  // accepted — `<input type="date">` rejects anything else.
  const rawExpected =
    (header as { parsed_json?: { expectedDate?: string } | null }).parsed_json?.expectedDate?.trim() ?? '';
  const defaultExpectedAt = /^\d{4}-\d{2}-\d{2}$/.test(rawExpected) ? rawExpected : null;

  // A line's suggested_item_id (barcode/ISBN/vendor-mapping match — Tasks
  // 2/3) is write-only advisory data until we resolve it to something a
  // human can read. Build the label from the `items` lookup we already load
  // for the match combobox — no extra query. (The suggested item's charter
  // isn't in `listForMatching`'s intentionally lean column set, so it's
  // left out of the label rather than adding a query for it.)
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const linesWithSuggestions = lines.map((l) => {
    const suggested = l.suggested_item_id ? itemsById.get(l.suggested_item_id) : undefined;
    return {
      ...l,
      suggestionLabel: suggested ? `${suggested.name} · ${suggested.sku}` : null,
    };
  });

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/purchase-orders/imports"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to imports
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {header.file_name}
        </h1>
        {/* Lineage sits ABOVE the review UI on purpose: on a superseded import
            it changes how everything below it should be read, so it must not
            be reachable only after scrolling past the line table. */}
        <PoImportLineageNotice lineage={lineage} className="mt-4" />
        {header.superseded_at && lineage.successors.length === 0 && (
          // superseded_at is stamped, but the successor row is gone (deleted,
          // or invisible under RLS). Say so plainly rather than offering a
          // link that would 404.
          <p className="text-muted-foreground mt-3 text-xs">
            This file was imported again later, so this is no longer the live import for it.
          </p>
        )}
      </div>
      <PoImportDetail
        header={header}
        lines={linesWithSuggestions}
        suppliers={suppliers.map((s) => ({
          id: s.id as string,
          name: s.name as string,
        }))}
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        charters={charters.map((c) => ({ id: c.id, name: c.name }))}
        locations={(locations as Array<{ id: string; name: string; warehouse_id: string | null }>)
          .filter((l) => l.warehouse_id)
          .map((l) => ({ id: l.id, name: l.name, warehouseId: l.warehouse_id as string }))}
        items={items.map((i) => ({
          id: i.id,
          sku: i.sku,
          name: i.name,
          quantityOnHand: Number(i.quantity_on_hand) || 0,
          // createdAt drives the dropdown's SKU-dedupe (oldest row wins).
          createdAt: i.created_at,
        }))}
        defaultExpectedAt={defaultExpectedAt}
      />
    </div>
  );
}
