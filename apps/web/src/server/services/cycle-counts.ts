import 'server-only';

import { isManagerOrAbove } from '@stockpilot/core';

import { assertWarehouseAccess, ForbiddenError, getWarehouseAccess } from '@/lib/auth/warehouse';

import { audit } from './audit';
import { dispatchEvent } from './integration-events';
import { fetchAllRows } from './lib/paginate';
import {
  assertModuleEnabled,
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

/** Whole-count roll-up the server-paginated detail page can no longer derive
 *  from a single page of lines (computed set-based by cycle_count_summary). */
export interface CycleCountSummary {
  /** Total lines in the count (every line, regardless of page / filter). */
  total: number;
  /** Lines with a recorded counted_quantity. */
  counted: number;
  /** Counted lines whose count differs from the expected snapshot. */
  varianceCount: number;
  /** Σ (counted_quantity − expected_quantity) over counted lines. */
  netDelta: number;
}

export interface CycleCountDetailPage {
  header: CycleCountRow;
  /** ONE server-paginated page of lines, ordered like the on-screen list. */
  lines: CycleCountLineWithItem[];
  summary: CycleCountSummary;
  /** 1-based page actually returned — the EFFECTIVE page, which can be
   *  LOWER than the requested one: a past-end request (stale ?page= after
   *  counting shrank an `uncounted` filter, deep link, etc.) is clamped to
   *  the real last page so the counter always lands on rows. The UI must
   *  render THIS page number, not the URL param. */
  page: number;
  pageSize: number;
  /** Filtered total (matches search + filter) — drives the page controls. */
  total: number;
  search: string;
  filter: CycleCountLineFilter;
}

export type CycleCountLineFilter = 'all' | 'uncounted' | 'variance';

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

/**
 * Maps the stable raise from start_cycle_count (migration 0226) back to the
 * exact user-facing errors the old TypeScript start() produced. The RPC
 * raises `cycle_count_no_items` when the scope snapshotted zero active items
 * (the header insert rolls back with it — no orphan); every other failure
 * (RLS-blocked header for a cross-org / non-manager caller, etc.) stays an
 * internal_error, matching the old bulk-insert error path.
 */
function mapStartCycleCountError(
  message: string,
  scope: 'warehouse' | 'selection',
  warehouseId: string | null,
): ServiceError {
  if (message.includes('cycle_count_no_items')) {
    if (scope === 'selection') {
      return new ServiceError(
        'validation_error',
        'None of the selected items are still active. Refresh and try again.',
      );
    }
    const where = warehouseId ? 'this warehouse' : 'your organization';
    return new ServiceError(
      'validation_error',
      `No active items found in ${where}. Add items first, or pick a different warehouse.`,
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
    assertModuleEnabled(this.ctx, 'cycle_counts');
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
    assertModuleEnabled(this.ctx, 'cycle_counts');
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

  /**
   * Release the assignment: the assigned employee (self-release) or a
   * manager+. Authorization + reason enforcement live in the 0282
   * `release_cycle_count` RPC (race-safe, version-bumped). Counted lines are
   * preserved (owner decision) — only the assignment clears. A non-blank
   * reason is required and recorded in the audit trail.
   */
  async release(id: string, reason: string): Promise<CycleCountRow> {
    assertModuleEnabled(this.ctx, 'cycle_counts');
    assertPermission(this.ctx, 'stock:adjust');
    if (!reason || reason.trim() === '') {
      throw new ServiceError(
        'validation_error',
        'A release reason is required.',
        { reason: 'release_reason_required' },
      );
    }
    const { data, error } = await this.ctx.supabase.rpc('release_cycle_count', {
      p_count_id: id,
      p_reason: reason,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('release_reason_required'))
        throw new ServiceError('validation_error', 'A release reason is required.', {
          reason: 'release_reason_required',
        });
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError('conflict', 'This cycle count is closed — it can\'t be released.');
      if (msg.includes('cycle_count_not_found'))
        throw new ServiceError('not_found', 'Cycle count not found.');
      if (msg.includes('forbidden'))
        throw new ServiceError(
          'forbidden',
          'Only the assigned employee or a manager can release this count.',
        );
      throw new ServiceError('internal_error', 'Could not release the cycle count.');
    }
    await audit(
      {
        event: 'cycle_count.released',
        entityType: 'cycle_count',
        entityId: id,
        reason,
      },
      this.ctx,
    );
    return data as unknown as CycleCountRow;
  }

  /**
   * Manager+ force-reassign of an ACTIVE (assigned) count to another member,
   * with a required reason (owner decision). Authorization + reason live in
   * the 0282 `force_reassign_cycle_count` RPC. Notifies the new assignee;
   * the previous-assignee notification is a Phase-3 follow-up.
   */
  async forceReassign(
    id: string,
    userId: string,
    reason: string,
  ): Promise<CycleCountRow> {
    assertModuleEnabled(this.ctx, 'cycle_counts');
    // Authorization (manager+) is enforced inside the RPC; the module gate is
    // kept here. A blanket permission assert would wrongly block a manager who
    // is manager-by-role but lacks a specific granular grant.
    if (!reason || reason.trim() === '') {
      throw new ServiceError(
        'validation_error',
        'A reassignment reason is required.',
        { reason: 'reassign_reason_required' },
      );
    }
    const { data, error } = await this.ctx.supabase.rpc(
      'force_reassign_cycle_count',
      { p_count_id: id, p_user_id: userId, p_reason: reason },
    );
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('reassign_reason_required'))
        throw new ServiceError('validation_error', 'A reassignment reason is required.', {
          reason: 'reassign_reason_required',
        });
      if (msg.includes('invalid_assignee'))
        throw new ServiceError(
          'validation_error',
          'That user is not an active member of this organization.',
        );
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError('conflict', 'This cycle count is closed — it can\'t be reassigned.');
      if (msg.includes('cycle_count_not_found'))
        throw new ServiceError('not_found', 'Cycle count not found.');
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Only a manager can force-reassign an active count.');
      throw new ServiceError('internal_error', 'Could not reassign the cycle count.');
    }
    await audit(
      {
        event: 'cycle_count.force_reassigned',
        entityType: 'cycle_count',
        entityId: id,
        reason,
        extra: { assigned_to: userId },
      },
      this.ctx,
    );
    return data as unknown as CycleCountRow;
  }

  async get(
    id: string,
  ): Promise<{ header: CycleCountRow; lines: CycleCountLineWithItem[] }> {
    assertModuleEnabled(this.ctx, 'cycle_counts');
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

    // Fetch EVERY line. The PDF count sheet + variance report print all of
    // them, and a bare select silently clamps to [api] max_rows = 1000 —
    // which for a >1000-SKU count dropped the tail off the printout and the
    // on-screen list. Page by a stable id order, then apply the on-screen
    // sort below. The detail PAGE does NOT use this method (it pulls one
    // server-paginated page via getDetailPage), so shipping the whole set
    // here stays bounded to the print / export callers that genuinely need
    // every row.
    const rawLines = await fetchAllRows<Record<string, unknown>>((from, to) =>
      this.ctx.supabase
        .from('cycle_count_lines')
        .select(
          `id, cycle_count_id, item_id, warehouse_id, expected_quantity, counted_quantity,
           reason, notes, counted_by, counted_at,
           item:inventory_items!item_id (id, name, sku, unit_of_measure, barcode)`,
        )
        .eq('cycle_count_id', id)
        .order('id', { ascending: true })
        .range(from, to),
    );

    const flattened = rawLines.map((row) => {
      const r = row as Record<string, unknown>;
      const itemField = r.item as
        | { id: string; name: string; sku: string; unit_of_measure: string; barcode: string | null }
        | { id: string; name: string; sku: string; unit_of_measure: string; barcode: string | null }[]
        | null
        | undefined;
      const item = Array.isArray(itemField) ? (itemField[0] ?? null) : (itemField ?? null);
      return { ...r, item } as CycleCountLineWithItem;
    });

    // Reproduce the exact on-screen / count-sheet ordering the caller saw
    // before pagination:
    //   • in_progress → SKU ascending (matches the printable count sheet);
    //     lines without an item sort last.
    //   • completed / canceled → counted_at descending, nulls last (the old
    //     DB `.order('counted_at', …)` order).
    // JS Array.sort is stable, so the id-ascending fetch order breaks any
    // ties deterministically.
    if (h.status === 'in_progress') {
      flattened.sort((a, b) => {
        const ak = a.item?.sku ?? '￿';
        const bk = b.item?.sku ?? '￿';
        return ak.localeCompare(bk);
      });
    } else {
      flattened.sort((a, b) => {
        const at = a.counted_at ? Date.parse(a.counted_at) : -Infinity;
        const bt = b.counted_at ? Date.parse(b.counted_at) : -Infinity;
        return bt - at;
      });
    }

    return { header: h, lines: flattened };
  }

  /**
   * ONE server-paginated page of a count's lines for the detail page, plus
   * the whole-count summary. Replaces get() on the interactive page so a
   * >1000-SKU count no longer ships (or silently caps at) the entire line
   * set — the counter pages / searches through every line server-side.
   *
   * The line page + filtered total come from cycle_count_lines_page (which
   * can order + search by the joined item's columns and filter on the
   * column-vs-column variance predicate — none of which PostgREST can do);
   * the summary (total / counted / variance / net delta the stat cards +
   * post dialog need) comes from cycle_count_summary. Both are SECURITY
   * INVOKER, so the caller's RLS applies exactly like get() did.
   *
   * A past-end page request is CLAMPED to the real last page (honest total
   * via an offset-0 probe, then that page's rows) and the returned `page`
   * is the effective one — see CycleCountDetailPage.page.
   */
  async getDetailPage(
    id: string,
    opts: {
      page?: number;
      pageSize?: number;
      search?: string;
      filter?: CycleCountLineFilter;
    } = {},
  ): Promise<CycleCountDetailPage> {
    assertModuleEnabled(this.ctx, 'cycle_counts');
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('cycle_counts')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'Cycle count not found');

    const h = header as unknown as CycleCountRow;
    // Same warehouse-access gate as get(): a warehouse-scoped count needs
    // read access to its warehouse; org-wide counts skip it. 404 (not 403)
    // so we don't leak the existence of a count in a hidden warehouse.
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

    const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? 50), 1), 200);
    const page = Math.max(Math.trunc(opts.page ?? 1), 1);
    const filter: CycleCountLineFilter = opts.filter ?? 'all';
    const search = (opts.search ?? '').trim();
    // Open counts sort by SKU (matches the count sheet); closed counts by
    // most-recent activity — the same split get() applies.
    const order = h.status === 'in_progress' ? 'sku' : 'recent';

    const linesPageArgs = {
      p_cycle_count_id: id,
      p_search: search || null,
      p_filter: filter,
      p_order: order,
    };
    const [pageRes, sumRes] = await Promise.all([
      this.ctx.supabase.rpc('cycle_count_lines_page', {
        ...linesPageArgs,
        p_limit: pageSize,
        p_offset: (page - 1) * pageSize,
      }),
      this.ctx.supabase.rpc('cycle_count_summary', { p_cycle_count_id: id }),
    ]);
    if (pageRes.error) throw new ServiceError('internal_error', pageRes.error.message);
    if (sumRes.error) throw new ServiceError('internal_error', sumRes.error.message);

    let rows = (pageRes.data ?? []) as Array<Record<string, unknown>>;
    let total = rows.length > 0 ? Number(rows[0]?.full_count) || 0 : 0;
    let effectivePage = page;

    // Past-end CLAMP. An empty window past the last page carries no
    // window-count row, so `total` would read 0 and the UI would collapse to
    // a bogus "no items match" while lines remain — a deterministic strand
    // for the counter: finish the last page's lines under filter=uncounted
    // and the router.refresh() re-requests the same now-past-end ?page=N.
    // This is the PRIMARY counting flow, so don't just report the honest
    // total (the listPage probe pattern) — land the counter on real rows:
    // probe offset 0 for the true filtered total, then fetch the REAL last
    // page and return its number as the effective page.
    if (rows.length === 0 && page > 1) {
      const probe = await this.ctx.supabase.rpc('cycle_count_lines_page', {
        ...linesPageArgs,
        p_limit: 1,
        p_offset: 0,
      });
      if (probe.error) throw new ServiceError('internal_error', probe.error.message);
      const probeRows = (probe.data ?? []) as Array<Record<string, unknown>>;
      total = probeRows.length > 0 ? Number(probeRows[0]?.full_count) || 0 : 0;

      if (total > 0) {
        effectivePage = Math.max(1, Math.ceil(total / pageSize));
        const lastRes = await this.ctx.supabase.rpc('cycle_count_lines_page', {
          ...linesPageArgs,
          p_limit: pageSize,
          p_offset: (effectivePage - 1) * pageSize,
        });
        if (lastRes.error) throw new ServiceError('internal_error', lastRes.error.message);
        rows = (lastRes.data ?? []) as Array<Record<string, unknown>>;
        // Prefer the fetched page's own window count — the filtered set can
        // shift between probe and fetch under concurrent counting.
        if (rows.length > 0) total = Number(rows[0]?.full_count) || total;
      } else {
        // Genuinely empty filtered set: normalize to page 1 so the UI
        // renders the true empty state with no phantom paginator.
        effectivePage = 1;
      }
    }
    const lines: CycleCountLineWithItem[] = rows.map((r) => ({
      id: r.id as string,
      cycle_count_id: r.cycle_count_id as string,
      item_id: r.item_id as string,
      warehouse_id: (r.warehouse_id as string | null) ?? null,
      expected_quantity: Number(r.expected_quantity) || 0,
      counted_quantity: r.counted_quantity == null ? null : Number(r.counted_quantity),
      reason: (r.reason as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      counted_by: (r.counted_by as string | null) ?? null,
      counted_at: (r.counted_at as string | null) ?? null,
      item: {
        id: r.item_id as string,
        name: (r.item_name as string) ?? '',
        sku: (r.item_sku as string) ?? '',
        unit_of_measure: (r.item_uom as string) ?? '',
        barcode: (r.item_barcode as string | null) ?? null,
      },
    }));

    const sumRow = (Array.isArray(sumRes.data) ? sumRes.data[0] : sumRes.data) as
      | { total: number; counted: number; variance_count: number; net_delta: number }
      | null
      | undefined;
    const summary: CycleCountSummary = {
      total: Number(sumRow?.total) || 0,
      counted: Number(sumRow?.counted) || 0,
      varianceCount: Number(sumRow?.variance_count) || 0,
      netDelta: Number(sumRow?.net_delta) || 0,
    };

    return { header: h, lines, summary, page: effectivePage, pageSize, total, search, filter };
  }

  /**
   * Counts the active items in scope right now. Used by the UI to
   * surface a "new items added mid-count" warning when this number
   * exceeds the line count from the original snapshot. Cheap head
   * query — no row data is transferred.
   */
  async itemsInScopeCount(cycleCountId: string): Promise<number> {
    assertModuleEnabled(this.ctx, 'cycle_counts');
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
    assertModuleEnabled(this.ctx, 'cycle_counts');
    // The cycle_counts INSERT RLS requires manager-level access. Gate on the
    // SAME permission assign() uses for header mutation so a staff caller gets
    // a clean `forbidden` BEFORE the DB round-trip instead of an opaque
    // internal_error 500 from the RLS-blocked insert. Keep stock:adjust too:
    // it's the floor for the line writes + the downstream post() this enables.
    assertPermission(this.ctx, 'cycle_counts:assign');
    assertPermission(this.ctx, 'stock:adjust');
    const scope = input.scope ?? 'warehouse';

    // Header warehouse: for a warehouse-scoped count it's the chosen
    // warehouse; for a selection it's derived below (the picks' shared
    // warehouse, or null when they span warehouses / have none).
    let headerWarehouseId: string | null = input.warehouseId;
    // Warehouse-scope item filter for the snapshot RPC (null = org-wide).
    let filterWarehouseId: string | null = null;
    // Selection-scope item filter for the snapshot RPC (null for warehouse
    // scope). The validated, active pick ids the RPC re-selects.
    let selectionItemIds: string[] | null = null;
    let requested = 0;

    if (scope === 'selection') {
      const ids = Array.from(new Set(input.itemIds ?? []));
      requested = ids.length;
      if (ids.length === 0) {
        throw new ServiceError('validation_error', 'Pick at least one item to count.');
      }
      // Fetch the picked items under the caller's RLS to (a) gate write
      // access per distinct warehouse, (b) derive the header warehouse,
      // (c) surface the "none active" error before snapshotting. Same org +
      // deleted_at + status predicate the snapshot RPC re-selects with, so
      // the gated set and the snapshotted set are the same items.
      const { data, error } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, warehouse_id')
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null)
        .eq('status', 'active')
        .in('id', ids);
      if (error) throw new ServiceError('internal_error', error.message);
      const items = (data ?? []) as Array<{ id: string; warehouse_id: string | null }>;
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
      // Label the count with its warehouse when every pick shares one
      // (the common case — picks usually come from a single warehouse /
      // the active workspace). Mixed- or no-warehouse selections stay null.
      headerWarehouseId =
        distinctWh.size === 1 && !hasNullWh ? (Array.from(distinctWh)[0] as string) : null;
      // Snapshot exactly the active picks we just validated + gated.
      selectionItemIds = items.map((it) => it.id);
    } else {
      // Defense-in-depth: warehouse-write check so a manager can't
      // start a cycle count for a warehouse they can't write to (the
      // post() path eventually zeros out the warehouse's stock — that
      // must be gated). Org-wide counts (warehouseId = null) skip the
      // gate; only admins+ realistically reach that branch via UI.
      if (input.warehouseId) {
        await assertWarehouseAccess(input.warehouseId, 'write', this.ctx);
      }
      filterWarehouseId = input.warehouseId;
      headerWarehouseId = input.warehouseId;
    }

    // Atomic snapshot: the cycle_counts header + one cycle_count_lines row
    // per in-scope item are inserted in ONE transaction via INSERT … SELECT
    // (migration 0226). This (a) never ships the per-row payload over the
    // wire, so a 50k-SKU warehouse count actually starts instead of blowing
    // the 8s statement_timeout, and (b) can't orphan a header — an empty
    // scope raises and rolls the header back. SECURITY INVOKER, so item RLS
    // scopes the snapshot to the caller's visible items exactly like the old
    // user-client fetch did, and the manager-level header/line INSERT
    // policies still apply.
    const { data: rpcData, error: rpcErr } = await this.ctx.supabase.rpc('start_cycle_count', {
      p_organization_id: this.ctx.organizationId,
      p_scope: scope,
      p_header_warehouse_id: headerWarehouseId,
      p_filter_warehouse_id: filterWarehouseId,
      p_item_ids: selectionItemIds,
      p_notes: input.notes ?? null,
    });
    if (rpcErr) throw mapStartCycleCountError(rpcErr.message, scope, input.warehouseId);
    const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as
      | { cycle_count_id: string; line_count: number }
      | null
      | undefined;
    if (!row?.cycle_count_id) {
      throw new ServiceError('internal_error', 'Cycle count could not be started.');
    }
    const ccId = row.cycle_count_id;
    const lineCount = Number(row.line_count) || 0;

    // Assign as a SEPARATE update so trg_cycle_counts_assigned (0042)
    // fires and the assignee gets the in-app + push notification — the
    // RPC's inserts wouldn't trip an AFTER UPDATE OF assigned_to trigger.
    if (input.assignedTo) {
      try {
        await this.assign(ccId, input.assignedTo);
      } catch {
        // Non-fatal: the count exists; the assignment just didn't stick.
        // The starter can re-assign from the detail page.
      }
    }

    await audit(
      {
        event: 'cycle_count.started',
        entityType: 'cycle_count',
        entityId: ccId,
        after: {
          scope,
          warehouseId: headerWarehouseId,
          lineCount,
        },
      },
      this.ctx,
    );

    return {
      id: ccId,
      // Warehouse scope never "skips" (the snapshot IS the scope); selection
      // skips picks that were archived / deleted / left the org.
      lineCount,
      skipped: scope === 'selection' ? requested - lineCount : 0,
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
    if (wh) {
      await assertWarehouseAccess(wh, 'write', this.ctx);
      return;
    }
    // Null header warehouse: either a true org-wide warehouse count OR a
    // selection that spans multiple warehouses / includes no-warehouse
    // items (start() forces the header null in those cases). The header
    // carries no warehouse to gate on, so fall back to gating on every
    // warehouse the count's LINES actually touch — mirroring start()'s
    // per-warehouse write gate. Without this a warehouse-scoped staffer
    // could record/clear lines for a warehouse they have no write access
    // to: the cycle_count_lines RLS is org-wide, not warehouse-scoped, so
    // the DB won't catch it. Items with no warehouse require full
    // (manager+) access, same as start().
    const { data: lineRows, error: lErr } = await this.ctx.supabase
      .from('cycle_count_lines')
      .select('warehouse_id')
      .eq('cycle_count_id', cycleCountId);
    if (lErr) throw new ServiceError('internal_error', lErr.message);
    const distinctWh = new Set<string>();
    let hasNullWh = false;
    for (const r of (lineRows ?? []) as Array<{ warehouse_id: string | null }>) {
      if (r.warehouse_id) distinctWh.add(r.warehouse_id);
      else hasNullWh = true;
    }
    if (hasNullWh) {
      const access = await getWarehouseAccess(this.ctx);
      if (!access.hasAllAccess) {
        throw new ForbiddenError(
          'You cannot modify a count that includes items with no warehouse.',
        );
      }
    }
    for (const w of distinctWh) {
      await assertWarehouseAccess(w, 'write', this.ctx);
    }
  }

  /**
   * Assignee lock (defense-in-depth over the 0282 line-write RLS): a count
   * assigned to a specific staffer may only be counted by that staffer or a
   * manager+. An UNASSIGNED count stays open — parity with the RLS predicate
   * (`assigned_to IS NULL`), closed later by the assign-before-count flow.
   * Surfaces a clean `forbidden` (reason `assigned_to_another_user`) BEFORE
   * the DB round-trip instead of the RLS-blocked update's misleading
   * "line no longer editable" 404.
   */
  private async assertAssignee(cycleCountId: string): Promise<void> {
    if (isManagerOrAbove(this.ctx.role)) return;
    const { data, error } = await this.ctx.supabase
      .from('cycle_counts')
      .select('assigned_to')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', cycleCountId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Cycle count not found.');
    const assignedTo = (data as { assigned_to: string | null }).assigned_to;
    if (assignedTo && assignedTo !== this.ctx.userId) {
      throw new ServiceError(
        'forbidden',
        'This cycle count is assigned to another employee. A manager must release or reassign it before you can count.',
        { reason: 'assigned_to_another_user' },
      );
    }
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
    assertModuleEnabled(this.ctx, 'cycle_counts');
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(input.cycleCountId);
    await this.assertAssignee(input.cycleCountId);
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
    assertModuleEnabled(this.ctx, 'ai_shelf_scan');
    // Full pre-flight authorization BEFORE the caller (route) spends a paid
    // vision call + photo upload. Previously only module + warehouse scope
    // were checked here and the stock:adjust permission was deferred until
    // the confirm/record step — so an unauthorized or non-assignee user could
    // still trigger the expensive AI call. Gate on the SAME rules as
    // recordCount: permission + warehouse scope + assignee lock + open status.
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(cycleCountId);
    await this.assertAssignee(cycleCountId);
    const { data: statusRow, error: sErr } = await this.ctx.supabase
      .from('cycle_counts')
      .select('status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', cycleCountId)
      .maybeSingle();
    if (sErr) throw new ServiceError('internal_error', sErr.message);
    if (!statusRow) throw new ServiceError('not_found', 'Cycle count not found.');
    if ((statusRow as { status: string }).status !== 'in_progress') {
      throw new ServiceError(
        'conflict',
        'This cycle count is closed — it can no longer be scanned.',
      );
    }

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
    assertModuleEnabled(this.ctx, 'ai_shelf_scan');
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
    assertModuleEnabled(this.ctx, 'ai_shelf_scan');
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
    assertModuleEnabled(this.ctx, 'cycle_counts');
    assertPermission(this.ctx, 'stock:adjust');
    await this.assertSessionAccess(input.cycleCountId);
    await this.assertAssignee(input.cycleCountId);
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
    assertModuleEnabled(this.ctx, 'cycle_counts');
    // The cycle_counts UPDATE RLS requires manager-level access. Gate on the
    // SAME permission assign() uses so a staff caller gets a clean `forbidden`
    // BEFORE the DB round-trip instead of the misleading "no longer open"
    // conflict the RLS-blocked update would otherwise produce. Keep stock:adjust
    // too as the established floor for cycle-count mutations.
    assertPermission(this.ctx, 'cycle_counts:assign');
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
    assertModuleEnabled(this.ctx, 'cycle_counts');
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
    void dispatchEvent(this.ctx.organizationId, 'cycle_count.completed', { id });
    return data as unknown as CycleCountRow;
  }
}
