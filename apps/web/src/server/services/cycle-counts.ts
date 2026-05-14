import 'server-only';

import { assertWarehouseAccess } from '@/lib/auth/warehouse';

import { audit } from './audit';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

export type CycleCountStatus = 'in_progress' | 'completed' | 'canceled';

export interface CycleCountRow {
  id: string;
  organization_id: string;
  warehouse_id: string | null;
  status: CycleCountStatus;
  notes: string | null;
  started_by: string | null;
  started_at: string;
  completed_by: string | null;
  completed_at: string | null;
  /** Manager-set assignee responsible for the count. Null = unassigned. */
  assigned_to: string | null;
}

export interface CycleCountLineRow {
  id: string;
  cycle_count_id: string;
  item_id: string;
  expected_quantity: number;
  counted_quantity: number | null;
  reason: string | null;
  notes: string | null;
  counted_by: string | null;
  counted_at: string | null;
}

export interface CycleCountLineWithItem extends CycleCountLineRow {
  item: {
    id: string;
    name: string;
    sku: string;
    unit_of_measure: string;
    barcode: string | null;
  } | null;
}

export class CycleCountsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new CycleCountsService(await withContext());
  }

  /**
   * Cheap count of cycle counts currently in progress, optionally scoped to
   * a single warehouse. Used by the dashboard "needs attention" hero so the
   * caller doesn't have to inline a head-count query. No role gate — every
   * member who can see the dashboard can see how many counts are open.
   */
  async inProgressCount(options: { warehouseId?: string | null } = {}): Promise<number> {
    let q = this.ctx.supabase
      .from('cycle_counts')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('status', 'in_progress');
    if (options.warehouseId) q = q.eq('warehouse_id', options.warehouseId);
    const { count, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);
    return count ?? 0;
  }

  async list(filters: { assignedTo?: string | null } = {}): Promise<CycleCountRow[]> {
    let query = this.ctx.supabase
      .from('cycle_counts')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .order('started_at', { ascending: false })
      // 200 rows is multiple years of monthly counts for a typical
      // org. Pagination + cursor can come later if any org actually
      // crosses this; the cap exists to bound memory + payload size.
      .limit(200);
    if (filters.assignedTo === null) {
      // Explicit unassigned filter — used by the "unassigned" view.
      query = query.is('assigned_to', null);
    } else if (typeof filters.assignedTo === 'string') {
      query = query.eq('assigned_to', filters.assignedTo);
    }
    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return (data ?? []) as CycleCountRow[];
  }

  /**
   * Manager+ only — point a cycle count at a specific person on the team
   * (or clear with null). The role gate is the new 'cycle_counts:assign'
   * permission added in the same change set; staff and viewers will get a
   * forbidden error and a clear toast on the client.
   *
   * The optional `expectedAssignee` arg does an optimistic-concurrency
   * check: if someone else changed the assignee in the meantime, we
   * surface a validation error so the caller knows their toolbar state
   * was stale. Pass undefined to skip the check.
   */
  async assign(
    id: string,
    assignedTo: string | null,
    expectedAssignee?: string | null,
  ): Promise<CycleCountRow> {
    assertPermission(this.ctx, 'cycle_counts:assign');

    let query = this.ctx.supabase
      .from('cycle_counts')
      .update({ assigned_to: assignedTo })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (expectedAssignee === null) {
      query = query.is('assigned_to', null);
    } else if (typeof expectedAssignee === 'string') {
      query = query.eq('assigned_to', expectedAssignee);
    }
    const { data, error } = await query.select('*').maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'validation_error',
        'Cycle count not found, or its assignee changed since you opened this page.',
      );
    }
    await audit(
      {
        event: 'cycle_count.assigned',
        entityType: 'cycle_count',
        entityId: id,
        after: { assigned_to: assignedTo },
      },
      this.ctx,
    );
    return data as unknown as CycleCountRow;
  }

  async get(
    id: string,
  ): Promise<{ header: CycleCountRow; lines: CycleCountLineWithItem[] }> {
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('cycle_counts')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'Cycle count not found');

    const { data: lines, error: lErr } = await this.ctx.supabase
      .from('cycle_count_lines')
      .select(
        `id, cycle_count_id, item_id, expected_quantity, counted_quantity,
         reason, notes, counted_by, counted_at,
         item:inventory_items!item_id (id, name, sku, unit_of_measure, barcode)`,
      )
      .eq('cycle_count_id', id)
      .order('counted_at', { ascending: false, nullsFirst: false });
    if (lErr) throw new ServiceError('internal_error', lErr.message);

    const flattened = (lines ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const itemField = r.item as
        | { id: string; name: string; sku: string; unit_of_measure: string; barcode: string | null }
        | { id: string; name: string; sku: string; unit_of_measure: string; barcode: string | null }[]
        | null
        | undefined;
      const item = Array.isArray(itemField) ? (itemField[0] ?? null) : (itemField ?? null);
      return { ...r, item } as CycleCountLineWithItem;
    });

    return {
      header: header as unknown as CycleCountRow,
      lines: flattened,
    };
  }

  /**
   * Starts a new cycle count session by snapshotting the current
   * quantity_on_hand for every item in the chosen scope. Optionally
   * scoped to a warehouse — null means "every active item in the org".
   */
  async start(input: { warehouseId: string | null; notes?: string | null }): Promise<{ id: string; lineCount: number }> {
    assertPermission(this.ctx, 'stock:adjust');
    // Defense-in-depth: warehouse-write check so a manager can't
    // start a cycle count for a warehouse they can't write to (the
    // post() path eventually zeros out the warehouse's stock — that
    // must be gated). Org-wide counts (warehouseId = null) skip the
    // gate; only admins+ realistically reach that branch via UI.
    if (input.warehouseId) {
      await assertWarehouseAccess(input.warehouseId, 'write', this.ctx);
    }

    let itemQuery = this.ctx.supabase
      .from('inventory_items')
      .select('id, quantity_on_hand')
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active');
    if (input.warehouseId) {
      itemQuery = itemQuery.eq('warehouse_id', input.warehouseId);
    }
    const { data: items, error: iErr } = await itemQuery;
    if (iErr) throw new ServiceError('internal_error', iErr.message);
    if (!items || items.length === 0) {
      throw new ServiceError(
        'validation_error',
        'No active items in scope — add items first or pick a different warehouse.',
      );
    }

    const { data: cc, error: ccErr } = await this.ctx.supabase
      .from('cycle_counts')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: input.warehouseId,
        status: 'in_progress',
        notes: input.notes ?? null,
        started_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (ccErr) throw new ServiceError('internal_error', ccErr.message);

    const linesPayload = items.map((it) => ({
      cycle_count_id: cc.id as string,
      item_id: it.id as string,
      expected_quantity: Number(it.quantity_on_hand) || 0,
    }));

    const { error: linesErr } = await this.ctx.supabase
      .from('cycle_count_lines')
      .insert(linesPayload);
    if (linesErr) throw new ServiceError('internal_error', linesErr.message);

    await audit(
      {
        event: 'cycle_count.started',
        entityType: 'cycle_count',
        entityId: cc.id as string,
        after: {
          warehouseId: input.warehouseId,
          lineCount: linesPayload.length,
        },
      },
      this.ctx,
    );

    return { id: cc.id as string, lineCount: linesPayload.length };
  }

  /**
   * Loads the session's warehouse_id and asserts the caller can write
   * to it. Called by every mutator (record/clear/cancel/post) so a
   * manager can't tamper with a warehouse they don't have access to,
   * even if they hold the cycle-count id.
   */
  private async assertSessionAccess(cycleCountId: string): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('cycle_counts')
      .select('warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', cycleCountId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Cycle count not found.');
    const wh = (data as { warehouse_id: string | null }).warehouse_id;
    // Org-wide sessions (null warehouse) skip the gate — only admins+
    // can start those today, and the start() guard already enforces
    // permission. Any future role expansion should re-check here.
    if (wh) await assertWarehouseAccess(wh, 'write', this.ctx);
  }

  /** Records a counted quantity for a single line. */
  async recordCount(input: {
    cycleCountId: string;
    lineId: string;
    countedQuantity: number;
    reason?: string | null;
    notes?: string | null;
  }): Promise<void> {
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(input.cycleCountId);
    const { error } = await this.ctx.supabase
      .from('cycle_count_lines')
      .update({
        counted_quantity: input.countedQuantity,
        reason: input.reason ?? null,
        notes: input.notes ?? null,
        counted_by: this.ctx.userId,
        counted_at: new Date().toISOString(),
      })
      .eq('cycle_count_id', input.cycleCountId)
      .eq('id', input.lineId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  /** Clears a previously-recorded count for a line so the user can recount. */
  async clearCount(input: { cycleCountId: string; lineId: string }): Promise<void> {
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(input.cycleCountId);
    const { error } = await this.ctx.supabase
      .from('cycle_count_lines')
      .update({
        counted_quantity: null,
        reason: null,
        notes: null,
        counted_by: null,
        counted_at: null,
      })
      .eq('cycle_count_id', input.cycleCountId)
      .eq('id', input.lineId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  /** Cancels the session without posting any adjustments. */
  async cancel(id: string): Promise<void> {
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(id);
    const { error } = await this.ctx.supabase
      .from('cycle_counts')
      .update({ status: 'canceled' })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .eq('status', 'in_progress');
    if (error) throw new ServiceError('internal_error', error.message);
    await audit(
      {
        event: 'cycle_count.canceled',
        entityType: 'cycle_count',
        entityId: id,
      },
      this.ctx,
    );
  }

  /**
   * Posts every counted line as an adjust-type stock_movement (only when
   * variance != 0), updates inventory_items.quantity_on_hand, flips the
   * session to 'completed'. Atomic via the post_cycle_count RPC.
   */
  async post(id: string): Promise<CycleCountRow> {
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(id);
    const { data, error } = await this.ctx.supabase.rpc('post_cycle_count', {
      p_cycle_count_id: id,
    });
    if (error) throw new ServiceError('internal_error', error.message);
    await audit(
      {
        event: 'cycle_count.posted',
        entityType: 'cycle_count',
        entityId: id,
      },
      this.ctx,
    );
    return data as unknown as CycleCountRow;
  }
}
