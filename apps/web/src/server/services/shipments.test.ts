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
import { audit } from './audit';

// markShipped tests use the atomic `post_shipment_shipped` RPC, so they
// no longer need shipment/line/warehouse/charter row fixtures — the JS
// layer never reads them. manualCreate has its own minimal scenario below.

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ShipmentsService.markShipped', () => {
  it('calls post_shipment_shipped RPC once and audits the response', async () => {
    const stub = makeSupabaseStub({
      // Atomic posting — single RPC returning the table row.
      'rpc:post_shipment_shipped': {
        data: [{ lines_shipped: 2, total_qty_shipped: 8 }],
        error: null,
      },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await svc.markShipped('ship-1');

    // Exactly one RPC call to the atomic posting function.
    expect(stub.rpcCalls).toHaveLength(1);
    expect(stub.rpcCalls[0]).toEqual({
      name: 'post_shipment_shipped',
      args: { p_shipment_id: 'ship-1' },
    });

    // Audit metadata is pulled from the RPC return row.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'shipment.shipped',
        entityType: 'shipment',
        entityId: 'ship-1',
        extra: { linesShipped: 2, totalQtyShipped: 8 },
      }),
    );
  });

  it('also accepts a single-object RPC response shape', async () => {
    // Postgres `returns table` can come back as a bare object from
    // supabase-js depending on shape — defensive normalization check.
    const stub = makeSupabaseStub({
      'rpc:post_shipment_shipped': {
        data: { lines_shipped: 1, total_qty_shipped: 3 },
        error: null,
      },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await svc.markShipped('ship-1');

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: { linesShipped: 1, totalQtyShipped: 3 },
      }),
    );
  });

  it('maps P0001 insufficient_stock to a conflict ServiceError with actionable copy', async () => {
    const stub = makeSupabaseStub({
      'rpc:post_shipment_shipped': {
        data: null,
        error: {
          code: 'P0001',
          message: 'insufficient_stock for item ...',
        },
      },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await expect(svc.markShipped('ship-1')).rejects.toMatchObject({
      code: 'conflict',
      message: 'Not enough stock to ship every line. Check on-hand quantities.',
    });

    // Audit must NOT have fired — RPC rolled back the whole transition.
    expect(audit).not.toHaveBeenCalled();
  });

  it('maps P0001 shipment_not_draft to a conflict ServiceError (race-loser)', async () => {
    const stub = makeSupabaseStub({
      'rpc:post_shipment_shipped': {
        data: null,
        error: {
          code: 'P0001',
          message: 'shipment_not_draft: Shipment ... is in status shipped',
        },
      },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await expect(svc.markShipped('ship-1')).rejects.toMatchObject({
      code: 'conflict',
      message: 'Shipment is no longer in draft status.',
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('maps P0002 shipment_not_found to a not_found ServiceError', async () => {
    const stub = makeSupabaseStub({
      'rpc:post_shipment_shipped': {
        data: null,
        error: { code: 'P0002', message: 'shipment_not_found' },
      },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await expect(svc.markShipped('ship-1')).rejects.toMatchObject({
      code: 'not_found',
      message: 'Shipment not found',
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('maps 42501 forbidden to a forbidden ServiceError', async () => {
    const stub = makeSupabaseStub({
      'rpc:post_shipment_shipped': {
        data: null,
        error: { code: '42501', message: 'forbidden' },
      },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await expect(svc.markShipped('ship-1')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it('falls through to internal_error for unmapped Postgres errors', async () => {
    const stub = makeSupabaseStub({
      'rpc:post_shipment_shipped': {
        data: null,
        error: { code: 'XX000', message: 'unexpected database failure' },
      },
    });
    const svc = new ShipmentsService(makeServiceContext(stub.client));

    await expect(svc.markShipped('ship-1')).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(audit).not.toHaveBeenCalled();
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
