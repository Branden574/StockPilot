import 'server-only';

import { z } from 'zod';

import { assertWarehouseAccess, getWarehouseAccess } from '@/lib/auth/warehouse';

import { assertPermission, ServiceError, withContext, type ServiceContext } from './context';

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

    return { po, lines: lines ?? [] };
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

  async receive(id: string, input: ReceivePoInput) {
    assertPermission(this.ctx, 'purchase_orders:manage');
    await this.get(id);
    const { error } = await this.ctx.supabase.rpc('receive_purchase_order', {
      p_po_id: id,
      p_lines: input.lines.map((l) => ({ line_id: l.lineId, quantity: l.quantity })),
      p_notes: input.notes ?? null,
    });
    if (error) {
      if (error.message.includes('po_already_closed')) {
        throw new ServiceError('conflict', 'Purchase order is already closed.');
      }
      throw new ServiceError('internal_error', error.message);
    }
  }
}
