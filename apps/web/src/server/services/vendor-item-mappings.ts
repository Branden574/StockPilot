import 'server-only';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import {
  matchByVendorNumber,
  type MappingRow,
  type MatchInput,
  type MatchResult,
  type MatchSource,
} from './vendor-item-mappings-match';

import type { UpsertVendorItemMappingInput } from '@stockpilot/core';

export {
  matchByVendorNumber,
  type MappingRow,
  type MatchInput,
  type MatchResult,
  type MatchSource,
};

export class VendorItemMappingsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new VendorItemMappingsService(await withContext());
  }

  async listForVendor(vendorId: string): Promise<MappingRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('vendor_item_mappings')
      .select('id, vendor_id, item_id, vendor_item_number, vendor_product_number, auxiliary_number')
      .eq('organization_id', this.ctx.organizationId)
      .eq('vendor_id', vendorId);
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as MappingRow[];
  }

  async upsert(input: UpsertVendorItemMappingInput) {
    assertPermission(this.ctx, 'purchase_orders:manage');
    const { data, error } = await this.ctx.supabase
      .from('vendor_item_mappings')
      .upsert(
        {
          organization_id: this.ctx.organizationId,
          vendor_id: input.vendorId,
          item_id: input.itemId,
          vendor_item_number: input.vendorItemNumber ?? null,
          vendor_product_number: input.vendorProductNumber ?? null,
          auxiliary_number: input.auxiliaryNumber ?? null,
          vendor_description: input.vendorDescription ?? null,
          vendor_uom: input.vendorUom ?? null,
          pack_qty: input.packQty ?? null,
          conversion_factor: input.conversionFactor ?? null,
          approved_by: this.ctx.userId,
          approved_at: new Date().toISOString(),
        },
        { onConflict: 'organization_id,vendor_id,vendor_item_number' },
      )
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'vendor_item_mapping.upserted',
      entityType: 'vendor_item_mapping',
      entityId: data.id as string,
      after: input,
    });
    return { id: data.id as string };
  }

  async delete(id: string) {
    assertPermission(this.ctx, 'purchase_orders:manage');
    const { error } = await this.ctx.supabase
      .from('vendor_item_mappings')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }
}
