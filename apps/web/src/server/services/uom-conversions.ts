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

  async upsert(input: UpsertUomConversionInput) {
    assertPermission(this.ctx, 'items:update');
    const fromUom = input.fromUom.toUpperCase();
    const toUom = input.toUom.toUpperCase();
    if (fromUom === toUom) {
      throw new ServiceError(
        'validation_error',
        'from_uom and to_uom must differ. Identity conversions are implicit.',
      );
    }
    const { data, error } = await this.ctx.supabase
      .from('uom_conversions')
      .upsert(
        {
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
        },
        { onConflict: 'organization_id,item_id,from_uom,to_uom' },
      )
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'uom_conversion.upserted',
      entityType: 'uom_conversion',
      entityId: data.id as string,
      after: { ...input, fromUom, toUom },
    });
    return { id: data.id as string };
  }

  async delete(id: string) {
    assertPermission(this.ctx, 'items:update');
    const { error } = await this.ctx.supabase
      .from('uom_conversions')
      .delete()
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'uom_conversion.deleted',
      entityType: 'uom_conversion',
      entityId: id,
    });
  }
}
