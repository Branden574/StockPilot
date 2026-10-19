import { BinsManager } from '@/components/admin/bins-manager';
import { PageHeader } from '@/components/patterns/page-header';
import { effectiveNavLabel } from '@/lib/nav-labels';
import { BinsService } from '@/server/services/bins';
import { WarehousesService } from '@/server/services/warehouses';

export default async function BinsAdminPage() {
  const [warehouses, bins, title] = await Promise.all([
    (await WarehousesService.forCurrentUser()).listNames(),
    (await BinsService.forCurrentUser()).list(),
    // A Settings > Navigation rename of the sidebar entry reaches the heading
    // (no read of its own: the org row is cached for the request).
    effectiveNavLabel('/dashboard/admin/bins', 'Bins'),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title={title}
        subline={
          <p className="max-w-[72ch]">
            Physical bins/zones inside each warehouse. Inventory tracks per-bin breakdown via
            inventory_stock; the warehouse total (inventory_items.quantity_on_hand) stays the source
            of truth for org-wide reporting.
          </p>
        }
      />
      <BinsManager warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))} bins={bins} />
    </div>
  );
}
