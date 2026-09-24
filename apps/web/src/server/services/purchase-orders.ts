import 'server-only';

import { z } from 'zod';

import { assertWarehouseAccess, getWarehouseAccess } from '@/lib/auth/warehouse';
import { reportError } from '@/lib/error-reporter';
import { createAdminClient } from '@/lib/supabase/admin';
import { mapWithConcurrency } from '@/lib/supabase/in-filter';
import { createNotification } from './notifications';

import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import {
  planAutoReorder,
  shouldAutoSend,
  type AutoReorderCandidate,
  type AutoReorderSettings,
} from './auto-reorder';
import {
  fetchAllRowsByIds,
  rawErrorText,
  reportDegradedRead,
  writeInIdBatches,
} from './lib/fetch-by-ids';
import { invalidateInventoryListAfterWrite } from './lib/inventory-list-cache';
import { fetchAllRows } from './lib/paginate';
import { audit, auditMany } from './audit';
import { dispatchEvent } from './integration-events';
import { ItemImagesService } from './item-images';
import { InventoryService } from './inventory';
import { createItemSchema } from '@stockpilot/core';

/** Notifications created at once by one fan-out (maintenance-notify.ts uses
 *  the same number for the same reason). */
const PO_NOTIFY_CONCURRENCY = 6;

/**
 * The PO states in which an item is still "on order": a draft (it will be
 * sent), and every state that still expects goods. An item on a PO in one of
 * these is not drafted again by the reorder paths. Received and cancelled POs
 * do not count.
 */
const OPEN_PO_STATUSES = ['draft', 'expected_inbound', 'ordered', 'partially_received'] as const;

/** One line as save_purchase_order_draft (0366) takes it. */
type SaveDraftLine = { itemId: string; quantityOrdered: number; unitCost: number };

/**
 * Map a save_purchase_order_draft error onto a ServiceError. The function
 * marks its own refusals with a hint (0366 header); a PO number taken by
 * another PO surfaces as the unique index's 23505. Anything else (an RLS or
 * guard refusal, a lost connection) stays an internal error, as the direct
 * writes it replaces reported it.
 */
function saveDraftRpcError(err: { message?: string; code?: string; hint?: string | null }): ServiceError {
  const message = err.message ?? '';
  if (err.code === '23505') {
    return new ServiceError('conflict', 'That PO number is already in use.');
  }
  switch (err.hint) {
    case 'po_not_draft':
      return new ServiceError(
        'conflict',
        'This purchase order is no longer a draft (it may have just been ordered).',
      );
    case 'po_not_found':
      return new ServiceError('not_found', 'Purchase order not found');
    case 'po_lines_required':
      return new ServiceError('validation_error', 'Add at least one line item');
    case 'po_line_invalid':
    case 'po_invalid':
    case 'po_not_in_org':
      return new ServiceError('validation_error', message);
    default:
      break;
  }
  // 40001 without our hint cannot come from READ COMMITTED; if it ever does,
  // it is still "the draft changed under you".
  if (err.code === '40001') {
    return new ServiceError(
      'conflict',
      'This purchase order is no longer a draft (it may have just been ordered).',
    );
  }
  return new ServiceError('internal_error', message || 'Could not save the purchase order.');
}

const lineInputSchema = z
  .object({
    itemId: z.string().uuid().optional(),
    newItemName: z.string().trim().min(1).max(200).optional(),
    quantityOrdered: z.coerce.number().positive(),
    unitCost: z.coerce.number().nonnegative(),
  })
  .refine(
    (l) => Boolean(l.itemId) !== Boolean(l.newItemName),
    {
      message: 'Each line must have exactly one of itemId or newItemName (not both, not neither)',
    },
  );

export const createPoSchema = z.object({
  supplierId: z.string().uuid().nullable().optional(),
  destinationLocationId: z.string().uuid().nullable().optional(),
  /** Bill-to charter rendered on the PO PDF. Distinct from item ownership. */
  charterId: z.string().uuid().nullable().optional(),
  expectedAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).optional(),
  poNumber: z.string().trim().min(1).max(64).optional(),
  lines: z.array(lineInputSchema).min(1, 'Add at least one line item'),
});
export type CreatePoInput = z.infer<typeof createPoSchema>;

export const updatePoStatusSchema = z.object({
  status: z.enum(['draft', 'ordered', 'cancelled']),
});

export const receivePoSchema = z.object({
  lines: z
    .array(z.object({ lineId: z.string().uuid(), quantity: z.coerce.number().nonnegative() }))
    .min(1),
  notes: z.string().max(2000).optional(),
});
export type ReceivePoInput = z.infer<typeof receivePoSchema>;

/** Aggregates for the PO index header + stat cards (purchase_orders_stats). */
export interface PoListStats {
  totalCount: number;
  totalValue: number;
  openCount: number;
  committedValue: number;
  openSupplierCount: number;
  inboundCount: number;
  nextEtaPoNumber: string | null;
  nextEtaExpectedAt: string | null;
  /** Fractional days — the page rounds for display (Math.round parity). */
  avgLeadDays: number | null;
}

const EMPTY_PO_LIST_STATS: PoListStats = {
  totalCount: 0,
  totalValue: 0,
  openCount: 0,
  committedValue: 0,
  openSupplierCount: 0,
  inboundCount: 0,
  nextEtaPoNumber: null,
  nextEtaExpectedAt: null,
  avgLeadDays: null,
};

/** One purchase_orders_page RPC row (filtered_count repeats per row). */
interface PoPageRpcRow {
  id: string;
  po_number: string;
  status: string;
  supplier_id: string | null;
  destination_location_id: string | null;
  expected_at: string | null;
  ordered_at: string | null;
  received_at: string | null;
  total: number;
  created_at: string;
  updated_at: string;
  line_count: number;
  filtered_count: number;
}

/** One PO index table row — the RPC row minus the window count. */
export type PoPageRow = Omit<PoPageRpcRow, 'filtered_count'>;

/**
 * Every status that COMMITS spend / creates a receivable PO — i.e. a
 * transition OUT of 'draft' that a spend control must clear. The canonical
 * placement is 'ordered', but 'expected_inbound' and 'partially_received' are
 * equally receivable, and 'received' additionally fabricates a fully-received
 * PO (no receipts, no stock movements). The action's TS union is compile-time
 * only, so a forged call can carry any of these; each must clear the approval
 * threshold. 'draft' (de-commit) and 'cancelled' (terminal) are NOT here — they
 * stay open to any purchase_orders:manage holder.
 */
export const SPEND_COMMITTING_PO_STATUSES: ReadonlySet<string> = new Set([
  'ordered',
  'expected_inbound',
  'partially_received',
  'received',
]);

/**
 * PO approval threshold (Intacct-grade spend governance, no migration — lives
 * in the purchase_orders module's organization_modules.settings as
 * `approvalThresholdAmount`). When configured (> 0), a PO whose total is AT OR
 * ABOVE the threshold can only be committed by an owner or admin; managers keep
 * full draft/cancel rights at any size. Absent/0 = feature off (the default —
 * existing orgs are unaffected).
 *
 * Shared by the PO status transition (PurchaseOrdersService.updateStatus) AND
 * the PO-import approval (PoImportsService.approve) so the two spend-committing
 * paths can never drift — a threshold enforced on one but not the other is not
 * a threshold.
 *
 * FAIL CLOSED: a settings read error blocks the transition rather than silently
 * waiving governance (an approval gate that disappears on a transient DB error
 * is not a gate).
 */
export async function assertPoApprovalThreshold(
  ctx: ServiceContext,
  total: number,
): Promise<void> {
  if (ctx.role === 'owner' || ctx.role === 'admin') return;
  const { data, error } = await ctx.supabase
    .from('organization_modules')
    .select('settings')
    .eq('organization_id', ctx.organizationId)
    .eq('module_id', 'purchase_orders')
    .maybeSingle();
  if (error) throw new ServiceError('internal_error', error.message);
  const settings = ((data as { settings?: unknown } | null)?.settings ?? {}) as Record<
    string,
    unknown
  >;
  const raw = Number(settings.approvalThresholdAmount);
  const threshold = Number.isFinite(raw) && raw > 0 ? raw : null;
  if (threshold !== null && total >= threshold) {
    throw new ServiceError(
      'forbidden',
      `This purchase order ($${total.toLocaleString()}) meets the $${threshold.toLocaleString()} approval threshold — ask an owner or admin to place it.`,
    );
  }
}

export class PurchaseOrdersService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new PurchaseOrdersService(await withContext());
  }

  /**
   * Cheap count of receivable POs whose `expected_at` is in the past — used
   * by the dashboard "needs attention" hero to surface inbound deliveries
   * that are late. Warehouse-scoped via the destination location's
   * warehouse, matching the same access rules as `list()`. Returns 0 when
   * the user has zero readable warehouses.
   */
  async overdueCount(params: { warehouseId?: string } = {}): Promise<number> {
    const access = await getWarehouseAccess(this.ctx);
    const needsScope = !access.hasAllAccess || !!params.warehouseId;
    if (!access.hasAllAccess && access.readableIds.length === 0) return 0;

    const destEmbed = needsScope
      ? 'destination:locations!destination_location_id!inner (warehouse_id)'
      : 'destination:locations!destination_location_id (warehouse_id)';

    let query = this.ctx.supabase
      .from('purchase_orders')
      .select(`id, ${destEmbed}`, { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .in('status', ['expected_inbound', 'ordered', 'partially_received'])
      .not('expected_at', 'is', null)
      .lt('expected_at', new Date().toISOString());

    if (!access.hasAllAccess) {
      // in-list-bound: the caller's readable warehouses (an org's handful of sites)
      query = query.in('destination.warehouse_id', access.readableIds);
    } else if (params.warehouseId) {
      query = query.eq('destination.warehouse_id', params.warehouseId);
    }

    const { count, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return count ?? 0;
  }

  async list(params: { warehouseId?: string } = {}) {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    const access = await getWarehouseAccess(this.ctx);

    // Scope by destination location's warehouse via inner-join when needed.
    const needsScope = !access.hasAllAccess || !!params.warehouseId;
    const destEmbed = needsScope
      ? 'destination:locations!destination_location_id!inner (warehouse_id)'
      : 'destination:locations!destination_location_id (warehouse_id)';

    if (!access.hasAllAccess && access.readableIds.length === 0) return [];

    type PoListRow = {
      id: string;
      po_number: string;
      status: string;
      supplier_id: string | null;
      destination_location_id: string | null;
      expected_at: string | null;
      ordered_at: string | null;
      received_at: string | null;
      total: number;
      created_at: string;
      updated_at: string;
      destination?: unknown;
      purchase_order_items?: Array<{ count: number }>;
    };

    // Paginate the FULL rowset rather than relying on PostgREST's 1000-row cap,
    // so the page's in-memory stat aggregation (open count, committed value,
    // lead time, …) stays accurate at any PO volume (repo rule: paginate every
    // aggregation SELECT). The stable secondary `.order('id')` is required for
    // window correctness. `purchase_order_items(count)` is an embedded
    // aggregate (RLS-scoped) giving the LINES column without an N+1;
    // `ordered_at`/`received_at` feed the placed/lead-time stats.
    const rows = await fetchAllRows<PoListRow>((from, to) => {
      let query = this.ctx.supabase
        .from('purchase_orders')
        .select(
          `id, po_number, status, supplier_id, destination_location_id, expected_at, ordered_at, received_at, total, created_at, updated_at, ${destEmbed}, purchase_order_items(count)`,
        )
        .eq('organization_id', this.ctx.organizationId);
      if (!access.hasAllAccess) {
        // in-list-bound: the caller's readable warehouses (an org's handful of sites)
        query = query.in('destination.warehouse_id', access.readableIds);
      } else if (params.warehouseId) {
        query = query.eq('destination.warehouse_id', params.warehouseId);
      }
      return query
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: PoListRow[] | null;
        error: { message: string } | null;
      }>;
    });

    // Normalize the embedded `purchase_order_items(count)` shape (PostgREST
    // returns `[{ count: N }]`) into a flat `line_count` number.
    return rows.map((row) => {
      const line_count = Array.isArray(row.purchase_order_items)
        ? (row.purchase_order_items[0]?.count ?? 0)
        : 0;
      return { ...row, line_count };
    });
  }

  /**
   * Maps the caller's warehouse situation onto the `p_warehouse_ids`
   * parameter the 0227 list RPCs take — EXACTLY the branch structure
   * list() applies via its `destination:locations` embed:
   *   • restricted user with zero readable warehouses → empty result,
   *     no query (list() returns [] the same way);
   *   • restricted user → their readableIds (the active warehouse
   *     view-filter is IGNORED for them, same as list());
   *   • all-access + view-filter → that single warehouse;
   *   • all-access, no filter → null (org-wide, left-join semantics).
   * The ids only ever NARROW: purchase_orders' RLS floor is org
   * membership (mig 0140), so no id list can widen what the caller's
   * own client could already read.
   */
  private async warehouseScope(params: {
    warehouseId?: string;
  }): Promise<{ empty: boolean; ids: string[] | null }> {
    const access = await getWarehouseAccess(this.ctx);
    if (!access.hasAllAccess && access.readableIds.length === 0) {
      return { empty: true, ids: null };
    }
    if (!access.hasAllAccess) return { empty: false, ids: access.readableIds };
    if (params.warehouseId) return { empty: false, ids: [params.warehouseId] };
    return { empty: false, ids: null };
  }

  /**
   * Header + stat-card aggregates for the PO index — ONE set-based RPC
   * (purchase_orders_stats, migration 0227) over the warehouse-scoped
   * full list, replacing the page's JS roll-up over a fetchAllRows dump
   * of every org PO. Tab/search never affect these figures (parity with
   * the page, which computed them from the unfiltered list). SECURITY:
   * the RPC is SECURITY INVOKER and runs on the USER client, so
   * purchase_orders RLS (org membership) binds inside it — a cross-org
   * org id aggregates zero rows.
   *
   * `avgLeadDays` is returned UNROUNDED (may be fractional); the page
   * keeps its own Math.round so the displayed math is unchanged.
   */
  async listStats(params: { warehouseId?: string } = {}): Promise<PoListStats> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    const scope = await this.warehouseScope(params);
    if (scope.empty) return EMPTY_PO_LIST_STATS;

    const { data, error } = await this.ctx.supabase.rpc('purchase_orders_stats', {
      p_organization_id: this.ctx.organizationId,
      p_warehouse_ids: scope.ids,
    });
    if (error) throw new ServiceError('internal_error', error.message);
    const row = (Array.isArray(data) ? data[0] : data) as
      | {
          total_count: number | string | null;
          total_value: number | string | null;
          open_count: number | string | null;
          committed_value: number | string | null;
          open_supplier_count: number | string | null;
          inbound_count: number | string | null;
          next_eta_po_number: string | null;
          next_eta_expected_at: string | null;
          avg_lead_days: number | string | null;
        }
      | null
      | undefined;
    return {
      totalCount: Number(row?.total_count ?? 0),
      totalValue: Number(row?.total_value ?? 0),
      openCount: Number(row?.open_count ?? 0),
      committedValue: Number(row?.committed_value ?? 0),
      openSupplierCount: Number(row?.open_supplier_count ?? 0),
      inboundCount: Number(row?.inbound_count ?? 0),
      nextEtaPoNumber: row?.next_eta_po_number ?? null,
      nextEtaExpectedAt: row?.next_eta_expected_at ?? null,
      avgLeadDays: row?.avg_lead_days == null ? null : Number(row.avg_lead_days),
    };
  }

  /**
   * ONE server-side page of the PO index table (purchase_orders_page,
   * migration 0227): tab statuses + q (po_number OR the rendered
   * supplier label, with %/_/\ treated literally like the old JS
   * .includes) + the same warehouse scoping and created_at DESC / id ASC
   * ordering list() had, but only `perPage` rows leave the database —
   * the page no longer dumps and renders every org PO. `total` is the
   * FILTERED set size (never clamped — it's a window count in SQL).
   *
   * When a stale deep link lands past the last page, the empty window
   * carries no window-count row, so a one-row probe at offset 0 recovers
   * the true total (rare path; keeps "Showing X–Y of N" honest instead
   * of misreporting "no matches").
   */
  async listPage(params: {
    warehouseId?: string;
    statuses?: readonly string[] | null;
    q?: string;
    page: number;
    perPage: number;
  }): Promise<{ rows: PoPageRow[]; total: number }> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    const scope = await this.warehouseScope(params);
    if (scope.empty) return { rows: [], total: 0 };

    const perPage = Math.max(1, Math.floor(params.perPage));
    const page = Math.max(1, Math.floor(params.page));
    const q = (params.q ?? '').trim();
    const rpcArgs = {
      p_organization_id: this.ctx.organizationId,
      p_warehouse_ids: scope.ids,
      p_statuses: params.statuses && params.statuses.length > 0 ? [...params.statuses] : null,
      p_q: q || null,
    };

    const { data, error } = await this.ctx.supabase.rpc('purchase_orders_page', {
      ...rpcArgs,
      p_limit: perPage,
      p_offset: (page - 1) * perPage,
    });
    if (error) throw new ServiceError('internal_error', error.message);
    const raw = (data ?? []) as PoPageRpcRow[];

    let total = raw.length > 0 ? Number(raw[0]!.filtered_count ?? 0) : 0;
    if (raw.length === 0 && page > 1) {
      const probe = await this.ctx.supabase.rpc('purchase_orders_page', {
        ...rpcArgs,
        p_limit: 1,
        p_offset: 0,
      });
      if (probe.error) throw new ServiceError('internal_error', probe.error.message);
      const probeRows = (probe.data ?? []) as PoPageRpcRow[];
      total = probeRows.length > 0 ? Number(probeRows[0]!.filtered_count ?? 0) : 0;
    }

    return {
      rows: raw.map(({ filtered_count: _filtered, ...row }) => ({
        ...row,
        line_count: Number(row.line_count ?? 0),
      })),
      total,
    };
  }

  async get(id: string) {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    // Permission gate — `get()` is reused by the detail page, the PDF
    // route, and bulk actions, so the cheapest place to enforce read is
    // here. RLS would also keep the row hidden, but an explicit check
    // returns a clear `forbidden` instead of a confusing `not_found`.
    assertPermission(this.ctx, 'purchase_orders:read');
    const { data: po, error } = await this.ctx.supabase
      .from('purchase_orders')
      .select('*, destination:locations!destination_location_id (warehouse_id)')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!po) throw new ServiceError('not_found', 'Purchase order not found');

    const dest = (po as { destination?: unknown }).destination;
    const destRow = Array.isArray(dest) ? dest[0] : dest;
    const wh = (destRow as { warehouse_id?: string | null } | null | undefined)?.warehouse_id ?? null;
    if (wh) {
      const access = await getWarehouseAccess(this.ctx);
      if (!access.hasAllAccess && !access.readableIds.includes(wh)) {
        throw new ServiceError('not_found', 'Purchase order not found');
      }
    }

    const { data: lines } = await this.ctx.supabase
      .from('purchase_order_items')
      .select('id, item_id, quantity_ordered, quantity_received, unit_cost, line_total')
      .eq('purchase_order_id', id)
      .eq('organization_id', this.ctx.organizationId);

    // Keep the raw row shape (callers downstream — detail page, PDF
    // route — read snake_case fields off these lines), and tack
    // `imageUrl` on as an extra. Casting to the explicit row shape so
    // TypeScript doesn't collapse the union when we spread.
    type RawLine = {
      id: string;
      item_id: string | null;
      quantity_ordered: number;
      quantity_received: number;
      unit_cost: number;
      line_total: number;
    };
    const rawLines = (lines ?? []) as RawLine[];

    // Batch-fetch primary thumbnails for the line items so the detail
    // page can render real photos. Single `item_images IN (...)` +
    // one `createSignedUrls` call. Skipped when there are no lines.
    const lineItemIds = rawLines
      .map((l) => l.item_id)
      .filter((id): id is string => Boolean(id));
    // Thumb for the small line-table tile + master for the sharp hover
    // preview — the tile used to download the 2048px master into a 40px cell.
    const imageMap =
      lineItemIds.length > 0
        ? await new ItemImagesService(this.ctx).primaryImagesWithThumbsForItems(lineItemIds)
        : new Map<string, { url: string; thumbUrl: string | null; lqip: string | null }>();

    const linesWithImages: Array<
      RawLine & { imageUrl: string | null; previewUrl: string | null }
    > = rawLines.map((l) => {
      const img = l.item_id ? imageMap.get(l.item_id) : undefined;
      return {
        ...l,
        imageUrl: img ? (img.thumbUrl ?? img.url) : null,
        previewUrl: img ? img.url : null,
      };
    });

    return { po, lines: linesWithImages };
  }

  /**
   * Resolves the warehouse a PO's destination location belongs to, enforcing
   * write access. Throws a clear validation error when the location is missing
   * or — critically — has no warehouse_id. A warehouse-less destination makes
   * the PO impossible to receive against (received stock has nowhere to post):
   * the detail page silently hides the Receive button AND the "set destination"
   * recovery card (which only fires when destination is null), stranding the PO
   * in a dead-end. Rejecting it at write time keeps that state from ever forming.
   */
  private async resolveDestinationWarehouseId(
    destinationLocationId: string | null | undefined,
  ): Promise<string | null> {
    if (!destinationLocationId) return null;
    const { data: loc } = await this.ctx.supabase
      .from('locations')
      .select('warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', destinationLocationId)
      .maybeSingle();
    if (!loc) {
      throw new ServiceError('validation_error', 'The selected destination location was not found.');
    }
    const wh = (loc as { warehouse_id?: string | null }).warehouse_id ?? null;
    if (!wh) {
      throw new ServiceError(
        'validation_error',
        "That destination location isn't linked to a warehouse, so received stock would have nowhere to go. Pick a warehouse-backed location.",
      );
    }
    await assertWarehouseAccess(wh, 'write', this.ctx);
    return wh;
  }

  /**
   * Throws a validation_error if the given supplierId does not belong to this org.
   * null/undefined input is a no-op (no supplier is always valid).
   */
  private async assertSupplierInOrg(supplierId: string | null | undefined) {
    if (!supplierId) return;
    const { data, error } = await this.ctx.supabase
      .from('suppliers')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', supplierId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('validation_error', 'The selected supplier was not found in your organization.');
  }

  /**
   * Verifies a bill-to charter belongs to this org before tagging a PO with it.
   * Returns the id when valid, else null — a spoofed/cross-tenant or stale
   * charter id is silently dropped (never written), mirroring the charter
   * defense in the PO-import create-items path. null input → null (no charter).
   */
  private async resolveCharterId(charterId: string | null | undefined): Promise<string | null> {
    if (!charterId) return null;
    const { data: charter } = await this.ctx.supabase
      .from('charters')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', charterId)
      .maybeSingle();
    return (charter?.id as string | undefined) ?? null;
  }

  async create(input: CreatePoInput) {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    // Validate the destination location is in a warehouse the user can write to
    // (and reject a warehouse-less one). Also capture the warehouse_id so we can
    // assign custom items to it.
    const destinationWarehouseId = await this.resolveDestinationWarehouseId(
      input.destinationLocationId,
    );

    // Resolve the warehouse to assign to any custom (new) items.
    // Priority: PO destination warehouse → org's primary/first warehouse.
    // If there is no warehouse at all, throw a clear error before touching the DB.
    const hasCustomLines = input.lines.some((l) => Boolean(l.newItemName));
    let customItemWarehouseId: string | null = destinationWarehouseId;
    if (hasCustomLines && !customItemWarehouseId) {
      const access = await getWarehouseAccess(this.ctx);
      customItemWarehouseId = access.primaryWarehouseId;
      if (!customItemWarehouseId) {
        throw new ServiceError(
          'validation_error',
          'Pick a destination location (or set up a warehouse) before adding a custom item.',
        );
      }
    }

    // Resolve the PO number BEFORE creating any custom items. A caller-supplied
    // number is pre-checked against this org's existing POs so a duplicate fails
    // FAST — otherwise we'd create the custom catalog items, then hit the unique
    // constraint on insert, and strand those items as orphans (made more likely
    // now that a duplicate po_number is a real, user-triggerable failure). The
    // save below still maps the unique index's 23505 for the rare concurrent
    // race (and archives the custom items it created).
    const suppliedPoNumber = input.poNumber?.trim();
    let poNumber: string;
    if (suppliedPoNumber) {
      // A CANCELLED PO is void and does NOT reserve its number — exclude it so a
      // number "spent" on a later-cancelled PO can be reissued. The partial
      // unique index (status <> 'cancelled') backs this at the DB level.
      const { data: existing } = await this.ctx.supabase
        .from('purchase_orders')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('po_number', suppliedPoNumber)
        .neq('status', 'cancelled')
        .maybeSingle();
      if (existing) {
        throw new ServiceError('conflict', 'That PO number is already in use.');
      }
      poNumber = suppliedPoNumber;
    } else {
      // ═══ THE FALLBACK MUST BE LOUD ═══
      //
      // This discarded the RPC error and fell back to `PO-${Date.now()}`. The
      // function was MISSING from production from 2026-05-20 until 0350, so
      // every auto-numbered PO silently got an epoch timestamp
      // (27 of them, e.g. PO-1788277456195) and nobody could see why. The
      // fallback still exists — a PO must never fail to get a number — but a
      // failure is now reported, so the next time an RPC goes missing it is a
      // Sentry event and not three months of ugly supplier-facing documents.
      const { data: numberRpc, error: numberErr } = await this.ctx.supabase.rpc(
        'next_po_number',
        { p_org_id: this.ctx.organizationId },
      );
      if (numberErr) {
        void reportError(new Error(`next_po_number failed: ${numberErr.message}`), {
          tag: 'purchase-orders.next_po_number',
          organizationId: this.ctx.organizationId,
        });
      }
      poNumber = (numberRpc as string | null) ?? `PO-${Date.now()}`;
    }

    // Pure reads, before any custom item exists: a foreign supplier must not
    // leave items behind (these used to run after the item loop).
    await this.assertSupplierInOrg(input.supplierId);
    const billToCharterId = await this.resolveCharterId(input.charterId);

    // Custom "newItemName" lines become real catalog items (InventoryService
    // enforces items:create, plan limits, SKU auto-gen and warehouse access)
    // BEFORE the one-transaction save below. Items created here are archived
    // again if anything after their creation fails, so a failed create leaves
    // neither a PO nor hidden items behind.
    const customItemIds: string[] = [];
    let saved: { id: string; stamped: number; stampError: string | null };
    try {
      const resolvedLines = await this.resolveLines(
        input.lines,
        customItemWarehouseId,
        customItemIds,
      );
      saved = await this.saveDraft({
        poId: null,
        poNumber,
        supplierId: input.supplierId ?? null,
        destinationLocationId: input.destinationLocationId ?? null,
        charterId: billToCharterId,
        expectedAt: input.expectedAt ?? null,
        notes: input.notes ?? null,
        lines: resolvedLines,
        customItemIds,
        op: 'po.create',
      });
    } catch (e) {
      await this.archiveUnusedCustomItems(customItemIds, 'po.create.rollback_custom_items');
      throw e;
    }
    const poId = saved.id;

    void audit(
      {
        event: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: poId,
        extra: {
          po_number: poNumber,
          supplier_id: input.supplierId ?? null,
          line_count: input.lines.length,
        },
      },
      this.ctx,
    );
    // Fan out to configured webhooks / Slack / Teams (best-effort).
    void dispatchEvent(this.ctx.organizationId, 'po.created', {
      id: poId,
      poNumber,
      lineCount: input.lines.length,
    });

    return { id: poId, poNumber };
  }

  /**
   * Resolve form lines to item ids, creating a catalog item for every
   * `newItemName` line (hidden as "Expected" until its first receipt,
   * migration 0277). Each created id is pushed onto `createdIds` AS IT IS
   * CREATED, so a failure on a later line still tells the caller which items
   * to archive.
   */
  private async resolveLines(
    lines: CreatePoInput['lines'],
    customItemWarehouseId: string | null,
    createdIds: string[],
  ): Promise<SaveDraftLine[]> {
    const invSvc = new InventoryService(this.ctx);
    const resolved: SaveDraftLine[] = [];
    for (const l of lines) {
      if (l.newItemName) {
        // Parse through the item schema to apply all Zod defaults (retailPrice,
        // reorderPoint, reorderQuantity, unitOfMeasure, trackingType, etc.)
        // before passing to InventoryService.create(), which expects the fully
        // resolved CreateItemInput shape.
        const itemInput = createItemSchema.parse({
          name: l.newItemName,
          itemType: 'product',
          status: 'active',
          unitCost: l.unitCost,
          quantityOnHand: 0,
          warehouseId: customItemWarehouseId,
        });
        const newItem = await invSvc.create(itemInput, { awaitingFirstReceipt: true });
        createdIds.push(newItem.id as string);
        resolved.push({
          itemId: newItem.id as string,
          quantityOrdered: l.quantityOrdered,
          unitCost: l.unitCost,
        });
      } else {
        // itemId is guaranteed present by the refine (validated upstream).
        resolved.push({
          itemId: l.itemId!,
          quantityOrdered: l.quantityOrdered,
          unitCost: l.unitCost,
        });
      }
    }
    return resolved;
  }

  /**
   * Write a draft PO — header, lines and custom-item tags — in ONE
   * transaction (save_purchase_order_draft, migration 0366). `poId` null
   * creates; otherwise it replaces that draft's header and lines, refusing a
   * PO that is no longer a draft. The database computes subtotal and total.
   *
   * `p_actor` keeps the cron's created_by (a service-role call has no
   * auth.uid()); for a signed-in caller the function and the 0364 guard use
   * auth.uid(), so it cannot be spoofed.
   */
  private async saveDraft(args: {
    poId: string | null;
    poNumber: string;
    supplierId: string | null;
    destinationLocationId: string | null;
    charterId: string | null;
    expectedAt: string | null;
    notes: string | null;
    lines: SaveDraftLine[];
    customItemIds: string[];
    /** Names the report and invalidation tags. */
    op: 'po.create' | 'po.update';
  }): Promise<{ id: string; stamped: number; stampError: string | null }> {
    const { data, error } = await this.ctx.supabase.rpc('save_purchase_order_draft', {
      p_org_id: this.ctx.organizationId,
      p_po_id: args.poId,
      p_po_number: args.poNumber,
      p_supplier_id: args.supplierId,
      p_destination_location_id: args.destinationLocationId,
      p_charter_id: args.charterId,
      p_expected_at: args.expectedAt,
      p_notes: args.notes,
      p_lines: args.lines.map((l) => ({
        item_id: l.itemId,
        quantity_ordered: l.quantityOrdered,
        unit_cost: l.unitCost,
      })),
      p_custom_item_ids: args.customItemIds,
      p_actor: this.ctx.userId,
    });
    if (error) throw saveDraftRpcError(error as { message?: string; code?: string; hint?: string | null });
    const row = data as { id?: string | null; stamped?: number | null; stamp_error?: string | null } | null;
    if (!row?.id) {
      throw new ServiceError('internal_error', 'save_purchase_order_draft returned no purchase order id');
    }
    const saved = {
      id: row.id,
      stamped: Number(row.stamped ?? 0),
      stampError: row.stamp_error ?? null,
    };
    if (args.customItemIds.length > 0) {
      this.reportStampShortfall(`${args.op}.stamp_custom_items`, args.customItemIds.length, saved);
      // The tag bumps updated_at (tg_inventory_items_set_updated_at), the
      // default view's sort key. The items themselves came from
      // InventoryService.create, which already invalidated.
      invalidateInventoryListAfterWrite(this.ctx.organizationId, args.op);
    }
    return saved;
  }

  /**
   * The custom-item tag is best-effort (a shortfall only weakens cancel-time
   * cleanup), but never silent: RLS filtering some rows, or an error, is
   * reported with how many items were left untagged.
   */
  private reportStampShortfall(
    tag: string,
    expected: number,
    saved: { stamped: number; stampError: string | null },
  ): void {
    if (saved.stampError === null && saved.stamped >= expected) return;
    void reportError(
      new Error(saved.stampError ?? `tagged ${saved.stamped} of ${expected} custom items`),
      {
        tag,
        organizationId: this.ctx.organizationId,
        extra: { stamped: saved.stamped, unstamped: Math.max(0, expected - saved.stamped) },
      },
    );
  }


  /**
   * Edit a DRAFT purchase order in place. The header fields (supplier,
   * destination, expected date, notes, PO number) and the full line-item
   * list are replaced in ONE database transaction
   * (save_purchase_order_draft, migration 0366): the header and lines change
   * together or not at all. Only drafts can be edited — once ordered the PO is
   * immutable (use receive/cancel flows instead).
   *
   * Custom "newItemName" lines are created as catalog items BEFORE that
   * transaction (InventoryService owns item creation); if anything after
   * their creation fails, the items created by this call are archived again.
   *
   * Security guarantees:
   *   - assertModuleEnabled + assertPermission gate matches create()
   *   - Every query is scoped to ctx.organizationId (no cross-tenant edit)
   *   - get() refuses a non-draft BEFORE any item is created (fast pre-check)
   *   - The function locks the header row and re-reads its status: a PO that
   *     was ordered after the pre-check is refused ("no longer a draft")
   *     and nothing is written; two saves of one draft run one after the
   *     other, never interleaved
   *   - Line replacement is safe: a draft PO has no receipt_lines yet
   */
  async update(id: string, input: CreatePoInput): Promise<{ id: string; poNumber: string }> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    // Fetch the current PO (org-scoped, permission-gated).
    const { po } = await this.get(id);
    const currentStatus = (po as { status?: string }).status ?? '';
    if (currentStatus !== 'draft') {
      throw new ServiceError('forbidden', 'Only draft purchase orders can be edited.');
    }
    const currentPoNumber = (po as { po_number?: string }).po_number ?? '';
    // Captured BEFORE the write so a bill-to change is auditable as a billing
    // event (B4). Operational placement is captured alongside it purely to
    // PROVE it did not move — this edit path writes no stock movement, no
    // receipt and no item, so a bill-to-only save can never be a placement
    // change.
    const beforeCharterId = (po as { charter_id?: string | null }).charter_id ?? null;
    const beforeDestinationLocationId =
      (po as { destination_location_id?: string | null }).destination_location_id ?? null;

    // Resolve the destination warehouse id for custom-item creation (and reject
    // a warehouse-less destination — same guard as create()).
    const destinationWarehouseId = await this.resolveDestinationWarehouseId(
      input.destinationLocationId,
    );

    // Resolve the warehouse for any custom (new) items — same logic as create().
    const hasCustomLines = input.lines.some((l) => Boolean(l.newItemName));
    let customItemWarehouseId: string | null = destinationWarehouseId;
    if (hasCustomLines && !customItemWarehouseId) {
      const access = await getWarehouseAccess(this.ctx);
      customItemWarehouseId = access.primaryWarehouseId;
      if (!customItemWarehouseId) {
        throw new ServiceError(
          'validation_error',
          'Pick a destination location (or set up a warehouse) before adding a custom item.',
        );
      }
    }

    // PO number uniqueness pre-check — run BEFORE creating custom items so
    // a duplicate number never orphans catalog items.
    const suppliedPoNumber = input.poNumber?.trim();
    let poNumber: string;
    if (suppliedPoNumber && suppliedPoNumber !== currentPoNumber) {
      // Only check uniqueness when the caller is actually changing the number.
      // Cancelled POs don't reserve their number (matches the partial unique
      // index), so a number freed by a cancellation can be claimed on edit.
      const { data: existing } = await this.ctx.supabase
        .from('purchase_orders')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('po_number', suppliedPoNumber)
        .neq('id', id)
        .neq('status', 'cancelled')
        .maybeSingle();
      if (existing) {
        throw new ServiceError('conflict', 'That PO number is already in use.');
      }
      poNumber = suppliedPoNumber;
    } else {
      // Keep the current number when omitted or unchanged.
      poNumber = suppliedPoNumber ?? currentPoNumber;
    }

    await this.assertSupplierInOrg(input.supplierId);
    const billToCharterId = await this.resolveCharterId(input.charterId);

    // Create the custom items, then save header + lines in one transaction.
    // The function's row lock and status re-read are the AUTHORITATIVE draft
    // gate (the get() check above is only a fast pre-check): a concurrent
    // "mark as ordered" makes it refuse, and the items this call created are
    // archived again, so a now-ordered PO is never mutated and no hidden
    // items are left behind.
    const customItemIds: string[] = [];
    let resolvedLines: SaveDraftLine[];
    try {
      resolvedLines = await this.resolveLines(input.lines, customItemWarehouseId, customItemIds);
      await this.saveDraft({
        poId: id,
        poNumber,
        supplierId: input.supplierId ?? null,
        destinationLocationId: input.destinationLocationId ?? null,
        charterId: billToCharterId,
        expectedAt: input.expectedAt ?? null,
        notes: input.notes ?? null,
        lines: resolvedLines,
        customItemIds,
        op: 'po.update',
      });
    } catch (e) {
      await this.archiveUnusedCustomItems(customItemIds, 'po.update.rollback_custom_items');
      throw e;
    }

    void audit(
      {
        event: 'purchase_order.updated',
        entityType: 'purchase_order',
        entityId: id,
        extra: {
          po_number: poNumber,
          supplier_id: input.supplierId ?? null,
          line_count: resolvedLines.length,
          // BILLING (B4): a bill-to charter change is a first-class, auditable
          // billing event with its own before/after. It is recorded here and
          // NOT as any kind of placement change.
          bill_to_charter_id_before: beforeCharterId,
          bill_to_charter_id_after: billToCharterId,
          bill_to_changed: beforeCharterId !== billToCharterId,
          // OPERATIONAL placement, recorded so history can show it held still
          // across a billing-only edit.
          destination_location_id_before: beforeDestinationLocationId,
          destination_location_id_after: input.destinationLocationId ?? null,
          placement_changed:
            beforeDestinationLocationId !== (input.destinationLocationId ?? null),
        },
      },
      this.ctx,
    );

    void dispatchEvent(this.ctx.organizationId, 'po.updated', {
      id,
      poNumber,
      lineCount: resolvedLines.length,
    });

    // Notify org owners/admins (best-effort, except the editor themselves).
    void (async () => {
      try {
        const admin = createAdminClient();
        const { data: members } = await admin
          .from('organization_members')
          .select('user_id')
          .eq('organization_id', this.ctx.organizationId)
          .in('role', ['owner', 'admin'])
          .not('accepted_at', 'is', null)
          .is('impersonation_expires_at', null);
        // Fan out notifications concurrently — createNotification catches its
        // own errors, so a serial await-loop only adds latency (N round-trips) —
        // but at most PO_NOTIFY_CONCURRENCY at once: each one is a profile read
        // and an INSERT, and this list is every owner and admin of the org.
        const recipients = ((members ?? []) as Array<{ user_id: string }>).filter(
          (m) => m.user_id !== this.ctx.userId, // don't notify the editor
        );
        await mapWithConcurrency(recipients, PO_NOTIFY_CONCURRENCY, (m) =>
          createNotification({
            organizationId: this.ctx.organizationId,
            userId: m.user_id,
            type: 'purchase_order.updated',
            title: 'Purchase order updated',
            body: `PO ${poNumber} was edited (${resolvedLines.length} item(s)).`,
            link: `/dashboard/purchase-orders/${id}`,
          }),
        );
      } catch {
        // Best-effort: notification errors never fail the edit.
      }
    })();

    return { id, poNumber };
  }

  /**
   * Rename a PO's number, independent of status. The full draft-edit (update())
   * is gated to drafts, but the PO NUMBER is just a label — imported POs land in
   * 'expected_inbound' and users still need to relabel them (e.g. to the
   * vendor's real PO #). Allowed for any non-cancelled PO; a cancelled PO has
   * released its number, so renaming it is pointless and blocked. Uniqueness
   * mirrors create()/update(): no OTHER non-cancelled PO may hold the number.
   */
  async renamePoNumber(id: string, newPoNumber: string): Promise<{ id: string; poNumber: string }> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const trimmed = newPoNumber.trim();
    if (!trimmed) throw new ServiceError('validation_error', 'Enter a PO number.');
    if (trimmed.length > 100) throw new ServiceError('validation_error', 'PO number is too long.');

    const { po } = await this.get(id);
    const currentStatus = (po as { status?: string }).status ?? '';
    const currentNumber = (po as { po_number?: string }).po_number ?? '';
    if (currentStatus === 'cancelled') {
      throw new ServiceError('conflict', 'A cancelled purchase order cannot be renamed.');
    }
    if (trimmed === currentNumber) return { id, poNumber: trimmed }; // no-op

    // Uniqueness pre-check (exclude cancelled — they don't reserve their number).
    const { data: existing } = await this.ctx.supabase
      .from('purchase_orders')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('po_number', trimmed)
      .neq('id', id)
      .neq('status', 'cancelled')
      .maybeSingle();
    if (existing) throw new ServiceError('conflict', 'That PO number is already in use.');

    const { data: row, error } = await this.ctx.supabase
      .from('purchase_orders')
      .update({ po_number: trimmed, updated_by: this.ctx.userId, updated_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .neq('status', 'cancelled')
      .select('id')
      .maybeSingle();
    // Concurrent claim of the number → partial unique index 23505. Map to a
    // clean conflict like create()/update() rather than leaking the raw error.
    if (error?.code === '23505') {
      throw new ServiceError('conflict', 'That PO number is already in use.');
    }
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('conflict', 'Purchase order not found or was cancelled.');

    void audit(
      {
        event: 'purchase_order.updated',
        entityType: 'purchase_order',
        entityId: id,
        before: { po_number: currentNumber },
        after: { po_number: trimmed, renamed: true },
      },
      this.ctx,
    );
    return { id, poNumber: trimmed };
  }

  /**
   * Update just the free-text notes on a PO. Unlike update() (which replaces
   * lines + recomputes totals and is therefore draft-only), notes are a pure
   * annotation with no stock/money impact, so this is allowed at ANY status —
   * including received/ordered/expected_inbound POs that can't use the
   * draft-only edit form. Pass an empty string to clear the notes.
   */
  async updateNotes(id: string, notes: string): Promise<{ id: string }> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    const trimmed = (notes ?? '').trim();
    if (trimmed.length > 2000) {
      throw new ServiceError('validation_error', 'Notes are too long (2000 characters max).');
    }

    // get() enforces org scope + warehouse read access; throws not_found if the
    // caller can't see this PO. Reused so notes editing can't reach another
    // org's (or an inaccessible warehouse's) PO.
    const { po } = await this.get(id);
    const before = (po as { notes?: string | null }).notes ?? null;
    const nextNotes = trimmed.length > 0 ? trimmed : null;

    const { data: row, error } = await this.ctx.supabase
      .from('purchase_orders')
      .update({ notes: nextNotes, updated_by: this.ctx.userId, updated_at: new Date().toISOString() })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail closed: a 0-row update means the PO vanished between get() and write.
    if (!row) throw new ServiceError('not_found', 'Purchase order not found');

    void audit(
      {
        event: 'purchase_order.updated',
        entityType: 'purchase_order',
        entityId: id,
        before: { notes: before },
        after: { notes: nextNotes, notesUpdated: true },
      },
      this.ctx,
    );
    return { id };
  }

  async updateStatus(id: string, status: 'draft' | 'ordered' | 'cancelled') {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');
    const { po } = await this.get(id); // throws not_found if user can't see this PO's warehouse
    // Cancelled is terminal. A cancelled PO releases its po_number (the partial
    // unique index only covers non-cancelled rows), so its number may already
    // have been reissued to a new active PO — reopening it would collide. Block
    // the revive with a clear message instead of leaking a raw 23505; create a
    // new PO instead.
    if ((po as { status?: string }).status === 'cancelled' && status !== 'cancelled') {
      throw new ServiceError(
        'conflict',
        'This purchase order was cancelled and cannot be reopened. Create a new one instead.',
      );
    }
    // Already there (a second tab, a stale page): nothing to change. Writing
    // it again would re-stamp ordered_at, which the database refuses for a PO
    // that is not moving out of draft (migration 0360), and re-publish the
    // outbox event the dedupe key already treats as a no-op.
    if ((po as { status?: string }).status === status) return;
    if (SPEND_COMMITTING_PO_STATUSES.has(status)) {
      // Spend governance: committing the order is the gated act — drafting
      // and cancelling stay open to everyone with purchase_orders:manage.
      // Gate EVERY receivable transition, not just 'ordered': a forged action
      // payload can carry 'expected_inbound' / 'partially_received' / 'received'
      // (the TS union is compile-time only), each of which writes a receivable
      // PO — 'received' fabricates a fully-received one — and must clear the
      // same threshold. The action boundary (updatePoStatusAction) additionally
      // zod-rejects those states so the UI's real set (draft/ordered/cancelled)
      // is the only thing a client can send; this is the defense-in-depth twin.
      await this.assertApprovalThreshold(Number((po as { total?: unknown }).total ?? 0));
    }
    const { data: row, error } = await this.ctx.supabase
      .from('purchase_orders')
      .update({
        status,
        ordered_at: status === 'ordered' ? new Date().toISOString() : undefined,
        updated_by: this.ctx.userId,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    // Defense-in-depth: a residual collision (e.g. a TOCTOU revive race) hits the
    // partial unique index → 23505. Map it to a clean conflict, mirroring create().
    if ((error as { code?: string } | null)?.code === '23505') {
      throw new ServiceError('conflict', 'That PO number is already in use by another order.');
    }
    if (error) throw new ServiceError('internal_error', error.message);
    // Fail closed: a 0-row update means the PO vanished/changed under us — never
    // audit a no-op or fire the QBO outbox for a status change that didn't land.
    if (!row) throw new ServiceError('conflict', 'Purchase order not found or already changed.');
    void audit(
      {
        event: 'purchase_order.status_changed',
        entityType: 'purchase_order',
        entityId: id,
        extra: { new_status: status },
      },
      this.ctx,
    );
    if (status === 'ordered') {
      // Publish to the connector outbox → the QuickBooks connector pushes a QBO
      // PurchaseOrder (drained by the every-5-min cron; dedupe key makes a
      // draft↔ordered toggle idempotent). Best-effort: never fails the status
      // change. Only fires when the org has an active QBO connection + the
      // api/integrations module enabled (the drainer gates on that).
      // Await so the request actually fires — a bare `void`ed PostgREST builder
      // is a lazy thenable that never sends, so the QBO/Intacct outbox event
      // was silently never published. Swallow failures to keep it best-effort.
      try {
        await this.ctx.supabase.rpc('publish_outbox', {
          p_org_id: this.ctx.organizationId,
          p_topic: 'purchase_order.ordered',
          p_aggregate_type: 'purchase_order',
          p_aggregate_id: id,
          p_payload: { poId: id },
          p_dedupe_key: `purchase_order.ordered:${id}`,
        });
      } catch {
        /* best-effort: never fail the status change on an outbox hiccup */
      }
    }
    if (status === 'cancelled') {
      const poNumber = (po as { po_number?: string | null }).po_number ?? null;
      void dispatchEvent(this.ctx.organizationId, 'po.cancelled', {
        id,
        poNumber,
        cancelledBy: this.ctx.userId,
      });
      // Clean up the catalog items this PO auto-created but that never went
      // anywhere — a cancelled PO shouldn't leave phantom items on the Items
      // page. Awaited (it does DB writes + audits) but self-contained so it
      // can't fail the cancel.
      await this.archiveOrphanedCustomItems(id);
    }
  }

  /**
   * When a PO is cancelled, archive the catalog items it auto-created (custom
   * "newItemName" lines) that were never actually used. "Never used" means:
   * status 'active', zero on-hand, AND the item has no received history on ANY
   * PO line AND is not referenced by any non-cancelled PO. We deliberately do
   * NOT treat quantity_on_hand=0 alone as "unused" — an item that was received
   * then sold/consumed is also zero, and archiving it would hide real receipt /
   * stock-movement / cost history. Reversible (archive, not delete) and
   * race-guarded; if a kept item is later received on another PO the receiving
   * flow auto-unarchives it. Best-effort — never throws.
   */
  private async archiveOrphanedCustomItems(poId: string): Promise<void> {
    try {
      const { data: candidates, error: candErr } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, name')
        .eq('organization_id', this.ctx.organizationId)
        .eq('created_from_purchase_order_id', poId)
        .eq('status', 'active')
        .eq('quantity_on_hand', 0)
        .is('deleted_at', null);
      if (candErr) {
        void reportError(new Error(candErr.message), {
          tag: 'po.cancel.archive_custom_items.candidates',
          organizationId: this.ctx.organizationId,
        });
        return;
      }
      const cand = (candidates ?? []) as Array<{ id: string; name: string }>;
      await this.archiveUnusedCandidates(cand, {
        tag: 'po.cancel.archive_custom_items',
        reason: 'po_cancelled',
        purchaseOrderId: poId,
      });
    } catch (e) {
      void reportError(e, {
        tag: 'po.cancel.archive_custom_items.unhandled',
        organizationId: this.ctx.organizationId,
      });
    }
  }

  /**
   * Compensation for a failed create()/update(): archive the custom items
   * THIS call created, by id, under the same "never used" rule as the
   * cancel-time cleanup (an item that ever received stock, or that is on a
   * non-cancelled PO — e.g. the save actually committed and only its response
   * was lost — is kept). The failed save wrote nothing, so without this the
   * items would stay hidden as "Expected" forever, on no PO. Best-effort —
   * never throws, so it cannot mask the error that triggered it.
   */
  private async archiveUnusedCustomItems(itemIds: string[], tag: string): Promise<void> {
    if (itemIds.length === 0) return;
    try {
      const ctx = this.ctx;
      let cand: Array<{ id: string; name: string }>;
      try {
        cand = await fetchAllRowsByIds<{ id: string; name: string }>(
          itemIds,
          (batch) => (from, to) =>
            ctx.supabase
              .from('inventory_items')
              .select('id, name')
              .eq('organization_id', ctx.organizationId)
              .in('id', batch)
              .eq('status', 'active')
              .eq('quantity_on_hand', 0)
              .is('deleted_at', null)
              .order('id')
              .range(from, to),
        );
      } catch (readErr) {
        void reportError(new Error(rawErrorText(readErr)), {
          tag: `${tag}.candidates`,
          organizationId: this.ctx.organizationId,
          extra: { items: itemIds.length },
        });
        return;
      }
      await this.archiveUnusedCandidates(cand, {
        tag,
        reason: 'po_save_failed',
        purchaseOrderId: null,
      });
    } catch (e) {
      void reportError(e, { tag: `${tag}.unhandled`, organizationId: this.ctx.organizationId });
    }
  }

  /**
   * The shared "never used" rule: of `cand` (active, zero on-hand, not
   * deleted), archive the items with no received history on any PO line and
   * on no non-cancelled PO, then audit each. A failed keep-check archives
   * nothing. Throws only on a bug; callers catch.
   */
  private async archiveUnusedCandidates(
    cand: Array<{ id: string; name: string }>,
    opts: { tag: string; reason: 'po_cancelled' | 'po_save_failed'; purchaseOrderId: string | null },
  ): Promise<void> {
    if (cand.length === 0) return;
    const candIds = cand.map((c) => c.id);

    // One pass over every PO line referencing these items. Keep (do NOT
    // archive) an item if EITHER it ever received stock (quantity_received>0
    // on any line — qoh=0 then just means it was consumed) OR it's still on a
    // non-cancelled PO (a cancelled PO is excluded — and such an item may yet
    // receive stock + auto-unarchive there).
    //
    // Batched AND paged: an unpaged read was cut at 1000 lines with no
    // error, and a dropped line that would have said "keep" archived an item
    // a live PO still needs. One `.in()` past ~215 ids failed outright.
    const ctx = this.ctx;
    let poLines: Array<Record<string, unknown>>;
    try {
      poLines = await fetchAllRowsByIds<Record<string, unknown>>(
        candIds,
        (batch) => (from, to) =>
          ctx.supabase
            .from('purchase_order_items')
            .select('item_id, quantity_received, po:purchase_orders!inner(status)')
            .eq('organization_id', ctx.organizationId) // defense-in-depth: keep the keep-check single-org
            .in('item_id', batch)
            .order('id')
            .range(from, to),
      );
    } catch (keepErr) {
      // An unreadable keep-check archives NOTHING. Its error used to be
      // discarded, so a failed read (statement timeout, pooler hiccup) looked
      // like "never received, on no live PO" and archived items with real
      // receipt history, or ones another open PO still expects, off the Items
      // list. Leaving an unused item active costs nothing.
      void reportError(new Error(rawErrorText(keepErr)), {
        tag: `${opts.tag}.keep_check`,
        organizationId: this.ctx.organizationId,
      });
      return;
    }
    const keep = new Set<string>();
    for (const row of poLines) {
      const itemId = row.item_id as string;
      if (Number(row.quantity_received) > 0) keep.add(itemId);
      const poField = row.po as { status?: string } | { status?: string }[] | null;
      const poStatus = Array.isArray(poField) ? poField[0]?.status : poField?.status;
      if (poStatus && poStatus !== 'cancelled') keep.add(itemId);
    }

    const toArchive = cand.filter((c) => !keep.has(c.id));
    if (toArchive.length === 0) return;

    // Batched, one batch at a time. A failure stops the rest; whatever
    // committed is still invalidated and audited before it is reported.
    const flip = await writeInIdBatches<string, { id: string; name: string }>(
      toArchive.map((c) => c.id),
      (batch) =>
        ctx.supabase
          .from('inventory_items')
          .update({ status: 'archived' })
          .eq('organization_id', ctx.organizationId)
          .in('id', batch)
          .eq('status', 'active') // race guard
          .select('id, name'),
    );
    if (flip.error !== null) {
      void reportError(new Error(flip.error), {
        tag: opts.tag,
        organizationId: this.ctx.organizationId,
        extra: { archived: flip.rows.length, notArchived: flip.notWritten.length },
      });
    }
    if (flip.rows.length === 0) return;
    // Archived rows leave the default view.
    invalidateInventoryListAfterWrite(this.ctx.organizationId, opts.tag);

    // Batched INSERTs (auditMany): a Promise.all of one audit() per item
    // started every INSERT at once, however many items the PO carried.
    await auditMany(
      flip.rows.map((item) => ({
        event: 'inventory.item.archived' as const,
        entityType: 'inventory_item',
        entityId: item.id,
        after: { status: 'archived' },
        before: { status: 'active' },
        extra: {
          reason: opts.reason,
          purchaseOrderId: opts.purchaseOrderId,
          itemName: item.name,
        },
      })),
      this.ctx,
    );
  }

  /**
   * Spend-governance gate for a status transition. Delegates to the shared
   * `assertPoApprovalThreshold` (module scope) so the PO-import approval path
   * enforces the identical threshold — see that function for the full rationale
   * and the fail-closed posture.
   */
  private async assertApprovalThreshold(total: number): Promise<void> {
    await assertPoApprovalThreshold(this.ctx, total);
  }

  /**
   * Supplier id -> name, for draft names and failure messages. Cosmetic: a
   * failed read leaves names blank (the callers fall back) and is reported.
   * Batched: the suppliers on a large selection have no cap.
   */
  private async supplierNames(supplierIds: string[], tag: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (supplierIds.length === 0) return out;
    const ctx = this.ctx;
    try {
      const rows = await fetchAllRowsByIds<{ id: string; name: string }>(
        supplierIds,
        (batch) => (from, to) =>
          ctx.supabase
            .from('suppliers')
            .select('id, name')
            .eq('organization_id', ctx.organizationId)
            .in('id', batch)
            .order('id')
            .range(from, to),
      );
      for (const r of rows) out.set(r.id, r.name);
    } catch (err) {
      reportDegradedRead(tag, err, { suppliers: supplierIds.length });
    }
    return out;
  }

  /**
   * Ids of the items already on an open PO (OPEN_PO_STATUSES: draft,
   * expected_inbound, ordered, partially_received) in this org — the set the
   * reorder paths must not draft again. Shared by runAutoReorder (cron) and
   * createDraftsFromReorderForecast (the manual button and the AI tool), so
   * the two can never disagree about what "already on order" means.
   *
   * FAIL CLOSED: a read error THROWS (fetchAllRows). An unreadable set must
   * never look like "nothing is on order", which would draft every below-par
   * item again. Paged past PostgREST's 1000-row cap with a stable order.
   *
   * Reads through the caller's client: a signed-in user sees the POs RLS lets
   * them see (managers: all of the org's); the cron's service client sees all.
   */
  private async openPoItemIds(): Promise<Set<string>> {
    const openItems = await fetchAllRows<{ item_id: string }>((from, to) =>
      this.ctx.supabase
        .from('purchase_order_items')
        .select('item_id, id, purchase_orders!inner(status)')
        .eq('organization_id', this.ctx.organizationId)
        .in('purchase_orders.status', OPEN_PO_STATUSES)
        .order('id', { ascending: true })
        .range(from, to),
    );
    return new Set(openItems.map((r) => r.item_id));
  }

  /**
   * The open-PO item set for a page that previews what the reorder button
   * will do (Planning). Gated like a PO read. Throws on a read error; the
   * caller decides how to say it could not check.
   */
  async listOpenPoItemIds(): Promise<Set<string>> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:read');
    return this.openPoItemIds();
  }

  /**
   * Bulk-creates draft POs from a list of inventory item IDs. Items are
   * fetched, grouped by supplier_id, and one draft PO is created per
   * supplier with line quantities pre-filled from each item's
   * reorder_quantity (fallback: max(1, reorder_point - quantity_on_hand)).
   *
   * Items without a supplier_id are skipped. Per-supplier failures are
   * collected so callers can report partial success — we do NOT roll
   * back already-created drafts.
   *
   * Unlike the reorder paths, an explicit selection is NOT filtered by what
   * is already on order: the user chose these items. `alreadyOnOpenPo`
   * reports how many of the drafted items were already on another open PO,
   * so the caller can warn. It is null when that could not be checked (the
   * read failed): unknown, never a silent 0. The warning is advisory, so a
   * failed check does not block the drafts.
   *
   * Powers both the BulkActions toolbar button (via
   * createDraftPosFromItemsAction) and the Gemini draftPos tool.
   *
   * Spec: docs/superpowers/specs/2026-05-08-draft-pos-from-low-stock-design.md
   */
  async createDraftsFromItems(itemIds: string[]): Promise<{
    createdPoIds: string[];
    skipped: number;
    /** Drafted items that were already on another open PO; null = unknown. */
    alreadyOnOpenPo: number | null;
    supplierFailures: Array<{ supplierId: string; supplierName: string; error: string }>;
    supplierCount: number;
  }> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    type Row = {
      id: string;
      supplier_id: string | null;
      reorder_quantity: number | null;
      reorder_point: number | null;
      quantity_on_hand: number | null;
      unit_cost: number | null;
    };
    // Batched: the selection has no cap here, and one `.in()` past ~215 ids
    // fails. A failed batch throws rather than drafting from a partial set.
    const ctx = this.ctx;
    const items = await fetchAllRowsByIds<Row>(
      itemIds,
      (batch) => (from, to) =>
        ctx.supabase
          .from('inventory_items')
          .select('id, supplier_id, reorder_quantity, reorder_point, quantity_on_hand, unit_cost')
          .eq('organization_id', ctx.organizationId)
          .in('id', batch)
          .order('id')
          .range(from, to),
    );
    const noSupplier = items.filter((r) => !r.supplier_id);
    const withSupplier = items.filter((r) => !!r.supplier_id);
    const skipped = noSupplier.length + (itemIds.length - items.length);

    if (withSupplier.length === 0) {
      throw new ServiceError(
        'validation_error',
        'No items had a supplier set. Assign suppliers and try again.',
      );
    }

    const bySupplier = new Map<string, Row[]>();
    for (const r of withSupplier) {
      const key = r.supplier_id as string;
      const list = bySupplier.get(key) ?? [];
      list.push(r);
      bySupplier.set(key, list);
    }

    const supplierIds = [...bySupplier.keys()];
    const supplierName = await this.supplierNames(
      supplierIds,
      'po.drafts_from_items.supplier_names',
    );

    // Read BEFORE the drafts below exist, or they would count themselves.
    let openItemIds: Set<string> | null;
    try {
      openItemIds = await this.openPoItemIds();
    } catch (err) {
      reportDegradedRead('po.drafts_from_items.open_po_items', err, { items: withSupplier.length });
      openItemIds = null;
    }
    let alreadyOnOpenPo = 0;

    const createdPoIds: string[] = [];
    const supplierFailures: Array<{
      supplierId: string;
      supplierName: string;
      error: string;
    }> = [];

    for (const [supplierId, group] of bySupplier) {
      const lines = group.map((r) => {
        const reorderQty = Number(r.reorder_quantity ?? 0);
        const reorderPoint = Number(r.reorder_point ?? 0);
        const onHand = Number(r.quantity_on_hand ?? 0);
        const qty =
          reorderQty > 0 ? reorderQty : Math.max(1, reorderPoint - onHand);
        return {
          itemId: r.id,
          quantityOrdered: qty,
          unitCost: Number(r.unit_cost ?? 0),
        };
      });
      try {
        const po = await this.create({ supplierId, lines });
        createdPoIds.push(po.id);
        if (openItemIds) {
          for (const r of group) if (openItemIds.has(r.id)) alreadyOnOpenPo++;
        }
      } catch (e) {
        const msg =
          e instanceof ServiceError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Unknown error';
        supplierFailures.push({
          supplierId,
          supplierName: supplierName.get(supplierId) ?? 'Unknown supplier',
          error: msg,
        });
      }
    }

    return {
      createdPoIds,
      skipped,
      alreadyOnOpenPo: openItemIds ? alreadyOnOpenPo : null,
      supplierFailures,
      supplierCount: bySupplier.size,
    };
  }

  /**
   * Recomputes the reorder forecast (items at or below their reorder point)
   * and turns the suggestions into editable DRAFT purchase orders — the
   * "last mile" of reorder automation.
   *
   * Items are grouped by their supplier_id and one draft PO is created per
   * supplier. Line quantities are pre-filled with the deficit needed to
   * bring each item back up to its target level — `max(reorder_quantity,
   * reorder_point) - quantity_on_hand` (floored at 1 unit for a flagged
   * item). This mirrors the deficit shown on the reorder-forecast report.
   *
   * Items with no supplier_id are NOT dropped: they are collected into a
   * single "unassigned" draft PO (supplier_id null) so the buyer can assign
   * a supplier during review. `unassignedCount` reports how many landed
   * there.
   *
   * Items already on an OPEN PO (draft, expected_inbound, ordered,
   * partially_received) are SKIPPED, exactly as the daily auto-reorder does,
   * so clicking twice never drafts the same item twice and nothing already
   * on order is ordered again. `skippedOnOpenPo` counts them. The open-PO
   * read fails CLOSED: if it errors, this throws before any draft exists.
   *
   * Drafts are editable and NOT auto-sent — the caller routes the user to
   * the created drafts for review before sending. Per-supplier failures are
   * collected so callers can report partial success; we do NOT roll back
   * already-created drafts.
   *
   * Org-scoped + gated identically to other PO creation (assertModuleEnabled
   * + assertPermission run inside the shared create()).
   */
  async createDraftsFromReorderForecast(): Promise<{
    createdPoIds: string[];
    /** How many items landed on the unassigned (no-supplier) draft PO. */
    unassignedCount: number;
    /** Items that were below par but couldn't be processed at all. */
    skipped: number;
    /** Below-par items NOT drafted because they are already on an open PO. */
    skippedOnOpenPo: number;
    supplierFailures: Array<{ supplierId: string | null; supplierName: string; error: string }>;
    /** Distinct real suppliers (excludes the unassigned bucket). */
    supplierCount: number;
  }> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    type Row = {
      id: string;
      supplier_id: string | null;
      reorder_point: number | null;
      reorder_quantity: number | null;
      quantity_on_hand: number | null;
      unit_cost: number | null;
    };

    // Recompute the below-par set with the same filters the reorder-forecast
    // report uses: active, non-deleted, non-rental, reorder_point > 0.
    // PostgREST clamps any single response to `[api] max_rows = 1000`, so the
    // former `.limit(5_000)` SILENTLY returned at most 1000 candidates — every
    // below-par item past the first 1000 got NO draft PO. Paginate in 1000-row
    // `.range()` windows with a stable `.order('id')` and accumulate the full
    // candidate set (same cap class as forecasting.ts / order-requests.ts).
    const rows = await fetchAllRows<Row>((from, to) =>
      this.ctx.supabase
        .from('inventory_items')
        .select(
          'id, supplier_id, reorder_point, reorder_quantity, quantity_on_hand, unit_cost',
        )
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null)
        .eq('status', 'active')
        .eq('is_rental', false)
        .gt('reorder_point', 0)
        .order('id', { ascending: true })
        .range(from, to),
    );

    // Items already on an open PO are not drafted again (the same set and
    // rule as the daily auto-reorder). Throws on a read error: fail closed.
    const openItemIds = await this.openPoItemIds();

    // Build a prefilled line for each item that is at or below its reorder
    // point. Quantity = deficit to bring it back to target.
    type PreparedLine = { itemId: string; quantityOrdered: number; unitCost: number };
    const bySupplier = new Map<string, PreparedLine[]>();
    const unassigned: PreparedLine[] = [];
    let skippedOnOpenPo = 0;

    for (const raw of rows) {
      const qty = Number(raw.quantity_on_hand ?? 0);
      const reorderPoint = Number(raw.reorder_point ?? 0);
      if (qty > reorderPoint) continue; // healthy — skip
      if (openItemIds.has(raw.id)) {
        skippedOnOpenPo++; // already on order — never draft it twice
        continue;
      }
      const reorderQty = Number(raw.reorder_quantity ?? 0);
      const targetQty = Math.max(reorderQty, reorderPoint);
      // Floor at 1 so a flagged item always produces a positive line even
      // when it sits exactly at its reorder point with no reorder qty set.
      const quantityOrdered = Math.max(1, targetQty - qty);
      const line: PreparedLine = {
        itemId: raw.id,
        quantityOrdered,
        unitCost: Number(raw.unit_cost ?? 0),
      };
      if (raw.supplier_id) {
        const list = bySupplier.get(raw.supplier_id) ?? [];
        list.push(line);
        bySupplier.set(raw.supplier_id, list);
      } else {
        unassigned.push(line);
      }
    }

    // Resolve supplier names for failure messages.
    const supplierIds = [...bySupplier.keys()];
    const supplierName = await this.supplierNames(
      supplierIds,
      'po.drafts_from_lines.supplier_names',
    );

    const createdPoIds: string[] = [];
    const supplierFailures: Array<{
      supplierId: string | null;
      supplierName: string;
      error: string;
    }> = [];
    let skipped = 0;

    // One draft per supplier.
    for (const [supplierId, lines] of bySupplier) {
      try {
        const po = await this.create({ supplierId, lines });
        createdPoIds.push(po.id);
      } catch (e) {
        skipped += lines.length;
        supplierFailures.push({
          supplierId,
          supplierName: supplierName.get(supplierId) ?? 'Unknown supplier',
          error: errMessage(e),
        });
      }
    }

    // One draft for the unassigned bucket (supplier_id null) so no
    // suggestion is silently dropped.
    if (unassigned.length > 0) {
      try {
        const po = await this.create({ supplierId: null, lines: unassigned });
        createdPoIds.push(po.id);
      } catch (e) {
        skipped += unassigned.length;
        supplierFailures.push({
          supplierId: null,
          supplierName: 'Unassigned (no supplier)',
          error: errMessage(e),
        });
      }
    }

    return {
      createdPoIds,
      unassignedCount: unassigned.length,
      skipped,
      skippedOnOpenPo,
      supplierFailures,
      supplierCount: bySupplier.size,
    };
  }

  /**
   * AUTOMATIC reordering (daily cron). Like createDraftsFromReorderForecast, but:
   *   - DEDUPS against open POs (any below-par item already on a draft/ordered
   *     PO is skipped) so a daily run never double-orders — the core guarantee;
   *   - skips no-supplier items entirely (can't auto-send to nobody);
   *   - in `send` mode, transitions each draft to `ordered` ONLY when its total
   *     is under the auto-send cap AND under the org's PO approval threshold —
   *     otherwise it's left as a draft for a human (we enforce the threshold
   *     EXPLICITLY here because owners bypass assertApprovalThreshold, and the
   *     cron runs as an owner-equivalent system context).
   *
   * Designed to run in EITHER a user context (manual "run now") or the cron's
   * per-org system context. Returns a summary for notifications.
   */
  async runAutoReorder(settings: AutoReorderSettings): Promise<{
    created: number;
    sent: number;
    heldForReview: number;
    skippedDuplicate: number;
    skippedNoSupplier: number;
    supplierFailures: number;
  }> {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');

    type Row = {
      id: string;
      supplier_id: string | null;
      reorder_point: number | null;
      reorder_quantity: number | null;
      quantity_on_hand: number | null;
      unit_cost: number | null;
    };

    // 1. Below-par candidates — same canonical filter as the reorder forecast.
    const rows = await fetchAllRows<Row>((from, to) =>
      this.ctx.supabase
        .from('inventory_items')
        .select('id, supplier_id, reorder_point, reorder_quantity, quantity_on_hand, unit_cost')
        .eq('organization_id', this.ctx.organizationId)
        .is('deleted_at', null)
        .eq('status', 'active')
        .eq('is_rental', false)
        .gt('reorder_point', 0)
        .order('id', { ascending: true })
        .range(from, to),
    );

    const candidates: AutoReorderCandidate[] = [];
    for (const raw of rows) {
      const qty = Number(raw.quantity_on_hand ?? 0);
      const reorderPoint = Number(raw.reorder_point ?? 0);
      if (qty > reorderPoint) continue; // healthy
      const reorderQty = Number(raw.reorder_quantity ?? 0);
      const quantityOrdered = Math.max(1, Math.max(reorderQty, reorderPoint) - qty);
      candidates.push({
        itemId: raw.id,
        supplierId: raw.supplier_id,
        quantityOrdered,
        unitCost: Number(raw.unit_cost ?? 0),
      });
    }

    // 2. Open-PO item set — FAIL CLOSED (openPoItemIds throws): if we can't
    //    read it, abort rather than risk double-ordering.
    const openItemIds = await this.openPoItemIds();

    // 3. Plan (pure): dedup + group by supplier.
    const plan = planAutoReorder(candidates, openItemIds);

    // 4. Approval threshold (dollars) — read once for send-mode decisions.
    //    FAIL CLOSED: if the settings read errors we cannot verify the spend
    //    ceiling, so we BLOCK all auto-sends for this run (drafts still created).
    //    A vanished approval gate must never become "no gate" (owners bypass
    //    assertApprovalThreshold, so this read is the ONLY send-side gate).
    let threshold: number | null = null;
    let capDollars: number | null = null;
    let sendBlocked = false;
    if (settings.mode === 'send') {
      const { data: modRow, error: modErr } = await this.ctx.supabase
        .from('organization_modules')
        .select('settings')
        .eq('organization_id', this.ctx.organizationId)
        .eq('module_id', 'purchase_orders')
        .maybeSingle();
      if (modErr) {
        sendBlocked = true;
      } else {
        const modSettings = ((modRow as { settings?: unknown } | null)?.settings ?? {}) as Record<
          string,
          unknown
        >;
        const rawThreshold = Number(modSettings.approvalThresholdAmount);
        threshold = Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : null;
        capDollars = settings.maxAutoSendCents != null ? settings.maxAutoSendCents / 100 : null;
      }
    }

    let created = 0;
    let sent = 0;
    let heldForReview = 0;
    let supplierFailures = 0;

    for (const group of plan.bySupplier) {
      try {
        const po = await this.create({ supplierId: group.supplierId, lines: group.lines });
        created++;
        if (settings.mode === 'send') {
          // shouldAutoSend never sends unbounded: it requires a ceiling (cap or
          // threshold) and the total under it. sendBlocked (a failed settings
          // read) forces a hold.
          if (!sendBlocked && shouldAutoSend(group.total, capDollars, threshold)) {
            await this.updateStatus(po.id, 'ordered');
            sent++;
          } else {
            heldForReview++; // left as a draft for a human
          }
        }
      } catch {
        supplierFailures++;
      }
    }

    return {
      created,
      sent,
      heldForReview,
      skippedDuplicate: plan.skippedDuplicate,
      skippedNoSupplier: plan.skippedNoSupplier,
      supplierFailures,
    };
  }
}

function errMessage(e: unknown): string {
  if (e instanceof ServiceError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Unknown error';
}
