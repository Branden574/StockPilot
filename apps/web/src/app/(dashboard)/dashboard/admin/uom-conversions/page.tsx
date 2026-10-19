import { UomConversionsManager } from '@/components/admin/uom-conversions-manager';
import { PageHeader } from '@/components/patterns/page-header';
import { effectiveNavLabel } from '@/lib/nav-labels';
import { InventoryService } from '@/server/services/inventory';
import { UomConversionsService } from '@/server/services/uom-conversions';

export default async function UomConversionsAdminPage() {
  const [items, conversions, title] = await Promise.all([
    (await InventoryService.forCurrentUser()).list({ limit: 500 }),
    (await UomConversionsService.forCurrentUser()).list(),
    // A Settings > Navigation rename of the sidebar entry reaches the heading
    // (no read of its own: the org row is cached for the request).
    effectiveNavLabel('/dashboard/admin/uom-conversions', 'Unit-of-measure conversions'),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title={title}
        subline={
          <p className="max-w-[72ch]">
            Define how vendor pack/box/carton quantities convert to your internal base UoM. A
            receipt of &quot;1 PK&quot; of AA batteries with a &quot;1 PK = 24 EA&quot; conversion
            bumps stock by 24.
          </p>
        }
      />
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
  );
}
