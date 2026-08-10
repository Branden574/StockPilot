import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// approve() constructs InventoryService only inside the ownership-charter block
// (not exercised here) but the module import must still resolve. Audit + the
// parser/scan/admin side-modules are stubbed so the service loads with no env.
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./inventory', () => ({
  InventoryService: class {
    create = vi.fn(async () => ({ id: 'itm-x' }));
  },
}));
vi.mock('@/lib/po-parser', () => ({ parsePoFile: vi.fn() }));
vi.mock('@/lib/po-scan/extract', () => ({ extractPoFromMedia: vi.fn(), SCAN_MODEL_NAME: 'mock' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { ServiceError } from './context';
import { PoImportsService } from './po-imports';

const IMPORT_ID = '11111111-1111-1111-1111-111111111111';
const WH = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOC = 'bbbbbbbb-0000-0000-0000-000000000002';

/**
 * A parsed import with ONE inventory line whose `line_total` is `lineTotal`,
 * plus the module settings that back the approval threshold. Enough for
 * approve() to compute a total and reach the spend-governance gate.
 */
function makeStub(opts: { lineTotal: number; threshold: number | null }) {
  let lineSelectCall = 0;
  return makeSupabaseStub({
    'po_imports.select': {
      data: { id: IMPORT_ID, organization_id: 'org-test', status: 'parsed', warehouse_id: WH },
      error: null,
    },
    'po_import_lines.select': () => {
      lineSelectCall += 1;
      // get() reads the lines on the first call; the later created-items sweep
      // gets an empty set (nothing was auto-created here).
      return lineSelectCall === 1
        ? {
            data: [
              {
                id: 'line-1',
                line_number: 1,
                line_type: 'inventory',
                item_id: 'itm-1',
                qty_ordered_original: 1,
                unit_cost: opts.lineTotal,
                line_total: opts.lineTotal,
              },
            ],
            error: null,
          }
        : { data: [], error: null };
    },
    'organization_modules.select': {
      data:
        opts.threshold === null
          ? { settings: {} }
          : { settings: { approvalThresholdAmount: opts.threshold } },
      error: null,
    },
    'rpc:next_po_number': { data: 'PO-900', error: null },
    'locations.select': { data: { id: LOC }, error: null },
    'purchase_orders.insert': { data: { id: 'po-new' }, error: null },
    'purchase_order_items.insert': { data: null, error: null },
    'purchase_order_charges.insert': { data: null, error: null },
    'po_imports.update': { data: null, error: null },
  });
}

function approve(
  stub: ReturnType<typeof makeSupabaseStub>,
  role: 'owner' | 'admin' | 'manager',
) {
  const svc = new PoImportsService(makeServiceContext(stub.client, { role }) as never);
  return svc.approve({
    poImportId: IMPORT_ID,
    vendorId: 'vendor-1',
    warehouseId: WH,
    locationId: LOC,
    lineOverrides: [],
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('PoImportsService.approve — approval threshold (HI-1 path 2)', () => {
  it('blocks a manager approving an above-threshold import — no PO is inserted', async () => {
    const stub = makeStub({ lineTotal: 750, threshold: 500 });
    const err = await approve(stub, 'manager').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
    expect((err as ServiceError).message).toMatch(/approval threshold/i);
    // The receivable purchase_orders row must never have been written.
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
  });

  it('blocks exactly AT the threshold (>= semantics)', async () => {
    const stub = makeStub({ lineTotal: 500, threshold: 500 });
    const err = await approve(stub, 'manager').catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('forbidden');
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
  });

  it('lets a manager approve BELOW the threshold', async () => {
    const stub = makeStub({ lineTotal: 100, threshold: 500 });
    const res = await approve(stub, 'manager');
    expect(res.poId).toBe('po-new');
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeDefined();
  });

  it('no threshold configured → manager can approve any size', async () => {
    const stub = makeStub({ lineTotal: 50_000, threshold: null });
    const res = await approve(stub, 'manager');
    expect(res.poId).toBe('po-new');
  });

  it('exempts an admin from the threshold (no organization_modules read)', async () => {
    const stub = makeStub({ lineTotal: 9_999, threshold: 500 });
    const res = await approve(stub, 'admin');
    expect(res.poId).toBe('po-new');
    expect(stub.fromCalls.filter((t) => t === 'organization_modules')).toHaveLength(0);
  });
});
