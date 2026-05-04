import { UomConversionsManager } from '@/components/admin/uom-conversions-manager';
import { InventoryService } from '@/server/services/inventory';
import { UomConversionsService } from '@/server/services/uom-conversions';

export default async function UomConversionsAdminPage() {
  const [items, conversions] = await Promise.all([
    (await InventoryService.forCurrentUser()).list({ limit: 500 }),
    (await UomConversionsService.forCurrentUser()).list(),
  ]);

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 pb-20 pt-7">
      <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">
        Unit-of-measure conversions
      </h1>
      <p className="text-muted-foreground mt-1 text-[13.5px]">
        Define how vendor pack/box/carton quantities convert to your internal
        base UoM. A receipt of &quot;1 PK&quot; of AA batteries with a
        &quot;1 PK = 24 EA&quot; conversion bumps stock by 24.
      </p>
      <div className="mt-6">
        <UomConversionsManager
          conversions={conversions.map((c) => ({
            id: c.id,
            item_id: c.item_id,
            from_uom: c.from_uom,
            to_uom: c.to_uom,
            numerator: c.numerator,
            denominator: c.denominator,
            rounding_rule: c.rounding_rule,
          }))}
          items={items.items.map((i) => ({
            id: i.id,
            sku: i.sku,
            name: i.name,
          }))}
        />
      </div>
    </div>
  );
}
