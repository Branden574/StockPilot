import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// po-imports approve/cancel only touch the DB + audit. Stub the heavy
// collaborators the module pulls in so the suite stays hermetic.
const { mockAudit: _mockAudit } = vi.hoisted(() => ({ mockAudit: vi.fn(async () => {}) }));
vi.mock('./audit', () => ({ audit: _mockAudit }));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

const mockAudit = _mockAudit;

import { ServiceError } from './context';
import { PoImportsService } from './po-imports';

const IMPORT_ID = 'imp-1';
const WH_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── cancel() archives import-created items ────────────────────────────────────

describe('PoImportsService.cancel — cleanup of auto-created items (Fix #2)', () => {
  it('archives only the import-created, unused items and keeps ones still on a live PO', async () => {
    // Two items were auto-created by the import (item_created lines): item-A and
    // item-B. Both are active + zero on-hand. item-B is still referenced by an
    // ordered (non-cancelled) PO, so it must survive; item-A must be archived.
    const stub = makeSupabaseStub({
      'po_imports.update': { data: { id: IMPORT_ID }, error: null }, // cancel succeeds
      'po_import_lines.select': {
        data: [{ item_id: 'item-A' }, { item_id: 'item-B' }],
        error: null,
      },
      'inventory_items.select': {
        data: [
          { id: 'item-A', name: 'Created A' },
          { id: 'item-B', name: 'Created B' },
        ],
        error: null,
      },
      // item-B is on an ordered PO → keep it; item-A appears on nothing live.
      'purchase_order_items.select': {
        data: [{ item_id: 'item-B', po: { status: 'ordered' } }],
        error: null,
      },
      // The archive update returns only the rows it flipped (race-guarded).
      'inventory_items.update': { data: [{ id: 'item-A', name: 'Created A' }], error: null },
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.cancel(IMPORT_ID);

    // The candidate query enforces active + zero-on-hand (never touch received stock).
    const candArgs = (stub.chainArgsAll.get('inventory_items.select') ?? []).flat(2);
    expect(candArgs).toContain('status');
    expect(candArgs).toContain('active');
    expect(candArgs).toContain('quantity_on_hand');
    expect(candArgs).toContain(0);

    // The archive update targeted item-A ONLY (item-B kept — on a live PO).
    // flat(Infinity): .in('id', [...]) nests the id array one level deeper.
    const updateArgs = (stub.chainArgsAll.get('inventory_items.update') ?? []).flat(Infinity);
    expect(updateArgs).toContain('item-A');
    expect(updateArgs).not.toContain('item-B');
    const updatePayload = stub.chainArgs.get('inventory_items.update')?.[0]?.[0] as Record<string, unknown>;
    expect(updatePayload?.status).toBe('archived');
    // Race guard: only flip rows still active.
    expect(updateArgs).toContain('active');

    // Audited the archive of item-A with the cancellation reason.
    const archivedCall = mockAudit.mock.calls
      .map((c) => (c as unknown as [Record<string, unknown>])[0])
      .find((a) => a.event === 'inventory.item.archived');
    expect(archivedCall?.entityId).toBe('item-A');
    expect((archivedCall?.extra as Record<string, unknown>)?.reason).toBe('po_import_canceled');
    // And the cancellation itself was audited.
    expect(
      mockAudit.mock.calls.some(
        (c) => (c as unknown as [{ event?: string }])[0]?.event === 'po_import.canceled',
      ),
    ).toBe(true);
  });

  it('archives nothing when the import created no items (only linked existing ones)', async () => {
    const stub = makeSupabaseStub({
      'po_imports.update': { data: { id: IMPORT_ID }, error: null },
      'po_import_lines.select': { data: [], error: null }, // no item_created lines
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.cancel(IMPORT_ID);

    // No inventory mutation at all — pre-existing linked items are never touched.
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
    expect(stub.chainsAll.get('inventory_items.select')).toBeUndefined();
    expect(
      mockAudit.mock.calls.some(
        (c) => (c as unknown as [{ event?: string }])[0]?.event === 'po_import.canceled',
      ),
    ).toBe(true);
  });

  it('fails closed (conflict) and skips cleanup when the import is gone or already finalized', async () => {
    const stub = makeSupabaseStub({
      'po_imports.update': { data: null, error: null }, // 0-row update
    });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    const thrown = await svc.cancel(IMPORT_ID).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('conflict');
    // No cleanup ran (we never confirmed the cancel happened).
    expect(stub.chainsAll.get('po_import_lines.select')).toBeUndefined();
    expect(stub.chainsAll.get('inventory_items.update')).toBeUndefined();
  });
});

// ─── approve() stamps created items + honours chosen location ──────────────────

describe('PoImportsService.approve — stamps created items + destination (Fix #2/#3)', () => {
  /** Build an approve() stub. po_import_lines.select is called twice (get() lines,
   *  then the item_created stamping query) so it uses a counter. Pass
   *  locationRow: null to simulate a chosen location that is NOT in the
   *  org/warehouse (the lookup misses). */
  function makeApproveStub(opts: { locationRow?: { id: string } | null } = {}) {
    let lineSelectCall = 0;
    const locationRow = 'locationRow' in opts ? opts.locationRow : { id: 'loc-chosen' };
    return makeSupabaseStub({
      'po_imports.select': {
        data: { id: IMPORT_ID, organization_id: 'org-test', status: 'parsed', warehouse_id: WH_UUID },
        error: null,
      },
      'po_import_lines.select': () => {
        lineSelectCall += 1;
        // 1st = get() lines; 2nd = created-items stamping query.
        return lineSelectCall === 1
          ? {
              data: [
                {
                  id: 'line-1',
                  line_number: 1,
                  line_type: 'inventory',
                  item_id: 'item-A',
                  qty_ordered_original: 2,
                  unit_cost: 5,
                  line_total: 10,
                },
              ],
              error: null,
            }
          : { data: [{ item_id: 'item-A' }], error: null }; // item_created line
      },
      'rpc:next_po_number': { data: 'PO-100', error: null },
      // resolveDestinationLocation: the preferred-location verification lookup.
      'locations.select': { data: locationRow ?? null, error: null },
      'purchase_orders.insert': { data: { id: 'new-po' }, error: null },
      'purchase_order_items.insert': { data: null, error: null },
      'inventory_items.update': { data: null, error: null },
      // approve() CLAIMS the import (conditional update) before it inserts
      // the PO, and stamps approved_po_id afterwards. Both are checked
      // writes, so the stub has to answer with a ROW or every approval
      // reads as a lost race.
      'po_imports.update': { data: { id: IMPORT_ID }, error: null },
    });
  }

  it('creates the PO at the chosen location and stamps created_from on import-created items', async () => {
    const stub = makeApproveStub();
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    const result = await svc.approve({
      poImportId: IMPORT_ID,
      vendorId: 'vendor-1',
      warehouseId: WH_UUID,
      locationId: 'loc-chosen',
      lineOverrides: [],
    } as never);

    expect(result.poId).toBe('new-po');

    // Fix #3: the PO was created at the user's chosen destination location.
    const poInsert = stub.chainArgs.get('purchase_orders.insert')?.[0]?.[0] as Record<string, unknown>;
    expect(poInsert?.destination_location_id).toBe('loc-chosen');
    expect(poInsert?.status).toBe('expected_inbound');
    // expected_at defaults to null when no expectedAt is supplied.
    expect(poInsert?.expected_at ?? null).toBeNull();

    // Fix #2: created_from_purchase_order_id stamped onto the import-created item,
    // so cancelling the PO later archives it via the normal cleanup.
    const stampPayload = stub.chainArgs.get('inventory_items.update')?.[0]?.[0] as Record<string, unknown>;
    expect(stampPayload?.created_from_purchase_order_id).toBe('new-po');
    const stampArgs = (stub.chainArgsAll.get('inventory_items.update') ?? []).flat(Infinity);
    expect(stampArgs).toContain('item-A');

    // The stamping query filtered on item_created=true (never stamps linked items).
    const lineSelectArgs = (stub.chainArgsAll.get('po_import_lines.select') ?? []).flat(2);
    expect(lineSelectArgs).toContain('item_created');
    expect(lineSelectArgs).toContain(true);
  });

  it('sets expected_at on the created PO when an expectedAt is supplied', async () => {
    const stub = makeApproveStub();
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    await svc.approve({
      poImportId: IMPORT_ID,
      vendorId: 'vendor-1',
      warehouseId: WH_UUID,
      locationId: 'loc-chosen',
      expectedAt: '2026-07-15T00:00:00.000Z',
      lineOverrides: [],
    } as never);

    const poInsert = stub.chainArgs.get('purchase_orders.insert')?.[0]?.[0] as Record<string, unknown>;
    expect(poInsert?.expected_at).toBe('2026-07-15T00:00:00.000Z');
  });

  // Owner directive 2026-07-08: the destination location is REQUIRED and the
  // old fallback (pick any location in the warehouse, else AUTO-CREATE one)
  // is gone — an absent/foreign location throws, never silently substitutes.
  it('rejects approve with NO location — no PO created, no location looked up or auto-created', async () => {
    const stub = makeApproveStub();
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .approve({
        poImportId: IMPORT_ID,
        vendorId: 'vendor-1',
        warehouseId: WH_UUID,
        lineOverrides: [],
      } as never)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    expect((thrown as ServiceError).message).toBe(
      'Pick a destination location for this warehouse.',
    );
    // Nothing was created: no PO, and crucially no synthetic location.
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
    expect(stub.chainsAll.get('locations.insert')).toBeUndefined();
    // The old any-location-in-warehouse fallback never even queried locations.
    expect(stub.chainsAll.get('locations.select')).toBeUndefined();
  });

  it('rejects a location that is not in this org/warehouse — and never falls back or auto-creates', async () => {
    // The verification lookup misses (cross-warehouse / cross-org / deleted id).
    const stub = makeApproveStub({ locationRow: null });
    const svc = new PoImportsService(makeServiceContext(stub.client) as never);

    const thrown = await svc
      .approve({
        poImportId: IMPORT_ID,
        vendorId: 'vendor-1',
        warehouseId: WH_UUID,
        locationId: 'loc-foreign',
        lineOverrides: [],
      } as never)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('validation_error');
    expect((thrown as ServiceError).message).toBe(
      'Pick a destination location for this warehouse.',
    );
    // The lookup was scoped to org + warehouse + not-deleted…
    const locArgs = (stub.chainArgsAll.get('locations.select') ?? []).flat(Infinity);
    expect(locArgs).toContain('organization_id');
    expect(locArgs).toContain('warehouse_id');
    expect(locArgs).toContain(WH_UUID);
    expect(locArgs).toContain('loc-foreign');
    expect(locArgs).toContain('deleted_at');
    // …and on a miss nothing was created: no PO, no synthetic location, and
    // the removed auto-create branch's warehouse-name lookup never ran.
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
    expect(stub.chainsAll.get('locations.insert')).toBeUndefined();
    expect(stub.chainsAll.get('warehouses.select')).toBeUndefined();
  });

  it('rejects approving an import that is not in a reviewable status', async () => {
    const stub = makeApproveStub();
    // Override the header to an already-approved status.
    const approvedStub = makeSupabaseStub({
      'po_imports.select': { data: { id: IMPORT_ID, status: 'approved', warehouse_id: WH_UUID }, error: null },
      'po_import_lines.select': { data: [], error: null },
    });
    void stub;
    const svc = new PoImportsService(makeServiceContext(approvedStub.client) as never);

    const thrown = await svc
      .approve({ poImportId: IMPORT_ID, vendorId: 'v', warehouseId: WH_UUID, lineOverrides: [] } as never)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(ServiceError);
    expect((thrown as ServiceError).code).toBe('conflict');
    // No PO created.
    expect(approvedStub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
  });
});
