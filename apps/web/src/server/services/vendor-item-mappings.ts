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

    // The DB enforces uniqueness via a functional, partial index:
    //   UNIQUE (organization_id, vendor_id, lower(vendor_item_number))
    //   WHERE vendor_item_number IS NOT NULL
    // PostgREST's onConflict can't match functional/partial indexes, so
    // we look up the existing row case-insensitively first and then
    // INSERT or UPDATE explicitly. The DB index still backstops us if
    // a concurrent insert ever races us.
    let existingId: string | null = null;
    if (input.vendorItemNumber) {
      const { data, error: findErr } = await this.ctx.supabase
        .from('vendor_item_mappings')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('vendor_id', input.vendorId)
        .ilike('vendor_item_number', input.vendorItemNumber)
        .maybeSingle();
      if (findErr) throw new ServiceError('internal_error', findErr.message);
      existingId = (data?.id as string | undefined) ?? null;
    }

    const payload = {
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
    };

    let id: string;
    if (existingId) {
      const { data, error } = await this.ctx.supabase
        .from('vendor_item_mappings')
        .update(payload)
        .eq('id', existingId)
        .select('id')
        .single();
      if (error) throw new ServiceError('internal_error', error.message);
      id = data.id as string;
    } else {
      const { data, error } = await this.ctx.supabase
        .from('vendor_item_mappings')
        .insert(payload)
        .select('id')
        .single();
      if (error) throw new ServiceError('internal_error', error.message);
      id = data.id as string;
    }

    await audit({
      event: 'vendor_item_mapping.upserted',
      entityType: 'vendor_item_mapping',
      entityId: id,
      after: input,
    });
    return { id };
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
