import { describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type SupabaseStub } from '@/test/supabase-mock';

vi.mock('./audit', () => ({ audit: vi.fn() }));

import { audit } from './audit';
import { ServiceError, type ServiceContext } from './context';
import { SerialsService } from './serials';

// ---------------------------------------------------------------------------
// SerialsService — manual serial-number management (serial_registry).
//
// Covers the required behaviors:
//   add:    happy path / duplicate conflict NAMED / cross-org warehouse
//           rejected / insert-race 23505 → conflict
//   update: status enum rejected / fail-open guard (0-row update throws)
//           / unique-violation → friendly conflict
//   remove: blocked on receipt-captured rows / allowed on manual rows
//   list:   fail-closed (empty page on read error) / warehouse names resolved
// ---------------------------------------------------------------------------

const ITEM_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WAREHOUSE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SERIAL_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function makeService(
  results: Parameters<typeof makeSupabaseStub>[0] = {},
  role: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer' = 'admin',
): { svc: SerialsService; stub: SupabaseStub } {
  const stub = makeSupabaseStub(results);
  const ctx = makeServiceContext(stub.client, { role }) as unknown as ServiceContext;
  return { svc: new SerialsService(ctx), stub };
}

async function expectServiceError(p: Promise<unknown>): Promise<ServiceError> {
  const err = await p.then(() => null).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ServiceError);
  return err as ServiceError;
}

describe('SerialsService.add', () => {
  it('inserts trimmed, de-duplicated manual rows (happy path) and audits', async () => {
    const { svc, stub } = makeService({
      'inventory_items.select': { data: { id: ITEM_ID }, error: null },
      'warehouses.select': { data: { id: WAREHOUSE_ID }, error: null },
      'serial_registry.select': { data: [], error: null }, // pre-check: no duplicates
      'serial_registry.insert': { data: null, error: null },
    });

    const result = await svc.add(ITEM_ID, WAREHOUSE_ID, [' SN-1 ', 'SN-1', 'SN-2', '', '   ']);
    expect(result).toEqual({ added: 2 });

    const insertArgs = stub.chainArgs.get('serial_registry.insert');
    expect(insertArgs).toBeDefined();
    const rows = insertArgs![0]![0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.serial_number)).toEqual(['SN-1', 'SN-2']);
    for (const row of rows) {
      expect(row.organization_id).toBe('org-test');
      expect(row.item_id).toBe(ITEM_ID);
      expect(row.warehouse_id).toBe(WAREHOUSE_ID);
      expect(row.current_status).toBe('available');
      expect(row.receipt_line_id).toBeNull();
    }

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'item.serials.added',
        entityId: ITEM_ID,
        extra: { count: 2 },
      }),
      expect.anything(),
    );
  });

  it('names the already-registered serial(s) in the duplicate conflict', async () => {
    const { svc, stub } = makeService({
      'inventory_items.select': { data: { id: ITEM_ID }, error: null },
      'warehouses.select': { data: { id: WAREHOUSE_ID }, error: null },
      'serial_registry.select': { data: [{ serial_number: 'SN-2' }], error: null },
    });

    const err = await expectServiceError(svc.add(ITEM_ID, WAREHOUSE_ID, ['SN-1', 'SN-2']));
    expect(err.code).toBe('conflict');
    expect(err.message).toContain('SN-2');
    // Nothing was inserted after the pre-check hit.
    expect(stub.chains.get('serial_registry.insert')).toBeUndefined();
  });

  it('rejects a warehouse that is not in the caller org — no insert', async () => {
    const { svc, stub } = makeService({
      'inventory_items.select': { data: { id: ITEM_ID }, error: null },
      'warehouses.select': { data: null, error: null }, // cross-org / missing
    });

    const err = await expectServiceError(svc.add(ITEM_ID, WAREHOUSE_ID, ['SN-1']));
    expect(err.code).toBe('validation_error');
    expect(err.message).toMatch(/warehouse not found in your organization/i);
    expect(stub.chains.get('serial_registry.insert')).toBeUndefined();
  });

  it('throws not_found when the item is missing/deleted/cross-org', async () => {
    const { svc, stub } = makeService({
      'inventory_items.select': { data: null, error: null },
    });

    const err = await expectServiceError(svc.add(ITEM_ID, WAREHOUSE_ID, ['SN-1']));
    expect(err.code).toBe('not_found');
    expect(stub.chains.get('serial_registry.insert')).toBeUndefined();
  });

  it('maps an insert-race 23505 to a conflict (post-pre-check duplicate)', async () => {
    const { svc } = makeService({
      'inventory_items.select': { data: { id: ITEM_ID }, error: null },
      'warehouses.select': { data: { id: WAREHOUSE_ID }, error: null },
      'serial_registry.select': { data: [], error: null },
      'serial_registry.insert': {
        data: null,
        error: { message: 'duplicate key value violates unique constraint', code: '23505' },
      },
    });

    const err = await expectServiceError(svc.add(ITEM_ID, WAREHOUSE_ID, ['SN-1']));
    expect(err.code).toBe('conflict');
  });

  it('rejects an empty (post-trim) list and gates on items:update', async () => {
    const { svc } = makeService();
    const err = await expectServiceError(svc.add(ITEM_ID, WAREHOUSE_ID, ['  ', '']));
    expect(err.code).toBe('validation_error');

    const { svc: viewerSvc, stub } = makeService({}, 'viewer');
    const forbidden = await expectServiceError(viewerSvc.add(ITEM_ID, WAREHOUSE_ID, ['SN-1']));
    expect(forbidden.code).toBe('forbidden');
    expect(stub.fromCalls).toHaveLength(0);
  });
});

describe('SerialsService.updateSerial', () => {
  const EXISTING = {
    id: SERIAL_ID,
    item_id: ITEM_ID,
    serial_number: 'SN-OLD',
    current_status: 'available',
    receipt_line_id: null,
  };

  it('rejects a status outside the 6-value enum before any query', async () => {
    const { svc, stub } = makeService();
    const err = await expectServiceError(svc.updateSerial(SERIAL_ID, { status: 'exploded' }));
    expect(err.code).toBe('validation_error');
    expect(err.message).toMatch(/invalid serial status/i);
    expect(stub.fromCalls).toHaveLength(0);
  });

  it('fail-open guard: a 0-row update (row vanished mid-flight) throws', async () => {
    const { svc } = makeService({
      'serial_registry.select': { data: EXISTING, error: null },
      // .update().eq().eq().select().maybeSingle() resolves to no row.
      'serial_registry.update': { data: null, error: null },
    });

    const err = await expectServiceError(
      svc.updateSerial(SERIAL_ID, { serialNumber: 'SN-NEW' }),
    );
    expect(err.code).toBe('not_found');
  });

  it('maps a 23505 on update to the friendly conflict message', async () => {
    const { svc } = makeService({
      'serial_registry.select': { data: EXISTING, error: null },
      'serial_registry.update': {
        data: null,
        error: { message: 'duplicate key value violates unique constraint', code: '23505' },
      },
    });

    const err = await expectServiceError(
      svc.updateSerial(SERIAL_ID, { serialNumber: 'SN-DUPE' }),
    );
    expect(err.code).toBe('conflict');
    expect(err.message).toBe('That serial number already exists for this item.');
  });

  it('updates serial + status and audits {from, to} — including receipt rows', async () => {
    const receiptCaptured = { ...EXISTING, receipt_line_id: 'rl-1' };
    const { svc, stub } = makeService({
      'serial_registry.select': { data: receiptCaptured, error: null },
      'serial_registry.update': {
        data: {
          id: SERIAL_ID,
          item_id: ITEM_ID,
          serial_number: 'SN-NEW',
          current_status: 'damaged',
        },
        error: null,
      },
    });

    const result = await svc.updateSerial(SERIAL_ID, {
      serialNumber: '  SN-NEW ',
      status: 'damaged',
    });
    expect(result).toEqual({
      id: SERIAL_ID,
      itemId: ITEM_ID,
      serialNumber: 'SN-NEW',
      currentStatus: 'damaged',
    });

    const updateArgs = stub.chainArgs.get('serial_registry.update');
    expect(updateArgs![0]![0]).toEqual({ serial_number: 'SN-NEW', current_status: 'damaged' });

    // entityId MUST be the ITEM id (not the serial_registry row id) — that's
    // what ActivityService.forItem filters on to surface this edit in the
    // item's Activity feed. The serial's own id still travels in extra.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'item.serial.updated',
        entityType: 'inventory_item',
        entityId: ITEM_ID,
        before: { serialNumber: 'SN-OLD', status: 'available' },
        after: { serialNumber: 'SN-NEW', status: 'damaged' },
        extra: expect.objectContaining({
          serial_id: SERIAL_ID,
          from: 'SN-OLD',
          to: 'SN-NEW',
          receipt_captured: true,
        }),
      }),
      expect.anything(),
    );
  });

  it('throws not_found when the row is missing (org-scoped fetch first)', async () => {
    const { svc, stub } = makeService({
      'serial_registry.select': { data: null, error: null },
    });
    const err = await expectServiceError(
      svc.updateSerial(SERIAL_ID, { serialNumber: 'SN-NEW' }),
    );
    expect(err.code).toBe('not_found');
    expect(stub.chains.get('serial_registry.update')).toBeUndefined();
  });
});

describe('SerialsService.remove', () => {
  it("refuses to delete a receipt-captured serial (receipt_line_id set)", async () => {
    const { svc, stub } = makeService({
      'serial_registry.select': {
        data: {
          id: SERIAL_ID,
          item_id: ITEM_ID,
          serial_number: 'SN-1',
          receipt_line_id: 'rl-1',
        },
        error: null,
      },
    });

    const err = await expectServiceError(svc.remove(SERIAL_ID));
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/can't be deleted/i);
    expect(stub.chains.get('serial_registry.delete')).toBeUndefined();
  });

  it('deletes a manually-added serial (receipt_line_id null) and audits', async () => {
    const { svc, stub } = makeService({
      'serial_registry.select': {
        data: { id: SERIAL_ID, item_id: ITEM_ID, serial_number: 'SN-1', receipt_line_id: null },
        error: null,
      },
      'serial_registry.delete': { data: { id: SERIAL_ID }, error: null },
    });

    await expect(svc.remove(SERIAL_ID)).resolves.toEqual({ itemId: ITEM_ID });
    expect(stub.chains.get('serial_registry.delete')).toBeDefined();
    // Same entityId=item rationale as updateSerial above.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'item.serial.deleted',
        entityType: 'inventory_item',
        entityId: ITEM_ID,
        extra: { serial_id: SERIAL_ID },
      }),
      expect.anything(),
    );
  });

  it('throws not_found when the DELETE matches 0 rows (fail-open guard) and does NOT audit', async () => {
    // A 0-row DELETE (concurrent double-delete, or RLS floor above the app
    // gate) returns success with data:null — the service must not report
    // success or write a phantom audit row (recurring fail-open pattern #2).
    const { svc } = makeService({
      'serial_registry.select': {
        data: { id: SERIAL_ID, item_id: ITEM_ID, serial_number: 'SN-1', receipt_line_id: null },
        error: null,
      },
      'serial_registry.delete': { data: null, error: null },
    });

    const err = await svc.remove(SERIAL_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('not_found');
    expect(audit).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'item.serial.deleted' }),
      expect.anything(),
    );
  });
});

describe('SerialsService.list', () => {
  it('fails CLOSED on a read error — empty page, no throw', async () => {
    const { svc } = makeService({
      'serial_registry.select': { data: null, error: { message: 'boom' } },
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(svc.list(ITEM_ID)).resolves.toEqual({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 50,
    });
    expect(consoleError).toHaveBeenCalled();
  });

  it('returns mapped rows with resolved warehouse names + total count', async () => {
    const { svc } = makeService({
      'serial_registry.select': {
        data: [
          {
            id: 's1',
            serial_number: 'SN-1',
            current_status: 'available',
            warehouse_id: WAREHOUSE_ID,
            receipt_line_id: null,
            created_at: '2026-07-01T00:00:00Z',
          },
          {
            id: 's2',
            serial_number: 'SN-2',
            current_status: 'sold',
            warehouse_id: 'wh-unknown',
            receipt_line_id: 'rl-9',
            created_at: '2026-06-30T00:00:00Z',
          },
        ],
        error: null,
        count: 72,
      },
      'warehouses.select': { data: [{ id: WAREHOUSE_ID, name: 'Main DC' }], error: null },
    });

    const result = await svc.list(ITEM_ID, { page: 2 });
    expect(result.total).toBe(72);
    expect(result.page).toBe(2);
    expect(result.rows).toEqual([
      {
        id: 's1',
        serialNumber: 'SN-1',
        currentStatus: 'available',
        warehouseId: WAREHOUSE_ID,
        warehouseName: 'Main DC',
        receiptLineId: null,
        createdAt: '2026-07-01T00:00:00Z',
      },
      {
        id: 's2',
        serialNumber: 'SN-2',
        currentStatus: 'sold',
        warehouseId: 'wh-unknown',
        warehouseName: null, // name lookup miss degrades to null, row still returned
        receiptLineId: 'rl-9',
        createdAt: '2026-06-30T00:00:00Z',
      },
    ]);
  });
});
