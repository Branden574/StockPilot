import 'server-only';

import { ServiceError, withContext, type ServiceContext } from './context';

export interface ReconciliationRow {
  organization_id: string;
  purchase_order_id: string;
  po_number: string;
  status: string;
  supplier_id: string | null;
  supplier_name: string | null;
  qty_ordered_total: number;
  qty_received_total: number;
  qty_open_total: number;
  cost_ordered_total: number;
  cost_received_total: number;
  created_at: string;
  updated_at: string;
}

export interface VendorPerformanceRow {
  organization_id: string;
  supplier_id: string;
  supplier_name: string | null;
  po_count: number;
  qty_ordered: number;
  qty_received: number;
  fill_rate_pct: number | null;
}

export interface WarehouseInboundRow {
  organization_id: string;
  warehouse_id: string;
  open_po_count: number;
  qty_open_total: number;
}

export class ReconciliationService {
  constructor(private readonly ctx: ServiceContext) {}

  static async forCurrentUser() {
    return new ReconciliationService(await withContext());
  }

  async summary(filters: {
    vendorId?: string | null;
    status?: 'open' | 'closed' | 'all';
  } = {}) {
    let q = this.ctx.supabase
      .from('vw_po_reconciliation')
      .select(
        'organization_id, purchase_order_id, po_number, status, supplier_id, supplier_name, qty_ordered_total, qty_received_total, qty_open_total, cost_ordered_total, cost_received_total, created_at, updated_at',
      )
      .eq('organization_id', this.ctx.organizationId)
      .order('created_at', { ascending: false });

    if (filters.vendorId) q = q.eq('supplier_id', filters.vendorId);
    if (filters.status === 'open') {
      q = q.in('status', ['expected_inbound', 'ordered', 'partially_received']);
    } else if (filters.status === 'closed') {
      q = q.in('status', ['received', 'cancelled']);
    }

    const { data: rows, error: rErr } = await q;
    if (rErr) throw new ServiceError('internal_error', rErr.message);

    const { data: vendor, error: vErr } = await this.ctx.supabase
      .from('vw_vendor_performance')
      .select('*')
      .eq('organization_id', this.ctx.organizationId)
      .order('po_count', { ascending: false });
    if (vErr) throw new ServiceError('internal_error', vErr.message);

    const { data: warehouse, error: wErr } = await this.ctx.supabase
      .from('vw_warehouse_inbound')
      .select('*')
      .eq('organization_id', this.ctx.organizationId);
    if (wErr) throw new ServiceError('internal_error', wErr.message);

    const recRows = (rows ?? []) as unknown as ReconciliationRow[];
    const totals = recRows.reduce(
      (a, r) => ({
        qtyOrdered: a.qtyOrdered + Number(r.qty_ordered_total),
        qtyReceived: a.qtyReceived + Number(r.qty_received_total),
        qtyOpen: a.qtyOpen + Number(r.qty_open_total),
        costOrdered: a.costOrdered + Number(r.cost_ordered_total),
        costReceived: a.costReceived + Number(r.cost_received_total),
      }),
      { qtyOrdered: 0, qtyReceived: 0, qtyOpen: 0, costOrdered: 0, costReceived: 0 },
    );

    return {
      rows: recRows,
      totals,
      byVendor: (vendor ?? []) as unknown as VendorPerformanceRow[],
      byWarehouse: (warehouse ?? []) as unknown as WarehouseInboundRow[],
    };
  }
}
