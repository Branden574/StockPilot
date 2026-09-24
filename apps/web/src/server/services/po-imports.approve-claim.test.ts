import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * approve() must CLAIM the import in the same step that writes the purchase
 * order.
 *
 * Two defects, one root cause (SP-013 / SP-024): the only guard against a
 * second PO was a plain `header.status` READ, and the write that flipped the
 * status was itself unchecked. So (a) two approvals that overlap — a mobile
 * retry after its 20s client timeout while the 60s server call is still
 * running, or two managers on web + mobile — both read 'parsed', both pass,
 * and both insert a receivable purchase_orders row for ONE vendor document;
 * and (b) a stamp that silently matched zero rows (RLS, statement timeout)
 * left a live PO behind an import still showing "Approve".
 *
 * The claim, the PO, its lines, its charges and the import's approved_po_id
 * are now ONE database call, approve_po_import_commit (migration 0360). Its
 * atomicity is a database property and is proven in pgTAP, not here:
 *   0360 assertion 37  claim and link land in the same transaction
 *   0360 assertion 38  an approved import cannot be approved again
 *   0360 assertions 44-46  a failure after the claim rolls the claim back
 *
 * What these tests pin is the APP side of that contract: the service never
 * writes a claim, a PO or a link of its own, it maps the function's refusals
 * to the right error, and nothing downstream (the created-items stamp, the
 * approval audit) runs for a commit that did not happen.
 *
 * The RPC stub models only the function's documented outcome: it claims the
 * row while the row is still claimable and raises `po_import_not_claimable`
 * otherwise.
 */

const { mockAudit } = vi.hoisted(() => ({ mockAudit: vi.fn(async () => {}) }));
vi.mock('./audit', () => ({ audit: mockAudit }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }));

import { PoImportsService } from './po-imports';

const IMPORT_ID = '11111111-1111-4111-8111-111111111111';
const VENDOR_ID = '33333333-3333-4333-8333-333333333333';
const WH = '44444444-4444-4444-8444-444444444444';
const LOC = '55555555-5555-4555-8555-555555555555';

const LINE = {
  id: 'line-1',
  po_import_id: IMPORT_ID,
  line_number: 1,
  line_type: 'inventory',
  description: 'Widget',
  qty_ordered_original: 3,
  unit_cost: 4,
  line_total: 12,
  item_id: 'itm-1',
  item_created: false,
  mapping_confidence: null,
  jersey_number: null,
  variant_size: null,
  variant_size_original: null,
  variant_size_system: null,
  variant_color: null,
  player_name: null,
  group_hint: null,
  serial_hint: null,
};

type Row = Record<string, unknown>;

/**
 * A stub whose `po_imports` row is only ever changed by the commit RPC, the
 * way the database changes it. The created-items sweep answers with LINE's
 * item, so a successful approval stamps exactly one item: a refused one must
 * stamp none.
 */
function makeApproveStub(
  opts: {
    initialStatus?: string;
    /** Serve `get()` a permanently 'parsed' header — models the read/write
     *  race: the row moved on between the status read and the commit. */
    staleHeader?: boolean;
    /** The commit raises, the way prod can (the database rolls back with it). */
    commitError?: { message: string; code?: string };
    /** The commit reports success but hands back no PO id. */
    commitReturnsNoId?: boolean;
  } = {},
) {
  const row: Row = {
    id: IMPORT_ID,
    organization_id: 'org-test',
    status: opts.initialStatus ?? 'parsed',
    warehouse_id: WH,
    approved_po_id: null,
    approved_at: null,
    approved_by: null,
  };
  let posMinted = 0;

  const stub = makeSupabaseStub({
    'po_imports.select': () => ({
      data: opts.staleHeader ? { ...row, status: 'parsed' } : { ...row },
      error: null,
    }),
    'po_import_lines.select': { data: [LINE], error: null },
    'locations.select': { data: { id: LOC }, error: null },
    'organization_modules.select': { data: { settings: {} }, error: null },
    'rpc:next_po_number': { data: 'PO-500', error: null },
    'rpc:approve_po_import_commit': (call) => {
      if (opts.commitError) return { data: null, error: opts.commitError };
      if (opts.commitReturnsNoId) return { data: null, error: null };
      const args = call.args[0]?.[0] as { p_import_id: string };
      const claimable = row.status === 'parsed' || row.status === 'needs_review';
      if (args.p_import_id !== row.id || !claimable) {
        return { data: null, error: { message: 'po_import_not_claimable', code: 'P0001' } };
      }
      posMinted += 1;
      const poId = `po-${posMinted}`;
      Object.assign(row, { status: 'approved', approved_po_id: poId, approved_by: 'user-test' });
      return { data: poId, error: null };
    },
    'inventory_items.update': { data: null, error: null },
  });

  const svc = new (PoImportsService as unknown as new (ctx: unknown) => PoImportsService)(
    makeServiceContext(stub.client, {
      organizationId: 'org-test',
      role: 'admin',
      enabledModules: new Set<ModuleId>(['inventory', 'po_imports']),
    }),
  );
  return { svc, stub, row, posMinted: () => posMinted };
}

const APPROVE_INPUT = {
  poImportId: IMPORT_ID,
  vendorId: VENDOR_ID,
  warehouseId: WH,
  locationId: LOC,
  lineOverrides: [],
};

const commitCalls = (stub: ReturnType<typeof makeSupabaseStub>) =>
  stub.rpcCalls.filter((c) => c.name === 'approve_po_import_commit');
const approvalAudits = () =>
  mockAudit.mock.calls.filter(
    (c) => (c as unknown as [{ event?: string }])[0]?.event === 'po_import.approved',
  );
const createdFromStamps = (stub: ReturnType<typeof makeSupabaseStub>) =>
  stub.chainsAll.get('inventory_items.update') ?? [];

/** The service must never write the claim, the PO or the link itself. */
function expectNoDirectApprovalWrites(stub: ReturnType<typeof makeSupabaseStub>) {
  expect(stub.chainsAll.get('po_imports.update')).toBeUndefined();
  expect(stub.chainsAll.get('purchase_orders.insert')).toBeUndefined();
  expect(stub.chainsAll.get('purchase_order_items.insert')).toBeUndefined();
  expect(stub.chainsAll.get('purchase_order_charges.insert')).toBeUndefined();
}

beforeEach(() => vi.clearAllMocks());

describe('PoImportsService.approve — the status claim is atomic (SP-013)', () => {
  it('creates exactly ONE purchase order when two approvals overlap', async () => {
    const { svc, stub, row, posMinted } = makeApproveStub();

    // Both callers start before either has finished: the status READ each one
    // does returns 'parsed' for both. Only the claim inside the commit can
    // separate them.
    const [a, b] = await Promise.allSettled([
      svc.approve(APPROVE_INPUT as never),
      svc.approve(APPROVE_INPUT as never),
    ]);

    // Both got past the read and reached the commit, so the refusal below
    // came from the claim, not from the read-then-act check.
    expect(commitCalls(stub)).toHaveLength(2);
    expect(posMinted()).toBe(1);

    const outcomes = [a, b];
    const winner = outcomes.find((o) => o.status === 'fulfilled') as PromiseFulfilledResult<{
      poId: string;
    }>;
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(winner.value.poId).toBe(row.approved_po_id);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(loser).toBeDefined();
    expect((loser.reason as { code?: string }).code).toBe('conflict');

    expectNoDirectApprovalWrites(stub);
  });

  it('never touches the ledger when the claim matches no row', async () => {
    // `get()` keeps reporting 'parsed' — a stale read is exactly what a
    // read-then-act guard cannot survive. The ROW, meanwhile, was approved by
    // the first call, so the commit's claim must refuse the second.
    const { svc, stub, row } = makeApproveStub({ staleHeader: true });

    await svc.approve(APPROVE_INPUT as never);
    const firstPo = row.approved_po_id;
    // The first, legitimate approval stamped its created item and was audited.
    expect(createdFromStamps(stub)).toHaveLength(1);
    expect(approvalAudits()).toHaveLength(1);

    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({
      code: 'conflict',
    });

    // The refused call reached the commit and stopped there: no second
    // created-from stamp, no second approval audit, and the import still
    // points at the first PO.
    expect(commitCalls(stub)).toHaveLength(2);
    expect(createdFromStamps(stub)).toHaveLength(1);
    expect(approvalAudits()).toHaveLength(1);
    expect(row.approved_po_id).toBe(firstPo);
    expectNoDirectApprovalWrites(stub);
  });

  it('surfaces a failed commit as internal_error and makes no po_imports write of its own', async () => {
    // Replaces "releases the claim when the purchase order itself fails to
    // insert". The service no longer holds a claim it could give back: the
    // commit failing rolls the claim back inside the database (pgTAP 0360
    // assertions 44-45), so any po_imports write here would be a second,
    // racing hand on the row.
    const { svc, stub } = makeApproveStub({
      commitError: { message: 'insert failed', code: 'XX000' },
    });

    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({
      code: 'internal_error',
    });

    expect(commitCalls(stub)).toHaveLength(1);
    expectNoDirectApprovalWrites(stub);
    expect(createdFromStamps(stub)).toHaveLength(0);
    expect(approvalAudits()).toHaveLength(0);
  });

  it('maps a PO number collision to conflict so the user can simply retry', async () => {
    // 23505 on purchase_orders(organization_id, po_number): the whole commit,
    // claim included, rolled back (pgTAP 0360 assertions 44-46), so a retry
    // takes a fresh number and is safe.
    const { svc, stub } = makeApproveStub({
      commitError: {
        message:
          'duplicate key value violates unique constraint "purchase_orders_org_ponumber_active_key"',
        code: '23505',
      },
    });

    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(createdFromStamps(stub)).toHaveLength(0);
    expect(approvalAudits()).toHaveLength(0);
  });

  it('does not call some OTHER unique violation a PO number collision', async () => {
    const { svc } = makeApproveStub({
      commitError: {
        message: 'duplicate key value violates unique constraint "some_other_key"',
        code: '23505',
      },
    });
    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it("maps the function's validation refusals to validation_error and a vanished import to not_found", async () => {
    for (const [message, code] of [
      ['line_item_invalid', 'validation_error'],
      ['lines_invalid', 'validation_error'],
      ['destination_invalid', 'validation_error'],
      ['po_import_not_found', 'not_found'],
    ] as const) {
      const { svc } = makeApproveStub({ commitError: { message, code: '22023' } });
      await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({ code });
    }
  });
});

describe('PoImportsService.approve — the commit result is checked (SP-024)', () => {
  // The approved_po_id stamp now lands inside approve_po_import_commit (pgTAP
  // 0360 assertion 37). The app-side half of SP-024 is what remains: a commit
  // that does not hand back a PO id is a failure, never a silent success.

  it('fails loudly when the commit returns no purchase order id, instead of reporting success', async () => {
    const { svc, stub } = makeApproveStub({ commitReturnsNoId: true });

    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({
      code: 'internal_error',
    });
    // Nothing may claim the import was approved without a PO behind it.
    expect(approvalAudits()).toHaveLength(0);
    expect(createdFromStamps(stub)).toHaveLength(0);
  });

  it('fails loudly when the commit errors', async () => {
    const { svc, stub } = makeApproveStub({
      commitError: { message: 'canceling statement due to statement timeout', code: '57014' },
    });

    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(approvalAudits()).toHaveLength(0);
    expect(createdFromStamps(stub)).toHaveLength(0);
  });
});
