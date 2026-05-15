import 'server-only';

import { randomBytes } from 'node:crypto';

import { assertWarehouseAccess, getWarehouseAccess } from '@/lib/auth/warehouse';

import { audit } from './audit';
import {
  assertPermission,
  ServiceError,
  withContext,
  type ServiceContext,
} from './context';
import { ItemImagesService } from './item-images';
import { OrderRequestsService } from './order-requests';

export type ShipmentStatus = 'draft' | 'shipped' | 'delivered' | 'cancelled';

export interface ShipmentSummary {
  id: string;
  workOrderNumber: string;
  status: ShipmentStatus;
  shipDate: string;
  sourceWarehouseId: string;
  sourceWarehouseName: string | null;
  /** Receiving CHARTER (not a warehouse). */
  destinationCharterId: string;
  destinationCharterName: string | null;
  destinationCharterCode: string | null;
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
  /**
   * Signed URL for the item's primary image (~7 day expiry, supplied by
   * `ItemImagesService.primaryImagesForItems`). Null when the item has
   * no images uploaded yet, or when the linked item row has been deleted.
   * Used by the shipment detail line table — the printed PDF stays
   * text-only.
   */
  imageUrl: string | null;
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

export interface ShipmentCharterInfo {
  id: string;
  name: string;
  code: string | null;
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
  destinationCharterId: string;
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
  destination: ShipmentCharterInfo | null;
  lines: ShipmentLineRow[];
}

interface CreateFromOrderRequestInput {
  orderRequestId: string;
  sourceWarehouseId: string;
  /** Receiving charter — picked by warehouse staff at slip-generation time. */
  destinationCharterId: string;
  attentionToName?: string | null;
  notes?: string | null;
  ccEmails?: string[];
}

interface ManualCreateInput {
  sourceWarehouseId: string;
  /** Receiving charter (not a warehouse). */
  destinationCharterId: string;
  attentionToName?: string | null;
  notes?: string | null;
  ccEmails?: string[];
  lines: Array<{ itemId: string; qtyShipped: number; qtyBackOrdered?: number }>;
}

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// PNG-only base64 data URL. Matches the public-signature submission
// regex in @stockpilot/core's submitShipmentSignatureSchema so both the
// authenticated mark-delivered path and the unauth signature path accept
// the same shape (no SVG, JPG, or other image types — react-pdf renders
// the inline signature, and arbitrary image bytes break the print path).
const SIGNATURE_PNG_DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
// Signature payload cap — matches submitShipmentSignatureSchema (1.4M
// chars after base64 inflation, ~1MB of binary). I1: standardize across
// the action and service paths.
const SIGNATURE_MAX_CHARS = 1_400_000;

/**
 * Phase 2A — print-and-paper-sign packing slip path. The shipment row carries
 * a signature_token + expires_at populated at create time, but Phase 2A doesn't
 * surface them anywhere. The public /s/[token] route, signature pad component,
 * and Resend integration land in Phase 2B.
 *
 * Phase 2A/B → 2C destination pivot: shipments now point at a CHARTER, not a
 * warehouse. A warehouse SHIPS, a charter RECEIVES. The destination dropdown
 * is filtered by `warehouse_charters` (the junction table that tracks which
 * charters each warehouse services).
 */
export class ShipmentsService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ShipmentsService(await withContext());
  }

  /**
   * Cheap count of shipments that have been marked shipped but have not
   * been signed for and are now more than `staleDays` old (default 7).
   * Used by the dashboard "needs attention" hero so warehouse staff can
   * chase down outstanding paper signatures. Warehouse-scoped via the
   * source_warehouse_id, matching the rest of the shipments surface.
   */
  async awaitingSignatureCount(
    options: { staleDays?: number } = {},
  ): Promise<number> {
    const access = await getWarehouseAccess(this.ctx);
    if (!access.hasAllAccess && access.readableIds.length === 0) return 0;
    const staleDays = options.staleDays ?? 7;
    const cutoffIso = new Date(
      Date.now() - staleDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    let q = this.ctx.supabase
      .from('shipments')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', this.ctx.organizationId)
      .eq('status', 'shipped')
      .is('signed_at', null)
      .lt('ship_date', cutoffIso);
    if (!access.hasAllAccess) {
      q = q.in('source_warehouse_id', access.readableIds);
    }
    const { count, error } = await q;
    if (error) throw new ServiceError('internal_error', error.message);
    return count ?? 0;
  }

  async list(filters: {
    status?: ShipmentStatus;
    destinationCharterId?: string;
    /**
     * Filter to shipments that originate from this warehouse. Used by the
     * per-warehouse detail page to show "recent shipments from here".
     */
    sourceWarehouseId?: string;
    /**
     * Cap the number of returned rows. Defaults to no cap; the per-warehouse
     * detail page passes `limit: 10` for the recent-shipments panel.
     */
    limit?: number;
    /** ISO timestamps for "what shipped in this window" AI queries. Filters
        `created_at` (not `ship_date`, which is null until shipped). */
    since?: string;
    until?: string;
  } = {}): Promise<ShipmentSummary[]> {
    // Gate reads on `purchase_orders:read` (viewer+) — shipments are
    // PO-adjacent docs and the same audience that can read POs should
    // be able to read packing slips. Aligns the service surface with
    // every other read entrypoint in this file.
    assertPermission(this.ctx, 'purchase_orders:read');
    let query = this.ctx.supabase
      .from('shipments')
      .select(
        `id, work_order_number, status, ship_date, source_warehouse_id,
         destination_charter_id, order_request_id, attention_to_name,
         created_at, updated_at,
         source:warehouses!source_warehouse_id (name),
         destination:charters!destination_charter_id (name, code)`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('ship_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (filters.status) query = query.eq('status', filters.status);
    if (filters.destinationCharterId) {
      query = query.eq('destination_charter_id', filters.destinationCharterId);
    }
    if (filters.sourceWarehouseId) {
      query = query.eq('source_warehouse_id', filters.sourceWarehouseId);
    }
    if (filters.since) query = query.gte('created_at', filters.since);
    if (filters.until) query = query.lt('created_at', filters.until);
    if (typeof filters.limit === 'number' && filters.limit > 0) {
      query = query.limit(filters.limit);
    }

    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);

    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      const src = r.source as { name?: string } | { name?: string }[] | null;
      const dst = r.destination as
        | { name?: string; code?: string | null }
        | { name?: string; code?: string | null }[]
        | null;
      const srcName = Array.isArray(src) ? (src[0]?.name ?? null) : (src?.name ?? null);
      const dstObj = Array.isArray(dst) ? (dst[0] ?? null) : dst;
      return {
        id: r.id as string,
        workOrderNumber: r.work_order_number as string,
        status: r.status as ShipmentStatus,
        shipDate: r.ship_date as string,
        sourceWarehouseId: r.source_warehouse_id as string,
        sourceWarehouseName: srcName,
        destinationCharterId: r.destination_charter_id as string,
        destinationCharterName: dstObj?.name ?? null,
        destinationCharterCode: dstObj?.code ?? null,
        orderRequestId: (r.order_request_id as string | null) ?? null,
        attentionToName: (r.attention_to_name as string | null) ?? null,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
      } satisfies ShipmentSummary;
    });
  }

  async get(id: string): Promise<ShipmentDetail> {
    // Same gate as list() — `purchase_orders:read` is granted to viewer+
    // and is the consistent read perm for PO-adjacent surfaces.
    assertPermission(this.ctx, 'purchase_orders:read');
    const { data: header, error: hErr } = await this.ctx.supabase
      .from('shipments')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (hErr) throw new ServiceError('internal_error', hErr.message);
    if (!header) throw new ServiceError('not_found', 'Shipment not found');
    const h = header as Record<string, unknown>;
    // I6: warehouse-scoped users only see shipments from their assigned
    // source warehouses. Enforcing here keeps the not_found / forbidden
    // distinction sharp on the service surface (org-mate sees not_found;
    // cross-warehouse user in the same org sees forbidden).
    await assertWarehouseAccess(
      h.source_warehouse_id as string,
      'read',
      this.ctx,
    );

    const { data: lineRows, error: lErr } = await this.ctx.supabase
      .from('shipment_lines')
      .select(
        `id, item_id, qty_shipped, qty_back_ordered, line_order,
         item:inventory_items!item_id (id, name, sku, barcode)`,
      )
      .eq('shipment_id', id)
      .order('line_order', { ascending: true });
    if (lErr) throw new ServiceError('internal_error', lErr.message);

    const linesPreImages: Array<Omit<ShipmentLineRow, 'imageUrl'>> = (lineRows ?? []).map((row) => {
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

    // Batch-fetch primary thumbnails for the line items so the detail
    // page can render real photos. Uses a single `item_images IN (...)`
    // + one `createSignedUrls` call. Skipped when there are no lines so
    // we don't emit no-op DB traffic.
    const lineItemIds = linesPreImages
      .map((l) => l.itemId)
      .filter((id): id is string => Boolean(id));
    const imageMap =
      lineItemIds.length > 0
        ? await new ItemImagesService(this.ctx).primaryImagesForItems(lineItemIds)
        : new Map<string, string>();

    const lines: ShipmentLineRow[] = linesPreImages.map((l) => ({
      ...l,
      imageUrl: imageMap.get(l.itemId) ?? null,
    }));

    const sourceId = h.source_warehouse_id as string;
    const destCharterId = h.destination_charter_id as string;
    const [source, destination] = await Promise.all([
      this.loadWarehouseInfo(sourceId),
      this.loadCharterInfo(destCharterId),
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
      destinationCharterId: destCharterId,
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

    // Pre-migration window: until migration 0109 applies, the DB still
    // serves legacy 'packaging' / 'ready_for_delivery' status values.
    // We accept BOTH legacy and new identifiers here so shipment
    // creation doesn't break during the rollout. After 0109 ships and
    // those legacy values are gone, this list can be tightened back to
    // just the new identifiers.
    const allowedSourceStatuses: readonly string[] = [
      'approved',
      'packing_slip_generated',
      'staged_for_delivery',
      // Legacy fallback — removable after migration 0109 ships
      'packaging',
      'ready_for_delivery',
    ];
    if (!allowedSourceStatuses.includes(detail.request.status as string)) {
      throw new ServiceError(
        'validation_error',
        'Only approved / packing-slip-generated / staged order requests can be packed.',
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

    // Validate the (source warehouse, destination charter) pair against
    // the warehouse_charters junction. The order_request's warehouse_id
    // is informational and unrelated to which charter receives — the
    // packing-slip operator picks the charter at this step.
    await this.assertWarehouseServicesCharter(
      input.sourceWarehouseId,
      input.destinationCharterId,
    );

    const id = await this.insertShipmentWithLines({
      sourceWarehouseId: input.sourceWarehouseId,
      destinationCharterId: input.destinationCharterId,
      orderRequestId: input.orderRequestId,
      attentionToName: input.attentionToName ?? null,
      notes: input.notes ?? null,
      ccEmails: input.ccEmails ?? [],
      lines: linesToShip,
    });

    await audit(
      {
        event: 'shipment.created',
        entityType: 'shipment',
        entityId: id,
        warehouseId: input.sourceWarehouseId,
        extra: { source: 'order_request', orderRequestId: input.orderRequestId },
      },
      this.ctx,
    );

    return { id };
  }

  async manualCreate(input: ManualCreateInput): Promise<{ id: string }> {
    assertPermission(this.ctx, 'purchase_orders:manage');
    await assertWarehouseAccess(input.sourceWarehouseId, 'write', this.ctx);

    // I12: refuse lines with qtyShipped === 0 even if qtyBackOrdered is
    // set — a slip with no shipped quantity is a back-order log, not a
    // packing slip. post_shipment_shipped would happily flip it to
    // shipped with zero movement, which is just noise in the audit trail.
    const linesToShip = input.lines
      .map((l) => ({
        itemId: l.itemId,
        qtyShipped: Number(l.qtyShipped) || 0,
        qtyBackOrdered: Number(l.qtyBackOrdered ?? 0) || 0,
      }))
      .filter((l) => l.qtyShipped > 0);

    if (linesToShip.length === 0) {
      throw new ServiceError(
        'validation_error',
        'Add at least one line with a non-zero shipped quantity.',
      );
    }

    // Verify every line item belongs to the source warehouse. Without
    // this check, the markShipped → post_shipment_shipped RPC would
    // refuse (or worse, silently mis-account) when a line lives at a
    // different warehouse than the slip's source.
    const itemIds = linesToShip.map((l) => l.itemId);
    if (itemIds.length > 0) {
      const { data: items, error: itemErr } = await this.ctx.supabase
        .from('inventory_items')
        .select('id, warehouse_id')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', itemIds);
      if (itemErr) throw new ServiceError('internal_error', itemErr.message);
      const itemRows = (items ?? []) as Array<{
        id: string;
        warehouse_id: string | null;
      }>;
      // I8: any ID that didn't resolve = wrong org, deleted, or hand-
      // crafted. Without this, those IDs slip past the wrongWarehouse
      // check below (which only sees the ones that DID resolve) and
      // hit a cryptic RLS/FK error at insert time.
      if (itemRows.length !== itemIds.length) {
        throw new ServiceError(
          'validation_error',
          'Some item IDs are invalid or cross-org.',
        );
      }
      const wrongWarehouse = itemRows.filter(
        (it) => (it.warehouse_id ?? null) !== input.sourceWarehouseId,
      );
      if (wrongWarehouse.length > 0) {
        throw new ServiceError(
          'validation_error',
          "Some items don't live in the source warehouse. Move them or pick a different warehouse.",
        );
      }
    }

    await this.assertWarehouseServicesCharter(
      input.sourceWarehouseId,
      input.destinationCharterId,
    );

    const id = await this.insertShipmentWithLines({
      sourceWarehouseId: input.sourceWarehouseId,
      destinationCharterId: input.destinationCharterId,
      orderRequestId: null,
      attentionToName: input.attentionToName ?? null,
      notes: input.notes ?? null,
      ccEmails: input.ccEmails ?? [],
      lines: linesToShip,
    });

    await audit(
      {
        event: 'shipment.created',
        entityType: 'shipment',
        entityId: id,
        warehouseId: input.sourceWarehouseId,
        extra: { source: 'manual' },
      },
      this.ctx,
    );

    return { id };
  }

  async markShipped(id: string): Promise<void> {
    assertPermission(this.ctx, 'purchase_orders:manage');

    // I6: warehouse access gate. The RPC enforces the manager role on
    // the shipment's org but doesn't know about warehouse-scope
    // assignments, so a warehouse-scoped manager could otherwise post
    // a shipment outside their assignment. Look up the source warehouse
    // first so we have something to check.
    const { data: whRow, error: whErr } = await this.ctx.supabase
      .from('shipments')
      .select('source_warehouse_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .maybeSingle();
    if (whErr) throw new ServiceError('internal_error', whErr.message);
    if (!whRow) throw new ServiceError('not_found', 'Shipment not found');
    await assertWarehouseAccess(
      (whRow as { source_warehouse_id: string }).source_warehouse_id,
      'write',
      this.ctx,
    );

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
    // Atomicity: this whole transition (status check → per-line
    // adjust_stock → status flip) runs inside the Postgres function
    // `post_shipment_shipped` so the entire sequence is ONE transaction.
    // The function `FOR UPDATE`-locks the shipment row, re-verifies
    // status='draft' inside the lock, then loops `adjust_stock` per
    // line and flips status to 'shipped'. Any insufficient_stock error
    // rolls back every prior deduction in the same call, and a second
    // concurrent caller serializes on the row lock — they'll see
    // status='shipped' when they finally acquire it and bail cleanly
    // without double-deducting. See supabase/migrations/0054 for the
    // full function body and the two CRITICAL bugs it closes.
    // ──────────────────────────────────────────────────────────────────
    const { data, error } = await this.ctx.supabase.rpc(
      'post_shipment_shipped',
      { p_shipment_id: id },
    );

    if (error) {
      // Map Postgres error codes to ServiceError types. The function
      // raises:
      //   P0002 'shipment_not_found'   → not_found
      //   P0001 'shipment_not_draft' OR adjust_stock's
      //         'insufficient_stock'  → conflict (with specific copy)
      //   42501 'forbidden'             → forbidden
      const code = (error as { code?: string }).code;
      const msg = error.message ?? '';
      if (code === 'P0002' || msg.includes('shipment_not_found')) {
        throw new ServiceError('not_found', 'Shipment not found');
      }
      if (code === 'P0001' || msg.includes('insufficient_stock') || msg.includes('shipment_not_draft')) {
        const friendly = msg.includes('insufficient_stock')
          ? 'Not enough stock to ship every line. Check on-hand quantities.'
          : msg.includes('shipment_not_draft')
            ? 'Shipment is no longer in draft status.'
            : (msg || 'Cannot post this shipment.');
        throw new ServiceError('conflict', friendly);
      }
      if (code === '42501' || msg.includes('forbidden')) {
        throw new ServiceError(
          'forbidden',
          'You do not have permission to post shipments.',
        );
      }
      throw new ServiceError(
        'internal_error',
        msg || 'Failed to post shipment',
      );
    }

    // The RPC returns a single-row table:
    //   [{ lines_shipped: int, total_qty_shipped: numeric }]
    // supabase-js can hand it back as either an array or a single object
    // depending on shape, so normalize.
    const row = Array.isArray(data)
      ? (data[0] as { lines_shipped?: number; total_qty_shipped?: number | string } | undefined)
      : (data as { lines_shipped?: number; total_qty_shipped?: number | string } | null);

    await audit({
      event: 'shipment.shipped',
      entityType: 'shipment',
      entityId: id,
      extra: {
        linesShipped: Number(row?.lines_shipped ?? 0),
        totalQtyShipped: Number(row?.total_qty_shipped ?? 0),
      },
    });
  }

  async markCancelled(id: string): Promise<void> {
    assertPermission(this.ctx, 'purchase_orders:manage');
    const detail = await this.get(id);
    // I6: get() asserts read access; cancel is a write op, re-assert.
    await assertWarehouseAccess(detail.sourceWarehouseId, 'write', this.ctx);
    if (
      detail.status === 'delivered' ||
      detail.status === 'cancelled' ||
      detail.status === 'shipped'
    ) {
      throw new ServiceError(
        'forbidden',
        detail.status === 'shipped'
          ? 'This slip has already shipped. Cancelling it would silently lose inventory — a returns/RMA flow is needed instead. Reach out to support to reverse a shipped slip.'
          : `This slip is already ${detail.status}.`,
      );
    }
    const { error } = await this.ctx.supabase
      .from('shipments')
      .update({ status: 'cancelled' satisfies ShipmentStatus })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);

    // C2: cancelling a draft shipment linked to an order_request leaves
    // the order's stock_reservations dangling. The slip never shipped,
    // so the order's "available" math was inflated by the reservation
    // for the slip's lifetime — and now nothing will ever release it.
    // Release here with reason='shipment_cancelled' so audit history can
    // trace the release back. We release ALL active reservations for
    // the order (not per-line): a cancelled draft means the order has
    // been abandoned at the warehouse side. If the user re-packs, the
    // order-side flow re-creates fresh reservations on the next pack.
    if (detail.orderRequestId) {
      const { error: relErr } = await this.ctx.supabase
        .from('stock_reservations')
        .update({
          released_at: new Date().toISOString(),
          released_reason: 'shipment_cancelled',
        })
        .eq('organization_id', this.ctx.organizationId)
        .eq('order_request_id', detail.orderRequestId)
        .is('released_at', null);
      if (relErr) {
        // Status flip already succeeded; logging-only so the user
        // doesn't lose the cancel because of a reservation hiccup.
        // Dangling rows can be reconciled by ops; rolling back the
        // cancel here would be worse for the user.
        console.warn(
          '[shipments.markCancelled] failed to release reservations',
          relErr.message,
        );
      }
    }

    await audit(
      {
        event: 'shipment.cancelled',
        entityType: 'shipment',
        entityId: id,
        warehouseId: detail.sourceWarehouseId,
        extra: {
          orderRequestId: detail.orderRequestId,
          releasedReservations: !!detail.orderRequestId,
        },
      },
      this.ctx,
    );
  }

  /**
   * Manual paper-delivery path: the manager hits "Mark delivered" on a
   * shipped slip after a signed paper copy comes back from the field.
   * No stock movement — the deduction already happened at markShipped.
   * Captures the receiver's name + delivered date so future re-prints
   * of the packing slip PDF render "Delivered · Signed by NAME · DATE"
   * instead of staying at "Shipped" forever.
   *
   * signature_image_url is intentionally left null — that's the marker
   * that distinguishes a manual paper-signed delivery from an
   * electronic QR signature (which DOES populate signature_image_url
   * via the /s/[token] flow in shipment-signature.tsx).
   */
  async markDelivered(
    id: string,
    args: {
      receiverName: string;
      deliveredAt?: string | null;
      /** Optional PNG data URL — stored inline in signature_image_url
       * exactly like the public /s/[token] flow does. */
      signatureDataUrl?: string | null;
    },
  ): Promise<void> {
    assertPermission(this.ctx, 'purchase_orders:manage');
    const detail = await this.get(id);
    // I6/I7: get() asserts read on source warehouse. Mark-delivered is
    // a write op, so re-assert.
    await assertWarehouseAccess(detail.sourceWarehouseId, 'write', this.ctx);
    if (detail.status === 'delivered') {
      throw new ServiceError('validation_error', 'Shipment is already delivered.');
    }
    if (detail.status === 'cancelled') {
      throw new ServiceError(
        'validation_error',
        'Cancelled shipments cannot be marked delivered.',
      );
    }
    if (detail.status !== 'shipped') {
      throw new ServiceError(
        'validation_error',
        `Only shipped shipments can be marked delivered. Current status: ${detail.status}.`,
      );
    }
    const receiverName = args.receiverName.trim();
    if (!receiverName) {
      throw new ServiceError('validation_error', 'Receiver name is required.');
    }
    const signedAt = args.deliveredAt
      ? new Date(args.deliveredAt).toISOString()
      : new Date().toISOString();
    if (Number.isNaN(new Date(signedAt).getTime())) {
      throw new ServiceError('validation_error', 'Invalid delivered date.');
    }
    const sigDataUrl = args.signatureDataUrl?.trim() || null;
    // I1: cap matches the public-signature flow (1.4M chars after base64
    // inflation, ~1MB binary). C4: PNG-only regex, same as
    // submitShipmentSignatureSchema — startsWith('data:image/') accepted
    // SVG, GIF, JPG, and even data:image/garbage; we render this back
    // into a PDF later so the shape needs to be PNG.
    if (sigDataUrl && sigDataUrl.length > SIGNATURE_MAX_CHARS) {
      throw new ServiceError(
        'validation_error',
        'Signature image is too large (max ~1MB).',
      );
    }
    if (sigDataUrl && !SIGNATURE_PNG_DATA_URL_RE.test(sigDataUrl)) {
      throw new ServiceError('validation_error', 'Signature must be a PNG data URL.');
    }

    // I3: don't clobber signed_at / signed_by_name / signature_image_url
    // when they're already set. If the public signature flow already
    // wrote those (stale browser tab → manager hits Mark delivered),
    // keeping the earliest values preserves the audit timeline and the
    // real signer's name. Status is the only thing we always flip.
    const updatePayload: Record<string, unknown> = {
      status: 'delivered' satisfies ShipmentStatus,
    };
    if (!detail.signedAt) {
      updatePayload.signed_at = signedAt;
    }
    if (!detail.signedByName) {
      updatePayload.signed_by_name = receiverName;
    }
    if (sigDataUrl && !detail.signatureImageUrl) {
      updatePayload.signature_image_url = sigDataUrl;
    }
    const { error } = await this.ctx.supabase
      .from('shipments')
      .update(updatePayload)
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);

    await audit(
      {
        event: 'shipment.delivered',
        entityType: 'shipment',
        entityId: id,
        warehouseId: detail.sourceWarehouseId,
        extra: {
          manual: true,
          signedByName: receiverName,
          signedAt,
          hasSignatureImage: !!sigDataUrl,
        },
      },
      this.ctx,
    );
  }

  // ── Private helpers ────────────────────────────────────────────────

  /**
   * Guard rail: refuse to create a shipment when the destination charter
   * isn't in `warehouse_charters` for the source warehouse. Surfaces a
   * friendly validation error instead of letting the FK / RLS bite later.
   */
  private async assertWarehouseServicesCharter(
    warehouseId: string,
    charterId: string,
  ): Promise<void> {
    const { data, error } = await this.ctx.supabase
      .from('warehouse_charters')
      .select('charter_id')
      .eq('organization_id', this.ctx.organizationId)
      .eq('warehouse_id', warehouseId)
      .eq('charter_id', charterId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) {
      throw new ServiceError(
        'validation_error',
        'Selected charter is not serviced by this warehouse.',
      );
    }
  }

  private async insertShipmentWithLines(args: {
    sourceWarehouseId: string;
    destinationCharterId: string;
    orderRequestId: string | null;
    attentionToName: string | null;
    notes: string | null;
    ccEmails: string[];
    lines: Array<{ itemId: string; qtyShipped: number; qtyBackOrdered: number }>;
  }): Promise<string> {
    // Look up the destination charter code for the WO# template. We need
    // a code; if the row is missing or the code is empty, throw rather
    // than silently mint a degenerate WO# like "ISR--MMDDYYYY".
    const { data: destCharter, error: chErr } = await this.ctx.supabase
      .from('charters')
      .select('id, code')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', args.destinationCharterId)
      .maybeSingle();
    if (chErr) throw new ServiceError('internal_error', chErr.message);
    if (!destCharter) {
      throw new ServiceError('not_found', 'Destination charter not found.');
    }
    const rawCode = (destCharter.code as string | null) ?? '';
    const code = rawCode
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, '');
    if (!code) {
      throw new ServiceError(
        'validation_error',
        'Destination charter has no usable code for the work order number.',
      );
    }

    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const yyyy = String(today.getFullYear());
    const baseWo = `ISR-${code}-${mm}${dd}${yyyy}`;
    const shipDate = `${yyyy}-${mm}-${dd}`; // YYYY-MM-DD for date column

    const signatureExpires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    // Try base WO# then -2, -3, ... up to -50. INSERT-and-catch on UNIQUE
    // violation avoids the SELECT-then-INSERT race window.
    let insertedId: string | null = null;
    let signatureToken = randomBytes(24).toString('hex');
    for (let suffix = 1; suffix <= 50; suffix += 1) {
      const wo = suffix === 1 ? baseWo : `${baseWo}-${suffix}`;
      const { data, error } = await this.ctx.supabase
        .from('shipments')
        .insert({
          organization_id: this.ctx.organizationId,
          source_warehouse_id: args.sourceWarehouseId,
          destination_charter_id: args.destinationCharterId,
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
      // 23505 = unique_violation. M1: distinguish a token collision from
      // a WO# collision so we know what to regenerate. A token collision
      // is astronomically rare (24-byte random) — but if it happens, we
      // regen the token and retry the SAME suffix. A WO# collision is
      // the expected case; bump the suffix.
      if (error.code !== '23505') {
        throw new ServiceError('internal_error', error.message);
      }
      const constraint = (error as { details?: string; message?: string })
        .details ?? (error as { message?: string }).message ?? '';
      if (constraint.includes('signature_token')) {
        // Token collision — astronomically rare, but stay defensive.
        // Regen the token; don't burn a suffix on a non-WO collision.
        signatureToken = randomBytes(24).toString('hex');
        suffix -= 1;
        continue;
      }
      // Otherwise treat as a WO# collision: bump the suffix on next iter.
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
      // M2: scope the rollback by org_id for defense in depth. RLS
      // already prevents cross-org deletes, but pinning it explicitly
      // keeps the failure mode predictable if anyone runs this path
      // with the service-role client.
      await this.ctx.supabase
        .from('shipments')
        .delete()
        .eq('organization_id', this.ctx.organizationId)
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

  private async loadCharterInfo(
    charterId: string,
  ): Promise<ShipmentCharterInfo | null> {
    const { data, error } = await this.ctx.supabase
      .from('charters')
      .select('id, name, code')
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', charterId)
      .maybeSingle();
    if (error) throw new ServiceError('internal_error', error.message);
    if (!data) return null;
    const r = data as Record<string, unknown>;
    return {
      id: r.id as string,
      name: (r.name as string) ?? '',
      code: (r.code as string | null) ?? null,
    };
  }
}
