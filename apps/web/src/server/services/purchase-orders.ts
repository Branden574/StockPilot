import 'server-only';

import { z } from 'zod';

import { assertWarehouseAccess, getWarehouseAccess } from '@/lib/auth/warehouse';
import { createAdminClient } from '@/lib/supabase/admin';
import { createNotification } from './notifications';

import { assertModuleEnabled, assertPermission, ServiceError, withContext, type ServiceContext } from './context';
import {
  planAutoReorder,
  shouldAutoSend,
  type AutoReorderCandidate,
  type AutoReorderSettings,
} from './auto-reorder';
import { fetchAllRows } from './lib/paginate';
import { audit } from './audit';
import { dispatchEvent } from './integration-events';
import { ItemImagesService } from './item-images';
import { InventoryService } from './inventory';
import { createItemSchema } from '@stockpilot/core';

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
    // Also capture the warehouse_id so we can assign custom items to it.
    let destinationWarehouseId: string | null = null;
    if (input.destinationLocationId) {
      const { data: loc } = await this.ctx.supabase
        .from('locations')
        .select('warehouse_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', input.destinationLocationId)
        .maybeSingle();
      const wh = (loc as { warehouse_id?: string | null } | null)?.warehouse_id ?? null;
      if (wh) {
        await assertWarehouseAccess(wh, 'write', this.ctx);
        destinationWarehouseId = wh;
      }
    }

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
    // insert below still keeps the 23505 guard for the rare concurrent-dup race.
    const suppliedPoNumber = input.poNumber?.trim();
    let poNumber: string;
    if (suppliedPoNumber) {
      const { data: existing } = await this.ctx.supabase
        .from('purchase_orders')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('po_number', suppliedPoNumber)
        .maybeSingle();
      if (existing) {
        throw new ServiceError('conflict', 'That PO number is already in use.');
      }
      poNumber = suppliedPoNumber;
    } else {
      const { data: numberRpc } = await this.ctx.supabase.rpc('next_po_number', {
        p_org_id: this.ctx.organizationId,
      });
      poNumber = (numberRpc as string | null) ?? `PO-${Date.now()}`;
    }

    // For each line that carries a newItemName, create a real catalog item via
    // InventoryService (which enforces items:create permission, plan limits,
    // SKU auto-gen, and warehouse access) and replace the line with its new id.
    // The PO number was already validated as available above, so a clean create
    // won't strand these as orphans (only the rare concurrent-duplicate race).
    const invSvc = new InventoryService(this.ctx);
    const resolvedLines: Array<{ itemId: string; quantityOrdered: number; unitCost: number }> = [];
    for (const l of input.lines) {
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
        const newItem = await invSvc.create(itemInput);
        resolvedLines.push({
          itemId: newItem.id as string,
          quantityOrdered: l.quantityOrdered,
          unitCost: l.unitCost,
        });
      } else {
        // itemId is guaranteed present by the refine (validated upstream).
        resolvedLines.push({
          itemId: l.itemId!,
          quantityOrdered: l.quantityOrdered,
          unitCost: l.unitCost,
        });
      }
    }

    const subtotal = resolvedLines.reduce((sum, l) => sum + l.quantityOrdered * l.unitCost, 0);

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
    // Unique-constraint violation on (organization_id, po_number) — surface a
    // clean user-facing message instead of leaking the raw Postgres error.
    if (error?.code === '23505') {
      throw new ServiceError('conflict', 'That PO number is already in use.');
    }
    if (error) throw new ServiceError('internal_error', error.message);

    const linesPayload = resolvedLines.map((l) => ({
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
    // Fan out to configured webhooks / Slack / Teams (best-effort).
    void dispatchEvent(this.ctx.organizationId, 'po.created', {
      id: po.id as string,
      poNumber,
      lineCount: input.lines.length,
    });

    return { id: po.id as string, poNumber };
  }


  /**
   * Edit a DRAFT purchase order in place. The header fields (supplier,
   * destination, expected date, notes, PO number) and the full line-item
   * list are replaced atomically. Only drafts can be edited — once ordered
   * the PO is immutable (use receive/cancel flows instead).
   *
   * Security guarantees:
   *   - assertModuleEnabled + assertPermission gate matches create()
   *   - Every query is scoped to ctx.organizationId (no cross-tenant edit)
   *   - status !== 'draft' guard is checked BEFORE any write
   *   - Line-delete is safe: draft POs have no receipt_lines yet
   *   - Header update is fail-closed: 0-row update throws conflict
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

    // Resolve the destination warehouse id for custom-item creation.
    let destinationWarehouseId: string | null = null;
    if (input.destinationLocationId) {
      const { data: loc } = await this.ctx.supabase
        .from('locations')
        .select('warehouse_id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('id', input.destinationLocationId)
        .maybeSingle();
      const wh = (loc as { warehouse_id?: string | null } | null)?.warehouse_id ?? null;
      if (wh) {
        await assertWarehouseAccess(wh, 'write', this.ctx);
        destinationWarehouseId = wh;
      }
    }

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
      const { data: existing } = await this.ctx.supabase
        .from('purchase_orders')
        .select('id')
        .eq('organization_id', this.ctx.organizationId)
        .eq('po_number', suppliedPoNumber)
        .neq('id', id)
        .maybeSingle();
      if (existing) {
        throw new ServiceError('conflict', 'That PO number is already in use.');
      }
      poNumber = suppliedPoNumber;
    } else {
      // Keep the current number when omitted or unchanged.
      poNumber = suppliedPoNumber ?? currentPoNumber;
    }

    // Resolve lines — create catalog items for newItemName lines.
    const invSvc = new InventoryService(this.ctx);
    const resolvedLines: Array<{ itemId: string; quantityOrdered: number; unitCost: number }> = [];
    for (const l of input.lines) {
      if (l.newItemName) {
        const itemInput = createItemSchema.parse({
          name: l.newItemName,
          itemType: 'product',
          status: 'active',
          unitCost: l.unitCost,
          quantityOnHand: 0,
          warehouseId: customItemWarehouseId,
        });
        const newItem = await invSvc.create(itemInput);
        resolvedLines.push({
          itemId: newItem.id as string,
          quantityOrdered: l.quantityOrdered,
          unitCost: l.unitCost,
        });
      } else {
        resolvedLines.push({
          itemId: l.itemId!,
          quantityOrdered: l.quantityOrdered,
          unitCost: l.unitCost,
        });
      }
    }

    const subtotal = resolvedLines.reduce((sum, l) => sum + l.quantityOrdered * l.unitCost, 0);

    // Replace lines: delete existing, insert resolved set.
    const { error: delErr } = await this.ctx.supabase
      .from('purchase_order_items')
      .delete()
      .eq('purchase_order_id', id)
      .eq('organization_id', this.ctx.organizationId);
    if (delErr) throw new ServiceError('internal_error', delErr.message);

    const linesPayload = resolvedLines.map((l) => ({
      organization_id: this.ctx.organizationId,
      purchase_order_id: id,
      item_id: l.itemId,
      quantity_ordered: l.quantityOrdered,
      unit_cost: l.unitCost,
    }));
    const { error: linesErr } = await this.ctx.supabase
      .from('purchase_order_items')
      .insert(linesPayload);
    if (linesErr) throw new ServiceError('internal_error', linesErr.message);

    // Update the header — fail-closed on 0 rows (PO was deleted/changed under us).
    const { data: updatedPo, error: updErr } = await this.ctx.supabase
      .from('purchase_orders')
      .update({
        supplier_id: input.supplierId ?? null,
        destination_location_id: input.destinationLocationId ?? null,
        expected_at: input.expectedAt ?? null,
        notes: input.notes ?? null,
        po_number: poNumber,
        subtotal,
        total: subtotal,
        updated_by: this.ctx.userId,
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', this.ctx.organizationId)
      .eq('id', id)
      .select('id')
      .maybeSingle();
    if (updErr) throw new ServiceError('internal_error', updErr.message);
    if (!updatedPo) throw new ServiceError('conflict', 'Purchase order not found or already changed.');

    void audit(
      {
        event: 'purchase_order.updated',
        entityType: 'purchase_order',
        entityId: id,
        extra: {
          po_number: poNumber,
          supplier_id: input.supplierId ?? null,
          line_count: resolvedLines.length,
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
        for (const m of (members ?? []) as Array<{ user_id: string }>) {
          if (m.user_id === this.ctx.userId) continue; // don't notify the editor
          await createNotification({
            organizationId: this.ctx.organizationId,
            userId: m.user_id,
            type: 'purchase_order.updated',
            title: 'Purchase order updated',
            body: `PO ${poNumber} was edited (${resolvedLines.length} item(s)).`,
            link: `/dashboard/purchase-orders/${id}`,
          });
        }
      } catch {
        // Best-effort: notification errors never fail the edit.
      }
    })();

    return { id, poNumber };
  }

  async updateStatus(id: string, status: 'draft' | 'ordered' | 'cancelled') {
    assertModuleEnabled(this.ctx, 'purchase_orders');
    assertPermission(this.ctx, 'purchase_orders:manage');
    const { po } = await this.get(id); // throws not_found if user can't see this PO's warehouse
    if (status === 'ordered') {
      // Spend governance: committing the order is the gated act — drafting
      // and cancelling stay open to everyone with purchase_orders:manage.
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
      void this.ctx.supabase.rpc('publish_outbox', {
        p_org_id: this.ctx.organizationId,
        p_topic: 'purchase_order.ordered',
        p_aggregate_type: 'purchase_order',
        p_aggregate_id: id,
        p_payload: { poId: id },
        p_dedupe_key: `purchase_order.ordered:${id}`,
      });
    }
    if (status === 'cancelled') {
      const poNumber = (po as { po_number?: string | null }).po_number ?? null;
      void dispatchEvent(this.ctx.organizationId, 'po.cancelled', {
        id,
        poNumber,
        cancelledBy: this.ctx.userId,
      });
    }
  }

  /**
   * PO approval threshold (Intacct-grade spend governance, no migration —
   * lives in the purchase_orders module's organization_modules.settings as
   * `approvalThresholdAmount`). When configured (> 0), a PO whose total is AT
   * OR ABOVE the threshold can only be PLACED (status → ordered) by an owner
   * or admin; managers keep full draft/cancel rights at any size. Absent/0 =
   * feature off (the default — existing orgs are unaffected).
   *
   * FAIL CLOSED: a settings read error blocks the transition rather than
   * silently waiving governance (an approval gate that disappears on a
   * transient DB error is not a gate).
   */
  private async assertApprovalThreshold(total: number): Promise<void> {
    if (this.ctx.role === 'owner' || this.ctx.role === 'admin') return;
    const { data, error } = await this.ctx.supabase
      .from('organization_modules')
      .select('settings')
      .eq('organization_id', this.ctx.organizationId)
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

    // 2. Open-PO item set — FAIL CLOSED: if we can't read it, abort rather than
    //    risk double-ordering. Paginated via an inner join on PO status. ALL
    //    genuinely-open states count (an item already on order must not be
    //    re-ordered): draft + expected_inbound + ordered + partially_received.
    //    (This is the open set used by overdueCount + the reconciliation views.)
    const openItems = await fetchAllRows<{ item_id: string }>((from, to) =>
      this.ctx.supabase
        .from('purchase_order_items')
        .select('item_id, id, purchase_orders!inner(status)')
        .eq('organization_id', this.ctx.organizationId)
        .in('purchase_orders.status', [
          'draft',
          'expected_inbound',
          'ordered',
          'partially_received',
        ])
        .order('id', { ascending: true })
        .range(from, to),
    );
    const openItemIds = new Set(openItems.map((r) => r.item_id));

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
