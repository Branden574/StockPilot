import { redirect } from 'next/navigation';

import { BackfillCoversButton } from '@/components/books/backfill-covers-button';
import { BulkIsbnImport } from '@/components/books/bulk-isbn-import';
import { PageHeader, PageHeaderBackLink } from '@/components/patterns/page-header';
import { forcedWarehouseId } from '@/lib/auth/warehouse';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ChartersService } from '@/server/services/charters';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';
import { WarehousesService } from '@/server/services/warehouses';

import { can, resolveTerminology } from '@stockpilot/core';

export const metadata = { title: 'Bulk ISBN import' };

// Bulk ISBN imports run the server action `bulkCreateBooksAction` against
// this route. Server actions are POSTed to the page URL, so the route-level
// maxDuration applies to the action invocation. A 200-book import does
// ~200 inventory_items inserts + ~200 stock_movements inserts + parallel
// cover rehosts; well within 60s on Pro, comfortably past Hobby's default
// 10s ceiling. Without this, real-world imports trip Vercel 504s halfway
// through and leave partial state in inventory.
export const maxDuration = 60;

export default async function BulkIsbnImportPage() {
  const ctx = await requireOrgContext();
  if (!can(ctx, 'items:import')) {
    redirect('/dashboard/books');
  }
  const supabase = await createClient();

  const [warehousesSvc, chartersSvc, whChartersSvc, forced, orgRow] = await Promise.all([
    WarehousesService.forCurrentUser(),
    ChartersService.forCurrentUser(),
    WarehouseChartersService.forCurrentUser(),
    forcedWarehouseId(),
    supabase
      .from('organizations')
      .select('terminology')
      .eq('id', ctx.organizationId)
      .maybeSingle(),
  ]);

  const [warehouses, charters, warehouseCharters] = await Promise.all([
    warehousesSvc.listNames(),
    chartersSvc.list(),
    whChartersSvc.listPairs(),
  ]);

  const term = resolveTerminology(
    (orgRow.data?.terminology as Partial<{
      charter_singular: string;
      warehouse_singular: string;
    }> | null) ?? null,
  );

  return (
    // The page area (DESIGN-SPEC 4 and 5.3) with the form at a reading width,
    // as the other form pages (Start a count).
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        back={<PageHeaderBackLink href="/dashboard/books">← Back to books</PageHeaderBackLink>}
        title="Bulk ISBN import"
        subline="Paste up to 200 ISBNs, look them up across Google Books / Open Library / Library of Congress in parallel, then create them as a batch. Perfect for school-year donation drops."
        actions={<BackfillCoversButton />}
        className="max-w-[880px]"
      />
      <div className="w-full max-w-[880px]">
        <BulkIsbnImport
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          charters={charters.map((c) => ({ id: c.id, name: c.name }))}
          warehouseCharters={warehouseCharters}
          forcedWarehouseId={forced}
          warehouseLabel={term.warehouse_singular}
          charterLabel={term.charter_singular}
        />
      </div>
    </div>
  );
}
