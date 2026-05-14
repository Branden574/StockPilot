import 'server-only';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

import type {
  UpsertUomConversionInput,
  RoundingRule,
} from '@stockpilot/core';

export interface UomConversionRow {
  id: string;
  organization_id: string;
  item_id: string;
  from_uom: string;
  to_uom: string;
  numerator: number;
  denominator: number;
  rounding_rule: RoundingRule;
  created_at: string;
  updated_at: string;
}

export class UomConversionsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new UomConversionsService(await withContext());
  }

  async list(): Promise<UomConversionRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('uom_conversions')
      .select(
        'id, organization_id, item_id, from_uom, to_uom, numerator, denominator, rounding_rule, created_at, updated_at',
      )
      .eq('organization_id', this.ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as UomConversionRow[];
  }

  async listForItem(itemId: string): Promise<UomConversionRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('uom_conversions')
      .select(
        'id, organization_id, item_id, from_uom, to_uom, numerator, denominator, rounding_rule, created_at, updated_at',
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', itemId);
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as UomConversionRow[];
  }

  /**
   * U1: org-scoped existence check for an `inventory_items.id`. Without
   * this, a caller could attach a conversion to an item in another
   * organization by supplying a stolen UUID directly. RLS on
   * `uom_conversions` filters by `organization_id`, but not by whether
   * the referenced item belongs to the same org.
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

  async upsert(input: UpsertUomConversionInput) {
    assertPermission(this.ctx, 'items:update');

    // U1 + U3: validate item ownership BEFORE the identity short-circuit
    // and before any DB write. Previously the identity-conversion error
    // path (from === to) ran before the org check, so a caller could
    // probe for valid item UUIDs across orgs by watching the error
    // message change. Run the ownership check first.
    await this.assertItemBelongsToOrg(input.itemId);

    // U6: trim before .toUpperCase() — leading/trailing whitespace
    // wrecks the unique constraint and breaks downstream convert()
    // lookups. The 0086 migration adds a DB-side CHECK so even direct
    // REST writes cannot bypass this.
    const fromUom = input.fromUom.trim().toUpperCase();
    const toUom = input.toUom.trim().toUpperCase();
    if (!fromUom || !toUom) {
      throw new ServiceError(
        'validation_error',
        'from_uom and to_uom are required.',
      );
    }
    if (fromUom === toUom) {
      throw new ServiceError(
        'validation_error',
        'from_uom and to_uom must differ. Identity conversions are implicit.',
      );
    }

    // U5: previously the upsert wrote `created_by: this.ctx.userId` on
    // every call, which overwrites the original creator on conflict.
    // Switch to explicit select → update | insert so `created_by` is
    // only written on the INSERT path.
    const { data: existing, error: existingErr } = await this.ctx.supabase
      .from('uom_conversions')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('item_id', input.itemId)
      .eq('from_uom', fromUom)
      .eq('to_uom', toUom)
      .maybeSingle();
    if (existingErr) {
      throw new ServiceError('internal_error', existingErr.message);
    }

    let id: string;
    if (existing) {
      const { data, error } = await this.ctx.supabase
        .from('uom_conversions')
        .update({
          numerator: input.numerator,
          denominator: input.denominator,
          rounding_rule: input.roundingRule,
          approved_by: this.ctx.userId,
          approved_at: new Date().toISOString(),
        })
        .eq('id', existing.id as string)
        .select('id')
        .single();
      if (error) throw new ServiceError('internal_error', error.message);
      id = data.id as string;
    } else {
      const { data, error } = await this.ctx.supabase
        .from('uom_conversions')
        .insert({
          organization_id: this.ctx.organizationId,
          item_id: input.itemId,
          from_uom: fromUom,
          to_uom: toUom,
          numerator: input.numerator,
          denominator: input.denominator,
          rounding_rule: input.roundingRule,
          created_by: this.ctx.userId,
          approved_by: this.ctx.userId,
          approved_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (error) throw new ServiceError('internal_error', error.message);
      id = data.id as string;
    }

    await audit(
      {
        event: 'uom_conversion.upserted',
        entityType: 'uom_conversion',
        entityId: id,
        after: { ...input, fromUom, toUom },
      },
      this.ctx,
    );
    return { id };
  }

  async delete(id: string) {
    assertPermission(this.ctx, 'items:update');
    const { error } = await this.ctx.supabase
      .from('uom_conversions')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit(
      {
        event: 'uom_conversion.deleted',
        entityType: 'uom_conversion',
        entityId: id,
      },
      this.ctx,
    );
  }
}
