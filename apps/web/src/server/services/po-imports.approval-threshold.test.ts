import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

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
 *
 * Two gates, two jobs. The service's check (assertPoApprovalThreshold) is the
 * FRIENDLY one: it reads the org setting and refuses before any write, with a
 * message that names the amounts. The binding one runs inside
 * approve_po_import_commit against the STORED line values (pgTAP 0360
 * assertions 43 and 49), which the RPC stub here stands in for.
 */
function makeStub(opts: {
  lineTotal: number;
  threshold: number | null;
  lines?: Array<Record<string, unknown>>;
  commit?: QueryResult;
}) {
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
            data: opts.lines ?? [
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
    // The claim, the PO, its lines and charges are one database call now.
    'rpc:approve_po_import_commit': opts.commit ?? { data: 'po-new', error: null },
  });
}

function approve(
  stub: ReturnType<typeof makeSupabaseStub>,
  role: 'owner' | 'admin' | 'manager',
  lineOverrides: Array<Record<string, unknown>> = [],
) {
  const svc = new PoImportsService(makeServiceContext(stub.client, { role }) as never);
  return svc.approve({
    poImportId: IMPORT_ID,
    vendorId: 'vendor-1',
    warehouseId: WH,
    locationId: LOC,
    lineOverrides,
  } as never);
}

const commitCalls = (stub: ReturnType<typeof makeSupabaseStub>) =>
  stub.rpcCalls.filter((c) => c.name === 'approve_po_import_commit');

beforeEach(() => vi.clearAllMocks());

describe('PoImportsService.approve — approval threshold (HI-1 path 2)', () => {
  it('blocks a manager approving an above-threshold import — no PO is inserted', async () => {
    const stub = makeStub({ lineTotal: 750, threshold: 500 });
    const err = await approve(stub, 'manager').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
    expect((err as ServiceError).message).toMatch(/approval threshold/i);
    // The receivable purchase_orders row must never have been written: the
    // friendly check refused before the commit was even called.
    expect(commitCalls(stub)).toHaveLength(0);
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
  });

  it('blocks exactly AT the threshold (>= semantics)', async () => {
    const stub = makeStub({ lineTotal: 500, threshold: 500 });
    const err = await approve(stub, 'manager').catch((e: unknown) => e);
    expect((err as ServiceError).code).toBe('forbidden');
    expect(commitCalls(stub)).toHaveLength(0);
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
  });

  it('lets a manager approve BELOW the threshold', async () => {
    const stub = makeStub({ lineTotal: 100, threshold: 500 });
    const res = await approve(stub, 'manager');
    expect(res.poId).toBe('po-new');
    // The friendly check did run for a manager (it read the org setting)…
    expect(stub.fromCalls.filter((t) => t === 'organization_modules')).toHaveLength(1);
    // …and the PO was created through the one commit, never a direct insert.
    expect(commitCalls(stub)).toHaveLength(1);
    expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
  });

  it('no threshold configured → manager can approve any size', async () => {
    const stub = makeStub({ lineTotal: 50_000, threshold: null });
    const res = await approve(stub, 'manager');
    expect(res.poId).toBe('po-new');
    expect(commitCalls(stub)).toHaveLength(1);
  });

  it('exempts an admin from the threshold (no organization_modules read)', async () => {
    const stub = makeStub({ lineTotal: 9_999, threshold: 500 });
    const res = await approve(stub, 'admin');
    expect(res.poId).toBe('po-new');
    expect(stub.fromCalls.filter((t) => t === 'organization_modules')).toHaveLength(0);
    expect(commitCalls(stub)).toHaveLength(1);
  });

  it("maps the database's own threshold refusal to forbidden", async () => {
    // The friendly check passes (100 < 500), but the commit, pricing the
    // STORED lines, refuses: the setting was lowered in between, or the
    // review's view of the total was stale. pgTAP 0360 assertion 43 proves the
    // database raises this; here the service must turn it into the same
    // forbidden the friendly check gives, not an internal error.
    const stub = makeStub({
      lineTotal: 100,
      threshold: 500,
      commit: { data: null, error: { message: 'po_over_approval_threshold', code: '42501' } },
    });
    const err = await approve(stub, 'manager').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('forbidden');
    expect((err as ServiceError).message).toMatch(/approval threshold/i);
    expect(commitCalls(stub)).toHaveLength(1);
  });
});

describe('PoImportsService.approve — the commit takes decisions, never amounts', () => {
  it('sends only line_id, item_id and line_type for each kept line, and leaves skipped lines out', async () => {
    // The database prices the PO from the stored import lines, so the only
    // thing the caller may send is this review's decisions. A quantity, cost
    // or total in p_lines would be a number the caller could understate to
    // slip under the threshold.
    const stub = makeStub({
      lineTotal: 0,
      threshold: null,
      lines: [
        { id: 'line-1', line_number: 1, line_type: 'inventory', item_id: 'itm-1', qty_ordered_original: 2, unit_cost: 5, line_total: 10 },
        // Skipped in review: must not reach the commit at all.
        { id: 'line-2', line_number: 2, line_type: 'inventory', item_id: 'itm-2', qty_ordered_original: 1, unit_cost: 99, line_total: 99 },
        { id: 'line-3', line_number: 3, line_type: 'tax', item_id: null, description: 'Sales tax', qty_ordered_original: 1, unit_cost: 3, line_total: 3 },
        // Re-mapped in review: the commit gets the reviewer's item.
        { id: 'line-4', line_number: 4, line_type: 'inventory', item_id: 'itm-old', qty_ordered_original: 4, unit_cost: 2, line_total: 8 },
        // Re-classified as freight in review: a charge never carries an item,
        // even when the stored line still has one.
        { id: 'line-5', line_number: 5, line_type: 'inventory', item_id: 'itm-5', qty_ordered_original: 1, unit_cost: 7, line_total: 7 },
      ],
    });

    const res = await approve(stub, 'admin', [
      { lineId: 'line-2', skip: true },
      { lineId: 'line-4', itemId: 'itm-override' },
      { lineId: 'line-5', lineType: 'freight' },
    ]);
    expect(res.poId).toBe('po-new');

    const calls = commitCalls(stub);
    expect(calls).toHaveLength(1);
    const pLines = (calls[0]!.args as { p_lines: Array<Record<string, unknown>> }).p_lines;

    expect(pLines).toEqual([
      { line_id: 'line-1', item_id: 'itm-1', line_type: 'inventory' },
      { line_id: 'line-3', item_id: null, line_type: 'tax' },
      { line_id: 'line-4', item_id: 'itm-override', line_type: 'inventory' },
      { line_id: 'line-5', item_id: null, line_type: 'freight' },
    ]);
    // Spelled out so a new field fails with a clear message, not a diff.
    for (const l of pLines) {
      expect(Object.keys(l).sort()).toEqual(['item_id', 'line_id', 'line_type']);
    }
    expect(pLines.map((l) => l.line_id)).not.toContain('line-2');
  });
});
