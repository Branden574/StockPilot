import 'server-only';

import { generateSku } from '@/lib/utils';
import {
  assertWarehouseAccess,
  forcedWarehouseId,
  getWarehouseAccess,
  ForbiddenError,
} from '@/lib/auth/warehouse';

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
  /** Optional filter for managers/admins. Ignored for warehouse-scoped users (forced). */
  warehouseId?: string | null;
  /**
   * Filter by item_type. Common values:
   *   - 'product' (default for the inventory tab)
   *   - 'book' (books tab)
   *   - 'all' (no filter — used by reports / dashboard rollups)
   */
  itemType?: 'product' | 'book' | 'asset' | 'consumable' | 'all';
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
    // Pass our ctx so getWarehouseAccess doesn't fall through to
    // requireOrgContext() — same NEXT_REDIRECT trap that broke
    // /api/v1/items/[id]/barcode when called from an API route.
    const access = await getWarehouseAccess(this.ctx);

    let query = this.ctx.supabase
      .from('inventory_items')
      .select(
        'id, sku, barcode, name, description, status, quantity_on_hand, reorder_point, unit_cost, retail_price, category_id, supplier_id, primary_location_id, warehouse_id, charter_id, tracking_type, item_type, custom_fields, created_at, updated_at',
        // Estimated counts use pg_class.reltuples (~1ms) instead of a full
        // sequential count under RLS. Display purposes don't need precision.
        { count: 'estimated' },
      )
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .limit(limit);

    // Warehouse scoping: defense against URL/API tampering. Warehouse-scoped
    // users (staff/viewer) never see items outside their assignments — even
    // if the request omits or forges warehouseId. Managers/admins may pass
    // an optional warehouseId filter; otherwise see everything.
    if (!access.hasAllAccess) {
      if (access.readableIds.length === 0) {
        return { items: [], total: 0 };
      }
      query = query.in('warehouse_id', access.readableIds);
    } else if (filters.warehouseId) {
      query = query.eq('warehouse_id', filters.warehouseId);
    }

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
    // PostgREST can't express qty_on_hand <= reorder_point in a single
    // filter, so narrow to items that have a reorder_point set and do the
    // final cross-column compare in JS below.
    if (filters.lowStock) query = query.gt('reorder_point', 0);

    // item_type defaults to 'product' so the legacy /dashboard/inventory tab
    // doesn't accidentally show books/assets. Pass 'all' to disable.
    if (filters.itemType === undefined) {
      query = query.eq('item_type', 'product');
    } else if (filters.itemType !== 'all') {
      query = query.eq('item_type', filters.itemType);
    }

    const { data, error, count } = await query;
    if (error) throw new ServiceError('internal_error', error.message);

    let rows = data ?? [];
    let totalCount = count ?? 0;
    if (filters.lowStock) {
      const filtered = rows.filter(
        (r: { quantity_on_hand: number; reorder_point: number }) =>
          r.quantity_on_hand <= r.reorder_point,
      );
      totalCount = filtered.length;
      rows = filtered;
    }

    return {
      items: rows as Array<{
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
        warehouse_id: string | null;
        charter_id: string | null;
        tracking_type: 'none' | 'lot' | 'serial';
        item_type: 'product' | 'book' | 'asset' | 'consumable';
        custom_fields: Record<string, unknown>;
        created_at: string;
        updated_at: string;
      }>,
      total: totalCount,
    };
  }

  /**
   * Loads only the (id, sku, name, tracking_type) tuple for a list of item
   * ids. Lets callers like the PO detail page render line rows without
   * over-fetching the entire inventory just for name/sku lookups. Order
   * is not guaranteed; callers should index by id.
   */
  async byIds(
    ids: string[],
  ): Promise<Array<{ id: string; sku: string; name: string; tracking_type: 'none' | 'lot' | 'serial' }>> {
    if (ids.length === 0) return [];
    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, sku, name, tracking_type')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', ids)
      .is('deleted_at', null);
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []).map((r) => ({
      id: r.id as string,
      sku: r.sku as string,
      name: r.name as string,
      tracking_type: ((r.tracking_type as string | null) ?? 'none') as
        | 'none'
        | 'lot'
        | 'serial',
    }));
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

    // Re-check warehouse access on the loaded row in case RLS was bypassed
    // (e.g. service-role contexts). For warehouse-scoped users this enforces
    // their assignment list.
    //
    // Pass our own ctx so the helper doesn't fall back to
    // requireOrgContext() — that path redirects to /signin and inside an
    // API route the redirect throws NEXT_REDIRECT, surfacing as a 500
    // (which broke the Print Label endpoint until this was fixed).
    const wh = (data as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (wh) {
      try {
        await assertWarehouseAccess(wh, 'read', this.ctx);
      } catch (e) {
        if (e instanceof ForbiddenError) throw new ServiceError('not_found', 'Item not found');
        throw e;
      }
    }
    return data;
  }

  async create(input: CreateItemInput) {
    assertPermission(this.ctx, 'items:create');
    await assertPlanLimit(this.ctx, 'items');

    const sku = (input.sku && input.sku.trim()) || generateSku();

    // Resolve warehouse: warehouse-scoped users (staff/viewer) get their
    // assignment forced regardless of input. Managers/admins must specify
    // one (we can't pick "any" silently — items must belong to a warehouse).
    // Pass our ctx so the helpers don't fall back to requireOrgContext()
    // (NEXT_REDIRECT trap when called from /api/* routes).
    const forced = await forcedWarehouseId(this.ctx);
    const resolvedWarehouseId = forced ?? input.warehouseId ?? null;
    if (!resolvedWarehouseId) {
      throw new ServiceError(
        'validation_error',
        'A warehouse must be selected before creating an item.',
      );
    }
    if (!forced) {
      // Manager/admin path: validate they have write access to the chosen warehouse.
      await assertWarehouseAccess(resolvedWarehouseId, 'write', this.ctx);
    }

    // Resolve charter: null = generic stock; otherwise (warehouse, charter)
    // must be a real pairing in warehouse_charters. The composite FK enforces
    // it on insert, but a friendlier error here saves a round trip.
    const resolvedCharterId = input.charterId ?? null;
    if (resolvedCharterId) {
      const { data: pair } = await this.ctx.supabase
        .from('warehouse_charters')
        .select('charter_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('warehouse_id', resolvedWarehouseId)
        .eq('charter_id', resolvedCharterId)
        .maybeSingle();
      if (!pair) {
        throw new ServiceError(
          'validation_error',
          'This charter is not serviced by the chosen warehouse. Pick a different one or mark the item as Generic.',
        );
      }
    }

    const { data, error } = await this.ctx.supabase
      .from('inventory_items')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: resolvedWarehouseId,
        charter_id: resolvedCharterId,
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
        tracking_type: input.trackingType,
        item_type: input.itemType,
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

    // Load current row to enforce warehouse-write access and to lock down
    // moves. Warehouse-scoped users cannot move an item to another warehouse;
    // managers/admins can only move it if they have write access to both.
    const current = await this.get(id);
    const currentWarehouseId = (current as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (currentWarehouseId) await assertWarehouseAccess(currentWarehouseId, 'write');

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
    if (patch.trackingType !== undefined) updates.tracking_type = patch.trackingType;
    if (patch.itemType !== undefined) updates.item_type = patch.itemType;
    if (patch.status !== undefined) updates.status = patch.status;
    if (patch.customFields !== undefined) updates.custom_fields = patch.customFields;

    if (patch.warehouseId !== undefined && patch.warehouseId !== currentWarehouseId) {
      const forced = await forcedWarehouseId();
      if (forced) {
        throw new ServiceError(
          'forbidden',
          'Warehouse-scoped users cannot move items to another warehouse.',
        );
      }
      if (!patch.warehouseId) {
        throw new ServiceError('validation_error', 'Item must remain assigned to a warehouse.');
      }
      await assertWarehouseAccess(patch.warehouseId, 'write');
      updates.warehouse_id = patch.warehouseId;
    }

    if (patch.charterId !== undefined) {
      // Validate the (final) (warehouse, charter) pair if non-null
      const finalWarehouseId =
        (updates.warehouse_id as string | undefined) ?? currentWarehouseId ?? null;
      if (patch.charterId && finalWarehouseId) {
        const { data: pair } = await this.ctx.supabase
          .from('warehouse_charters')
          .select('charter_id')
          .eq('organization_id', this.ctx.organizationId)
          .eq('warehouse_id', finalWarehouseId)
          .eq('charter_id', patch.charterId)
          .maybeSingle();
        if (!pair) {
          throw new ServiceError(
            'validation_error',
            'This charter is not serviced by the chosen warehouse.',
          );
        }
      }
      updates.charter_id = patch.charterId ?? null;
    }

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
    const current = await this.get(id);
    const wh = (current as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (wh) await assertWarehouseAccess(wh, 'write');
    const { error } = await this.ctx.supabase
      .from('inventory_items')
      .update({ status: 'archived', updated_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  /**
   * Bulk-applies one of a small whitelist of mutations across multiple
   * items. Validates per-item warehouse access (so a manager can't batch-
   * mutate an item in a warehouse they can't write to). Returns counts.
   *
   * Why one method instead of bulkArchive / bulkSetCategory / etc.: the
   * permission check + per-item warehouse-access loop is identical for
   * all of them, and bundling keeps that loop in one place.
   */
  async bulkUpdate(input: {
    ids: string[];
    op:
      | { kind: 'archive' }
      | { kind: 'unarchive' }
      | { kind: 'set_category'; categoryId: string | null }
      | { kind: 'set_supplier'; supplierId: string | null }
      | { kind: 'set_status'; status: 'active' | 'archived' | 'discontinued' };
  }): Promise<{ ok: number; skipped: number }> {
    assertPermission(this.ctx, 'items:update');
    if (input.ids.length === 0) return { ok: 0, skipped: 0 };
    if (input.ids.length > 500) {
      throw new ServiceError(
        'validation_error',
        'Bulk operations are limited to 500 items at a time.',
      );
    }

    const { data: rows, error: loadErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', input.ids)
      .is('deleted_at', null);
    if (loadErr) throw new ServiceError('internal_error', loadErr.message);

    const access = await getWarehouseAccess(this.ctx);
    const writableSet = new Set(access.writableIds);
    const allowedIds: string[] = [];
    let skipped = 0;
    for (const r of rows ?? []) {
      const wh = (r.warehouse_id as string | null) ?? null;
      if (access.hasAllAccess || wh === null || writableSet.has(wh)) {
        allowedIds.push(r.id as string);
      } else {
        skipped += 1;
      }
    }
    if (allowedIds.length === 0) return { ok: 0, skipped };

    const update: Record<string, unknown> = { updated_by: this.ctx.userId };
    switch (input.op.kind) {
      case 'archive':
        update.status = 'archived';
        break;
      case 'unarchive':
        update.status = 'active';
        break;
      case 'set_status':
        update.status = input.op.status;
        break;
      case 'set_category':
        update.category_id = input.op.categoryId;
        break;
      case 'set_supplier':
        update.supplier_id = input.op.supplierId;
        break;
    }

    const { error } = await this.ctx.supabase
      .from('inventory_items')
      .update(update)
      .eq('organization_id', this.ctx.organizationId)
      .in('id', allowedIds);
    if (error) throw new ServiceError('internal_error', error.message);

    return { ok: allowedIds.length, skipped };
  }

  async softDelete(id: string) {
    assertPermission(this.ctx, 'items:delete');
    const current = await this.get(id);
    const wh = (current as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (wh) await assertWarehouseAccess(wh, 'write');
    const { error } = await this.ctx.supabase
      .from('inventory_items')
      .update({ deleted_at: new Date().toISOString(), updated_by: this.ctx.userId })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async adjustStock(input: AdjustStockInput) {
    assertPermission(this.ctx, 'stock:adjust');
    // Verify the item is in a warehouse the user can write to before
    // delegating to the RPC. The RPC also enforces this server-side.
    // Pass ctx so the helper doesn't fall back to requireOrgContext()
    // (NEXT_REDIRECT trap when called from /api/* routes).
    const item = await this.get(input.itemId);
    const wh = (item as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (wh) await assertWarehouseAccess(wh, 'write', this.ctx);
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
