import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type MockCall } from '@/test/supabase-mock';

/**
 * Small fixes slice 2 review (finding 5). When an import is approved under an
 * owning charter that already has an item with the same SKU, the line moves to
 * that item and the item THIS import had just created is archived as an
 * orphan. That archive's error was never read: an orphan the write did not
 * archive stayed active and visible (an Expected row) and nobody heard of it.
 * Since 0395 the delete guard (trg_zz_inventory_items_no_delete_with_stock)
 * can refuse a soft delete too, though an orphan holds nothing today (it is
 * fresh, with 0 on record). The archive is still not a reason to fail the
 * approval (the PO lines already point at the right item), so a failed one is
 * reported, as a failed PO number or created-item stamp already is.
 */

const { reportError, mockInvCreate } = vi.hoisted(() => ({
  reportError: vi.fn(async () => {}),
  mockInvCreate: vi.fn(async () => ({ id: 'itm-new-sibling' })),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./inventory', () => ({
  InventoryService: class {
    create = mockInvCreate;
  },
}));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { PoImportsService } from './po-imports';

const IMPORT_ID = 'imp-1';
const WH = 'aaaaaaaa-0000-0000-0000-000000000001';
const CHARTER_A = 'chr-operational-A';

function makeStub(archive: { error: { message: string; code?: string; hint?: string } | null }) {
  let lineSelectCall = 0;
  return makeSupabaseStub({
    'po_imports.select': {
      data: { id: IMPORT_ID, organization_id: 'org-test', status: 'parsed', warehouse_id: WH },
      error: null,
    },
    'po_import_lines.select': () => {
      lineSelectCall += 1;
      return lineSelectCall === 1
        ? {
            data: [
              {
                id: 'line-1',
                line_number: 1,
                line_type: 'inventory',
                // Created by THIS import, under another charter: the orphan.
                item_id: 'itm-created-here',
                item_created: true,
                qty_ordered_original: 3,
                unit_cost: 4,
                line_total: 12,
              },
            ],
            error: null,
          }
        : { data: [], error: null };
    },
    'charters.select.maybeSingle': { data: { id: CHARTER_A }, error: null },
    'inventory_items.select': {
      data: [
        {
          id: 'itm-created-here',
          sku: 'SKU-1',
          name: 'Widget',
          barcode: null,
          charter_id: null,
          unit_cost: 4,
          retail_price: 9,
          category_id: null,
          supplier_id: null,
          warehouse_id: WH,
          unit_of_measure: 'unit',
          item_type: 'product',
          tracking_type: 'none',
        },
      ],
      error: null,
    },
    // The owning charter already has this SKU: the line moves to it.
    'inventory_items.select.maybeSingle': { data: { id: 'itm-sibling-under-A' }, error: null },
    'rpc:next_po_number': { data: 'PO-500', error: null },
    'locations.select': { data: { id: 'loc-A' }, error: null },
    'rpc:approve_po_import_commit': { data: 'po-new', error: null },
    // Only the orphan's archive (status archived + deleted_at) answers the
    // given error; any other item update succeeds.
    'inventory_items.update': (call: MockCall) => {
      const payload = (call.args[0]?.[0] ?? {}) as { status?: string };
      return payload.status === 'archived' ? { data: null, error: archive.error } : { data: null, error: null };
    },
    'po_import_lines.update': { data: { id: 'line-1' }, error: null },
  });
}

function approve(stub: ReturnType<typeof makeSupabaseStub>) {
  return new PoImportsService(makeServiceContext(stub.client) as never).approve({
    poImportId: IMPORT_ID,
    vendorId: 'vendor-1',
    warehouseId: WH,
    locationId: 'loc-A',
    itemCharterId: CHARTER_A,
    charterId: null,
    lineOverrides: [],
  } as never);
}

function archiveCalls(stub: ReturnType<typeof makeSupabaseStub>): unknown[][][] {
  return (stub.chainArgsAll.get('inventory_items.update') ?? []).filter(
    (args) => ((args[0]?.[0] ?? {}) as { status?: string }).status === 'archived',
  );
}

beforeEach(() => vi.clearAllMocks());

describe('PO import approval: archiving the orphan it superseded', () => {
  it('archives the orphan and reports nothing when the write succeeds', async () => {
    const stub = makeStub({ error: null });
    const res = await approve(stub);
    expect(res.poId).toBe('po-new');
    expect(archiveCalls(stub)).toHaveLength(1);
    expect(reportError).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tag: 'po_import.approve.archive_orphan' }));
  });

  it('reports an archive the database refused, and still approves (the lines already point at the right item)', async () => {
    const stub = makeStub({
      error: { message: 'item_holds_stock', code: '23514', hint: 'item_holds_stock' },
    });
    const res = await approve(stub);
    expect(res.poId).toBe('po-new');
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tag: 'po_import.approve.archive_orphan',
        organizationId: 'org-test',
        extra: expect.objectContaining({ itemId: 'itm-created-here', code: '23514' }),
      }),
    );
  });
});
