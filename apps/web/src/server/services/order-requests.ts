import 'server-only';

import { assertWarehouseAccess } from '@/lib/auth/warehouse';

import { audit } from './audit';
import {
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
  | 'signature_requested'
  | 'completed'
  | 'denied'
  | 'cancelled';

export type OrderRequestSource = 'internal' | 'public_link';

export interface OrderRequestRow {
  id: string;
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
}

export interface OrderRequestDetail {
  request: OrderRequestRow;
  lines: OrderRequestLineWithItem[];
  reservations: ActiveReservation[];
  warehouseName: string | null;
  requesterDisplay: string;
}

export interface CreateOrderRequestInput {
  warehouseId: string;
  notes?: string | null;
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

export class OrderRequestsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new OrderRequestsService(await withContext());
  }

  // ── Read ────────────────────────────────────────────────────────

  async list(filters: {
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
  } = {}): Promise<OrderRequestSummary[]> {
    let q = this.ctx.supabase
      .from('order_requests')
      .select(
        // requester:user_profiles join resolves the actual member name
        // when requester_name was never written to the row (always the
        // case for internal in-app requests — only public-link external
        // requesters populate the requester_name / requester_email cols
        // at create time). RLS on user_profiles already lets org members
        // read each other, so this join is safe and cheap.
        `id, status, warehouse_id, requester_user_id, requester_email,
         requester_name, requester_org_label, source, notes,
         created_at, updated_at, approved_at, delivered_at,
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

    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const wh = r.warehouse as { name?: string } | { name?: string }[] | null;
      const warehouseName = Array.isArray(wh) ? (wh[0]?.name ?? null) : (wh?.name ?? null);
      const lines = (r.lines as Array<{ quantity_requested: number }> | null) ?? [];

      // Resolve the requester display from user_profiles when the row's
      // own requester_name / requester_email columns are null — that's
      // the internal-in-app case (only public-link external requests
      // populate those columns at create time).
      const reqJoin = r.requester as
        | { full_name?: string | null; email?: string | null }
        | { full_name?: string | null; email?: string | null }[]
        | null;
      const reqProfile = Array.isArray(reqJoin) ? reqJoin[0] ?? null : reqJoin;
      const requesterName =
        ((r.requester_name as string | null) ?? null) ||
        (reqProfile?.full_name?.trim() || null);
      const requesterEmail =
        ((r.requester_email as string | null) ?? null) ||
        (reqProfile?.email?.trim() || null);

      return {
        id: r.id as string,
        status: r.status as OrderRequestStatus,
        warehouseId: r.warehouse_id as string,
        warehouseName,
        requesterUserId: (r.requester_user_id as string | null) ?? null,
        requesterEmail,
        requesterName,
        requesterOrgLabel: (r.requester_org_label as string | null) ?? null,
        source: r.source as OrderRequestSource,
        lineCount: lines.length,
        totalQuantity: lines.reduce(
          (s, l) => s + (Number(l.quantity_requested) || 0),
          0,
        ),
        notes: (r.notes as string | null) ?? null,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
        approvedAt: (r.approved_at as string | null) ?? null,
        deliveredAt: (r.delivered_at as string | null) ?? null,
      } satisfies OrderRequestSummary;
    });
  }

  async myRequests(): Promise<OrderRequestSummary[]> {
    return this.list({ requesterUserId: this.ctx.userId });
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

  async get(id: string): Promise<OrderRequestDetail> {
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
           item:inventory_items!item_id (id, name, sku, quantity_on_hand, barcode)`,
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

    const flatLines: OrderRequestLineWithItem[] = (lines ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const itemField = r.item as
        | { id: string; name: string; sku: string; quantity_on_hand: number; barcode: string | null }
        | { id: string; name: string; sku: string; quantity_on_hand: number; barcode: string | null }[]
        | null;
      const item = Array.isArray(itemField) ? (itemField[0] ?? null) : (itemField ?? null);
      const rawPicked = r.quantity_picked as number | null | undefined;
      return {
        id: r.id as string,
        order_request_id: r.order_request_id as string,
        item_id: r.item_id as string,
        quantity_requested: Number(r.quantity_requested) || 0,
        quantity_fulfilled: Number(r.quantity_fulfilled) || 0,
        quantity_picked:
          rawPicked === null || rawPicked === undefined ? null : Number(rawPicked),
        unit_cost_at_request: Number(r.unit_cost_at_request) || 0,
        notes: (r.notes as string | null) ?? null,
        item,
      };
    });

    const { data: rs } = rsRes;
    const { data: wh } = whRes;

    const h = header as OrderRequestRow;
    const requesterDisplay = h.requester_user_id
      ? (await this.lookupUserDisplay(h.requester_user_id)) ?? '(team member)'
      : `${h.requester_name ?? 'External requester'}${h.requester_org_label ? ' · ' + h.requester_org_label : ''}`;

    return {
      request: h,
      lines: flatLines,
      reservations: (rs ?? []) as ActiveReservation[],
      warehouseName: (wh?.name as string | null) ?? null,
      requesterDisplay,
    };
  }

  private async lookupUserDisplay(userId: string): Promise<string | null> {
    const { data } = await this.ctx.supabase
      .from('user_profiles')
      .select('full_name, email')
      .eq('id', userId)
      .maybeSingle();
    if (!data) return null;
    return (data.full_name as string | null) || (data.email as string | null) || null;
  }

  // ── Write — requester actions ───────────────────────────────────

  async create(input: CreateOrderRequestInput): Promise<OrderRequestRow> {
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
      .select('id, warehouse_id, unit_cost')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', itemIds);
    if (iErr) throw new ServiceError('internal_error', iErr.message);
    const itemMap = new Map<string, { warehouse_id: string | null; unit_cost: number }>();
    for (const row of (items ?? []) as Array<{
      id: string;
      warehouse_id: string | null;
      unit_cost: number;
    }>) {
      itemMap.set(row.id, { warehouse_id: row.warehouse_id, unit_cost: Number(row.unit_cost) || 0 });
    }
    for (const line of input.lines) {
      const it = itemMap.get(line.itemId);
      if (!it) throw new ServiceError('validation_error', `Item ${line.itemId} not found`);
      if (it.warehouse_id !== input.warehouseId) {
        throw new ServiceError(
          'validation_error',
          'Every line must be at the chosen warehouse',
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
    const { error: lErr } = await this.ctx.supabase
      .from('order_request_lines')
      .insert(linePayload);
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
    return row;
  }

  async cancel(id: string, reason?: string | null): Promise<OrderRequestRow> {
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
    if (
      this.ctx.role !== 'owner' &&
      this.ctx.role !== 'admin' &&
      this.ctx.role !== 'manager'
    ) {
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
    return row;
  }

  // ── Write — manager actions ─────────────────────────────────────

  async approve(id: string, internalNotes?: string | null): Promise<OrderRequestRow> {
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
    return row;
  }

  async generatePickSlip(id: string): Promise<OrderRequestRow> {
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

  async recordPickedLine(lineId: string, qty: number): Promise<void> {
    assertPermission(this.ctx, 'items:update');
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
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Not allowed to pick on this order.');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError('validation_error', 'Order is not in a pickable status.');
      throw new ServiceError('internal_error', msg);
    }
  }

  async completePicking(id: string): Promise<OrderRequestRow> {
    assertPermission(this.ctx, 'items:update');
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase.rpc('complete_picking', {
      p_order_id: id,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('insufficient_stock'))
        throw new ServiceError(
          'validation_error',
          'Not enough stock to complete picking. Reduce picked quantities or top up the short items.',
        );
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError('validation_error', 'Order is no longer being picked.');
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Not allowed to complete picking on this order.');
      throw new ServiceError('internal_error', msg);
    }
    const row = data as OrderRequestRow;
    await audit(
      { event: 'order.picking_complete', entityType: 'order_request', entityId: id },
      this.ctx,
    );
    return row;
  }

  async generatePackingSlips(id: string): Promise<OrderRequestRow> {
    assertPermission(this.ctx, 'orders:approve');
    await this.requireWarehouseAccess(id, 'write');

    const { data: row, error } = await this.ctx.supabase
      .from('order_requests')
      .select('status, signature_token')
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
    return updated as OrderRequestRow;
  }

  async stageOrder(
    id: string,
    target: 'staged_for_pickup' | 'staged_for_delivery',
  ): Promise<OrderRequestRow> {
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
      throw new ServiceError(
        'validation_error',
        'Only pickup orders can be staged for pickup.',
      );
    }
    if (target === 'staged_for_delivery' && r.fulfillment_type !== 'delivery') {
      throw new ServiceError(
        'validation_error',
        'Only delivery orders can be staged for delivery.',
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
          target === 'staged_for_pickup'
            ? 'order.staged_for_pickup'
            : 'order.staged_for_delivery',
        entityType: 'order_request',
        entityId: id,
      },
      this.ctx,
    );
    return updated as OrderRequestRow;
  }

  async assignDelivery(id: string, deliveryUserId: string): Promise<OrderRequestRow> {
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
    return updated as OrderRequestRow;
  }

  async deny(id: string, reason: string): Promise<OrderRequestRow> {
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
    return row;
  }

  async setStatus(
    id: string,
    next: 'packing_slip_generated' | 'staged_for_delivery',
  ): Promise<OrderRequestRow> {
    assertPermission(this.ctx, 'orders:approve');
    // C3: warehouse-scope gate. The helper returns the warehouse_id so
    // we can reuse it for the staged-for-delivery sanity check below
    // without an extra round trip.
    const warehouseId = await this.requireWarehouseAccess(id, 'write');
    // M8: 'staged_for_delivery' implies an external handoff is on the
    // table. If the destination warehouse has been archived after the
    // request was approved, surface that as a friendlier error than
    // letting a downstream pickup hit a 404. We don't gate on
    // `is_public_orderable` itself — internal-only requests can still
    // be marked ready — but archived destinations are always wrong.
    if (next === 'staged_for_delivery') {
      const { data: wh } = await this.ctx.supabase
        .from('warehouses')
        .select('id, status')
        .eq('id', warehouseId)
        .maybeSingle();
      const whStatus = (wh as { status?: string } | null)?.status;
      if (!wh || whStatus === 'archived') {
        throw new ServiceError(
          'validation_error',
          'The destination warehouse is archived. Restore it or move the request before marking ready.',
        );
      }
    }
    const expectedPrev =
      next === 'packing_slip_generated' ? 'approved' : 'packing_slip_generated';
    const stampField =
      next === 'packing_slip_generated' ? 'packaging_at' : 'ready_at';
    const { data, error } = await this.ctx.supabase
      .from('order_requests')
      .update({
        status: next,
        [stampField]: new Date().toISOString(),
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .eq('status', expectedPrev)
      .select('*')
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data)
      throw new ServiceError(
        'validation_error',
        `Request not in '${expectedPrev}' status; cannot move to '${next}'.`,
      );
    const row = data as OrderRequestRow;
    await audit(
      {
        event: 'order_request.status_changed',
        entityType: 'order_request',
        entityId: id,
        after: { from: expectedPrev, to: next },
      },
      this.ctx,
    );
    void this.notifyEmail(row, next);
    return row;
  }

  async markDelivered(id: string): Promise<OrderRequestRow> {
    assertPermission(this.ctx, 'orders:approve');
    // C3: warehouse-scope gate before the deliver RPC fires stock
    // movements + reservation releases.
    await this.requireWarehouseAccess(id, 'write');
    const { data, error } = await this.ctx.supabase.rpc('deliver_order_request', {
      p_id: id,
    });
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('order_request_not_found'))
        throw new ServiceError('not_found', 'Order request not found');
      if (msg.includes('forbidden'))
        throw new ServiceError('forbidden', 'Only managers can mark delivered');
      if (msg.includes('invalid_status_transition'))
        throw new ServiceError(
          'validation_error',
          'Only approved / packing-slip-generated / staged orders can be marked completed.',
        );
      if (msg.includes('insufficient_stock'))
        // I4: prior copy said "edit line qtys", which doesn't match the
        // actual remediation — line quantities aren't editable post-
        // approval. The correct fix is to top-up / transfer-in stock
        // and retry the deliver.
        throw new ServiceError(
          'validation_error',
          'Stock has dropped below what the request asked for since approval. Adjust stock first, then retry.',
        );
      throw new ServiceError('internal_error', msg);
    }
    const row = data as OrderRequestRow;
    await audit(
      {
        event: 'order_request.delivered',
        entityType: 'order_request',
        entityId: id,
      },
      this.ctx,
    );
    void this.notifyEmail(row, 'completed');
    return row;
  }

  async setInternalNotes(id: string, notes: string | null): Promise<void> {
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
  private async requireWarehouseAccess(
    requestId: string,
    op: 'read' | 'write',
  ): Promise<string> {
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
    // C1: org-level public-link admin (token rotation, blurb, per-warehouse
    // public_orderable toggle) writes to the `organizations` / `warehouses`
    // tables whose UPDATE RLS policies require admin+. Previously gated on
    // `orders:approve` (manager+), so a warehouse-scoped manager would pass
    // the service gate and then hit a confusing RLS denial at the DB. Align
    // service gate with RLS: admin+ only.
    assertPermission(this.ctx, 'organization:update');
    const token = generateToken();
    const { error } = await this.ctx.supabase
      .from('organizations')
      .update({
        public_request_token: token,
        public_request_token_rotated_at: new Date().toISOString(),
      })
      .eq('id', this.ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);
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

  async setBlurb(blurb: string | null): Promise<void> {
    // C1: writes `organizations.public_request_blurb`; RLS requires admin+.
    assertPermission(this.ctx, 'organization:update');
    const { error } = await this.ctx.supabase
      .from('organizations')
      .update({ public_request_blurb: blurb })
      .eq('id', this.ctx.organizationId);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  async setWarehousePublicOrderable(
    warehouseId: string,
    on: boolean,
  ): Promise<void> {
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
      | 'completed'
      | 'cancelled',
  ): Promise<void> {
    try {
      const { recipientEmail, recipientName } = await this.resolveRecipient(row);
      if (!recipientEmail) return;
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
          (orgRow as { public_request_token?: string | null } | null)
            ?.public_request_token ?? null;
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
