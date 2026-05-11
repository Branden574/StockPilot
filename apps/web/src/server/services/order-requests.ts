import 'server-only';

import { audit } from './audit';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';

import { sendOrderRequestEmail } from '@/lib/email/order-requests';

export type OrderRequestStatus =
  | 'pending_approval'
  | 'approved'
  | 'packaging'
  | 'ready_for_delivery'
  | 'delivered'
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
}

export interface OrderRequestLineRow {
  id: string;
  order_request_id: string;
  item_id: string;
  quantity_requested: number;
  quantity_fulfilled: number;
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
  } = {}): Promise<OrderRequestSummary[]> {
    let q = this.ctx.supabase
      .from('order_requests')
      .select(
        `id, status, warehouse_id, requester_user_id, requester_email,
         requester_name, requester_org_label, source, notes,
         created_at, updated_at, approved_at, delivered_at,
         warehouse:warehouses!warehouse_id (name),
         lines:order_request_lines (quantity_requested)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false });

    if (filters.status) {
      const arr = Array.isArray(filters.status) ? filters.status : [filters.status];
      q = q.in('status', arr);
    }
    if (filters.requesterUserId) q = q.eq('requester_user_id', filters.requesterUserId);
    if (filters.requesterEmail) q = q.eq('requester_email', filters.requesterEmail);
    if (filters.warehouseId) q = q.eq('warehouse_id', filters.warehouseId);

    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = Math.max(0, filters.offset ?? 0);
    q = q.range(offset, offset + limit - 1);

    const { data, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);

    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const wh = r.warehouse as { name?: string } | { name?: string }[] | null;
      const warehouseName = Array.isArray(wh) ? (wh[0]?.name ?? null) : (wh?.name ?? null);
      const lines = (r.lines as Array<{ quantity_requested: number }> | null) ?? [];
      return {
        id: r.id as string,
        status: r.status as OrderRequestStatus,
        warehouseId: r.warehouse_id as string,
        warehouseName,
        requesterUserId: (r.requester_user_id as string | null) ?? null,
        requesterEmail: (r.requester_email as string | null) ?? null,
        requesterName: (r.requester_name as string | null) ?? null,
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

    const { data: lines, error: lErr } = await this.ctx.supabase
      .from('order_request_lines')
      .select(
        `id, order_request_id, item_id, quantity_requested,
         quantity_fulfilled, unit_cost_at_request, notes,
         item:inventory_items!item_id (id, name, sku, quantity_on_hand, barcode)`,
      )
      .eq('order_request_id', id);
    if (lErr) throw new ServiceError('internal_error', lErr.message);

    const flatLines: OrderRequestLineWithItem[] = (lines ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const itemField = r.item as
        | { id: string; name: string; sku: string; quantity_on_hand: number; barcode: string | null }
        | { id: string; name: string; sku: string; quantity_on_hand: number; barcode: string | null }[]
        | null;
      const item = Array.isArray(itemField) ? (itemField[0] ?? null) : (itemField ?? null);
      return {
        id: r.id as string,
        order_request_id: r.order_request_id as string,
        item_id: r.item_id as string,
        quantity_requested: Number(r.quantity_requested) || 0,
        quantity_fulfilled: Number(r.quantity_fulfilled) || 0,
        unit_cost_at_request: Number(r.unit_cost_at_request) || 0,
        notes: (r.notes as string | null) ?? null,
        item,
      };
    });

    const { data: rs } = await this.ctx.supabase
      .from('stock_reservations')
      .select('id, item_id, warehouse_id, quantity, created_at')
      .eq('order_request_id', id)
      .is('released_at', null);

    const { data: wh } = await this.ctx.supabase
      .from('warehouses')
      .select('name')
      .eq('id', (header as OrderRequestRow).warehouse_id)
      .maybeSingle();

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

    const { data: header, error: hErr } = await this.ctx.supabase
      .from('order_requests')
      .insert({
        organization_id: this.ctx.organizationId,
        warehouse_id: input.warehouseId,
        requester_user_id: this.ctx.userId,
        notes: input.notes ?? null,
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

  async deny(id: string, reason: string): Promise<OrderRequestRow> {
    assertPermission(this.ctx, 'orders:approve');
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
    next: 'packaging' | 'ready_for_delivery',
  ): Promise<OrderRequestRow> {
    assertPermission(this.ctx, 'orders:approve');
    const expectedPrev =
      next === 'packaging' ? 'approved' : 'packaging';
    const stampField =
      next === 'packaging' ? 'packaging_at' : 'ready_at';
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
          'Only approved / packaging / ready orders can be marked delivered.',
        );
      if (msg.includes('insufficient_stock'))
        throw new ServiceError(
          'validation_error',
          'Stock has dropped below what the request asked for since approval. Edit line qtys to actual delivered amounts and retry.',
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
    void this.notifyEmail(row, 'delivered');
    return row;
  }

  async setInternalNotes(id: string, notes: string | null): Promise<void> {
    assertPermission(this.ctx, 'orders:approve');
    const { error } = await this.ctx.supabase
      .from('order_requests')
      .update({ internal_notes: notes })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
  }

  // ── Public link admin ───────────────────────────────────────────

  async rotatePublicToken(): Promise<{ token: string }> {
    assertPermission(this.ctx, 'orders:approve');
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
    assertPermission(this.ctx, 'orders:approve');
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
    assertPermission(this.ctx, 'orders:approve');
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
      | 'packaging'
      | 'ready_for_delivery'
      | 'delivered'
      | 'cancelled',
  ): Promise<void> {
    try {
      const { recipientEmail, recipientName } = await this.resolveRecipient(row);
      if (!recipientEmail) return;
      await sendOrderRequestEmail({
        kind,
        request: row,
        recipientEmail,
        recipientName,
        appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'https://stockpilotusa.com',
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
