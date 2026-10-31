import { VendorMappingsManager } from '@/components/admin/vendor-mappings-manager';
import { PageHeader } from '@/components/patterns/page-header';
import { effectiveNavLabel } from '@/lib/nav-labels';
import { InventoryService } from '@/server/services/inventory';
import { SuppliersService } from '@/server/services/suppliers';
import { createClient } from '@/lib/supabase/server';
import { requireOrgContext } from '@/lib/auth/session';

export default async function VendorMappingsPage() {
  const ctx = await requireOrgContext();
  const supabase = await createClient();

  const [suppliers, items, mappingsRes, title] = await Promise.all([
    (await SuppliersService.forCurrentUser()).listForLookups(),
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
    // A Settings > Navigation rename of the sidebar entry reaches the heading
    // (no read of its own: the org row is cached for the request).
    effectiveNavLabel('/dashboard/admin/vendor-mappings', 'Vendor item mappings'),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-4 px-4 pb-16 pt-6 sm:px-8 sm:pt-7">
      <PageHeader
        title={title}
        titleId="vendor-mappings-title"
        subline="Map vendor product numbers (for example, the item number on a supplier's invoice) to your internal items so future PO uploads auto-resolve."
      />
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
  );
}
