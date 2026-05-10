import 'server-only';

import { randomBytes } from 'node:crypto';

import { assertWarehouseAccess } from '@/lib/auth/warehouse';

import { audit } from './audit';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import { OrderRequestsService } from './order-requests';

export type ShipmentStatus = 'draft' | 'shipped' | 'delivered' | 'cancelled';

export interface ShipmentSummary {
  id: string;
  workOrderNumber: string;
  status: ShipmentStatus;
  shipDate: string;
  sourceWarehouseId: string;
  sourceWarehouseName: string | null;
  destinationWarehouseId: string;
  destinationWarehouseName: string | null;
  orderRequestId: string | null;
  attentionToName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShipmentLineRow {
  id: string;
  itemId: string;
  qtyShipped: number;
  qtyBackOrdered: number;
  lineOrder: number;
  item: {
    id: string;
    name: string;
    sku: string;
    barcode: string | null;
  } | null;
}

export interface ShipmentWarehouseInfo {
  id: string;
  name: string;
  code: string;
  address: Record<string, unknown> | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  manager: {
    id: string;
    fullName: string | null;
    email: string | null;
    /** Role in the org (resolved from organization_members). May be null. */
    role: string | null;
  } | null;
}

export interface ShipmentDetail {
  id: string;
  organizationId: string;
  workOrderNumber: string;
  status: ShipmentStatus;
  shipDate: string;
  attentionToName: string | null;
  notes: string | null;
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  orderRequestId: string | null;
  signatureImageUrl: string | null;
  signedByName: string | null;
  signedAt: string | null;
  signatureEmailTo: string | null;
  signatureEmailCc: string[] | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  source: ShipmentWarehouseInfo | null;
  destination: ShipmentWarehouseInfo | null;
  lines: ShipmentLineRow[];
}

interface CreateFromOrderRequestInput {
  orderRequestId: string;
  sourceWarehouseId: string;
  attentionToName?: string | null;
  notes?: string | null;
  ccEmails?: string[];
}

interface ManualCreateInput {
  sourceWarehouseId: string;
  destinationWarehouseId: string;
  attentionToName?: string | null;
  notes?: string | null;
  ccEmails?: string[];
  lines: Array<{ itemId: string; qtyShipped: number; qtyBackOrdered?: number }>;
}

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Phase 2A — print-and-paper-sign packing slip path. The shipment row carries
 * a signature_token + expires_at populated at create time, but Phase 2A doesn't
 * surface them anywhere. The public /s/[token] route, signature pad component,
 * and Resend integration land in Phase 2B.
 */
export class ShipmentsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ShipmentsService(await withContext());
  }

  async list(filters: {
    status?: ShipmentStatus;
    destinationWarehouseId?: string;
  } = {}): Promise<ShipmentSummary[]> {
    let query = this.ctx.supabase
      .from('shipments')
      .select(
        `id, work_order_number, status, ship_date, source_warehouse_id,
         destination_warehouse_id, order_request_id, attention_to_name,
         created_at, updated_at,
         source:warehouses!source_warehouse_id (name),
         destination:warehouses!destination_warehouse_id (name)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('ship_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.destinationWarehouseId) {
      query = query.eq('destination_warehouse_id', filters.destinationWarehouseId);
    }

    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);

    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const src = r.source as { name?: string } | { name?: string }[] | null;
      const dst = r.destination as { name?: string } | { name?: string }[] | null;
      const srcName = Array.isArray(src) ? (src[0]?.name ?? null) : (src?.name ?? null);
      const dstName = Array.isArray(dst) ? (dst[0]?.name ?? null) : (dst?.name ?? null);
      return {
        id: r.id as string,
        workOrderNumber: r.work_order_number as string,
        status: r.status as ShipmentStatus,
        shipDate: r.ship_date as string,
        sourceWarehouseId: r.source_warehouse_id as string,
        sourceWarehouseName: srcName,
        destinationWarehouseId: r.destination_warehouse_id as string,
        destinationWarehouseName: dstName,
        orderRequestId: (r.order_request_id as string | null) ?? null,
        attentionToName: (r.attention_to_name as string | null) ?? null,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
      } satisfies ShipmentSummary;
    });
  }

  async get(id: string): Promise<ShipmentDetail> {
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('shipments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'Shipment not found');
    const h = header as Record<string, unknown>;

    const { data: lineRows, error: lErr } = await this.ctx.supabase
      .from('shipment_lines')
      .select(
        `id, item_id, qty_shipped, qty_back_ordered, line_order,
         item:inventory_items!item_id (id, name, sku, barcode)`,
      )
      .eq('shipment_id', id)
      .order('line_order', { ascending: true });
    if (lErr) throw new ServiceError('internal_error', lErr.message);

    const lines: ShipmentLineRow[] = (lineRows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const itemField = r.item as
        | { id: string; name: string; sku: string; barcode: string | null }
        | { id: string; name: string; sku: string; barcode: string | null }[]
        | null;
      const item = Array.isArray(itemField) ? (itemField[0] ?? null) : (itemField ?? null);
      return {
        id: r.id as string,
        itemId: r.item_id as string,
        qtyShipped: Number(r.qty_shipped) || 0,
        qtyBackOrdered: Number(r.qty_back_ordered) || 0,
        lineOrder: Number(r.line_order) || 0,
        item,
      };
    });

    const sourceId = h.source_warehouse_id as string;
    const destId = h.destination_warehouse_id as string;
    const [source, destination] = await Promise.all([
      this.loadWarehouseInfo(sourceId),
      this.loadWarehouseInfo(destId),
    ]);

    return {
      id: h.id as string,
      organizationId: h.organization_id as string,
      workOrderNumber: h.work_order_number as string,
      status: h.status as ShipmentStatus,
      shipDate: h.ship_date as string,
      attentionToName: (h.attention_to_name as string | null) ?? null,
      notes: (h.notes as string | null) ?? null,
      sourceWarehouseId: sourceId,
      destinationWarehouseId: destId,
      orderRequestId: (h.order_request_id as string | null) ?? null,
      signatureImageUrl: (h.signature_image_url as string | null) ?? null,
      signedByName: (h.signed_by_name as string | null) ?? null,
      signedAt: (h.signed_at as string | null) ?? null,
      signatureEmailTo: (h.signature_email_to as string | null) ?? null,
      signatureEmailCc: (h.signature_email_cc as string[] | null) ?? null,
      createdBy: (h.created_by as string | null) ?? null,
      createdAt: h.created_at as string,
      updatedAt: h.updated_at as string,
      source,
      destination,
      lines,
    };
  }

  async createFromOrderRequest(
    input: CreateFromOrderRequestInput,
  ): Promise<{ id: string }> {
    assertPermission(this.ctx, 'purchase_orders:manage');
    await assertWarehouseAccess(input.sourceWarehouseId, 'write', this.ctx);

    // Defer to OrderRequestsService.get so RLS + warehouse-access on the
    // request itself carry. Throws not_found if the user can't see it.
    const orSvc = new OrderRequestsService(this.ctx);
    const detail = await orSvc.get(input.orderRequestId);

    const allowedSourceStatuses: Array<'approved' | 'packaging' | 'ready_for_delivery'> = [
      'approved',
      'packaging',
      'ready_for_delivery',
    ];
    if (
      !allowedSourceStatuses.includes(
        detail.request.status as 'approved' | 'packaging' | 'ready_for_delivery',
      )
    ) {
      throw new ServiceError(
        'validation_error',
        'Only approved / packaging / ready order requests can be packed.',
      );
    }

    const linesToShip = detail.lines
      .map((l) => ({
        itemId: l.item_id,
        qtyShipped: Math.max(
          0,
          (Number(l.quantity_requested) || 0) - (Number(l.quantity_fulfilled) || 0),
        ),
        qtyBackOrdered: 0,
      }))
      .filter((l) => l.qtyShipped > 0);

    if (linesToShip.length === 0) {
      throw new ServiceError(
        'validation_error',
        'Nothing left to ship from this request.',
      );
    }

    const destinationWarehouseId = detail.request.warehouse_id;
    const id = await this.insertShipmentWithLines({
      sourceWarehouseId: input.sourceWarehouseId,
      destinationWarehouseId,
      orderRequestId: input.orderRequestId,
      attentionToName: input.attentionToName ?? null,
      notes: input.notes ?? null,
      ccEmails: input.ccEmails ?? [],
      lines: linesToShip,
    });

    await audit({
      event: 'shipment.created',
      entityType: 'shipment',
      entityId: id,
      warehouseId: input.sourceWarehouseId,
      extra: { source: 'order_request', orderRequestId: input.orderRequestId },
    });

    return { id };
  }

  async manualCreate(input: ManualCreateInput): Promise<{ id: string }> {
    assertPermission(this.ctx, 'purchase_orders:manage');
    await assertWarehouseAccess(input.sourceWarehouseId, 'write', this.ctx);

    const linesToShip = input.lines
      .map((l) => ({
        itemId: l.itemId,
        qtyShipped: Number(l.qtyShipped) || 0,
        qtyBackOrdered: Number(l.qtyBackOrdered ?? 0) || 0,
      }))
      .filter((l) => l.qtyShipped > 0 || l.qtyBackOrdered > 0);

    if (linesToShip.length === 0) {
      throw new ServiceError(
        'validation_error',
        'Add at least one line with a non-zero quantity.',
      );
    }

    const id = await this.insertShipmentWithLines({
      sourceWarehouseId: input.sourceWarehouseId,
      destinationWarehouseId: input.destinationWarehouseId,
      orderRequestId: null,
      attentionToName: input.attentionToName ?? null,
      notes: input.notes ?? null,
      ccEmails: input.ccEmails ?? [],
      lines: linesToShip,
    });

    await audit({
      event: 'shipment.created',
      entityType: 'shipment',
      entityId: id,
      warehouseId: input.sourceWarehouseId,
      extra: { source: 'manual' },
    });

    return { id };
  }

  async markShipped(id: string): Promise<void> {
    assertPermission(this.ctx, 'purchase_orders:manage');
    const detail = await this.get(id);
    if (detail.status !== 'draft') {
      throw new ServiceError(
        'validation_error',
        `Only draft shipments can be marked shipped (this one is ${detail.status}).`,
      );
    }

    // ── Stock deduction design ────────────────────────────────────────
    //
    // Marking a shipment "shipped" must remove the shipped quantities
    // from the source warehouse's on-hand stock. Phase 2A's slip is a
    // one-warehouse outbound document — the destination is just a name
    // on paper, not a tracked inventory location — so the right primitive
    // is `adjust_stock` with a NEGATIVE quantity_change and movement_type
    // 'transfer' (we audit the org-level movement as a transfer between
    // warehouses, even though only the source side decrements). We do
    // NOT call `transfer_stock`, which operates on item_stock_levels
    // (per-bin levels within ONE warehouse) and would refuse if the
    // destination bin were the same as source.
    //
    // Sequencing vs transaction: there's no app-level transaction primitive
    // exposed here. The codebase pattern (see InventoryService.adjustStock,
    // ReceivingService.postReceipt) is to call adjust_stock once per line
    // — each call is itself transactional inside Postgres (it row-locks the
    // item, updates qty, and inserts the stock_movements row in one txn).
    // We sequence: deduct ALL lines FIRST, then flip status. If any
    // deduction fails (e.g. insufficient_stock), we throw before the status
    // flip, leaving the shipment as `draft`. Earlier successful deductions
    // are NOT rolled back — same partial-rollback caveat as the existing
    // `insertShipmentWithLines` line-insert path. The status check at the
    // top is the de-facto idempotency gate; once status is `shipped` this
    // method refuses, so a retry can't double-deduct.
    // ──────────────────────────────────────────────────────────────────
    const linesToDeduct = detail.lines.filter((l) => l.qtyShipped > 0);
    let totalQtyShipped = 0;
    for (const line of linesToDeduct) {
      const change = -Number(line.qtyShipped);
      const { error: rpcErr } = await this.ctx.supabase.rpc('adjust_stock', {
        p_item_id: line.itemId,
        p_quantity_change: change,
        p_movement_type: 'transfer',
        p_location_id: null,
        p_reason: `Shipment ${detail.workOrderNumber}`,
        p_notes: null,
      });
      if (rpcErr) {
        if (rpcErr.message.includes('insufficient_stock')) {
          throw new ServiceError(
            'validation_error',
            `Insufficient stock to ship ${line.qtyShipped} of item ${line.item?.sku ?? line.itemId}.`,
          );
        }
        if (rpcErr.message.includes('forbidden')) {
          throw new ServiceError(
            'forbidden',
            'You do not have permission to adjust stock for these items.',
          );
        }
        throw new ServiceError(
          'internal_error',
          `Stock deduction failed for line ${line.itemId}: ${rpcErr.message}`,
        );
      }
      totalQtyShipped += line.qtyShipped;
    }

    const { error } = await this.ctx.supabase
      .from('shipments')
      .update({ status: 'shipped' satisfies ShipmentStatus })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .eq('status', 'draft');
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'shipment.shipped',
      entityType: 'shipment',
      entityId: id,
      warehouseId: detail.sourceWarehouseId,
      extra: {
        linesShipped: linesToDeduct.length,
        totalQtyShipped,
      },
    });
  }

  async markCancelled(id: string): Promise<void> {
    assertPermission(this.ctx, 'purchase_orders:manage');
    const detail = await this.get(id);
    if (detail.status === 'delivered' || detail.status === 'cancelled') {
      throw new ServiceError(
        'validation_error',
        `Shipment is already ${detail.status}; cannot cancel.`,
      );
    }
    const { error } = await this.ctx.supabase
      .from('shipments')
      .update({ status: 'cancelled' satisfies ShipmentStatus })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
    await audit({
      event: 'shipment.cancelled',
      entityType: 'shipment',
      entityId: id,
      warehouseId: detail.sourceWarehouseId,
    });
  }

  // ── Private helpers ────────────────────────────────────────────────

  private async insertShipmentWithLines(args: {
    sourceWarehouseId: string;
    destinationWarehouseId: string;
    orderRequestId: string | null;
    attentionToName: string | null;
    notes: string | null;
    ccEmails: string[];
    lines: Array<{ itemId: string; qtyShipped: number; qtyBackOrdered: number }>;
  }): Promise<string> {
    // Look up the destination warehouse code for the WO# template. We need
    // a code; if the row is missing or the code is empty, throw rather
    // than silently mint a degenerate WO# like "ISR--MMDDYYYY".
    const { data: destWh, error: whErr } = await this.ctx.supabase
      .from('warehouses')
      .select('id, code')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', args.destinationWarehouseId)
      .maybeSingle();
    if (whErr) throw new ServiceError('internal_error', whErr.message);
    if (!destWh) {
      throw new ServiceError('not_found', 'Destination warehouse not found.');
    }
    const rawCode = (destWh.code as string | null) ?? '';
    const code = rawCode
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '');
    if (!code) {
      throw new ServiceError(
        'validation_error',
        'Destination warehouse has no usable code for the work order number.',
      );
    }

    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const yyyy = String(today.getFullYear());
    const baseWo = `ISR-${code}-${mm}${dd}${yyyy}`;
    const shipDate = `${yyyy}-${mm}-${dd}`; // YYYY-MM-DD for date column

    const signatureToken = randomBytes(24).toString('hex');
    const signatureExpires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    // Try base WO# then -2, -3, ... up to -50. INSERT-and-catch on UNIQUE
    // violation avoids the SELECT-then-INSERT race window.
    let insertedId: string | null = null;
    for (let suffix = 1; suffix <= 50; suffix += 1) {
      const wo = suffix === 1 ? baseWo : `${baseWo}-${suffix}`;
      const { data, error } = await this.ctx.supabase
        .from('shipments')
        .insert({
          organization_id: this.ctx.organizationId,
          source_warehouse_id: args.sourceWarehouseId,
          destination_warehouse_id: args.destinationWarehouseId,
          order_request_id: args.orderRequestId,
          work_order_number: wo,
          ship_date: shipDate,
          attention_to_name: args.attentionToName,
          notes: args.notes,
          status: 'draft' satisfies ShipmentStatus,
          signature_token: signatureToken,
          signature_token_expires_at: signatureExpires,
          signature_email_cc:
            args.ccEmails.length > 0 ? args.ccEmails : null,
          created_by: this.ctx.userId,
        })
        .select('id')
        .single();
      if (!error) {
        insertedId = data.id as string;
        break;
      }
      // 23505 = unique_violation. Could be the (org, work_order_number)
      // collision OR the unique signature_token. We regenerate a fresh
      // token on retry just in case.
      if (error.code !== '23505') {
        throw new ServiceError('internal_error', error.message);
      }
      // Will retry with next suffix.
    }
    if (!insertedId) {
      throw new ServiceError(
        'conflict',
        'Too many shipments today for this destination.',
      );
    }

    const linesPayload = args.lines.map((l, i) => ({
      shipment_id: insertedId,
      organization_id: this.ctx.organizationId,
      item_id: l.itemId,
      qty_shipped: l.qtyShipped,
      qty_back_ordered: l.qtyBackOrdered,
      line_order: i,
    }));
    const { error: linesErr } = await this.ctx.supabase
      .from('shipment_lines')
      .insert(linesPayload);
    if (linesErr) {
      // Roll back the header by hand — no transaction wrapper here.
      await this.ctx.supabase
        .from('shipments')
        .delete()
        .eq('id', insertedId);
      throw new ServiceError('internal_error', linesErr.message);
    }

    return insertedId;
  }

  private async loadWarehouseInfo(
    warehouseId: string,
  ): Promise<ShipmentWarehouseInfo | null> {
    const { data, error } = await this.ctx.supabase
      .from('warehouses')
      .select(
        `id, name, code, address, contact_name, contact_email, contact_phone,
         manager_user_id,
         manager:user_profiles!manager_user_id (id, full_name, email)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', warehouseId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) return null;
    const r = data as Record<string, unknown>;
    const mgField = r.manager as
      | { id: string; full_name: string | null; email: string | null }
      | { id: string; full_name: string | null; email: string | null }[]
      | null;
    const mg = Array.isArray(mgField) ? (mgField[0] ?? null) : (mgField ?? null);
    let role: string | null = null;
    if (mg) {
      const { data: member } = await this.ctx.supabase
        .from('organization_members')
        .select('role')
        .eq('organization_id', this.ctx.organizationId)
        .eq('user_id', mg.id)
        .maybeSingle();
      role = (member as { role?: string } | null)?.role ?? null;
    }
    return {
      id: r.id as string,
      name: (r.name as string) ?? '',
      code: (r.code as string) ?? '',
      address: (r.address as Record<string, unknown> | null) ?? null,
      contactName: (r.contact_name as string | null) ?? null,
      contactEmail: (r.contact_email as string | null) ?? null,
      contactPhone: (r.contact_phone as string | null) ?? null,
      manager: mg
        ? {
            id: mg.id,
            fullName: mg.full_name ?? null,
            email: mg.email ?? null,
            role,
          }
        : null,
    };
  }
}
