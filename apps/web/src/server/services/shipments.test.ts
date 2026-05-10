import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({
  getWarehouseAccess: vi.fn(async () => ({
    readableIds: ['wh-a'],
    writableIds: ['wh-a'],
    hasAllAccess: true,
    primaryWarehouseId: 'wh-a',
  })),
  assertWarehouseAccess: vi.fn(),
  forcedWarehouseId: vi.fn(async () => null),
  ForbiddenError: class ForbiddenError extends Error {
    readonly code = 'forbidden' as const;
  },
}));

vi.mock('@/lib/auth/session', () => ({
  requireOrgContext: vi.fn(async () => ({
    userId: 'user-test',
    organizationId: 'org-test',
    role: 'admin',
  })),
}));

// Stub the audit pipeline so tests don't need the admin client / headers.
vi.mock('./audit', () => ({
  audit: vi.fn(async () => undefined),
}));

import { ShipmentsService } from './shipments';
import { ServiceError } from './context';
import { audit } from './audit';

// Phase 2C destination pivot — shipments now point at a charter, not a
// warehouse. The header row carries `destination_charter_id`; the get()
// path loads charter info, not warehouse info, for the destination.
const SHIPMENT_HEADER = {
  id: 'ship-1',
  organization_id: 'org-test',
  work_order_number: 'ISR-CHARTERA-05102026',
  status: 'draft' as const,
  ship_date: '2026-05-10',
  attention_to_name: null,
  notes: null,
  source_warehouse_id: 'wh-a',
  destination_charter_id: 'ch-a',
  order_request_id: null,
  signature_image_url: null,
  signed_by_name: null,
  signed_at: null,
  signature_email_to: null,
  signature_email_cc: null,
  created_by: 'user-test',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const SHIPMENT_LINES = [
  {
    id: 'line-1',
    item_id: 'item-1',
    qty_shipped: 5,
    qty_back_ordered: 0,
    line_order: 0,
    item: { id: 'item-1', name: 'Widget', sku: 'W-1', barcode: null },
  },
  {
    id: 'line-2',
    item_id: 'item-2',
    qty_shipped: 3,
    qty_back_ordered: 1,
    line_order: 1,
    item: { id: 'item-2', name: 'Gadget', sku: 'G-1', barcode: null },
  },
];

const WAREHOUSE_ROW = {
  id: 'wh-a',
  name: 'Main',
  code: 'WHA',
  address: null,
  contact_name: null,
  contact_email: null,
  contact_phone: null,
  manager_user_id: null,
  manager: null,
};

const CHARTER_ROW = {
  id: 'ch-a',
  name: 'Charter A',
  code: 'CHARTERA',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ShipmentsService.markShipped', () => {
  it('deducts stock for every line via adjust_stock then flips status to shipped', async () => {
    const stub = makeSupabaseStub({
      // get() loads header + lines + source warehouse + destination charter
      'shipments.select.maybeSingle': { data: SHIPMENT_HEADER, error: null },
      'shipment_lines.select': { data: SHIPMENT_LINES, error: null },
      'warehouses.select.maybeSingle': { data: WAREHOUSE_ROW, error: null },
      'charters.select.maybeSingle': { data: CHARTER_ROW, error: null },
      'organization_members.select.maybeSingle': { data: null, error: null },
      // status flip
      'shipments.update': { data: null, error: null },
      // RPC for stock deduction
      'rpc:adjust_stock': { data: {}, error: null },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await svc.markShipped('ship-1');

    // Should have called adjust_stock once per line, with NEGATIVE qty.
    expect(stub.rpcCalls).toHaveLength(2);
    expect(stub.rpcCalls[0]).toEqual({
      name: 'adjust_stock',
      args: {
        p_item_id: 'item-1',
        p_quantity_change: -5,
        p_movement_type: 'transfer',
        p_location_id: null,
        p_reason: 'Shipment ISR-CHARTERA-05102026',
        p_notes: null,
      },
    });
    expect(stub.rpcCalls[1]!.args).toMatchObject({
      p_item_id: 'item-2',
      p_quantity_change: -3,
      p_movement_type: 'transfer',
    });

    // Audit metadata captures lines + total qty.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'shipment.shipped',
        entityId: 'ship-1',
        warehouseId: 'wh-a',
        extra: { linesShipped: 2, totalQtyShipped: 8 },
      }),
    );
  });

  it('refuses to flip status when a stock deduction fails (insufficient_stock)', async () => {
    const stub = makeSupabaseStub({
      'shipments.select.maybeSingle': { data: SHIPMENT_HEADER, error: null },
      'shipment_lines.select': { data: SHIPMENT_LINES, error: null },
      'warehouses.select.maybeSingle': { data: WAREHOUSE_ROW, error: null },
      'charters.select.maybeSingle': { data: CHARTER_ROW, error: null },
      'organization_members.select.maybeSingle': { data: null, error: null },
      'rpc:adjust_stock': {
        data: null,
        error: { message: 'insufficient_stock' },
      },
      'shipments.update': { data: null, error: null },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await expect(svc.markShipped('ship-1')).rejects.toBeInstanceOf(ServiceError);

    // Audit must NOT have fired — partial-success was rejected.
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects when shipment is not in draft status', async () => {
    const shipped = { ...SHIPMENT_HEADER, status: 'shipped' as const };
    const stub = makeSupabaseStub({
      'shipments.select.maybeSingle': { data: shipped, error: null },
      'shipment_lines.select': { data: SHIPMENT_LINES, error: null },
      'warehouses.select.maybeSingle': { data: WAREHOUSE_ROW, error: null },
      'charters.select.maybeSingle': { data: CHARTER_ROW, error: null },
      'organization_members.select.maybeSingle': { data: null, error: null },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await expect(svc.markShipped('ship-1')).rejects.toBeInstanceOf(ServiceError);
    // No RPC fired (status check is the idempotency gate).
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('skips deduction for lines with zero qty_shipped (e.g. back-order-only rows)', async () => {
    const linesWithZero = [
      {
        ...SHIPMENT_LINES[0]!,
        qty_shipped: 0,
        qty_back_ordered: 4,
      },
      SHIPMENT_LINES[1]!,
    ];
    const stub = makeSupabaseStub({
      'shipments.select.maybeSingle': { data: SHIPMENT_HEADER, error: null },
      'shipment_lines.select': { data: linesWithZero, error: null },
      'warehouses.select.maybeSingle': { data: WAREHOUSE_ROW, error: null },
      'charters.select.maybeSingle': { data: CHARTER_ROW, error: null },
      'organization_members.select.maybeSingle': { data: null, error: null },
      'shipments.update': { data: null, error: null },
      'rpc:adjust_stock': { data: {}, error: null },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await svc.markShipped('ship-1');

    // Only the second line should fire adjust_stock (qty=3).
    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.rpcCalls[0]!.args).toMatchObject({
      p_item_id: 'item-2',
      p_quantity_change: -3,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: { linesShipped: 1, totalQtyShipped: 3 },
      }),
    );
  });
});

describe('ShipmentsService.manualCreate', () => {
  it('rejects when the destination charter is not serviced by the source warehouse', async () => {
    // warehouse_charters lookup returns null → not serviced.
    const stub = makeSupabaseStub({
      'warehouse_charters.select.maybeSingle': { data: null, error: null },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await expect(
      svc.manualCreate({
        sourceWarehouseId: 'wh-a',
        destinationCharterId: 'ch-not-serviced',
        lines: [{ itemId: 'item-1', qtyShipped: 1 }],
      }),
    ).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Selected charter is not serviced by this warehouse.',
    });

    // We must NOT have proceeded to insert anything.
    expect(stub.fromCalls).not.toContain('shipments');
  });
});
