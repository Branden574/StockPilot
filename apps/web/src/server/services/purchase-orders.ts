import 'server-only';

import { z } from 'zod';

import { assertWarehouseAccess, getWarehouseAccess } from '@/lib/auth/warehouse';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { ItemImagesService } from './item-images';

const lineInputSchema = z.object({
  itemId: z.string().uuid(),
  quantityOrdered: z.coerce.number().positive(),
  unitCost: z.coerce.number().nonnegative(),
});

export const createPoSchema = z.object({
  supplierId: z.string().uuid().nullable().optional(),
  destinationLocationId: z.string().uuid().nullable().optional(),
  expectedAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).optional(),
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

export class PurchaseOrdersService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new PurchaseOrdersService(await withContext());
  }

  async list(params: { warehouseId?: string } = {}) {
    const access = await getWarehouseAccess();

    // Scope by destination location's warehouse via inner-join when needed.
    const needsScope = !access.hasAllAccess || !!params.warehouseId;
    const destEmbed = needsScope
      ? 'destination:locations!destination_location_id!inner (warehouse_id)'
      : 'destination:locations!destination_location_id (warehouse_id)';

    let query = this.ctx.supabase
      .from('purchase_orders')
      .select(
        `id, po_number, status, supplier_id, destination_location_id, expected_at, total, created_at, updated_at, ${destEmbed}`,
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false });

    if (!access.hasAllAccess) {
      if (access.readableIds.length === 0) return [];
      query = query.in('destination.warehouse_id', access.readableIds);
    } else if (params.warehouseId) {
      query = query.eq('destination.warehouse_id', params.warehouseId);
    }

    const { data, error } = await query;
    if (error) throw new ServiceError('internal_error', error.message);
    return data ?? [];
  }

  async get(id: string) {
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
      const access = await getWarehouseAccess();
      if (!access.hasAllAccess && !access.readableIds.includes(wh)) {
        throw new ServiceError('not_found', 'Purchase order not found');
      }
    }

    const { data: lines } = await this.ctx.supabase
      .from('purchase_order_items')
      .select('id, item_id, quantity_ordered, quantity_received, unit_cost, line_total')
      .eq('purchase_order_id', id);

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
    const imageMap =
      lineItemIds.length > 0
        ? await new ItemImagesService(this.ctx).primaryImagesForItems(lineItemIds)
        : new Map<string, string>();

    const linesWithImages: Array<RawLine & { imageUrl: string | null }> =
      rawLines.map((l) => ({
        ...l,
        imageUrl: l.item_id ? (imageMap.get(l.item_id) ?? null) : null,
      }));

    return { po, lines: linesWithImages };
  }

  async create(input: CreatePoInput) {
    assertPermission(this.ctx, 'purchase_orders:manage');

    // Validate the destination location is in a warehouse the user can write to.
    if (input.destinationLocationId) {
      const { data: loc } = await this.ctx.supabase
        .from('locations')
        .select('warehouse_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', input.destinationLocationId)
        .maybeSingle();
      const wh = (loc as { warehouse_id?: string | null } | null)?.warehouse_id ?? null;
      if (wh) await assertWarehouseAccess(wh, 'write');
    }

    const { data: numberRpc } = await this.ctx.supabase.rpc('next_po_number', {
      p_org_id: this.ctx.organizationId,
    });
    const poNumber = (numberRpc as string | null) ?? `PO-${Date.now()}`;

    const subtotal = input.lines.reduce((sum, l) => sum + l.quantityOrdered * l.unitCost, 0);

    const { data: po, error } = await this.ctx.supabase
      .from('purchase_orders')
      .insert({
        organization_id: this.ctx.organizationId,
        po_number: poNumber,
        supplier_id: input.supplierId ?? null,
        destination_location_id: input.destinationLocationId ?? null,
        expected_at: input.expectedAt ?? null,
        notes: input.notes ?? null,
        subtotal,
        total: subtotal,
        status: 'draft',
        created_by: this.ctx.userId,
        updated_by: this.ctx.userId,
      })
      .select('id')
      .single();
    if (error) throw new ServiceError('internal_error', error.message);

    const linesPayload = input.lines.map((l) => ({
      organization_id: this.ctx.organizationId,
      purchase_order_id: po.id as string,
      item_id: l.itemId,
      quantity_ordered: l.quantityOrdered,
      unit_cost: l.unitCost,
    }));
    const { error: linesError } = await this.ctx.supabase
      .from('purchase_order_items')
      .insert(linesPayload);
    if (linesError) throw new ServiceError('internal_error', linesError.message);

    return { id: po.id as string, poNumber };
  }

  async updateStatus(id: string, status: 'draft' | 'ordered' | 'cancelled') {
    assertPermission(this.ctx, 'purchase_orders:manage');
    await this.get(id); // throws not_found if user can't see this PO's warehouse
    const { error } = await this.ctx.supabase
      .from('purchase_orders')
      .update({
        status,
        ordered_at: status === 'ordered' ? new Date().toISOString() : undefined,
        updated_by: this.ctx.userId,
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id);
    if (error) throw new ServiceError('internal_error', error.message);
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
   * Powers both the BulkActions toolbar button (via
   * createDraftPosFromItemsAction) and the Gemini draftPos tool.
   *
   * Spec: docs/superpowers/specs/2026-05-08-draft-pos-from-low-stock-design.md
   */
  async createDraftsFromItems(itemIds: string[]): Promise<{
    createdPoIds: string[];
    skipped: number;
    supplierFailures: Array<{ supplierId: string; supplierName: string; error: string }>;
    supplierCount: number;
  }> {
    assertPermission(this.ctx, 'purchase_orders:manage');

    const { data: rows, error: fetchErr } = await this.ctx.supabase
      .from('inventory_items')
      .select(
        'id, supplier_id, reorder_quantity, reorder_point, quantity_on_hand, unit_cost',
      )
      .eq('organization_id', this.ctx.organizationId)
      .in('id', itemIds);
    if (fetchErr) throw new ServiceError('internal_error', fetchErr.message);

    type Row = {
      id: string;
      supplier_id: string | null;
      reorder_quantity: number | null;
      reorder_point: number | null;
      quantity_on_hand: number | null;
      unit_cost: number | null;
    };
    const items = (rows ?? []) as Row[];
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
    const { data: suppliersData } = await this.ctx.supabase
      .from('suppliers')
      .select('id, name')
      .eq('organization_id', this.ctx.organizationId)
      .in('id', supplierIds);
    const supplierName = new Map<string, string>();
    for (const s of (suppliersData ?? []) as Array<{ id: string; name: string }>) {
      supplierName.set(s.id, s.name);
    }

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
      supplierFailures,
      supplierCount: bySupplier.size,
    };
  }

}
