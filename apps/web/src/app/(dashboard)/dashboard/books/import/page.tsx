import Link from 'next/link';

import { BackfillCoversButton } from '@/components/books/backfill-covers-button';
import { BulkIsbnImport } from '@/components/books/bulk-isbn-import';
import { forcedWarehouseId } from '@/lib/auth/warehouse';
import { requireOrgContext } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import { ChartersService } from '@/server/services/charters';
import { WarehouseChartersService } from '@/server/services/warehouse-charters';
import { WarehousesService } from '@/server/services/warehouses';

import { resolveTerminology } from '@stockpilot/core';

export const metadata = { title: 'Bulk ISBN import' };

export default async function BulkIsbnImportPage() {
  const ctx = await requireOrgContext();
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
    warehousesSvc.list(),
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
    <div className="container mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="mb-6">
        <Link
          href="/dashboard/books"
          className="text-muted-foreground hover:text-foreground text-sm"
        >
          ← Back to books
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Bulk ISBN import
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Paste up to 200 ISBNs, look them up across Google Books / Open
              Library / Library of Congress in parallel, then create them as
              a batch. Perfect for school-year donation drops.
            </p>
          </div>
          <BackfillCoversButton />
        </div>
      </div>
      <BulkIsbnImport
        warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
        charters={charters.map((c) => ({ id: c.id, name: c.name }))}
        warehouseCharters={warehouseCharters}
        forcedWarehouseId={forced}
        warehouseLabel={term.warehouse_singular}
        charterLabel={term.charter_singular}
      />
    </div>
  );
}
