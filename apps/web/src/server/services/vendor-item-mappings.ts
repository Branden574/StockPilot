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

/**
 * V5: Escape `%` and `_` so a vendor SKU like `AB_12%` is matched
 * literally by PostgREST `.ilike()` — otherwise these characters are
 * treated as wildcards and a SKU like `AB_12` collides with `AB-12`.
 */
function escapeIlike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

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

  /**
   * V1: org-scoped existence check for an `inventory_items.id`. Prevents
   * a caller from referencing an item that belongs to a different org by
   * supplying a stolen UUID directly to the action. RLS on
   * `vendor_item_mappings` only filters by `organization_id`, not by
   * whether the referenced `item_id` is in the same org, so the FK alone
   * is not sufficient.
   */
  private async assertItemBelongsToOrg(itemId: string): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', itemId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'validation_error',
        'Item not found in this organization.',
      );
    }
  }

  /**
   * V1: same trick for the vendor (`suppliers.id`). Suppliers carry org
   * scoping; without this check, a caller could attach a mapping to a
   * supplier from another org by guessing/leaking its UUID.
   */
  private async assertVendorBelongsToOrg(vendorId: string): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('suppliers')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', vendorId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'validation_error',
        'Vendor not found in this organization.',
      );
    }
  }

  async upsert(input: UpsertVendorItemMappingInput) {
    assertPermission(this.ctx, 'purchase_orders:manage');

    // V1: validate cross-org references BEFORE any DB write. Without
    // these checks, a malicious caller could attach a mapping to an item
    // (or vendor) belonging to a different organization by passing a
    // UUID they shouldn't have.
    await this.assertVendorBelongsToOrg(input.vendorId);
    await this.assertItemBelongsToOrg(input.itemId);

    // The DB enforces uniqueness via a functional, partial index:
    //   UNIQUE (organization_id, vendor_id, lower(vendor_item_number))
    //   WHERE vendor_item_number IS NOT NULL
    // PostgREST's onConflict can't match functional/partial indexes, so
    // we look up the existing row case-insensitively first and then
    // INSERT or UPDATE explicitly. The DB index still backstops us if
    // a concurrent insert ever races us.
    //
    // V5: `.ilike()` treats `_` and `%` as wildcards, so a vendor SKU
    // like `AB_12` would match `AB-12`, `ABX12`, etc., potentially
    // colliding with an unrelated row. Escape the wildcards before
    // passing to `.ilike()` so the lookup is literally case-insensitive
    // equality. We keep `.ilike()` (instead of switching to `.eq()`)
    // because the index keys on `lower(vendor_item_number)`, so an
    // exact `.eq()` would miss rows that differ only in case.
    let existingId: string | null = null;
    let beforeItemId: string | null = null;
    const trimmedVin = input.vendorItemNumber?.trim() ?? null;
    if (trimmedVin) {
      const escaped = escapeIlike(trimmedVin);
      const { data, error: findErr } = await this.ctx.supabase
        .from('vendor_item_mappings')
        .select('id, item_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('vendor_id', input.vendorId)
        .ilike('vendor_item_number', escaped)
        .maybeSingle();
      if (findErr) throw new ServiceError('internal_error', findErr.message);
      existingId = (data?.id as string | undefined) ?? null;
      beforeItemId = (data?.item_id as string | undefined) ?? null;
    }

    const payload = {
      organization_id: this.ctx.organizationId,
      vendor_id: input.vendorId,
      item_id: input.itemId,
      vendor_item_number: trimmedVin,
      vendor_product_number: input.vendorProductNumber?.trim() || null,
      auxiliary_number: input.auxiliaryNumber?.trim() || null,
      vendor_description: input.vendorDescription ?? null,
      // V7: vendor_uom / pack_qty / conversion_factor are deprecated
      // — the source of truth for unit conversions is `uom_conversions`.
      // We still write them through unchanged so any external readers
      // don't break, but new code should not depend on these fields.
      /** @deprecated use uom_conversions */
      vendor_uom: input.vendorUom ?? null,
      /** @deprecated use uom_conversions */
      pack_qty: input.packQty ?? null,
      /** @deprecated use uom_conversions */
      conversion_factor: input.conversionFactor ?? null,
      approved_by: this.ctx.userId,
      approved_at: new Date().toISOString(),
    };

    let id: string;
    let wasCreate = false;
    let retargeted = false;
    if (existingId) {
      // V6: a silent UPDATE here re-points the mapping at a new item_id
      // when the (vendor, vendor_item_number) lookup matched. Capture
      // before/after so the audit log reflects the retarget instead of
      // looking like a no-op update.
      retargeted =
        beforeItemId !== null && beforeItemId !== input.itemId;
      const { data, error } = await this.ctx.supabase
        .from('vendor_item_mappings')
        .update(payload)
        .eq('id', existingId)
        .select('id')
        .single();
      if (error) throw new ServiceError('internal_error', error.message);
      id = data.id as string;
    } else {
      wasCreate = true;
      const { data, error } = await this.ctx.supabase
        .from('vendor_item_mappings')
        .insert(payload)
        .select('id')
        .single();
      if (error) throw new ServiceError('internal_error', error.message);
      id = data.id as string;
    }

    // Keep the legacy `vendor_item_mapping.upserted` for backward
    // compatibility with anything consuming the audit feed, but ALSO
    // emit the new `vendor_mapping.created` / `vendor_mapping.updated`
    // event so dashboards can split the two paths cleanly.
    await audit(
      {
        event: 'vendor_item_mapping.upserted',
        entityType: 'vendor_item_mapping',
        entityId: id,
        after: input,
      },
      this.ctx,
    );
    await audit(
      {
        event: wasCreate ? 'vendor_mapping.created' : 'vendor_mapping.updated',
        entityType: 'vendor_item_mapping',
        entityId: id,
        before: retargeted ? { item_id: beforeItemId } : undefined,
        after: { item_id: input.itemId, retargeted },
      },
      this.ctx,
    );
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
    // V3: emit a delete audit event. We pass entityId so the audit
    // viewer can still link to the (now-deleted) mapping by id.
    await audit(
      {
        event: 'vendor_mapping.deleted',
        entityType: 'vendor_item_mapping',
        entityId: id,
      },
      this.ctx,
    );
  }
}
