import 'server-only';

import { can, formatOrderNumber, isManagerOrAbove } from '@stockpilot/core';

import { assertWarehouseAccess } from '@/lib/auth/warehouse';
import { broadcastOrderChanged } from '@/lib/realtime/broadcast';
import { createAdminClient } from '@/lib/supabase/admin';
import { reportError as reportSrvError } from '@/lib/error-reporter';
import { maybeSendReturnPrompt } from '@/server/email/return-prompt';
import {
  notifyRequesterBackordered,
  notifyRequesterBackorderShipped,
} from '@/server/lib/order-handover-notify';

import { audit } from './audit';
import { createNotification } from './notifications';
import { dispatchEvent } from './integration-events';
import {
  assertModuleEnabled,
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

import { sendOrderRequestEmail } from '@/lib/email/order-requests';

export type OrderRequestStatus =
  | 'pending_confirmation'
  | 'pending_approval'
  | 'approved'
  | 'pick_slip_generated'
  | 'picking_in_progress'
  | 'picking_complete'
  | 'packing_slip_generated'
  | 'staged_for_pickup'
  | 'staged_for_delivery'
  | 'in_transit'
  | 'backordered'
  | 'completed'
  | 'denied'
  | 'cancelled';

export type OrderRequestSource = 'internal' | 'public_link' | 'portal';

export interface OrderRequestRow {
  id: string;
  /** Per-org sequential order number (mig 0254). */
  order_number: number | null;
  /** Structured needed-by datetime (mig 0255) — drives the auto schedule event. */
  needed_by: string | null;
  organization_id: string;
  warehouse_id: string;
  status: OrderRequestStatus;
  requester_user_id: string | null;
  requester_email: string | null;
  requester_name: string | null;
  requester_org_label: string | null;
  approved_by: string | null;
  approved_at: string | null;
  denied_reason: string | null;
  packaging_at: string | null;
  ready_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  notes: string | null;
  internal_notes: string | null;
  source: OrderRequestSource;
  created_at: string;
  updated_at: string;
  // Migration 0109 columns. Most are forward-looking — phases 3-5 will
  // populate them as the order moves through pick / pack / stage /
  // deliver / sign workflows. Listing them on the type now means
  // downstream code (email branching, detail pages, audit consumers)
  // can read them without further refactors.
  fulfillment_type: 'pickup' | 'delivery';
  delivery_charter_id: string | null;
  pickup_location_notes: string | null;
  requester_phone: string | null;
  assigned_picker_id: string | null;
  pick_slip_generated_at: string | null;
  pick_slip_generated_by: string | null;
  picking_completed_at: string | null;
  picking_completed_by: string | null;
  packing_slip_generated_at: string | null;
  packing_slip_generated_by: string | null;
  staged_at: string | null;
  staged_by: string | null;
  assigned_delivery_user_id: string | null;
  assigned_delivery_by: string | null;
  assigned_delivery_at: string | null;
  in_transit_at: string | null;
  in_transit_by: string | null;
  signature_token: string | null;
  signature_token_expires_at: string | null;
  signed_by_name: string | null;
  signed_by_email: string | null;
  signature_data_url: string | null;
  signed_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  /** Per-order requester-return-portal token (mig 0156). NULL until minted
   *  on completion (returns module on). Drives /returns/request/[token]. */
  return_token: string | null;
  /** One-time return-prompt email marker (mig 0278). NULL = never sent. */
  return_prompt_sent_at: string | null;
}

export interface OrderRequestLineRow {
  id: string;
  order_request_id: string;
  item_id: string;
  quantity_requested: number;
  quantity_fulfilled: number;
  /** Migration 0109: per-line picked qty, populated by partial_pick_line
   * RPC during the digital pick flow. Null = not yet touched. */
  quantity_picked: number | null;
  unit_cost_at_request: number;
  notes: string | null;
}

export interface OrderRequestLineWithItem extends OrderRequestLineRow {
  item: {
    id: string;
    name: string;
    sku: string;
    quantity_on_hand: number;
    barcode: string | null;
    /** Manufacturer's per-SKU code (e.g. "MX432LL/A"). Surfaces in
     *  the pick-slip "Item" cell so the picker can verify they're
     *  pulling the right product variant. */
    model_number: string | null;
    /** "product" | "book" | "asset" | "consumable" — drives the
     *  pick-slip PDF's rack vs rack+crate column rendering. */
    item_type: string | null;
    /** Holds rack_number / rack_row for items and the parallel
     *  book_rack_* / book_crate_* keys for books. Pick-slip and
     *  packing-slip renderers read this. */
    custom_fields: Record<string, unknown> | null;
    /** Phase 5 (lot_serial): "none" | "lot" | "serial" — drives the
     *  advisory FEFO picking hint on the pick surface. */
    tracking_type: string | null;
    /** Item-ownership charter (inventory_items.charter_id) — the site this
     *  stock is earmarked for. null = generic/shared stock. Distinct from the
     *  order's delivery_charter_id (destination). Surfaced per-line so a
     *  viewer/picker knows which site each item belongs to. */
    charter_id: string | null;
    charter_name: string | null;
    charter_code: string | null;
  } | null;
}

export interface ActiveReservation {
  id: string;
  item_id: string;
  warehouse_id: string;
  quantity: number;
  created_at: string;
}

export interface OrderRequestSummary {
  id: string;
  /** Per-org sequential order number (mig 0254) — the human handle ("#12"). */
  orderNumber: number;
  status: OrderRequestStatus;
  warehouseId: string;
  warehouseName: string | null;
  requesterUserId: string | null;
  requesterEmail: string | null;
  requesterName: string | null;
  requesterOrgLabel: string | null;
  source: OrderRequestSource;
  lineCount: number;
  totalQuantity: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
  deliveredAt: string | null;
  // Phase-2 list-page surface: passed through from list() so future
  // list-page enhancements (driver column, fulfillment-type filter)
  // don't require another schema sweep.
  fulfillmentType: 'pickup' | 'delivery';
  assignedPickerId: string | null;
  assignedPickerName: string | null;
  assignedDeliveryUserId: string | null;
  assignedDeliveryUserName: string | null;
}

/** One flattened order-history row for CSV export (see exportRows). */
export interface OrderExportRow {
  id: string;
  status: OrderRequestStatus;
  requesterName: string | null;
  requesterEmail: string | null;
  requesterOrgLabel: string | null;
  warehouseName: string | null;
  /** Delivery charter "Name (CODE)" when set; null for pickup orders. */
  charterLabel: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  source: OrderRequestSource;
  lineCount: number;
  totalQuantity: number;
  /** Sum of quantity_requested × unit_cost_at_request across the lines. */
  totalCost: number;
  notes: string | null;
  createdAt: string;
  approvedAt: string | null;
  /** completed_at, falling back to delivered_at for older rows. */
  completedAt: string | null;
}

export interface OrderRequestDetail {
  request: OrderRequestRow;
  lines: OrderRequestLineWithItem[];
  reservations: ActiveReservation[];
  warehouseName: string | null;
  requesterDisplay: string;
  /**
   * Resolved requester name — the free-text `requester_name` (set for
   * on-behalf-of + public-link orders) when present, else the joined
   * user_profiles.full_name for the `requester_user_id` (internal
   * self-submit orders, where `requester_name` is NULL). Null only when
   * neither source has a value. Unlike `requesterDisplay` this carries
   * NO " · org_label" suffix, so it's safe to render in a name cell.
   * Mirrors the same fallback the list() path uses.
   */
  requesterName: string | null;
  /** Resolved requester email — `requester_email` else the joined
   *  user_profiles.email. Same fallback shape as `requesterName`. */
  requesterEmail: string | null;
  /**
   * Display name of the picker who CLAIMED this order (`assigned_picker_id`),
   * resolved from user_profiles (full_name, else email). NULL when nobody has
   * claimed picking yet.
   *
   * Drives the pre-printed PICKER NAME on the printable pick slip + print view
   * so a picker only signs and dates by hand. Deliberately null-when-unclaimed
   * (owner decision 2026-07-22): these are SIGNED sheets, so printing a guessed
   * name (e.g. whoever hit print, who may be a manager printing for the crew)
   * is worse than leaving the line blank to fill in.
   */
  assignedPickerName: string | null;
  /**
   * True when a pick slip was generated and a line has been added SINCE —
   * i.e. the printed sheet no longer matches the order and needs a reprint.
   * Derived (line.created_at > pick_slip_generated_at) rather than stored, so
   * it can never drift out of sync with reality.
   */
  pickSlipStale: boolean;
}

export interface CreateOrderRequestInput {
  warehouseId: string;
  notes?: string | null;
  /** Structured "needed by" datetime (ISO) — drives the auto-created
   *  schedule event at approval. Replaces burying dates in notes. */
  neededBy?: string | null;
  fulfillmentType: 'pickup' | 'delivery';
  requesterPhone?: string | null;
  deliveryCharterId?: string | null;
  pickupLocationNotes?: string | null;
  /**
   * Manager-only: when set, the row is recorded as if a public-style
   * external requester filed it — `requester_user_id` stays null and
   * the name/email columns carry the on-behalf identity. The email
   * pipeline keys off `requester_user_id IS NULL`, so this path
   * automatically gets the external-recipient track-link emails.
   *
   * `source` stays `'internal'` either way; this is still a manager-
   * initiated order, just routed to a different recipient.
   */
  onBehalfOf?: {
    name: string;
    email: string;
  } | null;
  lines: Array<{
    itemId: string;
    quantity: number;
    notes?: string | null;
  }>;
}

/**
 * Orders → Schedule cleanup: when a linked order reaches a terminal state,
 * close its auto-created calendar event so the Schedule tidies itself
 * (owner ask 2026-07-10: "no Start button babysitting"). completed-order →
 * event completed; cancelled/denied order → event cancelled. Only touches
 * events still open (scheduled/in_progress); manual terminal states win.
 * Admin client + fire-and-forget: never blocks or fails the order flow.
 */
export async function syncOrderScheduleEvent(
  orderId: string,
  outcome: 'completed' | 'cancelled',
  organizationId?: string,
): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin
      .from('schedule_events')
      .update({ status: outcome })
      .eq('order_request_id', orderId)
      .in('status', ['scheduled', 'in_progress']);
  } catch (e) {
    void reportSrvError(e, {
      tag: 'orders.auto-schedule.sync',
      organizationId: organizationId ?? null,
      extra: { orderId, outcome },
    });
  }
}

export class OrderRequestsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new OrderRequestsService(await withContext());
  }

  // ── Read ────────────────────────────────────────────────────────

  async list(
    filters: {
      status?: OrderRequestStatus | OrderRequestStatus[];
      requesterUserId?: string;
      requesterEmail?: string;
      warehouseId?: string;
      limit?: number;
      offset?: number;
      /** ISO timestamps. Filter on `created_at`. Used by AI tools for
        "orders submitted yesterday / this week / between X and Y". */
      since?: string;
      until?: string;
    } = {},
  ): Promise<OrderRequestSummary[]> {
    assertModuleEnabled(this.ctx, 'orders');
    let q = this.ctx.supabase
      .from('order_requests')
      .select(
        // requester:user_profiles join resolves the actual member name
        // when requester_name was never written to the row (always the
        // case for internal in-app requests — only public-link external
        // requesters populate the requester_name / requester_email cols
        // at create time). RLS on user_profiles already lets org members
        // read each other, so this join is safe and cheap.
        //
        // picker + driver names are resolved in a separate batch query
        // below — PostgREST embeds become LATERAL joins, which multiply
        // cost per row even when assigned_picker_id / assigned_delivery_user_id
        // are NULL (the common case for not-yet-picked orders). Splitting
        // those two joins out and batching the lookup keeps the main
        // query lean.
        `id, order_number, status, warehouse_id, requester_user_id, requester_email,
         requester_name, requester_org_label, source, notes,
         created_at, updated_at, approved_at, delivered_at,
         fulfillment_type, assigned_picker_id, assigned_delivery_user_id,
         warehouse:warehouses!warehouse_id (name),
         lines:order_request_lines (quantity_requested),
         requester:user_profiles!requester_user_id (full_name, email)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      // M1: secondary `id desc` sort gives a stable order when two rows
      // share the same `created_at` (rare but possible under bulk inserts).
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });

    if (filters.status) {
      const arr = Array.isArray(filters.status) ? filters.status : [filters.status];
      q = q.in('status', arr);
    } else {
      // Anti-spam: pending_confirmation rows are public-submit limbo —
      // the requester hasn't clicked the confirmation email yet, so
      // managers should never see them in the inbox. Callers can
      // still opt-in by passing `status: 'pending_confirmation'`
      // explicitly.
      q = q.neq('status', 'pending_confirmation');
    }
    if (filters.requesterUserId) q = q.eq('requester_user_id', filters.requesterUserId);
    if (filters.requesterEmail) q = q.eq('requester_email', filters.requesterEmail);
    if (filters.warehouseId) q = q.eq('warehouse_id', filters.warehouseId);
    if (filters.since) q = q.gte('created_at', filters.since);
    if (filters.until) q = q.lt('created_at', filters.until);

    const limit = Math.min(filters.limit ?? 50, 200);
    // M3: cap the maximum offset so callers can't punch through enormous
    // page numbers and force the DB into a deep-offset scan.
    const MAX_OFFSET = 10_000;
    const offset = Math.min(MAX_OFFSET, Math.max(0, filters.offset ?? 0));
    q = q.range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);

    // Batch-fetch picker + driver display names for the IDs that
    // actually appear on this page. PostgREST embeds (`picker:...`,
    // `driver:...`) generate LATERAL joins that cost a lookup PER ROW
    // even when the FK is NULL — most order rows have NO picker yet
    // and NO driver, so the join cost was pure waste. One indexed
    // batch query on user_profiles.id is faster than 100 LATERAL hits.
    const rows = data ?? [];
    const assignedIds = new Set<string>();
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const pid = r.assigned_picker_id as string | null | undefined;
      const did = r.assigned_delivery_user_id as string | null | undefined;
      if (pid) assignedIds.add(pid);
      if (did) assignedIds.add(did);
    }
    type ProfileRow = { id: string; full_name: string | null; email: string | null };
    const profilesById = new Map<string, ProfileRow>();
    if (assignedIds.size > 0) {
      const { data: profs, error: profErr } = await this.ctx.supabase
        .from('user_profiles')
        .select('id, full_name, email')
        .in('id', [...assignedIds]);
      if (profErr) throw new ServiceError('internal_error', profErr.message);
      for (const p of (profs ?? []) as ProfileRow[]) {
        profilesById.set(p.id, p);
      }
    }

    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      const wh = r.warehouse as { name?: string } | { name?: string }[] | null;
      const warehouseName = Array.isArray(wh) ? (wh[0]?.name ?? null) : (wh?.name ?? null);
      const lines = (r.lines as Array<{ quantity_requested: number }> | null) ?? [];

      // Resolve the requester display from the embedded user_profiles
      // join when the row's own requester_name / requester_email cols
      // are null — internal in-app requests don't populate those at
      // create time (only public-link external requesters do).
      type ProfileShape = {
        full_name?: string | null;
        email?: string | null;
      };
      const flattenProfile = (field: unknown): ProfileShape | null => {
        if (!field) return null;
        return Array.isArray(field)
          ? ((field[0] as ProfileShape | undefined) ?? null)
          : (field as ProfileShape);
      };
      const reqProfile = flattenProfile(r.requester);
      const pickerId = (r.assigned_picker_id as string | null) ?? null;
      const driverId = (r.assigned_delivery_user_id as string | null) ?? null;
      const pickerProfile = pickerId ? (profilesById.get(pickerId) ?? null) : null;
      const driverProfile = driverId ? (profilesById.get(driverId) ?? null) : null;
      const requesterName =
        ((r.requester_name as string | null) ?? null) || reqProfile?.full_name?.trim() || null;
      const requesterEmail =
        ((r.requester_email as string | null) ?? null) || reqProfile?.email?.trim() || null;
      const displayProfile = (p: ProfileShape | null): string | null => {
        if (!p) return null;
        return p.full_name?.trim() || p.email?.trim() || null;
      };

      return {
        id: r.id as string,
        orderNumber: Number(r.order_number) || 0,
        status: r.status as OrderRequestStatus,
        warehouseId: r.warehouse_id as string,
        warehouseName,
        requesterUserId: (r.requester_user_id as string | null) ?? null,
        requesterEmail,
        requesterName,
        requesterOrgLabel: (r.requester_org_label as string | null) ?? null,
        source: r.source as OrderRequestSource,
        lineCount: lines.length,
        totalQuantity: lines.reduce((s, l) => s + (Number(l.quantity_requested) || 0), 0),
        notes: (r.notes as string | null) ?? null,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
        approvedAt: (r.approved_at as string | null) ?? null,
        deliveredAt: (r.delivered_at as string | null) ?? null,
        fulfillmentType: (r.fulfillment_type as 'pickup' | 'delivery' | null) ?? 'pickup',
        assignedPickerId: (r.assigned_picker_id as string | null) ?? null,
        assignedPickerName: displayProfile(pickerProfile),
        assignedDeliveryUserId: (r.assigned_delivery_user_id as string | null) ?? null,
        assignedDeliveryUserName: displayProfile(driverProfile),
      } satisfies OrderRequestSummary;
    });
  }

  async myRequests(): Promise<OrderRequestSummary[]> {
    return this.list({ requesterUserId: this.ctx.userId });
  }

  /**
   * Flattened order-history rows for CSV export. Org-scoped (via the
   * RLS-bound client + the explicit organization_id filter) and honoring
   * the same dimensions the orders list filters on: status, created-at
   * date range, delivery charter, and fulfillment type.
   *
   * Unlike list() this is NOT paginated for the UI — it pulls up to
   * `cap` rows so a single export captures the whole filtered set. The
   * caller (the export.csv route) clamps `cap` and signals truncation in
   * the body when the cap is hit.
   *
   * Computes line count, total requested qty, and total cost (sum of
   * quantity_requested × unit_cost_at_request across the order's lines)
   * so the CSV can carry order-level totals without a second round trip.
   */
  async exportRows(
    filters: {
      status?: OrderRequestStatus | OrderRequestStatus[];
      requesterUserId?: string;
      warehouseId?: string;
      deliveryCharterId?: string;
      fulfillmentType?: 'pickup' | 'delivery';
      since?: string;
      until?: string;
      cap?: number;
    } = {},
  ): Promise<{ rows: OrderExportRow[]; total: number }> {
    assertModuleEnabled(this.ctx, 'orders');

    const cap = Math.min(Math.max(1, filters.cap ?? 10_000), 50_000);

    // PostgREST clamps any single response to `[api] max_rows` (1000;
    // supabase/config.toml:10, also the hosted default). A naive
    // `.range(0, cap-1)` therefore SILENTLY returns only the newest 1000
    // rows for any org with >1000 matching orders — the same head-of-line
    // truncation class migration 0148 fixed for the connector drainer.
    // So we paginate in <=PAGE_SIZE batches with .range(), looping until
    // we've assembled every filtered row up to `cap`. The first page
    // carries the exact `count`, which we use both to size the loop and
    // to report the true total back to the caller (for the truncation
    // sentinel). PAGE_SIZE is kept <= the Data-API max_rows so each page
    // is returned in full.
    const PAGE_SIZE = 1000;

    const rawRows: Record<string, unknown>[] = [];
    let total = 0;
    let offset = 0;
    while (offset < cap) {
      const pageEnd = Math.min(offset + PAGE_SIZE, cap) - 1;
      let q = this.ctx.supabase
        .from('order_requests')
        .select(
          `id, status, warehouse_id, requester_user_id, requester_email,
           requester_name, requester_org_label, source, notes,
           created_at, updated_at, approved_at, delivered_at, completed_at,
           fulfillment_type, delivery_charter_id,
           warehouse:warehouses!warehouse_id (name),
           charter:charters!delivery_charter_id (name, code),
           lines:order_request_lines (quantity_requested, unit_cost_at_request),
           requester:user_profiles!requester_user_id (full_name, email)`,
          // Only the first page needs the exact count — it's stable across
          // the loop and re-counting each page would be wasted work.
          offset === 0 ? { count: 'exact' } : undefined,
        )
        .eq('organization_id', this.ctx.organizationId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false });

      if (filters.status) {
        const arr = Array.isArray(filters.status) ? filters.status : [filters.status];
        q = q.in('status', arr);
      } else {
        // Same anti-spam exclusion as list(): hide public-submit limbo rows
        // unless a caller explicitly asks for them.
        q = q.neq('status', 'pending_confirmation');
      }
      if (filters.requesterUserId) q = q.eq('requester_user_id', filters.requesterUserId);
      if (filters.warehouseId) q = q.eq('warehouse_id', filters.warehouseId);
      if (filters.deliveryCharterId) q = q.eq('delivery_charter_id', filters.deliveryCharterId);
      if (filters.fulfillmentType) q = q.eq('fulfillment_type', filters.fulfillmentType);
      if (filters.since) q = q.gte('created_at', filters.since);
      if (filters.until) q = q.lt('created_at', filters.until);

      q = q.range(offset, pageEnd);

      const { data, error, count } = await q;
      if (error) throw new ServiceError('internal_error', error.message);
      if (offset === 0) total = count ?? 0;

      const page = (data ?? []) as Record<string, unknown>[];
      for (const r of page) rawRows.push(r);

      // Stop when the DB returned a short page (no more rows) or we've
      // pulled everything the exact count promised. Without the short-page
      // guard a count that lags behind a concurrent delete could loop us
      // into an empty fetch.
      if (page.length < pageEnd - offset + 1) break;
      if (total > 0 && rawRows.length >= Math.min(total, cap)) break;
      offset += PAGE_SIZE;
    }

    const rows = rawRows.map((r): OrderExportRow => {
      const flatten = <T>(field: unknown): T | null =>
        Array.isArray(field) ? ((field[0] as T | undefined) ?? null) : ((field as T) ?? null);
      const wh = flatten<{ name?: string | null }>(r.warehouse);
      const ch = flatten<{ name?: string | null; code?: string | null }>(r.charter);
      const reqProfile = flatten<{ full_name?: string | null; email?: string | null }>(r.requester);
      const lines =
        (r.lines as Array<{ quantity_requested: number; unit_cost_at_request: number }> | null) ??
        [];

      const requesterName =
        ((r.requester_name as string | null) ?? null) || reqProfile?.full_name?.trim() || null;
      const requesterEmail =
        ((r.requester_email as string | null) ?? null) || reqProfile?.email?.trim() || null;
      // Charter/destination: real charter when set, otherwise the warehouse
      // (pickup orders have no charter — they're collected at the warehouse).
      const charterName = ch?.name ?? null;
      const charterLabel = charterName
        ? ch?.code
          ? `${charterName} (${ch.code})`
          : charterName
        : null;

      return {
        id: r.id as string,
        status: r.status as OrderRequestStatus,
        requesterName,
        requesterEmail,
        requesterOrgLabel: (r.requester_org_label as string | null) ?? null,
        warehouseName: wh?.name ?? null,
        charterLabel,
        fulfillmentType: (r.fulfillment_type as 'pickup' | 'delivery' | null) ?? 'pickup',
        source: r.source as OrderRequestSource,
        lineCount: lines.length,
        totalQuantity: lines.reduce((s, l) => s + (Number(l.quantity_requested) || 0), 0),
        totalCost: lines.reduce(
          (s, l) => s + (Number(l.quantity_requested) || 0) * (Number(l.unit_cost_at_request) || 0),
          0,
        ),
        notes: (r.notes as string | null) ?? null,
        createdAt: r.created_at as string,
        approvedAt: (r.approved_at as string | null) ?? null,
        completedAt:
          ((r.completed_at as string | null) ?? null) ||
          ((r.delivered_at as string | null) ?? null),
      };
    });

    // `total` is the EXACT count from the first page (the real number of
    // matching rows, which may exceed `cap`). The route uses
    // `total > rows.length` to decide whether to print a truncation
    // sentinel; with batching, rows.length now reaches min(total, cap)
    // rather than being silently clipped to 1000.
    return { rows, total: total || rows.length };
  }

  async pendingCount(): Promise<number> {
    const { count, error } = await this.ctx.supabase
      .from('order_requests')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('status', 'pending_approval');
    if (error) throw new ServiceError('internal_error', error.message);
    return count ?? 0;
  }

  /**
   * Orders that have reached the signable stage but not yet been signed.
   * Powers the dashboard "N orders waiting for signature" attention card.
   *
   * staged_for_pickup → waiting on the customer to come in and sign.
   * in_transit         → out for delivery, waiting for sign-on-arrival.
   */
  async awaitingSignatureCount(): Promise<number> {
    const { count, error } = await this.ctx.supabase
      .from('order_requests')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .in('status', ['staged_for_pickup', 'in_transit']);
    if (error) throw new ServiceError('internal_error', error.message);
    return count ?? 0;
  }

  async get(id: string): Promise<OrderRequestDetail> {
    assertModuleEnabled(this.ctx, 'orders');
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('order_requests')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'Order request not found');

    // M6: lines, reservations, and warehouse name are independent reads —
    // fan them out concurrently to shave a round-trip off the detail page.
    const [linesRes, rsRes, whRes] = await Promise.all([
      this.ctx.supabase
        .from('order_request_lines')
        .select(
          `id, order_request_id, item_id, quantity_requested,
           quantity_fulfilled, quantity_picked, unit_cost_at_request, notes,
           item:inventory_items!item_id (
             id, name, sku, quantity_on_hand, barcode, model_number, item_type, custom_fields, tracking_type,
             charter_id, charter:charters!charter_id ( name, code )
           )`,
        )
        .eq('order_request_id', id),
      this.ctx.supabase
        .from('stock_reservations')
        .select('id, item_id, warehouse_id, quantity, created_at')
        .eq('order_request_id', id)
        .is('released_at', null),
      this.ctx.supabase
        .from('warehouses')
        .select('name')
        .eq('id', (header as OrderRequestRow).warehouse_id)
        .maybeSingle(),
    ]);
    const { data: lines, error: lErr } = linesRes;
    if (lErr) throw new ServiceError('internal_error', lErr.message);

    type RawCharter = { name: string | null; code: string | null };
    type RawItem = {
      id: string;
      name: string;
      sku: string;
      quantity_on_hand: number;
      barcode: string | null;
      model_number: string | null;
      item_type: string | null;
      custom_fields: Record<string, unknown> | null;
      tracking_type: string | null;
      charter_id: string | null;
      charter: RawCharter | RawCharter[] | null;
    };
    const flatLines: OrderRequestLineWithItem[] = (lines ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const itemField = r.item as RawItem | RawItem[] | null;
      const rawItem = Array.isArray(itemField) ? (itemField[0] ?? null) : (itemField ?? null);
      // Flatten the charter embed (object-or-array from PostgREST) onto the item.
      const item = rawItem
        ? (() => {
            const c = Array.isArray(rawItem.charter)
              ? (rawItem.charter[0] ?? null)
              : (rawItem.charter ?? null);
            const { charter: _charter, ...rest } = rawItem;
            return {
              ...rest,
              charter_id: rawItem.charter_id ?? null,
              charter_name: c?.name ?? null,
              charter_code: c?.code ?? null,
            };
          })()
        : null;
      const rawPicked = r.quantity_picked as number | null | undefined;
      return {
        id: r.id as string,
        order_request_id: r.order_request_id as string,
        item_id: r.item_id as string,
        quantity_requested: Number(r.quantity_requested) || 0,
        quantity_fulfilled: Number(r.quantity_fulfilled) || 0,
        quantity_picked: rawPicked === null || rawPicked === undefined ? null : Number(rawPicked),
        unit_cost_at_request: Number(r.unit_cost_at_request) || 0,
        notes: (r.notes as string | null) ?? null,
        item,
      };
    });

    const { data: rs } = rsRes;
    const { data: wh } = whRes;

    const h = header as OrderRequestRow;

    // Resolve the requester identity ONCE from user_profiles (only for
    // internal self-submit orders, which carry a `requester_user_id` and
    // NULL name/email columns). On-behalf-of + public-link orders instead
    // carry the free-text name/email and no `requester_user_id`.
    // Resolved in PARALLEL with the picker below so adding the picker name
    // costs no extra round-trip on the detail path.
    const [profile, pickerProfile] = await Promise.all([
      h.requester_user_id ? this.lookupUserProfile(h.requester_user_id) : Promise.resolve(null),
      // Picker who CLAIMED this order — pre-printed on the pick slip's
      // PICKER NAME line. Null when unclaimed (see OrderRequestDetail doc).
      h.assigned_picker_id ? this.lookupUserProfile(h.assigned_picker_id) : Promise.resolve(null),
    ]);

    // Resolved name/email safe for a name cell — SAME fallback the list()
    // path uses: free-text column wins, else the joined profile, else null.
    // `||` (not `??`) so an empty-string column also falls through.
    const requesterName =
      ((h.requester_name as string | null) ?? null) || profile?.fullName?.trim() || null;
    const requesterEmail =
      ((h.requester_email as string | null) ?? null) || profile?.email?.trim() || null;

    // requesterDisplay is the on-screen label WITH the " · org_label"
    // suffix for external requesters — unchanged behavior, just now
    // derived from the single profile lookup above.
    const profileDisplay = profile
      ? profile.fullName?.trim() || profile.email?.trim() || null
      : null;
    const requesterDisplay = h.requester_user_id
      ? (profileDisplay ?? '(team member)')
      : `${h.requester_name ?? 'External requester'}${h.requester_org_label ? ' · ' + h.requester_org_label : ''}`;

    return {
      request: h,
      lines: flatLines,
      reservations: (rs ?? []) as ActiveReservation[],
      warehouseName: (wh?.name as string | null) ?? null,
      requesterDisplay,
      requesterName,
      requesterEmail,
      assignedPickerName: pickerProfile
        ? pickerProfile.fullName?.trim() || pickerProfile.email?.trim() || null
        : null,
      // Any line created after the slip was printed makes that slip stale.
      pickSlipStale:
        h.pick_slip_generated_at != null &&
        flatLines.some((l) => {
          const created = (l as { created_at?: string | null }).created_at;
          return created != null && created > (h.pick_slip_generated_at as string);
        }),
    };
  }

  private async lookupUserProfile(
    userId: string,
  ): Promise<{ fullName: string | null; email: string | null } | null> {
    const { data } = await this.ctx.supabase
      .from('user_profiles')
      .select('full_name, email')
      .eq('id', userId)
      .maybeSingle();
    if (!data) return null;
    return {
      fullName: (data.full_name as string | null) ?? null,
      email: (data.email as string | null) ?? null,
    };
  }

  // ── Write — requester actions ───────────────────────────────────

  async create(input: CreateOrderRequestInput): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:request');
    // Gate by warehouse access too — `orders:request` is org-wide, but a
    // requester restricted to warehouse A shouldn't be able to file a
    // request against warehouse B. The public-link path doesn't reach
    // this method (the public route builds rows via the admin client),
    // so this check is safe to apply unconditionally here.
    await assertWarehouseAccess(input.warehouseId, 'read', this.ctx);
    if (input.lines.length === 0) {
      throw new ServiceError('validation_error', 'A request needs at least one line');
    }

    // Validate every item belongs to the chosen warehouse + snapshot unit costs.
    const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
    const { data: items, error: iErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, name, warehouse_id, unit_cost, awaiting_first_receipt')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', itemIds);
    if (iErr) throw new ServiceError('internal_error', iErr.message);
    const itemMap = new Map<
      string,
      { name: string; warehouse_id: string | null; unit_cost: number; awaiting: boolean }
    >();
    for (const row of (items ?? []) as Array<{
      id: string;
      name: string;
      warehouse_id: string | null;
      unit_cost: number;
      awaiting_first_receipt: boolean;
    }>) {
      itemMap.set(row.id, {
        name: row.name,
        warehouse_id: row.warehouse_id,
        unit_cost: Number(row.unit_cost) || 0,
        awaiting: row.awaiting_first_receipt === true,
      });
    }
    for (const line of input.lines) {
      const it = itemMap.get(line.itemId);
      if (!it) throw new ServiceError('validation_error', `Item ${line.itemId} not found`);
      if (it.warehouse_id !== input.warehouseId) {
        throw new ServiceError('validation_error', 'Every line must be at the chosen warehouse');
      }
      // Expected-items guard (mig 0277): an item auto-created from an
      // inbound PO that has never received stock is NOT orderable. The
      // pickers/catalogs already exclude flagged items — this is the
      // authoritative server-side gate a crafted payload can't skip.
      if (it.awaiting) {
        throw new ServiceError(
          'validation_error',
          `This item hasn't been received yet: ${it.name}. It can be ordered once its first stock arrives.`,
        );
      }
    }

    // Defense-in-depth — the FK + CHECK constraint already enforce that
    // the (warehouse_id, charter_id) pair is one this warehouse services,
    // but a friendlier error here saves the user from a generic 23-error.
    // Mirrors the inventory.ts charter pairing check.
    if (input.deliveryCharterId) {
      const { data: pair } = await this.ctx.supabase
        .from('warehouse_charters')
        .select('charter_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('warehouse_id', input.warehouseId)
        .eq('charter_id', input.deliveryCharterId)
        .maybeSingle();
      if (!pair) {
        throw new ServiceError(
          'validation_error',
          'That site is not serviced by the chosen warehouse.',
        );
      }
    }

    const { data: header, error: hErr } = await this.ctx.supabase
      .from('order_requests')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: input.warehouseId,
        // When `onBehalfOf` is set, treat the row as public-style for
        // email purposes: requester_user_id stays null, the name+email
        // columns carry the on-behalf identity, and the email pipeline
        // (which keys off `requester_user_id IS NULL`) routes the
        // confirmation / status emails to that external address.
        // `source` remains 'internal' — this is still a manager-
        // initiated order.
        requester_user_id: input.onBehalfOf ? null : this.ctx.userId,
        requester_name: input.onBehalfOf?.name ?? null,
        requester_email: input.onBehalfOf?.email ?? null,
        notes: input.notes ?? null,
        needed_by: input.neededBy ?? null,
        fulfillment_type: input.fulfillmentType,
        requester_phone: input.requesterPhone ?? null,
        delivery_charter_id: input.deliveryCharterId ?? null,
        pickup_location_notes: input.pickupLocationNotes ?? null,
        source: 'internal' as OrderRequestSource,
        status: 'pending_approval' as OrderRequestStatus,
      })
      .select('*')
      .single();
    if (hErr) throw new ServiceError('internal_error', hErr.message);

    const linePayload = input.lines.map((l) => ({
      order_request_id: (header as { id: string }).id,
      item_id: l.itemId,
      quantity_requested: l.quantity,
      unit_cost_at_request: itemMap.get(l.itemId)?.unit_cost ?? 0,
      notes: l.notes ?? null,
    }));
    const { error: lErr } = await this.ctx.supabase.from('order_request_lines').insert(linePayload);
    if (lErr) {
      // Roll back the header by hand — we don't have a transaction wrapper here.
      await this.ctx.supabase
        .from('order_requests')
        .delete()
        .eq('id', (header as { id: string }).id);
      throw new ServiceError('internal_error', lErr.message);
    }

    const row = header as OrderRequestRow;
    await audit(
      {
        event: 'order_request.created',
        entityType: 'order_request',
        entityId: row.id,
        after: { lineCount: linePayload.length, warehouseId: input.warehouseId },
      },
      this.ctx,
    );
    void this.notifyEmail(row, 'submitted');
    // Fan out to configured webhooks / Slack / Teams (best-effort, no-op when
    // the org has no endpoints; cron backstops delivery).
    void dispatchEvent(this.ctx.organizationId, 'order.created', {
      id: row.id,
      orderNumber: formatOrderNumber(row.order_number) ?? row.id.slice(0, 8).toUpperCase(),
      requester: (row as { requester_name?: string | null }).requester_name ?? null,
      lineCount: linePayload.length,
    });
    return row;
  }

  /**
   * The gate every LINE-LEVEL edit shares: add, change quantity, remove.
   *
   * It lives in one place on purpose. Add and edit diverging — e.g. an order you
   * can still add to but can't correct — is itself the bug the owner hit, so
   * all three callers load the header the same way, refuse on the same
   * shipped/closed statuses, and answer "who may touch this order?" identically.
   * Only the two user-facing sentences differ, because "add" and "remove" want
   * different next steps.
   *
   * Scoping the header read by organization_id is also what makes a foreign
   * line id a clean not_found instead of a cross-org read: callers look the
   * line up by (id, order_request_id) against THIS header.
   */
  private async loadEditableOrderHeader(
    id: string,
    copy: { inTransit: string; forbidden: string },
  ): Promise<{
    id: string;
    status: OrderRequestStatus;
    warehouse_id: string;
    requester_user_id: string | null;
    pick_slip_generated_at: string | null;
    order_number: number | null;
  }> {
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('order_requests')
      .select('id, status, warehouse_id, requester_user_id, pick_slip_generated_at, order_number')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'Order not found');
    const h = header as {
      id: string;
      status: OrderRequestStatus;
      warehouse_id: string;
      requester_user_id: string | null;
      pick_slip_generated_at: string | null;
      order_number: number | null;
    };

    // Ship gate — once it's out the door (or dead) the contents are final.
    const SHIPPED_OR_CLOSED: OrderRequestStatus[] = [
      'in_transit',
      'completed',
      'denied',
      'cancelled',
    ];
    if (SHIPPED_OR_CLOSED.includes(h.status)) {
      throw new ServiceError(
        'conflict',
        h.status === 'in_transit'
          ? copy.inTransit
          : `This order is ${h.status} and can no longer be changed.`,
      );
    }

    // Requester-or-approver. `orders:request` alone is NOT enough to change
    // someone else's order.
    const isRequester = h.requester_user_id != null && h.requester_user_id === this.ctx.userId;
    if (!isRequester && !can(this.ctx, 'orders:approve')) {
      throw new ServiceError('forbidden', copy.forbidden);
    }
    // Same warehouse gate create() applies.
    await assertWarehouseAccess(h.warehouse_id, 'read', this.ctx);
    return h;
  }

  /**
   * Add line items to an EXISTING order — the "customer called back and wants
   * more" case (owner request 2026-07-22). Previously the only option was a
   * second order, because lines were frozen at create().
   *
   * Owner decisions:
   *  • Allowed ANY TIME BEFORE THE ORDER SHIPS — i.e. every status except
   *    in_transit / completed / denied / cancelled. Adding during
   *    picking/packing/staging is deliberately permitted; the already-printed
   *    pick slip is then stale, which `pickSlipStale` on the detail surfaces
   *    (derived from line.created_at > pick_slip_generated_at — no column
   *    needed, and it can never drift out of sync).
   *  • Allowed for the REQUESTER of the order, or anyone with orders:approve.
   *
   * Adding an item already on the order INCREMENTS that line rather than
   * creating a confusing duplicate row. Stock reservations are minted by the
   * pick-slip / picking RPCs, so a newly added line is reserved when the slip
   * is re-generated — which is exactly the reprint the staleness flag prompts.
   */
  async addLines(
    id: string,
    lines: Array<{ itemId: string; quantity: number }>,
  ): Promise<{ added: number; merged: number; pickSlipStale: boolean }> {
    assertModuleEnabled(this.ctx, 'orders');
    if (lines.length === 0) {
      throw new ServiceError('validation_error', 'Pick at least one item to add.');
    }
    for (const l of lines) {
      if (!Number.isFinite(l.quantity) || l.quantity <= 0) {
        throw new ServiceError('validation_error', 'Every added line needs a quantity above zero.');
      }
    }

    const h = await this.loadEditableOrderHeader(id, {
      inTransit: 'This order is already out for delivery — create a new order for the extra items.',
      forbidden: 'Only the requester or someone who can approve orders may add items to it.',
    });

    // Validate items exactly like create(): must exist in-org, sit in THIS
    // order's warehouse, and not be an unreceived (expected) phantom.
    const itemIds = [...new Set(lines.map((l) => l.itemId))];
    const { data: items, error: iErr } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, name, warehouse_id, unit_cost, awaiting_first_receipt')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', itemIds);
    if (iErr) throw new ServiceError('internal_error', iErr.message);
    const itemMap = new Map(
      (
        (items ?? []) as Array<{
          id: string;
          name: string;
          warehouse_id: string | null;
          unit_cost: number;
          awaiting_first_receipt: boolean;
        }>
      ).map((r) => [r.id, r]),
    );
    for (const l of lines) {
      const it = itemMap.get(l.itemId);
      if (!it) throw new ServiceError('validation_error', `Item ${l.itemId} not found`);
      if (it.warehouse_id !== h.warehouse_id) {
        throw new ServiceError(
          'validation_error',
          `${it.name} isn't stocked at this order's warehouse.`,
        );
      }
      if (it.awaiting_first_receipt === true) {
        throw new ServiceError(
          'validation_error',
          `This item hasn't been received yet: ${it.name}. It can be ordered once its first stock arrives.`,
        );
      }
    }

    // Existing lines — an item already on the order is topped up, not duplicated.
    const { data: existing, error: eErr } = await this.ctx.supabase
      .from('order_request_lines')
      .select('id, item_id, quantity_requested')
      .eq('order_request_id', h.id);
    if (eErr) throw new ServiceError('internal_error', eErr.message);
    const existingByItem = new Map(
      ((existing ?? []) as Array<{ id: string; item_id: string; quantity_requested: number }>).map(
        (r) => [r.item_id, r],
      ),
    );

    // Collapse duplicate itemIds in the caller's payload first.
    const wanted = new Map<string, number>();
    for (const l of lines) wanted.set(l.itemId, (wanted.get(l.itemId) ?? 0) + l.quantity);

    let merged = 0;
    let added = 0;
    // Service role: see the note on the merge branch below.
    const admin = createAdminClient();
    const toInsert: Array<Record<string, unknown>> = [];
    for (const [itemId, qty] of wanted) {
      const prior = existingByItem.get(itemId);
      if (prior) {
        // PRIVILEGED write. order_request_lines carries RLS policies
        // order_request_lines_no_update / _no_delete, both USING false (mig
        // 0049, deliberate: "once a line is created it shouldn't be mutated
        // outside the SQL approve/deliver/cancel functions"). Through the
        // USER client this UPDATE therefore matched ZERO rows and PostgREST
        // returned no error, so the top-up silently did nothing while the
        // caller was told it merged. Shipped that way this morning and caught
        // in review the same day.
        //
        // Opening RLS is the WRONG fix: policies are row-level, not
        // column-level, so an UPDATE policy permissive enough to allow this
        // would also let any requester write quantity_fulfilled/quantity_picked
        // straight through PostgREST. The gates live in this method; the write
        // goes through the service role, scoped to the line AND the order.
        const { data: mergedRow, error: uErr } = await admin
          .from('order_request_lines')
          .update({ quantity_requested: Number(prior.quantity_requested) + qty })
          .eq('id', prior.id)
          .eq('order_request_id', h.id)
          .select('id')
          .maybeSingle();
        if (uErr) throw new ServiceError('internal_error', uErr.message);
        // Fail CLOSED: no row back means nothing changed, so never report success.
        if (!mergedRow) {
          throw new ServiceError(
            'internal_error',
            'Could not update the existing line. Nothing was changed.',
          );
        }
        merged += 1;
      } else {
        toInsert.push({
          order_request_id: h.id,
          item_id: itemId,
          quantity_requested: qty,
          unit_cost_at_request: itemMap.get(itemId)?.unit_cost ?? 0,
        });
        added += 1;
      }
    }
    if (toInsert.length > 0) {
      const { error: insErr } = await this.ctx.supabase
        .from('order_request_lines')
        .insert(toInsert);
      if (insErr) throw new ServiceError('internal_error', insErr.message);
    }

    // A slip printed BEFORE this change no longer matches the order.
    const pickSlipStale = h.pick_slip_generated_at != null;

    await audit(
      {
        event: 'order_request.lines_added',
        entityType: 'order_request',
        entityId: h.id,
        after: {
          added,
          merged,
          items: [...wanted.entries()].map(([itemId, qty]) => ({
            itemId,
            name: itemMap.get(itemId)?.name ?? null,
            quantity: qty,
          })),
          statusWhenAdded: h.status,
          pickSlipStale,
        },
      },
      this.ctx,
    );

    return { added, merged, pickSlipStale };
  }

  /**
   * Load ONE line of an order for editing, having already cleared the shared
   * order-level gate. The line is fetched by (id, order_request_id) against a
   * header that was itself scoped to the caller's organization, so a line id
   * belonging to another order — or another org — comes back empty and is
   * reported as not_found rather than silently editing nothing.
   */
  private async loadOwnLine(
    orderId: string,
    lineId: string,
  ): Promise<{
    id: string;
    item_id: string;
    quantity_requested: number;
    quantity_fulfilled: number;
    quantity_picked: number | null;
    returned_quantity: number;
  }> {
    const { data, error } = await this.ctx.supabase
      .from('order_request_lines')
      .select(
        'id, item_id, quantity_requested, quantity_fulfilled, quantity_picked, returned_quantity',
      )
      .eq('id', lineId)
      .eq('order_request_id', orderId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'That line is not on this order.');
    return data as {
      id: string;
      item_id: string;
      quantity_requested: number;
      quantity_fulfilled: number;
      quantity_picked: number | null;
      returned_quantity: number;
    };
  }

  /** Item display name for audit payloads — best-effort, never blocks the edit. */
  /**
   * Two things every committed line edit owes the rest of the system.
   *
   * 1. TOUCH THE HEADER. The order detail page live-refreshes through
   *    OrderRealtimeRefresh, which subscribes to postgres_changes on the
   *    order_requests ROW. Line edits write only to order_request_lines, and
   *    that table has no trigger touching its parent (verified in prod), so
   *    without this the requester's open page sits on stale quantities until
   *    they navigate. Bumping updated_at makes the existing subscription fire.
   *
   * 2. TELL THE REQUESTER. Someone else changing what you asked for is worth
   *    knowing about (owner decision 2026-07-22). Skipped when the actor IS the
   *    requester — nobody needs a notification about their own action. Insert
   *    only; the AFTER INSERT trigger (mig 0028) owns push fan-out, so calling
   *    a push helper here would double-banner.
   *
   * Both are best-effort: the line change is already committed and durable, and
   * failing the request now would tell the user their edit did not happen when
   * it did.
   */
  private async announceLineChange(args: {
    orderId: string;
    orderNumber: number | null;
    requesterUserId: string | null;
    type: 'order_request.line_removed' | 'order_request.line_quantity_changed';
    title: string;
    body: string;
  }): Promise<void> {
    try {
      const admin = createAdminClient();
      await admin
        .from('order_requests')
        .update({ updated_at: new Date().toISOString() })
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', args.orderId);

      if (args.requesterUserId && args.requesterUserId !== this.ctx.userId) {
        await createNotification({
          organizationId: this.ctx.organizationId,
          userId: args.requesterUserId,
          type: args.type,
          title: args.title,
          body: args.body,
          // web-path-rewrite.ts maps /dashboard/orders/<uuid> to /order/<uuid>,
          // so this resolves on the phone as well as the browser.
          link: `/dashboard/orders/${args.orderId}`,
          metadata: { orderId: args.orderId, orderNumber: args.orderNumber },
        });
      }
    } catch (e) {
      void reportSrvError(e, { tag: 'orders.announce_line_change' });
    }
  }

  private async lineItemName(itemId: string): Promise<string | null> {
    const { data } = await this.ctx.supabase
      .from('inventory_items')
      .select('id, name')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', itemId)
      .maybeSingle();
    return (data as { name?: string | null } | null)?.name ?? null;
  }

  /**
   * Sum of quantity_requested still outstanding for one item across the order's
   * lines, EXCLUDING one line (the one being removed or rewritten) and with an
   * optional replacement figure for it. This is the target the item's active
   * reservation has to match after the edit.
   */
  private async remainingRequestedForItem(
    orderId: string,
    itemId: string,
    excludeLineId: string,
    replacementQuantity: number,
  ): Promise<number> {
    const { data, error } = await this.ctx.supabase
      .from('order_request_lines')
      .select('id, item_id, quantity_requested, quantity_fulfilled')
      .eq('order_request_id', orderId)
      .eq('item_id', itemId);
    if (error) throw new ServiceError('internal_error', error.message);
    const others = (data ?? []) as Array<{
      id: string;
      item_id: string;
      quantity_requested: number | null;
      quantity_fulfilled: number | null;
    }>;
    // The invariant is requested-and-UNFULFILLED, not requested. Units already
    // handed over are no longer promised — they left the building — so counting
    // them keeps a hold alive for stock the order no longer owes. On a
    // partially-fulfilled or resumed backordered line that is precisely the
    // over-hold this sync exists to eliminate, so it must be subtracted per
    // line and floored at zero (an over-receipt can leave fulfilled above
    // requested, and a negative would silently shrink a sibling's share).
    const owed = (l: { quantity_requested: number | null; quantity_fulfilled: number | null }) =>
      Math.max(0, (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0));
    // Re-assert the item match in JS: the reservation invariant is per item,
    // and summing a row for a different item would hold stock for the wrong one.
    return others
      .filter((l) => l.id !== excludeLineId && l.item_id === itemId)
      .reduce((sum, l) => sum + owed(l), replacementQuantity);
  }

  /**
   * Re-point an item's SOFT HOLD at what the order still asks for.
   *
   * A stock_reservations row is a commitment record, not staged stock: it is
   * minted for every line at APPROVAL (approve_order_request, mig 0044/0045)
   * and withdrawn by stamping released_at + released_reason. Nothing physical
   * moves either way. Treating its mere existence as "stock is staged" is the
   * bug this replaces — it made removal impossible from approval onward, on
   * orders where nothing had been picked.
   *
   * INVARIANT: after any line edit, the item's ACTIVE reservation total equals
   * the quantity still requested-and-unfulfilled for that item on this order.
   * The table has CHECK (quantity > 0), so a row that would fall to zero is
   * RELEASED rather than written down to zero.
   *
   * Approval inserts one row PER LINE, so an item on two lines has two active
   * rows; the target is spread across them oldest-first and any row left with
   * no share is released.
   *
   * We never GROW a reservation here — see the note at the raise branch in
   * updateLineQuantity.
   */
  private async syncItemReservation(
    orderId: string,
    itemId: string,
    remaining: number,
    releaseReason: 'line_removed' | 'line_quantity_lowered',
  ): Promise<{ from: number; to: number; released: boolean } | null> {
    // RLS grants SELECT on stock_reservations to members (0044/0140) — only the
    // writes need the service role, so the read stays on the user client.
    const { data, error } = await this.ctx.supabase
      .from('stock_reservations')
      .select('id, quantity, created_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('order_request_id', orderId)
      .eq('item_id', itemId)
      .is('released_at', null)
      .order('created_at', { ascending: true });
    if (error) throw new ServiceError('internal_error', error.message);
    const rows = ((data ?? []) as Array<{ id: string; quantity: number | null }>).map((r) => ({
      id: r.id,
      quantity: Number(r.quantity) || 0,
    }));
    if (rows.length === 0) return null;
    const total = rows.reduce((sum, r) => sum + r.quantity, 0);
    const target = Math.max(0, remaining);
    // Already at or below what the order wants: leave it alone. Raising a line
    // must not mint or grow a hold (addLines has never done so either).
    if (target >= total) return null;

    const admin = createAdminClient();
    let budget = target;
    for (const row of rows) {
      const keep = Math.min(row.quantity, budget);
      budget -= keep;
      if (keep === row.quantity) continue;
      const patch =
        keep > 0
          ? { quantity: keep }
          : { released_at: new Date().toISOString(), released_reason: releaseReason };
      // PRIVILEGED and fail CLOSED, exactly as the line writes above:
      // stock_reservations carries no INSERT/UPDATE/DELETE policy at all
      // (mig 0044) and 0119 pinned explicit USING/WITH CHECK false ones, so the
      // user client would match zero rows and report success. Scoped by org +
      // order + item + still-active so a stale read can never release someone
      // else's hold, and a write that touches no row is surfaced.
      const { data: written, error: wErr } = await admin
        .from('stock_reservations')
        .update(patch)
        .eq('id', row.id)
        .eq('organization_id', this.ctx.organizationId)
        .eq('order_request_id', orderId)
        .eq('item_id', itemId)
        .is('released_at', null)
        .select('id')
        .maybeSingle();
      if (wErr) throw new ServiceError('internal_error', wErr.message);
      if (!written) {
        throw new ServiceError(
          'conflict',
          'The stock reserved for this item changed while you were editing. Refresh and check the order before trying again.',
        );
      }
    }
    return { from: total, to: target, released: target === 0 };
  }

  /**
   * ORDERING: the line write lands FIRST, then the reservation is re-synced.
   *
   * If the second write fails we are left OVER-HOLDING — a hold with no line
   * behind it. That is the self-correcting direction: cancel/deliver release
   * every active row for the order by order_request_id (mig 0044/0045), so the
   * stray hold clears on its own when the order closes, and until then it only
   * makes us conservative about availability. The reverse order would leave us
   * OVER-RELEASED — an approved line with no hold at all, which nothing later
   * repairs and which lets the same units be promised twice.
   *
   * The failure is still surfaced rather than swallowed, and the audit row is
   * written first so the trail records what actually happened.
   */
  private async syncReservationAfterLineWrite(
    orderId: string,
    itemId: string,
    remaining: number,
    releaseReason: 'line_removed' | 'line_quantity_lowered',
  ): Promise<{
    effect: { from: number; to: number; released: boolean } | null;
    failure: ServiceError | null;
  }> {
    try {
      return { effect: await this.syncItemReservation(orderId, itemId, remaining, releaseReason), failure: null };
    } catch (err) {
      if (err instanceof ServiceError) return { effect: null, failure: err };
      throw err;
    }
  }

  /**
   * Correct the quantity on an existing line — the other half of addLines
   * (owner request 2026-07-22: "theres no way to ... edit the amount").
   *
   * Raising is just adding more, so it needs nothing beyond the shared gate.
   * LOWERING is where the real-world constraints bite, and both are hard floors
   * rather than warnings:
   *  • never below quantity_fulfilled — those units were physically handed over
   *    at pickup/delivery, and the record of what left the building must stand.
   *  • never below quantity_picked — those units are STAGED on a cart or shelf
   *    right now. Shrinking the request beneath them would strand physical
   *    stock nobody is accountable for putting back.
   */
  async updateLineQuantity(
    orderId: string,
    lineId: string,
    quantity: number,
  ): Promise<{ pickSlipStale: boolean; quantity: number }> {
    assertModuleEnabled(this.ctx, 'orders');
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ServiceError(
        'validation_error',
        'Enter a quantity above zero, or remove the line instead.',
      );
    }

    const h = await this.loadEditableOrderHeader(orderId, {
      inTransit:
        'This order is already out for delivery — its quantities are final. Record a return instead.',
      forbidden:
        'Only the requester or someone who can approve orders may change quantities on it.',
    });
    const line = await this.loadOwnLine(h.id, lineId);

    const prior = Number(line.quantity_requested);
    // A slip printed BEFORE this change no longer matches the order.
    const pickSlipStale = h.pick_slip_generated_at != null;
    // No-op: succeed quietly. Writing an audit row saying nothing changed only
    // makes the order's history harder to read.
    if (prior === quantity) return { pickSlipStale, quantity: prior };

    if (quantity < prior) {
      const fulfilled = Number(line.quantity_fulfilled ?? 0);
      if (quantity < fulfilled) {
        throw new ServiceError(
          'conflict',
          `${fulfilled} of these have already been handed over — the quantity can't go below ${fulfilled}.`,
        );
      }
      const picked = Number(line.quantity_picked ?? 0);
      if (quantity < picked) {
        throw new ServiceError(
          'conflict',
          `${picked} of these are already picked and staged — unstage them or finish fulfilling this line before lowering the quantity below ${picked}.`,
        );
      }
    }

    const admin = createAdminClient();
    // PRIVILEGED, and fail CLOSED — see the note in addLines' merge branch.
    // RLS forbids end-user UPDATE on this table by design, so the user client
    // would match zero rows and report success.
    const { data: changed, error: uErr } = await admin
      .from('order_request_lines')
      .update({ quantity_requested: quantity })
      .eq('id', line.id)
      .eq('order_request_id', h.id)
      .select('id')
      .maybeSingle();
    if (uErr) throw new ServiceError('internal_error', uErr.message);
    if (!changed) {
      throw new ServiceError(
        'conflict',
        'That line changed while you were editing it. Refresh and try again.',
      );
    }

    // LOWERING shrinks the hold: units the order no longer wants must go back
    // into everyone else's availability. RAISING deliberately does NOT grow it
    // — addLines has never minted a reservation for an added line either; the
    // approval/pick-slip path owns minting. The asymmetry is intentional.
    let reservation: { from: number; to: number; released: boolean } | null = null;
    let reservationFailure: ServiceError | null = null;
    if (quantity < prior) {
      // The edited line's own contribution is its NEW quantity minus what it
      // has already fulfilled — same requested-and-unfulfilled rule the sibling
      // lines get. U2 guarantees quantity >= quantity_fulfilled, so this is
      // never negative, but it is floored anyway rather than relying on a
      // guard several branches away.
      const ownRemaining = Math.max(0, quantity - (Number(line.quantity_fulfilled) || 0));
      const remaining = await this.remainingRequestedForItem(
        h.id,
        line.item_id,
        line.id,
        ownRemaining,
      );
      const synced = await this.syncReservationAfterLineWrite(
        h.id,
        line.item_id,
        remaining,
        'line_quantity_lowered',
      );
      reservation = synced.effect;
      reservationFailure = synced.failure;
    }

    // One lookup, shared by the audit payload and the requester notification.
    const itemName = await this.lineItemName(line.item_id);
    await audit(
      {
        event: 'order_request.line_quantity_changed',
        entityType: 'order_request',
        entityId: h.id,
        before: { lineId: line.id, itemId: line.item_id, quantity: prior },
        after: {
          lineId: line.id,
          itemId: line.item_id,
          itemName,
          quantity,
          statusWhenChanged: h.status,
          pickSlipStale,
          reservation: reservationFailure
            ? { synced: false, error: reservationFailure.message }
            : reservation
              ? {
                  synced: true,
                  action: reservation.released ? 'released' : 'reduced',
                  from: reservation.from,
                  to: reservation.to,
                }
              : { synced: true, action: 'unchanged' },
        },
      },
      this.ctx,
    );

    if (reservationFailure) throw reservationFailure;

    await this.announceLineChange({
      orderId: h.id,
      orderNumber: h.order_number,
      requesterUserId: h.requester_user_id,
      type: 'order_request.line_quantity_changed',
      title: `Order ${h.order_number != null ? `SO-${String(h.order_number).padStart(6, '0')}` : ''} was updated`.trim(),
      body: `${itemName ?? 'An item'} changed from ${prior} to ${quantity}.`,
    });

    return { pickSlipStale, quantity };
  }

  /**
   * Remove a line added in error. Deliberately narrower than a quantity change:
   * a line that has ANY history against it — handed over, staged, or returned —
   * is a record of something that physically happened and is never deleted.
   *
   * A reservation is NOT such a record and never blocks removal. It is a soft
   * hold minted at approval, so refusing on its existence made every approved
   * order un-editable (owner, production, 2026-07-22: "her order hasnt even
   * been picked yet"). Instead the hold follows the line: it is released, or
   * reduced to what the remaining lines for that item still ask for.
   *
   * Removing the LAST line is refused too: an order with no lines isn't a
   * meaningful record, and cancel() is the operation that actually means "this
   * order is not happening".
   */
  async removeLine(
    orderId: string,
    lineId: string,
  ): Promise<{ pickSlipStale: boolean; removedItemId: string }> {
    assertModuleEnabled(this.ctx, 'orders');

    const h = await this.loadEditableOrderHeader(orderId, {
      inTransit:
        'This order is already out for delivery — its contents are final. Record a return instead.',
      forbidden: 'Only the requester or someone who can approve orders may remove items from it.',
    });
    const line = await this.loadOwnLine(h.id, lineId);

    const fulfilled = Number(line.quantity_fulfilled ?? 0);
    if (fulfilled > 0) {
      throw new ServiceError(
        'conflict',
        `${fulfilled} of these have already been handed over — this line can't be removed. Lower the quantity instead, or record a return.`,
      );
    }
    const picked = Number(line.quantity_picked ?? 0);
    if (picked > 0) {
      throw new ServiceError(
        'conflict',
        `${picked} of these are already picked and staged — unstage them first, then remove the line.`,
      );
    }
    const returned = Number(line.returned_quantity ?? 0);
    if (returned > 0) {
      throw new ServiceError(
        'conflict',
        'This line has returns recorded against it and has to stay on the order for the history to make sense.',
      );
    }

    // Last line standing: an empty order is not a record anyone can act on.
    const { data: siblings, error: sErr } = await this.ctx.supabase
      .from('order_request_lines')
      .select('id, item_id, quantity_requested, quantity_fulfilled')
      .eq('order_request_id', h.id);
    if (sErr) throw new ServiceError('internal_error', sErr.message);
    if ((siblings ?? []).length <= 1) {
      throw new ServiceError(
        'conflict',
        'This is the only item on the order — cancel the order instead of emptying it.',
      );
    }

    const admin = createAdminClient();
    // PRIVILEGED, and fail CLOSED — RLS forbids end-user DELETE here by design
    // (mig 0049), so the user client would delete nothing and report success.
    const { data: deleted, error: dErr } = await admin
      .from('order_request_lines')
      .delete()
      .eq('id', line.id)
      .eq('order_request_id', h.id)
      .select('id')
      .maybeSingle();
    if (dErr) throw new ServiceError('internal_error', dErr.message);
    if (!deleted) {
      throw new ServiceError(
        'conflict',
        'That line was already removed. Refresh to see the current order.',
      );
    }

    // What the order still asks for of this item once the line is gone. The
    // same item can sit on more than one line, so removal is not automatically
    // a full release. Computed from the sibling read above — those rows were
    // fetched before the delete, and this line is excluded by id.
    // Requested-and-UNFULFILLED, not requested: units already handed over are
    // no longer promised, so counting them would keep a hold alive for stock
    // the order no longer owes (the over-hold this sync exists to remove).
    // Floored per line because an over-receipt can push fulfilled past
    // requested, and a negative would eat into a sibling's legitimate share.
    const remaining = ((siblings ?? []) as Array<
      { id: string; item_id: string; quantity_requested: number | null; quantity_fulfilled: number | null }
    >)
      .filter((l) => l.id !== line.id && l.item_id === line.item_id)
      .reduce(
        (sum, l) =>
          sum + Math.max(0, (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0)),
        0,
      );
    const { effect: reservation, failure: reservationFailure } =
      await this.syncReservationAfterLineWrite(h.id, line.item_id, remaining, 'line_removed');

    const pickSlipStale = h.pick_slip_generated_at != null;
    // One lookup, shared by the audit payload and the requester notification.
    const itemName = await this.lineItemName(line.item_id);
    await audit(
      {
        event: 'order_request.line_removed',
        entityType: 'order_request',
        entityId: h.id,
        before: {
          lineId: line.id,
          itemId: line.item_id,
          itemName,
          quantity: Number(line.quantity_requested),
        },
        after: {
          lineId: line.id,
          itemId: line.item_id,
          quantity: 0,
          statusWhenRemoved: h.status,
          pickSlipStale,
          reservation: reservationFailure
            ? { synced: false, error: reservationFailure.message }
            : reservation
              ? {
                  synced: true,
                  action: reservation.released ? 'released' : 'reduced',
                  from: reservation.from,
                  to: reservation.to,
                  ...(reservation.released ? { reason: 'line_removed' } : {}),
                }
              : { synced: true, action: 'unchanged' },
        },
      },
      this.ctx,
    );

    if (reservationFailure) throw reservationFailure;

    await this.announceLineChange({
      orderId: h.id,
      orderNumber: h.order_number,
      requesterUserId: h.requester_user_id,
      type: 'order_request.line_removed',
      title: `Order ${h.order_number != null ? `SO-${String(h.order_number).padStart(6, '0')}` : ''} was updated`.trim(),
      body: `${itemName ?? 'An item'} was removed from this order.`,
    });

    return { pickSlipStale, removedItemId: line.item_id };
  }

  async cancel(id: string, reason?: string | null): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    // C2: gate on the same permission used to create a request. The
    // underlying RPC (SECURITY DEFINER) still enforces its own
    // membership + owner-or-manager checks; the TS gate closes the
    // role-permissions-elision hole and surfaces a clean ServiceError
    // for forbidden callers before any round trip.
    assertPermission(this.ctx, 'orders:request');
    // M7: requesters can only self-cancel a request that is still
    // pending approval. Once managers have approved (and stock has
    // been reserved) or moved it into packing-slip/staged, a self-serve
    // cancel could orphan downstream work — managers must take that
    // path explicitly. Managers themselves are unaffected: the RPC's
    // own role check still permits any non-terminal cancel.
    if (this.ctx.role !== 'owner' && this.ctx.role !== 'admin' && this.ctx.role !== 'manager') {
      const { data: row } = await this.ctx.supabase
        .from('order_requests')
        .select('status, requester_user_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', id)
        .maybeSingle();
      if (
        row &&
        (row as { requester_user_id: string | null }).requester_user_id === this.ctx.userId
      ) {
        const status = (row as { status: OrderRequestStatus }).status;
        if (status !== 'pending_approval') {
          throw new ServiceError(
            'validation_error',
            'You can only cancel your own request while it is still pending approval. Ask a manager to cancel approved or in-progress requests.',
          );
        }
      }
    }
    // I2: NB — the *public-link* cancel path (anonymous external
    // requester) does NOT pass through this service. There is no
    // public cancel endpoint today; external requesters who need to
    // cancel must contact the org admin, who cancels on their behalf.
    // Surface this here so anyone hunting for a public cancel route
    // knows it is intentional, not an oversight.
    const { data, error } = await this.ctx.supabase.rpc('cancel_order_request', {
      p_id: id,
      p_reason: reason ?? null,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order request not found');
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'You can only cancel your own requests');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError('validation_error', 'This request can no longer be cancelled');
      throw new ServiceError('internal_error', msg);
    }
    const row = data as OrderRequestRow;
    // Live tracking: drop any driver GPS point once the order is cancelled
    // (best-effort — the public endpoint already gates on in_transit).
    try {
      await this.ctx.supabase.from('delivery_locations').delete().eq('order_request_id', id);
    } catch {
      /* non-fatal: no live point, or the table predates this org */
    }
    await audit(
      {
        event: 'order_request.cancelled',
        entityType: 'order_request',
        entityId: id,
        reason: reason ?? undefined,
      },
      this.ctx,
    );
    void this.notifyEmail(row, 'cancelled');
    void dispatchEvent(this.ctx.organizationId, 'order.cancelled', {
      id,
      orderNumber: formatOrderNumber(row.order_number) ?? id.slice(0, 8).toUpperCase(),
      cancelledBy: this.ctx.userId,
    });
    void syncOrderScheduleEvent(id, 'cancelled', this.ctx.organizationId);
    return row;
  }

  // ── Write — manager actions ─────────────────────────────────────

  async approve(id: string, internalNotes?: string | null): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:approve');
    // C3: warehouse-scoped managers must have write access to the
    // request's warehouse before flipping its status. The RPC's
    // has_org_role check covers role; this covers scope.
    await this.requireWarehouseAccess(id, 'write');
    if (internalNotes !== undefined) {
      const { error } = await this.ctx.supabase
        .from('order_requests')
        .update({ internal_notes: internalNotes ?? null })
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', id);
      if (error) throw new ServiceError('internal_error', error.message);
    }
    const { data, error } = await this.ctx.supabase.rpc('approve_order_request', {
      p_id: id,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order request not found');
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Only managers can approve requests');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError('validation_error', 'This request is no longer pending approval');
      if (msg.includes('insufficient_stock'))
        throw new ServiceError(
          'validation_error',
          'Not enough stock to approve. Reduce quantities or top up the short items.',
        );
      if (msg.includes('item_warehouse_mismatch'))
        throw new ServiceError(
          'validation_error',
          'A line references an item from a different warehouse than the request.',
        );
      throw new ServiceError('internal_error', msg);
    }
    const row = data as OrderRequestRow;
    await audit(
      {
        event: 'order_request.approved',
        entityType: 'order_request',
        entityId: id,
      },
      this.ctx,
    );
    void this.notifyEmail(row, 'approved');
    void dispatchEvent(this.ctx.organizationId, 'order.approved', {
      id,
      orderNumber: formatOrderNumber(row.order_number) ?? id.slice(0, 8).toUpperCase(),
      approvedBy: this.ctx.userId,
    });
    void this.autoScheduleFromOrder(row);
    return row;
  }

  /**
   * Orders → Schedule: when an approved order carries a needed_by datetime,
   * auto-create a linked calendar event so the team sees the deadline without
   * anyone hand-copying it (mig 0255). Admin client because the approver may
   * lack schedule:manage / the schedule module — the event is a system
   * artifact of approval, not a user calendar write. created_by = the
   * approving user (column is NOT NULL and RLS update rights key off it).
   * The partial unique index makes re-approval after resume idempotent
   * (23505 → ignore). Fire-and-forget: never blocks or fails an approval.
   */
  private async autoScheduleFromOrder(row: OrderRequestRow): Promise<void> {
    try {
      if (!row.needed_by) return;
      const admin = createAdminClient();
      const so = formatOrderNumber(row.order_number) ?? row.id.slice(0, 8).toUpperCase();
      const requester = (row.requester_name as string | null) ?? null;
      const { error } = await admin.from('schedule_events').insert({
        organization_id: row.organization_id,
        title: `${so} ${row.fulfillment_type === 'delivery' ? 'delivery' : 'pickup'}${requester ? ` — ${requester}` : ''}`,
        starts_at: row.needed_by,
        warehouse_id: row.warehouse_id,
        requester_name: requester,
        details: `Auto-created from order ${so}. Needed by ${new Date(row.needed_by).toLocaleString('en-US')}.`,
        status: 'scheduled',
        order_request_id: row.id,
        assigned_user_id:
          (row as unknown as { assigned_delivery_user_id?: string | null })
            .assigned_delivery_user_id ?? null,
        created_by: this.ctx.userId,
      });
      if (error && error.code !== '23505') {
        void reportSrvError(new Error(error.message), {
          tag: 'orders.auto-schedule',
          organizationId: this.ctx.organizationId,
          extra: { orderId: row.id },
        });
      }
    } catch (e) {
      void reportSrvError(e, {
        tag: 'orders.auto-schedule',
        organizationId: this.ctx.organizationId,
      });
    }
  }

  /**
   * Approve a knowingly-short order: reserve what's available now and let the
   * unreservable remainder backorder at hand-over. The permissive sibling of
   * approve() — the strict path still refuses short orders. Manager+ only.
   */
  async approvePartial(id: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:approve');
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase.rpc('approve_partial', { p_id: id });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order request not found');
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Only managers can approve requests');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError('validation_error', 'This request is no longer pending approval');
      if (msg.includes('item_warehouse_mismatch'))
        throw new ServiceError(
          'validation_error',
          'A line references an item from a different warehouse than the request.',
        );
      throw new ServiceError('internal_error', msg);
    }
    const row = data as OrderRequestRow;
    await audit(
      { event: 'order_request.approved', entityType: 'order_request', entityId: id },
      this.ctx,
    );
    void this.notifyEmail(row, 'approved');
    void dispatchEvent(this.ctx.organizationId, 'order.approved', {
      id,
      orderNumber: formatOrderNumber(row.order_number) ?? id.slice(0, 8).toUpperCase(),
      approvedBy: this.ctx.userId,
    });
    void this.autoScheduleFromOrder(row);
    return row;
  }

  async generatePickSlip(id: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:approve');
    await this.requireWarehouseAccess(id, 'write');
    const { data: row, error } = await this.ctx.supabase
      .from('order_requests')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Order not found');
    if ((row as OrderRequestRow).status !== 'approved') {
      throw new ServiceError(
        'validation_error',
        'Pick slip can only be generated from an approved order.',
      );
    }
    const { data: updated, error: updErr } = await this.ctx.supabase
      .from('order_requests')
      .update({
        status: 'pick_slip_generated',
        pick_slip_generated_at: new Date().toISOString(),
        pick_slip_generated_by: this.ctx.userId,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();
    if (updErr) throw new ServiceError('internal_error', updErr.message);
    await audit(
      { event: 'order.pick_slip_generated', entityType: 'order_request', entityId: id },
      this.ctx,
    );
    return updated as OrderRequestRow;
  }

  async recordPickedLine(orderId: string, lineId: string, qty: number): Promise<void> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'items:update');
    // Warehouse-scope gate: the caller must be able to write to THIS order's
    // warehouse. The order id is the canonical entity we permission-check.
    await this.requireWarehouseAccess(orderId, 'write');
    // CRITICAL: the RPC picks by lineId and derives the order FROM the line,
    // checking only an org-level staff role — it does NOT verify the line
    // belongs to `orderId`. So without this check a warehouse-A picker could
    // pass a lineId from another warehouse's order (same org) and tamper with
    // its pick state, bypassing the warehouse gate above. Verify the line is on
    // the gated order before touching it. ctx.supabase is RLS-scoped, so the
    // line is also necessarily in the caller's org.
    const { data: lineRow, error: lineErr } = await this.ctx.supabase
      .from('order_request_lines')
      .select('id')
      .eq('id', lineId)
      .eq('order_request_id', orderId)
      .maybeSingle();
    if (lineErr) throw new ServiceError('internal_error', 'Could not verify the pick line.');
    if (!lineRow) throw new ServiceError('not_found', 'That line is not on this order.');

    const { error } = await this.ctx.supabase.rpc('partial_pick_line', {
      p_line_id: lineId,
      p_qty: qty,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('over_pick'))
        throw new ServiceError('validation_error', 'Picked quantity exceeds requested.');
      if (msg.includes('order_request_line_not_found'))
        throw new ServiceError('not_found', 'Line not found.');
      if (msg.includes('not_assigned_picker'))
        throw new ServiceError(
          'forbidden',
          'This order is assigned to another picker. Claim it or ask a manager to reassign it.',
        );
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Not allowed to pick on this order.');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError('validation_error', 'Order is not in a pickable status.');
      // Don't leak the raw Postgres/RPC text to a Bearer caller.
      throw new ServiceError('internal_error', 'Could not record the pick.');
    }
  }

  async completePicking(id: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'items:update');
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase.rpc('complete_picking', {
      p_order_id: id,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('insufficient_placed_stock')) {
        // Name the order's items so the picker knows exactly what to put away.
        let items = '';
        try {
          const { data: ln } = await this.ctx.supabase
            .from('order_request_lines')
            .select(
              'quantity_requested, quantity_fulfilled, item:inventory_items!item_id(name, sku)',
            )
            .eq('order_request_id', id);
          items = (
            (ln ?? []) as {
              quantity_requested: number;
              quantity_fulfilled: number;
              item: { name: string; sku: string } | { name: string; sku: string }[] | null;
            }[]
          )
            .map((l) => {
              const it = Array.isArray(l.item) ? l.item[0] : l.item;
              const owed = Math.max(
                0,
                (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0),
              );
              return it ? `${it.name} (${it.sku}) — ${owed} needed` : null;
            })
            .filter(Boolean)
            .join('; ');
        } catch {
          /* message still useful without the list */
        }
        throw new ServiceError(
          'validation_error',
          `Not enough PUT-AWAY stock to complete this pick. Part of this item's on-hand total is still in Staging (awaiting put-away) or unplaced, and picking can only draw from placed rack/crate stock. Fix: open Inventory → Staging, put away the needed units, then retry.${items ? ` Short line(s): ${items}.` : ''}`,
        );
      }
      if (msg.includes('insufficient_stock'))
        throw new ServiceError(
          'validation_error',
          'Not enough stock to complete picking. Reduce picked quantities or top up the short items.',
        );
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError('validation_error', 'Order is no longer being picked.');
      if (msg.includes('not_assigned_picker'))
        throw new ServiceError(
          'forbidden',
          'Only the assigned picker or a manager can complete picking for this order.',
        );
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Not allowed to complete picking on this order.');
      throw new ServiceError('internal_error', 'Could not complete picking.');
    }
    const row = data as OrderRequestRow;
    await audit(
      { event: 'order.picking_complete', entityType: 'order_request', entityId: id },
      this.ctx,
    );
    void broadcastOrderChanged(this.ctx.organizationId, id);
    return row;
  }

  /**
   * Resume fulfillment of a backordered order — reserve newly-available stock
   * up to each line's owed and re-open the pick + signature cycle (→
   * pick_slip_generated). Manager+ only; the RPC enforces backordered-only and
   * refuses when nothing is fulfillable yet.
   */
  async resumeFulfillment(id: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:approve');
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase.rpc('resume_fulfillment', { p_id: id });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order not found.');
      if (msg.includes('no_fulfillable_stock'))
        throw new ServiceError(
          'validation_error',
          'No stock is available yet to fulfill the backordered items. Top up the short items first.',
        );
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Only a manager can resume fulfillment.');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError('validation_error', 'Only a backordered order can be resumed.');
      throw new ServiceError('internal_error', 'Could not resume fulfillment.');
    }
    const row = data as OrderRequestRow;
    await audit(
      { event: 'order.fulfillment_resumed', entityType: 'order_request', entityId: id },
      this.ctx,
    );
    void broadcastOrderChanged(this.ctx.organizationId, id);
    return row;
  }

  /**
   * Close a backordered order as delivered-partial (→ completed). Keeps
   * quantity_fulfilled as the record of what was provided and releases the hold
   * on the un-shipped remainder; no stock moves. Manager+ only.
   */
  async closePartial(id: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:approve');
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase.rpc('close_partial', { p_id: id });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order not found.');
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Only a manager can close a backordered order.');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError(
          'validation_error',
          'Only a backordered order can be closed as delivered-partial.',
        );
      throw new ServiceError('internal_error', 'Could not close the order.');
    }
    const row = data as OrderRequestRow;
    await audit(
      { event: 'order.closed_partial', entityType: 'order_request', entityId: id },
      this.ctx,
    );
    // close_partial drives the order to the terminal 'completed' state, so
    // downstream order.completed consumers (accounting export, webhooks) must
    // see it too — otherwise the order shows open/backordered there forever.
    // The sign-route completion fires this; the manager close path must match.
    void dispatchEvent(this.ctx.organizationId, 'order.completed', {
      id,
      orderNumber: formatOrderNumber(row.order_number) ?? id.slice(0, 8).toUpperCase(),
      closedPartial: true,
    });
    // Return-prompt email (returns-access Unit A): close-partial reaches the
    // terminal 'completed' state WITHOUT any signature, so the requester
    // would otherwise never get the self-service return link the sign route
    // sends. The units from the earlier partial hand-over are returnable.
    // Best-effort + marker-deduped (0278) — never fails the close.
    try {
      await maybeSendReturnPrompt(createAdminClient(), id, {
        appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com',
      });
    } catch {
      /* best-effort — the order is closed regardless */
    }
    void broadcastOrderChanged(this.ctx.organizationId, id);
    return row;
  }

  /**
   * Record a PHYSICAL (paper) signature at hand-over — the in-app sibling of
   * the public sign page. The confirm_physical_signature RPC (0248) enforces
   * authorization (manager+ OR the assigned delivery driver), the unsigned +
   * hand-over-status guards, and runs the exact same partial-fulfillment fork
   * as the digital path (owed > 0 → backordered, else completed). This method
   * then fires the same requester notifications/events the sign route does,
   * so the customer experience is identical however the pen met paper —
   * including (returns-access Unit A) the one-time self-service return-link
   * email, deduped against the digital path via the 0278 marker.
   */
  async confirmPhysicalSignature(id: string, signerName: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    // No blanket permission assert: the RPC's own gate admits the assigned
    // delivery driver, who may legitimately lack orders:approve.
    const trimmed = signerName.trim();
    if (!trimmed) throw new ServiceError('validation_error', 'Signer name is required.');

    // Prior-shipped total BEFORE the hand-over — >0 means this completion is a
    // backorder remainder arriving, which gets its own requester notice.
    const { data: priorLines } = await this.ctx.supabase
      .from('order_request_lines')
      .select('quantity_fulfilled')
      .eq('order_request_id', id);
    const priorFulfilled = ((priorLines ?? []) as { quantity_fulfilled: number | null }[]).reduce(
      (s, l) => s + (Number(l.quantity_fulfilled) || 0),
      0,
    );

    const { data, error } = await this.ctx.supabase.rpc('confirm_physical_signature', {
      p_id: id,
      p_signer_name: trimmed,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order not found.');
      if (msg.includes('forbidden'))
        throw new ServiceError(
          'forbidden',
          'Only a manager or the assigned driver can record a physical signature.',
        );
      if (msg.includes('already_signed'))
        throw new ServiceError('conflict', 'This order already has a signature.');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError(
          'validation_error',
          'A signature can only be recorded once the order is staged or in transit.',
        );
      if (msg.includes('signer_name_required'))
        throw new ServiceError('validation_error', 'Signer name is required.');
      throw new ServiceError('internal_error', 'Could not record the signature.');
    }
    const row = data as OrderRequestRow;

    await audit(
      {
        event: 'order_request.status_changed',
        entityType: 'order_request',
        entityId: id,
        extra: { signatureMethod: 'physical', signerName: trimmed, status: row.status },
      },
      this.ctx,
    );

    // Post-hand-over notifications — identical outcomes to the sign route.
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com';
      // Requester opt-out read needs the service client: the caller's RLS
      // can't see another user's notification_preferences row.
      let emailOptedOut = false;
      if (row.requester_user_id && row.requester_email) {
        const admin = createAdminClient();
        const { data: prefRow } = await admin
          .from('notification_preferences')
          .select('email_order_completed')
          .eq('user_id', row.requester_user_id)
          .maybeSingle();
        emailOptedOut = !(
          (prefRow as { email_order_completed?: boolean } | null)?.email_order_completed ?? true
        );
      }

      const { data: aggLines } = await this.ctx.supabase
        .from('order_request_lines')
        .select('quantity_requested, quantity_fulfilled')
        .eq('order_request_id', id);
      const aggRows = (aggLines ?? []) as {
        quantity_requested: number | null;
        quantity_fulfilled: number | null;
      }[];
      const totalRequested = aggRows.reduce((s, l) => s + (Number(l.quantity_requested) || 0), 0);
      const totalFulfilled = aggRows.reduce((s, l) => s + (Number(l.quantity_fulfilled) || 0), 0);

      if (row.status === 'backordered') {
        await notifyRequesterBackordered({
          organizationId: this.ctx.organizationId,
          orderId: id,
          requesterUserId: row.requester_user_id ?? null,
          requesterEmail: row.requester_email ?? null,
          requesterName: row.requester_name ?? null,
          appUrl,
          provided: totalFulfilled,
          requested: totalRequested,
          owed: Math.max(0, totalRequested - totalFulfilled),
          emailOptedOut,
        });
        void dispatchEvent(this.ctx.organizationId, 'order.status_changed', {
          id,
          orderNumber: formatOrderNumber(row.order_number) ?? id.slice(0, 8).toUpperCase(),
          status: 'backordered',
        });
      } else if (row.status === 'completed') {
        void syncOrderScheduleEvent(id, 'completed', this.ctx.organizationId);
        if (priorFulfilled > 0) {
          await notifyRequesterBackorderShipped({
            organizationId: this.ctx.organizationId,
            orderId: id,
            requesterUserId: row.requester_user_id ?? null,
            requesterEmail: row.requester_email ?? null,
            requesterName: row.requester_name ?? null,
            appUrl,
            emailOptedOut,
            // Display-only: how many units the remainder batch carried.
            unitsShipped: Math.max(0, totalFulfilled - priorFulfilled),
          });
        }
        // Completion receipt to the requester (notifyEmail honors prefs +
        // public-link tokens itself).
        void this.notifyEmail(row, 'completed');
        // Return-prompt email (returns-access Unit A): a paper hand-over
        // completes the order without the sign route, so send the same
        // one-time self-service return link from here. Marker-deduped
        // (0278) + best-effort inside this try — never fails the signature.
        await maybeSendReturnPrompt(createAdminClient(), id, { appUrl });
        void dispatchEvent(this.ctx.organizationId, 'order.completed', {
          id,
          orderNumber: formatOrderNumber(row.order_number) ?? id.slice(0, 8).toUpperCase(),
          signerName: trimmed,
          signatureMethod: 'physical',
        });
      }
    } catch {
      /* notifications are best-effort — the signature is recorded regardless */
    }

    void broadcastOrderChanged(this.ctx.organizationId, id);
    return row;
  }

  /**
   * Claim an unassigned picking order for the current user — the race-safe
   * self-assign. The claim_picking RPC does a locked, unassigned-only write, so
   * two simultaneous claims cannot both win: the loser gets `conflict`.
   */
  async claimPicking(id: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'items:update');
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase.rpc('claim_picking', { p_order_id: id });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('already_claimed'))
        throw new ServiceError('conflict', 'This order has already been claimed by someone else.');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError(
          'validation_error',
          'This order is not in a claimable picking state.',
        );
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order not found.');
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'You do not have access to this order.');
      throw new ServiceError('internal_error', 'Could not claim picking.');
    }
    await audit(
      { event: 'order.picking_claimed', entityType: 'order_request', entityId: id },
      this.ctx,
    );
    void broadcastOrderChanged(this.ctx.organizationId, id);
    return data as OrderRequestRow;
  }

  /**
   * Manager+ only: assign OR reassign the picker to a specific member. Pushes an
   * assignment notification to the new picker (mirrors delivery assignment).
   */
  async assignPicking(id: string, pickerUserId: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    // Authorization (manager+) is enforced inside the RPC; keep the module gate
    // here. A blanket permission assert would wrongly block a manager who lacks
    // a specific granular permission but is manager-by-role.
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase.rpc('assign_picking', {
      p_order_id: id,
      p_user_id: pickerUserId,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('invalid_picker'))
        throw new ServiceError(
          'validation_error',
          'That user is not an active member of this organization.',
        );
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError(
          'validation_error',
          'A picker can only be assigned while the order is being picked.',
        );
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order not found.');
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Only a manager can assign or reassign the picker.');
      throw new ServiceError('internal_error', 'Could not assign the picker.');
    }
    const row = data as OrderRequestRow;
    await audit(
      {
        event: 'order.picker_assigned',
        entityType: 'order_request',
        entityId: id,
        extra: { assigned_picker_id: pickerUserId },
      },
      this.ctx,
    );
    // Notify the newly-assigned picker (push + bell), unless they assigned
    // themselves.
    if (pickerUserId !== this.ctx.userId) {
      void this.notifyPickerAssignment(pickerUserId, id, row.requester_name);
    }
    void broadcastOrderChanged(this.ctx.organizationId, id);
    return row;
  }

  /**
   * Release a picking claim: the assigned picker (self-release) or a manager+.
   * Authorization is enforced in the RPC. Picked quantities are preserved.
   */
  async releasePicking(id: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'items:update');
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase.rpc('release_picking', { p_order_id: id });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order not found.');
      if (msg.includes('forbidden'))
        throw new ServiceError(
          'forbidden',
          'Only the assigned picker or a manager can release this claim.',
        );
      throw new ServiceError('internal_error', 'Could not release the claim.');
    }
    await audit(
      { event: 'order.picking_released', entityType: 'order_request', entityId: id },
      this.ctx,
    );
    void broadcastOrderChanged(this.ctx.organizationId, id);
    return data as OrderRequestRow;
  }

  async generatePackingSlips(id: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:approve');
    await this.requireWarehouseAccess(id, 'write');

    const { data: row, error } = await this.ctx.supabase
      .from('order_requests')
      .select('status, signature_token, signed_at')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Order not found');

    // Accept BOTH first-time generation (picking_complete) AND re-
    // generation (packing_slip_generated). Regenerating mints a new
    // signature_token, which invalidates any QR already printed.
    if (
      (row as { status: OrderRequestStatus }).status !== 'picking_complete' &&
      (row as { status: OrderRequestStatus }).status !== 'packing_slip_generated'
    ) {
      throw new ServiceError(
        'validation_error',
        'Packing slips can only be generated after picking is complete.',
      );
    }

    // Block silent-QR-invalidation: once an order is signed, regenerating
    // the packing slip would mint a fresh signature_token and orphan the
    // signed record (the QR on the customer's slip would still point at
    // the now-stale token). The signed copy is the audit anchor — refuse
    // to regenerate after the fact.
    if ((row as { signed_at: string | null }).signed_at !== null) {
      throw new ServiceError(
        'validation_error',
        'This order has already been signed and completed. Re-generating packing slips would invalidate the signed record.',
      );
    }

    // 256-bit hex token, distinct from the public-request token
    // namespace (those live on organizations.public_request_token).
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: updated, error: updErr } = await this.ctx.supabase
      .from('order_requests')
      .update({
        status: 'packing_slip_generated',
        packing_slip_generated_at: new Date().toISOString(),
        packing_slip_generated_by: this.ctx.userId,
        signature_token: token,
        signature_token_expires_at: expiresAt,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();
    if (updErr) throw new ServiceError('internal_error', updErr.message);
    await audit(
      { event: 'order.packing_slip_generated', entityType: 'order_request', entityId: id },
      this.ctx,
    );
    // Generic lifecycle webhook for stages without a dedicated topic (the
    // created/approved/denied/in_transit/completed/cancelled events have their
    // own). Lets a subscriber follow the full order lifecycle via one stream.
    void dispatchEvent(this.ctx.organizationId, 'order.status_changed', {
      id,
      orderNumber:
        formatOrderNumber((updated as OrderRequestRow).order_number) ??
        id.slice(0, 8).toUpperCase(),
      status: 'packing_slip_generated',
    });
    // Owner decision 2026-07-20: the formerly-latent "being packaged" email
    // is live (requires ES_LATENT_ORDER_EMAILS=1 — sendOrderRequestEmail
    // fails closed without it). Honors email_order_status_changed prefs.
    void this.notifyEmail(updated as OrderRequestRow, 'packing_slip_generated');
    return updated as OrderRequestRow;
  }

  async stageOrder(
    id: string,
    target: 'staged_for_pickup' | 'staged_for_delivery',
  ): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:approve');
    await this.requireWarehouseAccess(id, 'write');

    const { data: row, error } = await this.ctx.supabase
      .from('order_requests')
      .select('status, fulfillment_type')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!row) throw new ServiceError('not_found', 'Order not found');
    const r = row as { status: OrderRequestStatus; fulfillment_type: 'pickup' | 'delivery' };
    if (r.status !== 'packing_slip_generated') {
      throw new ServiceError(
        'validation_error',
        'Order must be packing-slip-generated before staging.',
      );
    }
    if (target === 'staged_for_pickup' && r.fulfillment_type !== 'pickup') {
      throw new ServiceError('validation_error', 'Only pickup orders can be staged for pickup.');
    }
    if (target === 'staged_for_delivery' && r.fulfillment_type !== 'delivery') {
      throw new ServiceError(
        'validation_error',
        'Only delivery orders can be staged for delivery.',
      );
    }

    // Defense-in-depth: complete_picking (after 0121) codifies any
    // remaining NULL quantity_picked lines to 0, so staging should
    // never see ambiguous state. Guard here anyway — orders predating
    // 0121 may still have NULL lines, and a fresh service-layer check
    // gives a clearer error than letting a downstream consumer crash.
    const { count: unpickedCount, error: unpickedErr } = await this.ctx.supabase
      .from('order_request_lines')
      .select('id', { count: 'exact', head: true })
      .eq('order_request_id', id)
      .is('quantity_picked', null);
    if (unpickedErr) throw new ServiceError('internal_error', unpickedErr.message);
    if ((unpickedCount ?? 0) > 0) {
      throw new ServiceError(
        'validation_error',
        'Some lines were never resolved during picking. Re-open picking and complete it before staging.',
      );
    }

    const { data: updated, error: updErr } = await this.ctx.supabase
      .from('order_requests')
      .update({
        status: target,
        staged_at: new Date().toISOString(),
        staged_by: this.ctx.userId,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();
    if (updErr) throw new ServiceError('internal_error', updErr.message);
    await audit(
      {
        event:
          target === 'staged_for_pickup' ? 'order.staged_for_pickup' : 'order.staged_for_delivery',
        entityType: 'order_request',
        entityId: id,
      },
      this.ctx,
    );
    // Generic lifecycle webhook (no dedicated topic for staging).
    void dispatchEvent(this.ctx.organizationId, 'order.status_changed', {
      id,
      orderNumber:
        formatOrderNumber((updated as OrderRequestRow).order_number) ??
        id.slice(0, 8).toUpperCase(),
      status: target,
    });
    // Owner decision 2026-07-20: the formerly-latent "is ready" email is
    // live for DELIVERY staging (the template's pin-on-the-dock-line design
    // is delivery-shaped; pickup staging stays email-free). Fails closed
    // without ES_LATENT_ORDER_EMAILS=1.
    if (target === 'staged_for_delivery') {
      void this.notifyEmail(updated as OrderRequestRow, 'staged_for_delivery');
    }
    return updated as OrderRequestRow;
  }

  async assignDelivery(id: string, deliveryUserId: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:assign_delivery');
    await this.requireWarehouseAccess(id, 'write');

    // Defense-in-depth: assignee must be an active org member.
    const { data: member } = await this.ctx.supabase
      .from('organization_members')
      .select('user_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('user_id', deliveryUserId)
      .not('accepted_at', 'is', null)
      .maybeSingle();
    if (!member) {
      throw new ServiceError(
        'validation_error',
        'That user is not an active member of this organization.',
      );
    }

    const { data: row } = await this.ctx.supabase
      .from('order_requests')
      .select('status')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (!row) throw new ServiceError('not_found', 'Order not found');
    if ((row as { status: OrderRequestStatus }).status !== 'staged_for_delivery') {
      throw new ServiceError(
        'validation_error',
        'Delivery can only be assigned to staged-for-delivery orders.',
      );
    }

    const { data: updated, error } = await this.ctx.supabase
      .from('order_requests')
      .update({
        assigned_delivery_user_id: deliveryUserId,
        assigned_delivery_by: this.ctx.userId,
        assigned_delivery_at: new Date().toISOString(),
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    await audit(
      {
        event: 'order.delivery_assigned',
        entityType: 'order_request',
        entityId: id,
        extra: { assigned_delivery_user_id: deliveryUserId },
      },
      this.ctx,
    );
    // Bell/toast for the assignee (gated by their push pref).
    void this.notifyAssignment(deliveryUserId, id, (updated as OrderRequestRow).requester_name);
    // Keep the auto-created schedule event pointed at the current driver so
    // reminder pushes/emails reach the right person. Fire-and-forget; awaited
    // internally (bug-pattern #22: a bare void on a BUILDER is a no-op, so
    // this wraps the builder in a real async fn).
    void (async () => {
      try {
        await createAdminClient()
          .from('schedule_events')
          .update({ assigned_user_id: deliveryUserId })
          .eq('order_request_id', id);
      } catch (e) {
        void reportSrvError(e, {
          tag: 'orders.auto-schedule.assign',
          organizationId: this.ctx.organizationId,
        });
      }
    })();
    return updated as OrderRequestRow;
  }

  async markInTransit(id: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    // Authorization is "assigned driver OR manager+", enforced by the
    // per-user/role check below (after the row loads). We must NOT gate on
    // orders:approve up front: a staff member assigned as the delivery driver
    // legitimately lacks that permission, and a blanket assert here blocked
    // them from ever marking their OWN delivery in transit — the exact mobile
    // workflow this is for (audit 2026-06-09). requireWarehouseAccess('write')
    // + the assigned-driver/manager check below remain the real gates.
    await this.requireWarehouseAccess(id, 'write');

    const { data: row } = await this.ctx.supabase
      .from('order_requests')
      .select('status, assigned_delivery_user_id, fulfillment_type')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (!row) throw new ServiceError('not_found', 'Order not found');
    const r = row as {
      status: string;
      assigned_delivery_user_id: string | null;
      fulfillment_type: 'pickup' | 'delivery';
    };
    if (r.fulfillment_type !== 'delivery') {
      throw new ServiceError('validation_error', 'Only delivery orders can be marked in transit.');
    }
    if (r.status !== 'staged_for_delivery') {
      throw new ServiceError('validation_error', 'Order must be staged for delivery first.');
    }
    if (!r.assigned_delivery_user_id) {
      throw new ServiceError('validation_error', 'Assign a driver before marking in transit.');
    }

    // The action layer permits assigned-driver OR manager+. Check role
    // here only if the caller is NOT the assigned driver.
    if (r.assigned_delivery_user_id !== this.ctx.userId) {
      if (!isManagerOrAbove(this.ctx.role)) {
        throw new ServiceError(
          'forbidden',
          'Only the assigned driver or a manager can mark in transit.',
        );
      }
    }

    const { data: updated, error } = await this.ctx.supabase
      .from('order_requests')
      .update({
        status: 'in_transit',
        in_transit_at: new Date().toISOString(),
        in_transit_by: this.ctx.userId,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);
    const finalRow = updated as OrderRequestRow;
    await audit({ event: 'order.in_transit', entityType: 'order_request', entityId: id }, this.ctx);
    // Best-effort: notify requester the order is on the way.
    void this.notifyEmail(finalRow, 'in_transit');
    void dispatchEvent(this.ctx.organizationId, 'order.in_transit', {
      id,
      orderNumber: formatOrderNumber(finalRow.order_number) ?? id.slice(0, 8).toUpperCase(),
      markedBy: this.ctx.userId,
    });
    return finalRow;
  }

  async deny(id: string, reason: string): Promise<OrderRequestRow> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:approve');
    // C3: warehouse-scope gate before any mutation.
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase
      .from('order_requests')
      .update({
        status: 'denied' as OrderRequestStatus,
        denied_reason: reason,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .eq('status', 'pending_approval')
      .select('*')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data)
      throw new ServiceError(
        'validation_error',
        'Request not found or no longer pending approval.',
      );
    const row = data as OrderRequestRow;
    await audit(
      {
        event: 'order_request.denied',
        entityType: 'order_request',
        entityId: id,
        reason,
      },
      this.ctx,
    );
    void this.notifyEmail(row, 'denied');
    void dispatchEvent(this.ctx.organizationId, 'order.denied', {
      id,
      orderNumber: formatOrderNumber(row.order_number) ?? id.slice(0, 8).toUpperCase(),
      reason,
      deniedBy: this.ctx.userId,
    });
    void syncOrderScheduleEvent(id, 'cancelled', this.ctx.organizationId);

    // Zendesk shell: a denied order is an "order problem" ticket (best-effort).
    try {
      await this.ctx.supabase.rpc('publish_outbox', {
        p_org_id: this.ctx.organizationId,
        p_topic: 'order.problem',
        p_aggregate_type: 'order_request',
        p_aggregate_id: id,
        p_payload: {
          orderRequestId: id,
          requesterEmail: row.requester_email,
          requesterName: row.requester_name,
          reason,
        },
        p_dedupe_key: `order.problem:${id}`,
      });
    } catch {
      /* best-effort */
    }

    return row;
  }

  async setInternalNotes(id: string, notes: string | null): Promise<void> {
    assertModuleEnabled(this.ctx, 'orders');
    assertPermission(this.ctx, 'orders:approve');
    // C3: 'read' is enough for editing internal notes — the RLS UPDATE
    // policy further restricts writes to manager+, and we already
    // gated on `orders:approve`. A warehouse-scoped manager who can
    // READ a warehouse should be able to annotate its requests even
    // without write privileges on the warehouse itself.
    await this.requireWarehouseAccess(id, 'read');
    const { error } = await this.ctx.supabase
      .from('order_requests')
      .update({ internal_notes: notes })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  // ── Helper ──────────────────────────────────────────────────────

  /**
   * Loads the request's warehouse_id and asserts the caller can access
   * it for the requested op. Throws `not_found` when the row doesn't
   * exist or isn't in the caller's org. Returns the warehouse_id so
   * callers can reuse it (e.g. setStatus → warehouse-status lookup).
   */
  private async requireWarehouseAccess(requestId: string, op: 'read' | 'write'): Promise<string> {
    const { data, error } = await this.ctx.supabase
      .from('order_requests')
      .select('warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', requestId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) throw new ServiceError('not_found', 'Order request not found');
    const warehouseId = (data as { warehouse_id: string }).warehouse_id;
    await assertWarehouseAccess(warehouseId, op, this.ctx);
    return warehouseId;
  }

  // ── Public link admin ───────────────────────────────────────────

  async rotatePublicToken(): Promise<{ token: string }> {
    assertModuleEnabled(this.ctx, 'public_requests');
    // C1: org-level public-link admin (token rotation, blurb, per-warehouse
    // public_orderable toggle) writes to the `organizations` / `warehouses`
    // tables whose UPDATE RLS policies require admin+. Previously gated on
    // `orders:approve` (manager+), so a warehouse-scoped manager would pass
    // the service gate and then hit a confusing RLS denial at the DB. Align
    // service gate with RLS: admin+ only.
    assertPermission(this.ctx, 'organization:update');
    const token = generateToken();
    // Load the CURRENT token first: since migration 0261 the /r/<token>
    // read path resolves public_request_links FIRST, and the org's legacy
    // token lives on its migrated "General request link". Rotating only the
    // organizations column would leave the old token alive in the links
    // table — rotation would silently stop invalidating the old URL. So the
    // matching link row (same token) is rotated in the same operation.
    const { data: orgRow, error: readErr } = await this.ctx.supabase
      .from('organizations')
      .select('public_request_token')
      .eq('id', this.ctx.organizationId)
      .maybeSingle();
    if (readErr) throw new ServiceError('internal_error', readErr.message);
    const oldToken =
      (orgRow as { public_request_token: string | null } | null)?.public_request_token ?? null;
    const { error } = await this.ctx.supabase
      .from('organizations')
      .update({
        public_request_token: token,
        public_request_token_rotated_at: new Date().toISOString(),
      })
      .eq('id', this.ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);
    let linkSynced = false;
    if (oldToken) {
      const { data: updatedLinks, error: linkErr } = await this.ctx.supabase
        .from('public_request_links')
        .update({ token })
        .eq('organization_id', this.ctx.organizationId)
        .eq('token', oldToken)
        .select('id');
      if (linkErr) throw new ServiceError('internal_error', linkErr.message);
      linkSynced = (updatedLinks ?? []).length > 0;
    }
    if (!linkSynced) {
      // First-time enablement (or pre-0261 drift): no link row carries the
      // old token, so mint the org's "General request link" now with the
      // same frozen-behavior defaults as the 0261 backfill — exact counts,
      // books only, no public pool — and seed explicit entries for every
      // currently-eligible book so the page shows exactly what the legacy
      // flow would have shown. Without this, a fresh enablement between P1
      // and the P2 catalog editor would land on an empty catalog with no
      // way to fix it.
      const { data: newLink, error: insErr } = await this.ctx.supabase
        .from('public_request_links')
        .insert({
          organization_id: this.ctx.organizationId,
          name: 'General request link',
          token,
          active: true,
          availability_display: 'exact',
          books_enabled: true,
          items_enabled: false,
          include_public_pool: false,
          created_by: this.ctx.userId,
        })
        .select('id')
        .single();
      if (insErr || !newLink) {
        throw new ServiceError('internal_error', insErr?.message ?? 'link_create_failed');
      }
      const linkId = (newLink as { id: string }).id;
      await this.seedGeneralLinkEntries(linkId);
    }
    await audit(
      {
        event: 'order_request.public_link_rotated',
        entityType: 'organization',
        entityId: this.ctx.organizationId,
      },
      this.ctx,
    );
    return { token };
  }

  /**
   * Seeds a freshly-minted General request link with an explicit catalog
   * entry for every currently-eligible book (active, not deleted, in a
   * publicly-orderable warehouse) — the same freeze semantics as the 0261
   * backfill. Paginates the id scan (PostgREST caps a select at 1000 rows)
   * and chunk-inserts the entries.
   */
  private async seedGeneralLinkEntries(linkId: string): Promise<void> {
    const { data: whs, error: whErr } = await this.ctx.supabase
      .from('warehouses')
      .select('id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('is_public_orderable', true);
    if (whErr) throw new ServiceError('internal_error', whErr.message);
    const whIds = ((whs ?? []) as Array<{ id: string }>).map((w) => w.id);
    if (whIds.length === 0) return;

    const PAGE = 1000;
    let from = 0;
    for (;;) {
      const { data: items, error: itemsErr } = await this.ctx.supabase
        .from('inventory_items')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .in('warehouse_id', whIds)
        .eq('item_type', 'book')
        .eq('status', 'active')
        .is('deleted_at', null)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (itemsErr) throw new ServiceError('internal_error', itemsErr.message);
      const ids = ((items ?? []) as Array<{ id: string }>).map((i) => i.id);
      if (ids.length === 0) break;
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const { error: entryErr } = await this.ctx.supabase
          .from('public_link_catalog_entries')
          .upsert(
            chunk.map((itemId) => ({ link_id: linkId, item_id: itemId })),
            { onConflict: 'link_id,item_id' },
          );
        if (entryErr) throw new ServiceError('internal_error', entryErr.message);
      }
      if (ids.length < PAGE) break;
      from += PAGE;
    }
  }

  async setBlurb(blurb: string | null): Promise<void> {
    assertModuleEnabled(this.ctx, 'public_requests');
    // C1: writes `organizations.public_request_blurb`; RLS requires admin+.
    assertPermission(this.ctx, 'organization:update');
    const { error } = await this.ctx.supabase
      .from('organizations')
      .update({ public_request_blurb: blurb })
      .eq('id', this.ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async setWarehousePublicOrderable(warehouseId: string, on: boolean): Promise<void> {
    assertModuleEnabled(this.ctx, 'public_requests');
    // C1: writes `warehouses.is_public_orderable`; `warehouses_admin_write`
    // RLS requires admin+. Was previously `orders:approve` (manager+) which
    // let a manager-scoped session through the service gate and then trip
    // an RLS denial — confusing for the user.
    assertPermission(this.ctx, 'organization:update');
    const { error } = await this.ctx.supabase
      .from('warehouses')
      .update({ is_public_orderable: on })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', warehouseId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async getPublicSettings(): Promise<{
    token: string | null;
    rotatedAt: string | null;
    blurb: string | null;
    publicOrderableWarehouseIds: string[];
  }> {
    assertModuleEnabled(this.ctx, 'public_requests');
    const { data: org, error: oErr } = await this.ctx.supabase
      .from('organizations')
      .select('public_request_token, public_request_token_rotated_at, public_request_blurb')
      .eq('id', this.ctx.organizationId)
      .maybeSingle();
    if (oErr) throw new ServiceError('internal_error', oErr.message);
    const { data: whs } = await this.ctx.supabase
      .from('warehouses')
      .select('id, is_public_orderable')
      .eq('organization_id', this.ctx.organizationId);
    return {
      token: (org?.public_request_token as string | null) ?? null,
      rotatedAt: (org?.public_request_token_rotated_at as string | null) ?? null,
      blurb: (org?.public_request_blurb as string | null) ?? null,
      publicOrderableWarehouseIds: (whs ?? [])
        .filter((w) => Boolean((w as { is_public_orderable: boolean }).is_public_orderable))
        .map((w) => (w as { id: string }).id),
    };
  }

  // ── Private email helper ────────────────────────────────────────

  private async notifyEmail(
    row: OrderRequestRow,
    kind:
      | 'submitted'
      | 'approved'
      | 'denied'
      | 'packing_slip_generated'
      | 'staged_for_delivery'
      | 'in_transit'
      | 'completed'
      | 'cancelled',
  ): Promise<void> {
    try {
      const { recipientEmail, recipientName } = await this.resolveRecipient(row);
      if (!recipientEmail) return;
      // Phase 6 prefs (migration 0113): internal requesters can opt out
      // per-event. Public-link requesters (no requester_user_id) are
      // treated as transactional and always emailed.
      if (!(await this.wantsEmail(kind, row))) return;
      // M3: public-link requesters (no requester_user_id) get a
      // /r/track link in the email — that route's GET requires the
      // org's public_request_token, so load it here and pass through.
      // For authenticated requesters the email links to the
      // dashboard and doesn't need the token, but loading once and
      // sending it through is harmless.
      let publicRequestToken: string | null = null;
      if (!row.requester_user_id) {
        const { data: orgRow } = await this.ctx.supabase
          .from('organizations')
          .select('public_request_token')
          .eq('id', this.ctx.organizationId)
          .maybeSingle();
        publicRequestToken =
          (orgRow as { public_request_token?: string | null } | null)?.public_request_token ?? null;
      }
      await sendOrderRequestEmail({
        kind,
        request: row,
        recipientEmail,
        recipientName,
        appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com',
        publicRequestToken,
      });
    } catch (e) {
      console.warn('[order-requests] email send failed', e);
    }
  }

  /**
   * Returns true if we should send the given email kind to the
   * order's requester. Public-link requesters (no requester_user_id)
   * always get the email — they're transactional and have no profile
   * row to read a preference from. Internal requesters can opt out
   * per-event via notification_preferences (migration 0113).
   *
   * Reads the prefs row via the admin client because RLS on
   * notification_preferences restricts to `user_id = auth.uid()` and
   * the order's actor is usually a different user than the requester.
   * Fail-open on any infra error: dropping a notification silently is
   * worse than sending one the user opted out of.
   */
  private async wantsEmail(
    kind:
      | 'submitted'
      | 'approved'
      | 'denied'
      | 'packing_slip_generated'
      | 'staged_for_delivery'
      | 'in_transit'
      | 'completed'
      | 'cancelled',
    row: OrderRequestRow,
  ): Promise<boolean> {
    if (!row.requester_user_id) return true;

    const col = (() => {
      switch (kind) {
        case 'submitted':
          return 'email_order_received';
        case 'in_transit':
          return 'email_order_in_transit';
        case 'completed':
          return 'email_order_completed';
        case 'approved':
        case 'denied':
        case 'packing_slip_generated':
        case 'staged_for_delivery':
        case 'cancelled':
          return 'email_order_status_changed';
      }
    })();

    try {
      const admin = createAdminClient();
      const { data } = await admin
        .from('notification_preferences')
        .select(col)
        .eq('user_id', row.requester_user_id)
        .maybeSingle();
      const val = (data as Record<string, boolean | null> | null)?.[col];
      return val !== false;
    } catch (e) {
      console.warn('[order-requests] wantsEmail pref lookup failed', e);
      return true;
    }
  }

  /**
   * Bell + live-toast notification for a user just assigned to a
   * delivery. Gated by their push_order_assigned_to_me pref (0113).
   * Uses the admin client because the RLS policy on the
   * notifications table only permits inserts via service role
   * (per 0003_rls.sql:225). Fire-and-forget; the assignment itself
   * has already committed.
   */
  private async notifyAssignment(
    assigneeUserId: string,
    orderId: string,
    requesterName: string | null,
  ): Promise<void> {
    try {
      const admin = createAdminClient();
      const { data: pref } = await admin
        .from('notification_preferences')
        .select('push_order_assigned_to_me')
        .eq('user_id', assigneeUserId)
        .maybeSingle();
      const wantsPush =
        (pref as { push_order_assigned_to_me?: boolean | null } | null)
          ?.push_order_assigned_to_me !== false;
      if (!wantsPush) return;
      const body = requesterName
        ? `Delivery for ${requesterName} is assigned to you.`
        : 'A delivery has been assigned to you.';
      // Funnel through createNotification so the row insert AND the
      // Expo push to the user's mobile devices happen together.
      await createNotification({
        organizationId: this.ctx.organizationId,
        userId: assigneeUserId,
        type: 'order_request.delivery_assigned',
        title: 'New delivery assignment',
        body,
        link: `/dashboard/orders/${orderId}`,
        metadata: { order_request_id: orderId },
      });
    } catch (e) {
      console.warn('[order-requests] assignment notification failed', e);
    }
  }

  /**
   * Push + in-app bell to a picker a manager just assigned to an order.
   * Mirrors notifyAssignment; gated by the same push preference.
   */
  private async notifyPickerAssignment(
    pickerUserId: string,
    orderId: string,
    requesterName: string | null,
  ): Promise<void> {
    try {
      const admin = createAdminClient();
      const { data: pref } = await admin
        .from('notification_preferences')
        .select('push_order_assigned_to_me')
        .eq('user_id', pickerUserId)
        .maybeSingle();
      const wantsPush =
        (pref as { push_order_assigned_to_me?: boolean | null } | null)
          ?.push_order_assigned_to_me !== false;
      if (!wantsPush) return;
      const body = requesterName
        ? `You're assigned to pick the order for ${requesterName}.`
        : "You've been assigned to pick an order.";
      await createNotification({
        organizationId: this.ctx.organizationId,
        userId: pickerUserId,
        type: 'order_request.picker_assigned',
        title: 'New picking assignment',
        body,
        link: `/dashboard/orders/${orderId}`,
        metadata: { order_request_id: orderId },
      });
    } catch (e) {
      console.warn('[order-requests] picker assignment notification failed', e);
    }
  }

  private async resolveRecipient(
    row: OrderRequestRow,
  ): Promise<{ recipientEmail: string | null; recipientName: string | null }> {
    if (row.requester_email) {
      return { recipientEmail: row.requester_email, recipientName: row.requester_name ?? null };
    }
    if (row.requester_user_id) {
      const { data } = await this.ctx.supabase
        .from('user_profiles')
        .select('email, full_name')
        .eq('id', row.requester_user_id)
        .maybeSingle();
      return {
        recipientEmail: (data?.email as string | null) ?? null,
        recipientName: (data?.full_name as string | null) ?? null,
      };
    }
    return { recipientEmail: null, recipientName: null };
  }
}

function generateToken(): string {
  // Hex 64 chars; collision rate is irrelevant given the unique
  // partial index will catch the astronomically improbable clash.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
