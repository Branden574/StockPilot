import 'server-only';

import { audit } from './audit';
import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

export type BinType =
  | 'receiving'
  | 'storage'
  | 'qa_hold'
  | 'damaged'
  | 'rejected'
  | 'shipping';

export interface BinRow {
  id: string;
  organization_id: string;
  warehouse_id: string;
  code: string;
  name: string;
  bin_type: BinType;
  is_default: boolean;
  status: 'active' | 'inactive' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface CreateBinInput {
  warehouseId: string;
  code: string;
  name: string;
  binType: BinType;
  isDefault?: boolean;
}

export class BinsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new BinsService(await withContext());
  }

  async list(): Promise<BinRow[]> {
    const { data, error } = await this.ctx.supabase
      .from('bins')
      .select(
        'id, organization_id, warehouse_id, code, name, bin_type, is_default, status, created_at, updated_at',
      )
      .eq('organization_id', this.ctx.organizationId)
      .neq('status', 'archived')
      .order('warehouse_id')
      .order('bin_type')
      .order('code');
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as BinRow[];
  }

  async create(input: CreateBinInput): Promise<{ id: string }> {
    assertPermission(this.ctx, 'organization:update');
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();
    if (!code || !name) {
      throw new ServiceError('validation_error', 'Code and name are required');
    }

    // If marked as default, clear any existing default for that (warehouse, bin_type).
    if (input.isDefault) {
      await this.ctx.supabase
        .from('bins')
        .update({ is_default: false })
        .eq('organization_id', this.ctx.organizationId)
        .eq('warehouse_id', input.warehouseId)
        .eq('bin_type', input.binType)
        .eq('is_default', true);
    }

    const { data, error } = await this.ctx.supabase
      .from('bins')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: input.warehouseId,
        code,
        name,
        bin_type: input.binType,
        is_default: input.isDefault ?? false,
        status: 'active',
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') {
        throw new ServiceError(
          'conflict',
          `A bin with code "${code}" already exists in this warehouse.`,
        );
      }
      throw new ServiceError('internal_error', error.message);
    }
    await audit({
      event: 'warehouse.updated',
      entityType: 'bin',
      entityId: data.id as string,
      warehouseId: input.warehouseId,
      after: { code, name, binType: input.binType, isDefault: !!input.isDefault },
    });
    return { id: data.id as string };
  }

  async archive(id: string): Promise<void> {
    assertPermission(this.ctx, 'organization:update');
    const { error } = await this.ctx.supabase
      .from('bins')
      .update({ status: 'archived' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }
}
