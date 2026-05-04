import { BinsManager } from '@/components/admin/bins-manager';
import { BinsService } from '@/server/services/bins';
import { WarehousesService } from '@/server/services/warehouses';

export default async function BinsAdminPage() {
  const [warehouses, bins] = await Promise.all([
    (await WarehousesService.forCurrentUser()).list(),
    (await BinsService.forCurrentUser()).list(),
  ]);

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 pb-20 pt-7">
      <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">Bins</h1>
      <p className="text-muted-foreground mt-1 text-[13.5px]">
        Physical bins/zones inside each warehouse. Inventory tracks per-bin
        breakdown via inventory_stock; the warehouse total
        (inventory_items.quantity_on_hand) stays the source of truth for
        org-wide reporting.
      </p>
      <div className="mt-6">
        <BinsManager
          warehouses={warehouses.map((w) => ({ id: w.id, name: w.name }))}
          bins={bins}
        />
      </div>
    </div>
  );
}
