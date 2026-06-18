import 'server-only';

import { ServiceError, withContext, type ServiceContext } from './context';
import { fetchAllRows } from './lib/paginate';

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
    // PAGINATED — this per-PO view feeds the financial TOTALS below; a 1000-row
    // PostgREST cap would silently undercount any org with >1000 POs. Page by a
    // stable key (purchase_order_id), then re-sort newest-first for display.
    const recRows = await fetchAllRows<ReconciliationRow>((from, to) => {
      let q = this.ctx.supabase
        .from('vw_po_reconciliation')
        .select(
          'organization_id, purchase_order_id, po_number, status, supplier_id, supplier_name, qty_ordered_total, qty_received_total, qty_open_total, cost_ordered_total, cost_received_total, created_at, updated_at',
        )
        .eq('organization_id', this.ctx.organizationId);
      if (filters.vendorId) q = q.eq('supplier_id', filters.vendorId);
      if (filters.status === 'open') {
        q = q.in('status', ['expected_inbound', 'ordered', 'partially_received']);
      } else if (filters.status === 'closed') {
        q = q.in('status', ['received', 'cancelled']);
      }
      return q.order('purchase_order_id', { ascending: true }).range(from, to);
    });
    recRows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));

    // PAGINATED — an org with >1000 suppliers would otherwise silently truncate
    // the byVendor list at the PostgREST cap. Page by a stable key (supplier_id),
    // then re-sort by po_count desc for display.
    const vendor = await fetchAllRows<VendorPerformanceRow>((from, to) =>
      this.ctx.supabase
        .from('vw_vendor_performance')
        .select('*')
        .eq('organization_id', this.ctx.organizationId)
        .order('supplier_id', { ascending: true })
        .range(from, to),
    );
    vendor.sort((a, b) => Number(b.po_count) - Number(a.po_count));

    const { data: warehouse, error: wErr } = await this.ctx.supabase
      .from('vw_warehouse_inbound')
      .select('*')
      .eq('organization_id', this.ctx.organizationId);
    if (wErr) throw new ServiceError('internal_error', wErr.message);

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
      byVendor: vendor,
      byWarehouse: (warehouse ?? []) as unknown as WarehouseInboundRow[],
    };
  }
}
