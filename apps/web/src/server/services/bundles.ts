import 'server-only';

import { audit } from './audit';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

export interface BundleRow {
  id: string;
  organization_id: string;
  name: string;
  sku: string | null;
  description: string | null;
  is_active: boolean;
  preassembly_enabled: boolean;
  phantom_item_id: string | null;
  archived_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BundleComponentRow {
  bundle_id: string;
  item_id: string;
  quantity: number;
  is_optional: boolean;
}

export interface BundleComponent {
  itemId: string;
  itemName: string;
  itemSku: string;
  itemQuantityOnHand: number;
  unitCost: number;
  /** Per-bundle qty — units of this item per 1 kit. */
  quantity: number;
  isOptional: boolean;
}

export interface BundleSummary {
  id: string;
  name: string;
  sku: string | null;
  isActive: boolean;
  preassemblyEnabled: boolean;
  preassembledQty: number;
  componentCount: number;
  lastDistributedAt: string | null;
  archivedAt: string | null;
}

export interface BundleDetail {
  bundle: BundleRow;
  components: BundleComponent[];
  phantom: {
    id: string;
    quantityOnHand: number;
    warehouseId: string | null;
  } | null;
}

/**
 * Per-component preview row. `drawnFromComponents` is what we'd subtract
 * from this item's stock; `shortage` is what's missing if stock is too
 * thin. When phantom kits cover part of the run, both numbers reflect
 * only the *virtual* remainder.
 */
export interface DistributionPreviewComponent {
  itemId: string;
  itemName: string;
  itemSku: string;
  unitCost: number;
  perBundleQty: number;
  isOptional: boolean;
  needed: number;
  available: number;
  drawnFromComponents: number;
  shortage: number;
}

export interface DistributionPreview {
  bundleId: string;
  quantity: number;
  fromPhantom: number;
  fromComponents: number;
  components: DistributionPreviewComponent[];
  hasShortage: boolean;
  totalShortageItems: number;
  totalShortageUnits: number;
}

export interface BundleDistributionRow {
  id: string;
  organization_id: string;
  bundle_id: string;
  warehouse_id: string;
  quantity: number;
  schedule_event_id: string | null;
  notes: string | null;
  shortage_recorded: boolean;
  distributed_by: string | null;
  distributed_at: string;
}

export interface CreateBundleInput {
  name: string;
  sku?: string | null;
  description?: string | null;
  preassemblyEnabled?: boolean;
  components: Array<{
    itemId: string;
    quantity: number;
    isOptional?: boolean;
  }>;
}

export interface UpdateBundleInput {
  name?: string;
  sku?: string | null;
  description?: string | null;
  isActive?: boolean;
  preassemblyEnabled?: boolean;
  components?: Array<{
    itemId: string;
    quantity: number;
    isOptional?: boolean;
  }>;
}

export interface DistributeInput {
  quantity: number;
  warehouseId: string;
  scheduleEventId?: string | null;
  notes?: string | null;
  allowShortage?: boolean;
}

export class BundlesService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new BundlesService(await withContext());
  }

  async list(opts: { search?: string; includeInactive?: boolean; includeArchived?: boolean } = {}): Promise<BundleSummary[]> {
    let query = this.ctx.supabase
      .from('bundles')
      .select(
        `id, name, sku, is_active, preassembly_enabled, phantom_item_id,
         archived_at, created_at,
         components:bundle_components(item_id),
         phantom:inventory_items!phantom_item_id(quantity_on_hand)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('name', { ascending: true });

    // `includeArchived` is a strict toggle: when true, return ONLY rows
    // with archived_at IS NOT NULL — these are the archived bundles the
    // "Archived" view shows. Takes precedence over `includeInactive`.
    if (opts.includeArchived) {
      query = query.not('archived_at', 'is', null);
    } else if (!opts.includeInactive) {
      query = query.eq('is_active', true).is('archived_at', null);
    } else {
      // Legacy includeInactive=true path: show active + inactive but
      // exclude archived, so "All" doesn't double-up with "Archived".
      query = query.is('archived_at', null);
    }
    if (opts.search) {
      const term = `%${opts.search}%`;
      query = query.or(`name.ilike.${term},sku.ilike.${term}`);
    }

    const { data: bundles, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);

    const ids = (bundles ?? []).map((b) => b.id as string);
    const lastSeen = await this.lastDistributedMap(ids);

    return (bundles ?? []).map((b) => {
      const phantomField = (b as { phantom?: { quantity_on_hand: number } | { quantity_on_hand: number }[] | null }).phantom;
      const phantom = Array.isArray(phantomField) ? phantomField[0] : phantomField;
      const components = (b as { components?: unknown[] }).components ?? [];
      return {
        id: b.id as string,
        name: b.name as string,
        sku: (b.sku as string | null) ?? null,
        isActive: Boolean(b.is_active),
        preassemblyEnabled: Boolean(b.preassembly_enabled),
        preassembledQty: Number(phantom?.quantity_on_hand ?? 0),
        componentCount: components.length,
        lastDistributedAt: lastSeen.get(b.id as string) ?? null,
        archivedAt: (b.archived_at as string | null) ?? null,
      } satisfies BundleSummary;
    });
  }

  private async lastDistributedMap(bundleIds: string[]): Promise<Map<string, string>> {
    if (bundleIds.length === 0) return new Map();
    const { data, error } = await this.ctx.supabase
      .from('bundle_distributions')
      .select('bundle_id, distributed_at')
      .eq('organization_id', this.ctx.organizationId)
      .in('bundle_id', bundleIds)
      .order('distributed_at', { ascending: false });
    if (error) throw new ServiceError('internal_error', error.message);
    const map = new Map<string, string>();
    for (const row of data ?? []) {
      const bid = row.bundle_id as string;
      if (!map.has(bid)) map.set(bid, row.distributed_at as string);
    }
    return map;
  }

  async get(id: string): Promise<BundleDetail> {
    const { data: bundle, error } = await this.ctx.supabase
      .from('bundles')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!bundle) throw new ServiceError('not_found', 'Bundle not found');

    const { data: comps, error: cErr } = await this.ctx.supabase
      .from('bundle_components')
      .select(
        `quantity, is_optional,
         item:inventory_items!item_id (
           id, name, sku, quantity_on_hand, unit_cost
         )`,
      )
      .eq('bundle_id', id);
    if (cErr) throw new ServiceError('internal_error', cErr.message);

    const components: BundleComponent[] = (comps ?? []).map((c) => {
      const itemField = (c as Record<string, unknown>).item as
        | { id: string; name: string; sku: string; quantity_on_hand: number; unit_cost: number }
        | { id: string; name: string; sku: string; quantity_on_hand: number; unit_cost: number }[]
        | null;
      const item = Array.isArray(itemField) ? itemField[0] : itemField;
      return {
        itemId: item?.id ?? '',
        itemName: item?.name ?? 'Deleted item',
        itemSku: item?.sku ?? '',
        itemQuantityOnHand: Number(item?.quantity_on_hand ?? 0),
        unitCost: Number(item?.unit_cost ?? 0),
        quantity: Number((c as { quantity: number }).quantity),
        isOptional: Boolean((c as { is_optional: boolean }).is_optional),
      };
    });

    let phantom: BundleDetail['phantom'] = null;
    const phantomId = (bundle as BundleRow).phantom_item_id;
    if (phantomId) {
      const { data: ph, error: pErr } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, quantity_on_hand, warehouse_id')
        .eq('id', phantomId)
        .maybeSingle();
      if (pErr) throw new ServiceError('internal_error', pErr.message);
      if (ph) {
        phantom = {
          id: ph.id as string,
          quantityOnHand: Number(ph.quantity_on_hand),
          warehouseId: (ph.warehouse_id as string | null) ?? null,
        };
      }
    }

    return { bundle: bundle as BundleRow, components, phantom };
  }

  /**
   * Dry-run a distribution. No writes, no locks. Used by the Distribute
   * modal for live preview and by the chat AI's preview tool.
   *
   * The math mirrors the SQL distribute_bundle() function: phantom is
   * drained first, components cover the rest. Optional components are
   * included in the preview but their `shortage` count is informational
   * only — distribution won't fail because an optional is short.
   */
  async preview(
    id: string,
    quantity: number,
    _warehouseId: string,
  ): Promise<DistributionPreview> {
    if (quantity <= 0) {
      throw new ServiceError('validation_error', 'Quantity must be positive');
    }
    const detail = await this.get(id);
    const phantomQty = detail.phantom?.quantityOnHand ?? 0;
    const fromPhantom = Math.min(quantity, phantomQty);
    const fromComponents = quantity - fromPhantom;

    let totalShortageItems = 0;
    let totalShortageUnits = 0;
    const componentRows: DistributionPreviewComponent[] = detail.components.map((c) => {
      const needed = c.quantity * fromComponents;
      const available = Math.max(0, c.itemQuantityOnHand);
      const drawn = Math.min(needed, available);
      const shortage = needed - drawn;
      if (shortage > 0 && !c.isOptional) {
        totalShortageItems += 1;
        totalShortageUnits += shortage;
      }
      return {
        itemId: c.itemId,
        itemName: c.itemName,
        itemSku: c.itemSku,
        unitCost: c.unitCost,
        perBundleQty: c.quantity,
        isOptional: c.isOptional,
        needed,
        available,
        drawnFromComponents: drawn,
        shortage,
      };
    });

    return {
      bundleId: id,
      quantity,
      fromPhantom,
      fromComponents,
      components: componentRows,
      hasShortage: totalShortageItems > 0,
      totalShortageItems,
      totalShortageUnits,
    };
  }

  async recentDistributions(
    opts: { bundleId?: string; limit?: number } = {},
  ): Promise<BundleDistributionRow[]> {
    let query = this.ctx.supabase
      .from('bundle_distributions')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .order('distributed_at', { ascending: false })
      .limit(opts.limit ?? 50);
    if (opts.bundleId) query = query.eq('bundle_id', opts.bundleId);
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as BundleDistributionRow[];
  }

  async create(input: CreateBundleInput): Promise<BundleDetail> {
    assertPermission(this.ctx, 'bundles:manage');
    if (input.components.length === 0) {
      throw new ServiceError('validation_error', 'A bundle needs at least one component');
    }

    const { data: bundle, error } = await this.ctx.supabase
      .from('bundles')
      .insert({
        organization_id: this.ctx.organizationId,
        name: input.name,
        sku: input.sku ?? null,
        description: input.description ?? null,
        preassembly_enabled: input.preassemblyEnabled ?? false,
        is_active: true,
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);

    const componentsPayload = input.components.map((c) => ({
      bundle_id: bundle.id as string,
      item_id: c.itemId,
      quantity: c.quantity,
      is_optional: c.isOptional ?? false,
    }));
    const { error: cErr } = await this.ctx.supabase
      .from('bundle_components')
      .insert(componentsPayload);
    if (cErr) throw new ServiceError('internal_error', cErr.message);

    await audit(
      {
        event: 'bundle.created',
        entityType: 'bundle',
        entityId: bundle.id as string,
        after: {
          name: input.name,
          componentCount: componentsPayload.length,
          preassemblyEnabled: input.preassemblyEnabled ?? false,
        },
      },
      this.ctx,
    );

    return this.get(bundle.id as string);
  }

  async update(id: string, patch: UpdateBundleInput): Promise<BundleDetail> {
    assertPermission(this.ctx, 'bundles:manage');

    // Block toggling preassembly off while phantom stock exists.
    if (patch.preassemblyEnabled === false) {
      const detail = await this.get(id);
      if ((detail.phantom?.quantityOnHand ?? 0) > 0) {
        throw new ServiceError(
          'validation_error',
          'Disassemble or distribute remaining pre-assembled kits before disabling pre-assembly.',
        );
      }
    }

    const updatePayload: Record<string, unknown> = { updated_by: this.ctx.userId };
    if (patch.name !== undefined) updatePayload.name = patch.name;
    if (patch.sku !== undefined) updatePayload.sku = patch.sku;
    if (patch.description !== undefined) updatePayload.description = patch.description;
    if (patch.isActive !== undefined) updatePayload.is_active = patch.isActive;
    if (patch.preassemblyEnabled !== undefined)
      updatePayload.preassembly_enabled = patch.preassemblyEnabled;

    if (Object.keys(updatePayload).length > 1) {
      const { error } = await this.ctx.supabase
        .from('bundles')
        .update(updatePayload)
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', id);
      if (error) throw new ServiceError('internal_error', error.message);
    }

    if (patch.components) {
      if (patch.components.length === 0) {
        throw new ServiceError('validation_error', 'A bundle needs at least one component');
      }
      // Replace the component set wholesale — simplest correct path.
      const { error: dErr } = await this.ctx.supabase
        .from('bundle_components')
        .delete()
        .eq('bundle_id', id);
      if (dErr) throw new ServiceError('internal_error', dErr.message);

      const payload = patch.components.map((c) => ({
        bundle_id: id,
        item_id: c.itemId,
        quantity: c.quantity,
        is_optional: c.isOptional ?? false,
      }));
      const { error: iErr } = await this.ctx.supabase
        .from('bundle_components')
        .insert(payload);
      if (iErr) throw new ServiceError('internal_error', iErr.message);
    }

    await audit(
      {
        event: 'bundle.updated',
        entityType: 'bundle',
        entityId: id,
        after: patch,
      },
      this.ctx,
    );

    return this.get(id);
  }

  async archive(id: string): Promise<void> {
    assertPermission(this.ctx, 'bundles:manage');
    const { error } = await this.ctx.supabase
      .from('bundles')
      .update({
        is_active: false,
        archived_at: new Date().toISOString(),
        updated_by: this.ctx.userId,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'bundle.archived', entityType: 'bundle', entityId: id }, this.ctx);
  }

  /**
   * Restore an archived bundle — clears `archived_at` and flips the
   * `is_active` flag back on so the bundle reappears in the active list
   * and can be distributed again. Same permission gate as archive().
   */
  async restore(id: string): Promise<void> {
    assertPermission(this.ctx, 'bundles:manage');
    const { error } = await this.ctx.supabase
      .from('bundles')
      .update({
        is_active: true,
        archived_at: null,
        updated_by: this.ctx.userId,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({ event: 'bundle.restored', entityType: 'bundle', entityId: id }, this.ctx);
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    assertPermission(this.ctx, 'bundles:manage');
    const payload: Record<string, unknown> = {
      is_active: isActive,
      updated_by: this.ctx.userId,
    };
    if (isActive) payload.archived_at = null;
    const { error } = await this.ctx.supabase
      .from('bundles')
      .update(payload)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit(
      {
        event: 'bundle.updated',
        entityType: 'bundle',
        entityId: id,
        after: { isActive },
      },
      this.ctx,
    );
  }

  /**
   * Pre-box N kits at the chosen warehouse. Decrements components,
   * creates the phantom item on first call, increments phantom by N.
   * Atomic via the assemble_bundle() SQL function.
   */
  async assemble(
    id: string,
    quantity: number,
    warehouseId: string,
    notes?: string | null,
  ): Promise<{ phantomItemId: string; phantomQty: number }> {
    assertPermission(this.ctx, 'bundles:manage');
    const { data, error } = await this.ctx.supabase.rpc('assemble_bundle', {
      p_bundle_id: id,
      p_quantity: quantity,
      p_warehouse_id: warehouseId,
      p_notes: notes ?? null,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('insufficient_stock')) {
        throw new ServiceError(
          'validation_error',
          'Not enough stock to assemble this many kits. Lower the quantity or top up the short components.',
        );
      }
      if (msg.includes('preassembly_disabled')) {
        throw new ServiceError(
          'validation_error',
          'Pre-assembly is disabled for this bundle.',
        );
      }
      if (msg.includes('phantom_warehouse_mismatch')) {
        throw new ServiceError(
          'validation_error',
          'Existing pre-assembled stock for this bundle is at a different warehouse. v1 only supports one warehouse per bundle phantom.',
        );
      }
      if (msg.includes('forbidden')) {
        throw new ServiceError('forbidden', 'Permission denied');
      }
      throw new ServiceError('internal_error', msg);
    }

    const row = Array.isArray(data) ? data[0] : data;
    await audit(
      {
        event: 'bundle.assembled',
        entityType: 'bundle',
        entityId: id,
        after: { quantity, warehouseId },
      },
      this.ctx,
    );
    return {
      phantomItemId: (row?.phantom_item_id as string) ?? '',
      phantomQty: Number(row?.phantom_qty ?? 0),
    };
  }

  async distribute(id: string, input: DistributeInput): Promise<{ distributionId: string }> {
    assertPermission(this.ctx, 'bundles:distribute');
    const { data, error } = await this.ctx.supabase.rpc('distribute_bundle', {
      p_bundle_id: id,
      p_quantity: input.quantity,
      p_warehouse_id: input.warehouseId,
      p_allow_shortage: input.allowShortage ?? false,
      p_schedule_event_id: input.scheduleEventId ?? null,
      p_notes: input.notes ?? null,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('insufficient_stock')) {
        throw new ServiceError(
          'validation_error',
          'Not enough stock to distribute. Either lower the quantity, top up components, or confirm shortage.',
        );
      }
      if (msg.includes('bundle_not_active')) {
        throw new ServiceError('validation_error', 'This bundle is archived or inactive.');
      }
      if (msg.includes('forbidden')) {
        throw new ServiceError('forbidden', 'Permission denied');
      }
      throw new ServiceError('internal_error', msg);
    }
    await audit(
      {
        event: 'bundle.distributed',
        entityType: 'bundle_distribution',
        entityId: data as string,
        after: {
          bundleId: id,
          quantity: input.quantity,
          warehouseId: input.warehouseId,
          scheduleEventId: input.scheduleEventId ?? null,
          allowShortage: input.allowShortage ?? false,
        },
      },
      this.ctx,
    );
    return { distributionId: data as string };
  }
}
