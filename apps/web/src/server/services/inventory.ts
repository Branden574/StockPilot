import 'server-only';

import { generateSku } from '@/lib/utils';

import type {
  AdjustStockInput,
  CreateItemInput,
  TransferStockInput,
  UpdateItemInput,
} from '@stockpilot/core';

import { assertPermission, assertPlanLimit, ServiceError, withContext, type ServiceContext } from './context';

export interface ItemListFilters {
  q?: string;
  status?: 'active' | 'archived' | 'discontinued' | 'all';
  categoryId?: string | null;
  locationId?: string | null;
  supplierId?: string | null;
  lowStock?: boolean;
  outOfStock?: boolean;
  cursor?: string | null;
  limit?: number;
}

export class InventoryService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new InventoryService(await withContext());
  }

  async list(filters: ItemListFilters = {}) {
    const limit = Math.min(filters.limit ?? 50, 200);
    let query = this.ctx.supabase
      .from('inventory_items')
      .select(
        'id, sku, barcode, name, description, status, quantity_on_hand, reorder_point, unit_cost, retail_price, category_id, supplier_id, primary_location_id, created_at, updated_at',
        { count: 'exact' },
      )
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (!filters.status || filters.status === 'active') {
      query = query.eq('status', 'active');
    } else if (filters.status !== 'all') {
      query = query.eq('status', filters.status);
    }

    if (filters.q && filters.q.trim()) {
      const term = filters.q.trim();
      query = query.or(
        `name.ilike.%${term}%,sku.ilike.%${term}%,barcode.ilike.%${term}%`,
      );
    }
    if (filters.categoryId) query = query.eq('category_id', filters.categoryId);
    if (filters.locationId) query = query.eq('primary_location_id', filters.locationId);
    if (filters.supplierId) query = query.eq('supplier_id', filters.supplierId);
    if (filters.outOfStock) query = query.lte('quantity_on_hand', 0);

    const { data, error, count } = await query;
    if (error) throw new ServiceError('internal_error', error.message);

    return {
      items: (data ?? []) as Array<{
        id: string;
        sku: string;
        barcode: string | null;
        name: string;
        description: string | null;
        status: 'active' | 'archived' | 'discontinued';
        quantity_on_hand: number;
        reorder_point: number;
        unit_cost: number;
        retail_price: number;
        category_id: string | null;
        supplier_id: string | null;
        primary_location_id: string | null;
        created_at: string;
        updated_at: string;
      }>,
      total: count ?? 0,
    };
  }

  async get(id: string) {
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Item not found');
    return data;
  }

  async create(input: CreateItemInput) {
    assertPermission(this.ctx, 'items:create');
    await assertPlanLimit(this.ctx, 'items');

    const sku = (input.sku && input.sku.trim()) || generateSku();

    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .insert({
        organization_id: this.ctx.organizationId,
        sku,
        barcode: input.barcode ?? null,
        name: input.name,
        description: input.description ?? null,
        category_id: input.categoryId ?? null,
        supplier_id: input.supplierId ?? null,
        primary_location_id: input.primaryLocationId ?? null,
        unit_cost: input.unitCost,
        retail_price: input.retailPrice,
        quantity_on_hand: input.quantityOnHand,
        reorder_point: input.reorderPoint,
        reorder_quantity: input.reorderQuantity,
        unit_of_measure: input.unitOfMeasure,
        bin_location: input.binLocation ?? null,
        custom_fields: input.customFields,
        status: input.status,
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ServiceError('conflict', 'A item with that SKU already exists');
      }
      throw new ServiceError('internal_error', error.message);
    }

    if (input.quantityOnHand && input.quantityOnHand > 0) {
      await this.ctx.supabase.from('stock_movements').insert({
        organization_id: this.ctx.organizationId,
        item_id: data.id,
        movement_type: 'initial',
        quantity_change: input.quantityOnHand,
        previous_quantity: 0,
        new_quantity: input.quantityOnHand,
        user_id: this.ctx.userId,
        to_location_id: input.primaryLocationId ?? null,
      });
    }

    return data;
  }

  async update(id: string, patch: UpdateItemInput) {
    assertPermission(this.ctx, 'items:update');

    const updates: Record<string, unknown> = { updated_by: this.ctx.userId };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.sku !== undefined) updates.sku = patch.sku;
    if (patch.barcode !== undefined) updates.barcode = patch.barcode ?? null;
    if (patch.description !== undefined) updates.description = patch.description ?? null;
    if (patch.categoryId !== undefined) updates.category_id = patch.categoryId ?? null;
    if (patch.supplierId !== undefined) updates.supplier_id = patch.supplierId ?? null;
    if (patch.primaryLocationId !== undefined) updates.primary_location_id = patch.primaryLocationId ?? null;
    if (patch.unitCost !== undefined) updates.unit_cost = patch.unitCost;
    if (patch.retailPrice !== undefined) updates.retail_price = patch.retailPrice;
    if (patch.reorderPoint !== undefined) updates.reorder_point = patch.reorderPoint;
    if (patch.reorderQuantity !== undefined) updates.reorder_quantity = patch.reorderQuantity;
    if (patch.unitOfMeasure !== undefined) updates.unit_of_measure = patch.unitOfMeasure;
    if (patch.binLocation !== undefined) updates.bin_location = patch.binLocation ?? null;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.customFields !== undefined) updates.custom_fields = patch.customFields;

    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .update(updates)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();

    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }

  async archive(id: string) {
    assertPermission(this.ctx, 'items:update');
    const { error } = await this.ctx.supabase
      .from('inventory_items')
      .update({ status: 'archived', updated_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async softDelete(id: string) {
    assertPermission(this.ctx, 'items:delete');
    const { error } = await this.ctx.supabase
      .from('inventory_items')
      .update({ deleted_at: new Date().toISOString(), updated_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async adjustStock(input: AdjustStockInput) {
    assertPermission(this.ctx, 'stock:adjust');
    const { data, error } = await this.ctx.supabase.rpc('adjust_stock', {
      p_item_id: input.itemId,
      p_quantity_change: input.quantityChange,
      p_movement_type: input.movementType,
      p_location_id: input.locationId ?? null,
      p_reason: input.reason ?? null,
      p_notes: input.notes ?? null,
    });
    if (error) {
      if (error.message.includes('insufficient_stock')) {
        throw new ServiceError('validation_error', 'Insufficient stock for this adjustment');
      }
      if (error.message.includes('forbidden')) {
        throw new ServiceError('forbidden', 'Permission denied');
      }
      throw new ServiceError('internal_error', error.message);
    }
    return data;
  }

  async transferStock(input: TransferStockInput) {
    assertPermission(this.ctx, 'stock:transfer');
    const { data, error } = await this.ctx.supabase.rpc('transfer_stock', {
      p_item_id: input.itemId,
      p_from_location_id: input.fromLocationId,
      p_to_location_id: input.toLocationId,
      p_quantity: input.quantity,
      p_notes: input.notes ?? null,
    });
    if (error) throw new ServiceError('internal_error', error.message);
    return data;
  }
}
