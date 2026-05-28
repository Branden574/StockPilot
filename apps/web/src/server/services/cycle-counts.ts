import 'server-only';

import { assertWarehouseAccess, ForbiddenError, getWarehouseAccess } from '@/lib/auth/warehouse';

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
  canceled_by: string | null;
  canceled_at: string | null;
  /** Manager-set assignee responsible for the count. Null = unassigned. */
  assigned_to: string | null;
}

export interface CycleCountLineRow {
  id: string;
  cycle_count_id: string;
  item_id: string;
  /** Snapshot of the item's warehouse at start() time. Set by migration 0081. */
  warehouse_id: string | null;
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

/**
 * Maps stable PG raise-exception codes from post_cycle_count (v2,
 * migration 0079) into user-friendly errors. Codes are kept stable
 * across releases; UI strings live in TypeScript so we can tune them
 * without a DB migration.
 */
function mapPostCycleCountError(message: string): ServiceError {
  if (message.includes('cycle_count_not_found')) {
    return new ServiceError('not_found', 'Cycle count not found.');
  }
  if (message.includes('cycle_count_not_open')) {
    return new ServiceError(
      'conflict',
      'This cycle count is no longer open. Reload to see the latest status.',
    );
  }
  if (message.includes('forbidden')) {
    return new ServiceError(
      'forbidden',
      'You do not have permission to post this cycle count.',
    );
  }
  if (message.includes('item_out_of_scope')) {
    return new ServiceError(
      'validation_error',
      'An item moved to a different warehouse mid-count. Cancel this count and restart it for the new warehouse, or clear the affected lines.',
    );
  }
  return new ServiceError('internal_error', message);
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
    // Warehouse-scoped users (staff/viewer with assignments) only see
    // counts for warehouses they can write to. Managers+ have
    // hasAllAccess and see every count. Org-wide counts (warehouse_id
    // is null) only surface for full-access users since those sessions
    // span any warehouse.
    const access = await getWarehouseAccess(this.ctx);

    let query = this.ctx.supabase
      .from('cycle_counts')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .order('started_at', { ascending: false })
      // 200 rows is multiple years of monthly counts for a typical
      // org. Pagination + cursor can come later if any org actually
      // crosses this; the cap exists to bound memory + payload size.
      .limit(200);

    if (!access.hasAllAccess) {
      if (access.writableIds.length === 0) return [];
      query = query.in('warehouse_id', access.writableIds);
    }

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

    // Refuse to update if the count is closed — assigning a completed
    // or canceled count is meaningless and would silently drop the
    // assignee history. The status filter below would already block it
    // (returning no row), but the explicit lookup gives us a clean
    // error code distinct from a stale-assignee conflict.
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('cycle_counts')
      .select('status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'Cycle count not found.');
    if ((header as { status: CycleCountStatus }).status !== 'in_progress') {
      throw new ServiceError(
        'conflict',
        'This cycle count is closed — assignment can\'t be changed.',
      );
    }

    // Cross-org tampering check: the assignee must be an accepted
    // member of THIS organization, otherwise a malicious caller could
    // route a count to a user_id they happen to know but who isn't on
    // the team. RLS on organization_members enforces org scope on the
    // select, so this query is safe.
    if (assignedTo) {
      const { data: member, error: mErr } = await this.ctx.supabase
        .from('organization_members')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('user_id', assignedTo)
        .not('accepted_at', 'is', null)
        .maybeSingle();
      if (mErr) throw new ServiceError('internal_error', mErr.message);
      if (!member) {
        throw new ServiceError(
          'validation_error',
          'That user is not an active member of this organization.',
        );
      }
    }

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
        after: { assigned_to: assignedTo, expected: expectedAssignee ?? null },
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

    const h = header as unknown as CycleCountRow;
    // Warehouse-access gate. Counts scoped to a specific warehouse
    // require read access to that warehouse; org-wide counts
    // (warehouse_id is null) skip the gate since they cover every
    // warehouse and only full-access roles can start them. We surface
    // a 404 instead of a 403 so we don't leak the existence of a
    // count in a warehouse the caller can't see.
    if (h.warehouse_id) {
      try {
        await assertWarehouseAccess(h.warehouse_id, 'read', this.ctx);
      } catch (e) {
        if (e instanceof ForbiddenError) {
          throw new ServiceError('not_found', 'Cycle count not found');
        }
        throw e;
      }
    }

    const { data: lines, error: lErr } = await this.ctx.supabase
      .from('cycle_count_lines')
      .select(
        `id, cycle_count_id, item_id, warehouse_id, expected_quantity, counted_quantity,
         reason, notes, counted_by, counted_at,
         item:inventory_items!item_id (id, name, sku, unit_of_measure, barcode)`,
      )
      .eq('cycle_count_id', id)
      // In-progress lines: sort by SKU so the on-screen list matches
      // the printed count-sheet order (also SKU-sorted in the PDF).
      // Completed lines: sort by counted_at descending so the most
      // recent activity is at the top. Tie-broken on SKU either way.
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

    // Stable secondary sort by SKU for the in-progress view. Lines
    // without an item (deleted mid-count) sort last by name/sku, which
    // keeps the active rows clustered at the top.
    if (h.status === 'in_progress') {
      flattened.sort((a, b) => {
        const ak = a.item?.sku ?? '￿';
        const bk = b.item?.sku ?? '￿';
        return ak.localeCompare(bk);
      });
    }

    return { header: h, lines: flattened };
  }

  /**
   * Counts the active items in scope right now. Used by the UI to
   * surface a "new items added mid-count" warning when this number
   * exceeds the line count from the original snapshot. Cheap head
   * query — no row data is transferred.
   */
  async itemsInScopeCount(cycleCountId: string): Promise<number> {
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('cycle_counts')
      .select('warehouse_id, status, scope')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', cycleCountId)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'Cycle count not found.');
    const h = header as {
      warehouse_id: string | null;
      status: CycleCountStatus;
      scope?: string;
    };
    // Only meaningful for open counts. Closed counts compare against
    // a fixed snapshot — new items added afterwards aren't "missing".
    if (h.status !== 'in_progress') return 0;
    // Selection counts have a fixed, hand-picked line set — there's no
    // "items added to the warehouse since start" concept to warn about.
    if (h.scope === 'selection') return 0;

    let q = this.ctx.supabase
      .from('inventory_items')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .is('deleted_at', null)
      .eq('status', 'active');
    if (h.warehouse_id) q = q.eq('warehouse_id', h.warehouse_id);
    const { count, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);
    return count ?? 0;
  }

  /**
   * Starts a new cycle count session by snapshotting the current
   * quantity_on_hand for every item in scope.
   *
   *   • scope 'warehouse' (default) — every active item in the given
   *     warehouse, or the whole org when warehouseId is null.
   *   • scope 'selection' — only the explicitly chosen itemIds. The
   *     header warehouse_id is forced null (the picked set may span
   *     warehouses); each line still snapshots its item's warehouse so
   *     post_cycle_count's per-line move guard keeps working unchanged.
   *
   * Returns `skipped` = how many requested ids were dropped because they
   * were archived / deleted / not in the org by the time we snapshotted.
   */
  async start(input: {
    scope?: 'warehouse' | 'selection';
    warehouseId: string | null;
    itemIds?: string[];
    notes?: string | null;
    assignedTo?: string | null;
  }): Promise<{ id: string; lineCount: number; skipped: number }> {
    assertPermission(this.ctx, 'stock:adjust');
    const scope = input.scope ?? 'warehouse';

    let items: Array<{ id: string; quantity_on_hand: number; warehouse_id: string | null }>;
    let requested: number;

    if (scope === 'selection') {
      const ids = Array.from(new Set(input.itemIds ?? []));
      requested = ids.length;
      if (ids.length === 0) {
        throw new ServiceError('validation_error', 'Pick at least one item to count.');
      }
      const { data, error } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, quantity_on_hand, warehouse_id')
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null)
        .eq('status', 'active')
        .in('id', ids);
      if (error) throw new ServiceError('internal_error', error.message);
      items = (data ?? []) as typeof items;
      if (items.length === 0) {
        throw new ServiceError(
          'validation_error',
          'None of the selected items are still active. Refresh and try again.',
        );
      }
      // Write-access gate: every distinct warehouse represented must be
      // writable by the caller. Items with no warehouse require full
      // (manager+) access since they aren't pinned to an assignment.
      const distinctWh = new Set<string>();
      let hasNullWh = false;
      for (const it of items) {
        if (it.warehouse_id) distinctWh.add(it.warehouse_id);
        else hasNullWh = true;
      }
      if (hasNullWh) {
        const access = await getWarehouseAccess(this.ctx);
        if (!access.hasAllAccess) {
          throw new ForbiddenError('You cannot count items that have no warehouse.');
        }
      }
      for (const wh of distinctWh) {
        await assertWarehouseAccess(wh, 'write', this.ctx);
      }
    } else {
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
        .select('id, quantity_on_hand, warehouse_id')
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null)
        .eq('status', 'active');
      if (input.warehouseId) {
        itemQuery = itemQuery.eq('warehouse_id', input.warehouseId);
      }
      const { data, error: iErr } = await itemQuery;
      if (iErr) throw new ServiceError('internal_error', iErr.message);
      items = (data ?? []) as typeof items;
      requested = items.length;
      if (items.length === 0) {
        const where = input.warehouseId ? 'this warehouse' : 'your organization';
        throw new ServiceError(
          'validation_error',
          `No active items found in ${where}. Add items first, or pick a different warehouse.`,
        );
      }
    }

    const { data: cc, error: ccErr } = await this.ctx.supabase
      .from('cycle_counts')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: scope === 'selection' ? null : input.warehouseId,
        scope,
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
      // Snapshot the item's warehouse at start() time. post() refuses
      // to apply variance if the item has moved warehouses since.
      warehouse_id: (it.warehouse_id as string | null) ?? null,
      expected_quantity: Number(it.quantity_on_hand) || 0,
    }));

    const { error: linesErr } = await this.ctx.supabase
      .from('cycle_count_lines')
      .insert(linesPayload);
    if (linesErr) throw new ServiceError('internal_error', linesErr.message);

    // Assign as a SEPARATE update so trg_cycle_counts_assigned (0042)
    // fires and the assignee gets the in-app + push notification — the
    // insert above wouldn't trip an AFTER UPDATE OF assigned_to trigger.
    if (input.assignedTo) {
      try {
        await this.assign(cc.id as string, input.assignedTo);
      } catch {
        // Non-fatal: the count exists; the assignment just didn't stick.
        // The starter can re-assign from the detail page.
      }
    }

    await audit(
      {
        event: 'cycle_count.started',
        entityType: 'cycle_count',
        entityId: cc.id as string,
        after: {
          scope,
          warehouseId: scope === 'selection' ? null : input.warehouseId,
          lineCount: linesPayload.length,
        },
      },
      this.ctx,
    );

    return {
      id: cc.id as string,
      lineCount: linesPayload.length,
      skipped: requested - linesPayload.length,
    };
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

  /** Records a counted quantity for a single line. When `aiScanId` is
   *  set, the line's `ai_scan_id` FK is also written so the audit
   *  trail traces the count back to the AI Shelf Scan that proposed
   *  it. NULL on the existing manual + barcode paths. */
  async recordCount(input: {
    cycleCountId: string;
    lineId: string;
    countedQuantity: number;
    reason?: string | null;
    notes?: string | null;
    aiScanId?: string | null;
  }): Promise<void> {
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(input.cycleCountId);
    // Use .select() so an RLS-blocked or already-missing row surfaces
    // as a real not_found error instead of a silent no-op. v1 silently
    // returned ok=true when RLS denied a staff record, which made the
    // mobile app look like it had recorded a count even though the DB
    // had ignored it. See hunter findings #3 + #13.
    const update: Record<string, unknown> = {
      counted_quantity: input.countedQuantity,
      reason: input.reason ?? null,
      notes: input.notes ?? null,
      counted_by: this.ctx.userId,
      counted_at: new Date().toISOString(),
    };
    // Only include ai_scan_id when the caller provides one — leaving
    // the column untouched on manual recounts preserves any prior AI
    // trace instead of nulling it out on a manual override.
    if (input.aiScanId !== undefined) {
      update.ai_scan_id = input.aiScanId;
    }
    const { data, error } = await this.ctx.supabase
      .from('cycle_count_lines')
      .update(update)
      .eq('cycle_count_id', input.cycleCountId)
      .eq('id', input.lineId)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      // Row either doesn't exist OR RLS / parent-status blocked the
      // write. We can't tell the difference from the API, so map both
      // to a 404 with a helpful message — the UI will tell the user to
      // reload, which surfaces the real state.
      throw new ServiceError(
        'not_found',
        'Line not found or no longer editable. Reload the count.',
      );
    }
  }

  /**
   * AI Shelf Scan v1 — returns the cycle count's line set in the
   * minimal shape the Gemini prompt needs: lineId, sku, name, isbn,
   * author. The prompt assembler in `lib/ai/shelf-scan.ts` builds the
   * model input from this; the parser uses the lineIds to map matched
   * SKUs back to rows for the review screen.
   *
   * Books-only filter — v1 only scans books. Non-book items in the
   * count are simply omitted from the line set (Gemini wouldn't
   * match them anyway given the prompt's book-focused rules).
   */
  async getLineSetForAiScan(cycleCountId: string): Promise<
    Array<{
      lineId: string;
      sku: string;
      name: string;
      isbn: string | null;
      author: string | null;
    }>
  > {
    // Reuse the existing session-access gate — same RBAC + warehouse
    // scope as recordCount. Throws not_found / forbidden which the
    // route handler maps to 404 / 403.
    await this.assertSessionAccess(cycleCountId);

    const { data, error } = await this.ctx.supabase
      .from('cycle_count_lines')
      .select(
        `id,
         item:inventory_items!item_id (
           sku, name, barcode, item_type, custom_fields
         )`,
      )
      .eq('cycle_count_id', cycleCountId);
    if (error) throw new ServiceError('internal_error', error.message);

    const out: Array<{
      lineId: string;
      sku: string;
      name: string;
      isbn: string | null;
      author: string | null;
    }> = [];
    for (const row of (data ?? []) as Array<{
      id: string;
      item:
        | {
            sku: string;
            name: string;
            barcode: string | null;
            item_type: string | null;
            custom_fields: Record<string, unknown> | null;
          }
        | Array<{
            sku: string;
            name: string;
            barcode: string | null;
            item_type: string | null;
            custom_fields: Record<string, unknown> | null;
          }>
        | null;
    }>) {
      const item = Array.isArray(row.item) ? row.item[0] : row.item;
      if (!item) continue;
      // Books-only filter for v1.
      if (item.item_type !== 'book') continue;
      const cf = (item.custom_fields ?? {}) as Record<string, unknown>;
      const author = typeof cf.author === 'string' ? cf.author : null;
      out.push({
        lineId: row.id,
        sku: item.sku,
        name: item.name,
        isbn: item.barcode ?? null,
        author,
      });
    }
    return out;
  }

  /**
   * AI Shelf Scan v1 — inserts the audit row representing one scan
   * attempt. Called from the route handler AFTER the Gemini call
   * returns (we record the response even when the user later
   * abandons the review) so the response data is preserved for
   * tuning the model / thresholds.
   */
  async insertAiScan(input: {
    cycleCountId: string;
    photoStoragePath: string;
    geminiResponse: unknown;
    modelVersion: string;
  }): Promise<{ id: string }> {
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(input.cycleCountId);
    // Look up org_id from the parent count — we don't want to trust
    // a request param when the value is derivable.
    const { data: cc, error: ccErr } = await this.ctx.supabase
      .from('cycle_counts')
      .select('organization_id')
      .eq('id', input.cycleCountId)
      .maybeSingle();
    if (ccErr) throw new ServiceError('internal_error', ccErr.message);
    if (!cc) throw new ServiceError('not_found', 'Cycle count not found');

    const { data, error } = await this.ctx.supabase
      .from('cycle_count_ai_scans')
      .insert({
        organization_id: (cc as { organization_id: string }).organization_id,
        cycle_count_id: input.cycleCountId,
        created_by: this.ctx.userId,
        photo_storage_path: input.photoStoragePath,
        gemini_response: input.geminiResponse,
        model_version: input.modelVersion,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    return { id: (data as { id: string }).id };
  }

  /**
   * AI Shelf Scan v1 — marks a scan confirmed when the user has
   * reviewed + saved the proposed counts. confirmed_at + confirmed_by
   * are filled in via the existing RLS policy (created_by or
   * manager+).
   */
  async markAiScanConfirmed(scanId: string): Promise<void> {
    assertPermission(this.ctx, 'stock:adjust');
    const { data, error } = await this.ctx.supabase
      .from('cycle_count_ai_scans')
      .update({
        confirmed_at: new Date().toISOString(),
        confirmed_by: this.ctx.userId,
      })
      .eq('id', scanId)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'not_found',
        'Scan not found or no longer editable.',
      );
    }
  }

  /** Clears a previously-recorded count for a line so the user can recount. */
  async clearCount(input: { cycleCountId: string; lineId: string }): Promise<void> {
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(input.cycleCountId);
    const { data, error } = await this.ctx.supabase
      .from('cycle_count_lines')
      .update({
        counted_quantity: null,
        reason: null,
        notes: null,
        counted_by: null,
        counted_at: null,
      })
      .eq('cycle_count_id', input.cycleCountId)
      .eq('id', input.lineId)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'not_found',
        'Line not found or no longer editable. Reload the count.',
      );
    }
  }

  /** Cancels the session without posting any adjustments. */
  async cancel(id: string): Promise<void> {
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(id);
    // Use .select().maybeSingle() so a stale page (someone else
    // posted/canceled it first) returns a clean conflict instead of
    // silently succeeding. The status filter on the update ensures we
    // only flip an in_progress row.
    const nowIso = new Date().toISOString();
    const { data, error } = await this.ctx.supabase
      .from('cycle_counts')
      .update({
        status: 'canceled',
        canceled_by: this.ctx.userId,
        canceled_at: nowIso,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .eq('status', 'in_progress')
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'conflict',
        'This cycle count is no longer open. Reload to see the latest status.',
      );
    }
    await audit(
      {
        event: 'cycle_count.canceled',
        entityType: 'cycle_count',
        entityId: id,
        extra: { canceled_at: nowIso },
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
    if (error) {
      // Map stable PG raise codes to user-friendly ServiceErrors.
      // post_cycle_count v2 emits: cycle_count_not_found,
      // cycle_count_not_open, forbidden, item_out_of_scope.
      throw mapPostCycleCountError(error.message);
    }
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
