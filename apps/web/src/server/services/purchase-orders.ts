import 'server-only';

import { z } from 'zod';

import { assertWarehouseAccess, getWarehouseAccess } from '@/lib/auth/warehouse';

import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import { fetchAllRows } from './lib/paginate';
import { audit } from './audit';
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
    assertModuleEnabled(this.ctx, 'purchase_orders');
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
      if (wh) await assertWarehouseAccess(wh, 'write', this.ctx);
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

    void audit(
      {
        event: 'purchase_order.created',
        entityType: 'purchase_order',
        entityId: po.id as string,
        extra: {
          po_number: poNumber,
          supplier_id: input.supplierId ?? null,
          line_count: input.lines.length,
        },
      },
      this.ctx,
    );

    return { id: po.id as string, poNumber };
  }

  async updateStatus(id: string, status: 'draft' | 'ordered' | 'cancelled') {
    assertModuleEnabled(this.ctx, 'purchase_orders');
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
    void audit(
      {
        event: 'purchase_order.status_changed',
        entityType: 'purchase_order',
        entityId: id,
        extra: { new_status: status },
      },
      this.ctx,
    );
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
    assertModuleEnabled(this.ctx, 'purchase_orders');
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

    // Build a prefilled line for each item that is at or below its reorder
    // point. Quantity = deficit to bring it back to target.
    type PreparedLine = { itemId: string; quantityOrdered: number; unitCost: number };
    const bySupplier = new Map<string, PreparedLine[]>();
    const unassigned: PreparedLine[] = [];

    for (const raw of rows) {
      const qty = Number(raw.quantity_on_hand ?? 0);
      const reorderPoint = Number(raw.reorder_point ?? 0);
      if (qty > reorderPoint) continue; // healthy — skip
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
    const supplierName = new Map<string, string>();
    if (supplierIds.length > 0) {
      const { data: suppliersData } = await this.ctx.supabase
        .from('suppliers')
        .select('id, name')
        .eq('organization_id', this.ctx.organizationId)
        .in('id', supplierIds);
      for (const s of (suppliersData ?? []) as Array<{ id: string; name: string }>) {
        supplierName.set(s.id, s.name);
      }
    }

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
      supplierFailures,
      supplierCount: bySupplier.size,
    };
  }

}

function errMessage(e: unknown): string {
  if (e instanceof ServiceError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Unknown error';
}
