import { VendorMappingsManager } from '@/components/admin/vendor-mappings-manager';
import { InventoryService } from '@/server/services/inventory';
import { SuppliersService } from '@/server/services/suppliers';
import { createClient } from '@/lib/supabase/server';
import { requireOrgContext } from '@/lib/auth/session';

export default async function VendorMappingsPage() {
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const [suppliers, items, mappingsRes] = await Promise.all([
    (await SuppliersService.forCurrentUser()).list(),
    // expected:'any' (mig 0277): vendor mappings are receiving-adjacent —
    // a vendor SKU must be mappable to an item still awaiting its first
    // receipt so the next PO upload resolves to it instead of creating a
    // duplicate.
    (await InventoryService.forCurrentUser()).list({ limit: 500, expected: 'any' }),
    supabase
      .from('vendor_item_mappings')
      .select(
        'id, vendor_id, item_id, vendor_item_number, vendor_product_number, auxiliary_number, vendor_description',
      )
      .eq('organization_id', ctx.organizationId)
      .order('vendor_id'),
  ]);

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 pb-20 pt-7">
      <h1 className="font-display text-[28px] font-medium tracking-[-0.025em]">
        Vendor item mappings
      </h1>
      <p className="text-muted-foreground mt-1 text-[13.5px]">
        Map vendor product numbers (e.g. Staples #867474) to your internal items
        so future PO uploads auto-resolve.
      </p>
      <div className="mt-6">
        <VendorMappingsManager
          mappings={
            (mappingsRes.data ?? []) as Array<{
              id: string;
              vendor_id: string;
              item_id: string;
              vendor_item_number: string | null;
              vendor_product_number: string | null;
              auxiliary_number: string | null;
              vendor_description: string | null;
            }>
          }
          suppliers={suppliers.map((s) => ({
            id: s.id as string,
            name: s.name as string,
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
