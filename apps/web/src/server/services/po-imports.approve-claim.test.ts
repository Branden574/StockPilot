import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * approve() must CLAIM the import before it writes a purchase order.
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
 * These tests model the po_imports row as a tiny state machine that actually
 * EVALUATES the filters the service sends, so a conditional update behaves the
 * way Postgres would: it matches only while the row is still claimable.
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
 * A stub whose `po_imports` row remembers writes AND honours the WHERE clause
 * (`eq` / `in` / `is` / `not …in`) the service actually built. Without that,
 * a "claim" test would pass against code that sends no claim at all.
 */
function makeApproveStub(
  opts: {
    initialStatus?: string;
    poInsertError?: { message: string };
    /** Serve `get()` a permanently 'parsed' header — models the read/write
     *  race: the row moved on between the status read and the write. */
    staleHeader?: boolean;
    /** Force the terminal approved_po_id stamp to fail the way prod can. */
    stampFails?: 'zero_rows' | 'error';
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

  let stub: ReturnType<typeof makeSupabaseStub>;

  function applyUpdate(): { data: unknown; error: { message: string } | null } {
    const methods = stub.chains.get('po_imports.update') ?? [];
    const args = stub.chainArgs.get('po_imports.update') ?? [];
    const payload = (args[0]?.[0] ?? {}) as Row;

    // Evaluate the filters exactly as Postgres would: any non-matching
    // predicate means ZERO rows updated, which supabase-js reports as
    // `{ data: null, error: null }` — the fail-open shape pattern #2 warns of.
    for (let i = 1; i < methods.length; i += 1) {
      const m = methods[i];
      const a = args[i] ?? [];
      if (m === 'eq' && row[String(a[0])] !== a[1]) return { data: null, error: null };
      if (m === 'is' && row[String(a[0])] !== a[1]) return { data: null, error: null };
      if (m === 'in') {
        const vals = (a[1] ?? []) as unknown[];
        if (!vals.includes(row[String(a[0])])) return { data: null, error: null };
      }
      if (m === 'not' && a[1] === 'in') {
        const list = String(a[2]).replace(/[()]/g, '').split(',');
        if (list.includes(String(row[String(a[0])]))) return { data: null, error: null };
      }
    }

    if (opts.stampFails && 'approved_po_id' in payload) {
      return opts.stampFails === 'error'
        ? { data: null, error: { message: 'canceling statement due to statement timeout' } }
        : { data: null, error: null };
    }

    Object.assign(row, payload);
    return { data: { id: row.id }, error: null };
  }

  stub = makeSupabaseStub({
    'po_imports.select': () => ({
      data: opts.staleHeader ? { ...row, status: 'parsed' } : { ...row },
      error: null,
    }),
    'po_imports.update': applyUpdate,
    'po_import_lines.select': { data: [LINE], error: null },
    'po_import_lines.update': { data: { id: LINE.id }, error: null },
    'locations.select': { data: { id: LOC }, error: null },
    'organization_modules.select': { data: { settings: {} }, error: null },
    'rpc:next_po_number': { data: 'PO-500', error: null },
    'purchase_orders.insert': opts.poInsertError
      ? { data: null, error: opts.poInsertError }
      : { data: { id: 'po-new' }, error: null },
    'purchase_order_items.insert': { data: null, error: null },
    'purchase_order_charges.insert': { data: null, error: null },
    'inventory_items.update': { data: { id: 'itm-1' }, error: null },
  } as never);

  const svc = new (PoImportsService as unknown as new (ctx: unknown) => PoImportsService)(
    makeServiceContext(stub.client, {
      organizationId: 'org-test',
      role: 'admin',
      enabledModules: new Set<ModuleId>(['inventory', 'po_imports']),
    }),
  );
  return { svc, stub, row };
}

const APPROVE_INPUT = {
  poImportId: IMPORT_ID,
  vendorId: VENDOR_ID,
  warehouseId: WH,
  locationId: LOC,
  lineOverrides: [],
};

beforeEach(() => vi.clearAllMocks());

describe('PoImportsService.approve — the status claim is atomic (SP-013)', () => {
  it('creates exactly ONE purchase order when two approvals overlap', async () => {
    const { svc, stub } = makeApproveStub();

    // Both callers start before either has finished: the status READ each one
    // does returns 'parsed' for both. Only an atomic claim can separate them.
    const [a, b] = await Promise.allSettled([
      svc.approve(APPROVE_INPUT as never),
      svc.approve(APPROVE_INPUT as never),
    ]);

    const inserts = stub.chainsAll.get('purchase_orders.insert') ?? [];
    expect(inserts).toHaveLength(1);

    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(loser).toBeDefined();
    expect((loser.reason as { code?: string }).code).toBe('conflict');
  });

  it('never touches the ledger when the claim matches no row', async () => {
    // `get()` keeps reporting 'parsed' — a stale read is exactly what a
    // read-then-act guard cannot survive. The ROW, meanwhile, was approved by
    // the first call, so any conditional claim must match zero rows.
    const { svc, stub } = makeApproveStub({ staleHeader: true });

    await svc.approve(APPROVE_INPUT as never);

    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({
      code: 'conflict',
    });
    // One PO total — from the first, legitimate approval.
    expect(stub.chainsAll.get('purchase_orders.insert')).toHaveLength(1);
  });

  it('releases the claim when the purchase order itself fails to insert', async () => {
    const { svc, stub, row } = makeApproveStub({
      poInsertError: { message: 'insert failed' },
    });

    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({
      code: 'internal_error',
    });

    // No PO exists, so the import must be approvable again — a claim that
    // stuck here would strand the document forever.
    expect(row.status).toBe('parsed');
    expect(row.approved_po_id).toBeNull();
    // Claim + release: two conditional writes were actually issued.
    expect((stub.chainsAll.get('po_imports.update') ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('PoImportsService.approve — the approved stamp is checked (SP-024)', () => {
  it('fails loudly when the stamp matches no row, instead of reporting success', async () => {
    const { svc } = makeApproveStub({ stampFails: 'zero_rows' });

    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({
      code: 'internal_error',
    });
    // Nothing may claim the import was approved when its own row disagrees.
    expect(
      mockAudit.mock.calls.filter(
        (c) => (c as unknown as [{ event?: string }])[0]?.event === 'po_import.approved',
      ),
    ).toHaveLength(0);
  });

  it('fails loudly when the stamp errors', async () => {
    const { svc } = makeApproveStub({ stampFails: 'error' });

    await expect(svc.approve(APPROVE_INPUT as never)).rejects.toMatchObject({
      code: 'internal_error',
    });
    expect(
      mockAudit.mock.calls.filter(
        (c) => (c as unknown as [{ event?: string }])[0]?.event === 'po_import.approved',
      ),
    ).toHaveLength(0);
  });
});
