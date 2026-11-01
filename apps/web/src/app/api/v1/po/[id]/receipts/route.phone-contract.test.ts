import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { RECEIVE_POST_MANAGER_ONLY_COPY, ROLE_PERMISSIONS, type ModuleId } from '@stockpilot/core';

// ═══════════════════════════════════════════════════════════════════════════
// WHAT AN INSTALLED PHONE MAKES OF THIS ROUTE'S REFUSALS, THROUGH THE REAL
// SERVICE.
//
// route.test.ts mocks ReceivingService and pins the route's own branches.
// This file runs the real route over the real ReceivingService.postReceipt,
// down to the post_receipt_v2 call on a stub client, and pins what every
// installed PO screen relies on (app/po/[id].tsx, unchanged since #185): when
// a refusal's details.reason is a string, the screen alerts what
// mapPostReceiptError makes of that REASON instead of the server's sentence,
// and the mapper's default arm shows its input as it is. So the only reason
// this route may send is one that mapper knows, and today that is
// idempotency_conflict: the one refusal whose recovery differs (retire the
// intent key and reload the PO).
//
// Review 2026-11-01: the manager floor added for the receiving checklist sent
// { reason: 'manager_posts' }, and a staff member who tapped Post receipt on
// an installed phone read an alert saying "manager_posts".
// ═══════════════════════════════════════════════════════════════════════════

vi.mock('@/lib/auth/api-context', () => ({ withApiContext: vi.fn() }));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => {}) }));
vi.mock('@/server/loaders/inventory-list', () => ({ revalidateInventoryList: vi.fn() }));
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
  auditMany: vi.fn(async (payloads: readonly unknown[]) => ({
    written: payloads.length,
    lost: 0,
  })),
}));

import { withApiContext } from '@/lib/auth/api-context';

import { POST } from './route';

const PO = '11111111-1111-4111-8111-111111111111';
const WH = '33333333-3333-4333-8333-333333333333';
const LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** The key the phone mints: `mobile-<poId>-<ts>-<rand>`. */
const BODY = {
  warehouseId: WH,
  idempotencyKey: `mobile-${PO}-1725500000000-a1b2c3`,
  lines: [{ poLineId: LINE, qtyReceived: 1, qtyAccepted: 1, qtyRejected: 0 }],
};
const MODULES = new Set<ModuleId>(['receiving', 'purchase_orders'] as ModuleId[]);

/** The only details.reason the installed PO screen's mapper turns into a recovery. */
const REASONS_INSTALLED_PHONES_MAP = ['idempotency_conflict'];

type Caller = {
  role?: 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
  permissions?: string[];
  modules?: Set<ModuleId>;
};

async function postAs(caller: Caller, rpc: QueryResult = { data: null, error: null }) {
  const role = caller.role ?? 'manager';
  const stub = makeSupabaseStub({
    'purchase_order_items.select': { data: [{ id: LINE, item_id: 'item-1' }], error: null },
    'rpc:post_receipt_v2': rpc,
  });
  const ctx = makeServiceContext(stub.client, {
    role,
    permissions: new Set(caller.permissions ?? [...ROLE_PERMISSIONS[role]]),
    enabledModules: caller.modules ?? MODULES,
  });
  vi.mocked(withApiContext).mockResolvedValue(ctx as never);
  const res = await POST(
    new Request(`https://test.local/api/v1/po/${PO}/receipts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODY),
    }) as unknown as Parameters<typeof POST>[0],
    { params: Promise.resolve({ id: PO }) },
  );
  const body = (await res.json()) as {
    error?: string;
    message?: string;
    details?: { reason?: unknown };
  };
  return { status: res.status, body, rpcCalls: stub.rpcCalls };
}

const rpcError = (error: NonNullable<QueryResult['error']>): QueryResult => ({ data: null, error });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a staff member posts a receipt from an installed phone', () => {
  // Mutation caught: the manager refusal thrown with { reason: 'manager_posts' }
  // again (the phone shows "manager_posts").
  it('gets 403 with the manager sentence and no details, and nothing reaches the ledger', async () => {
    const { status, body, rpcCalls } = await postAs({ role: 'staff' });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'forbidden', message: RECEIVE_POST_MANAGER_ONLY_COPY });
    expect(rpcCalls).toEqual([]);
  });
});

describe('every refusal carries only a reason the installed phone maps', () => {
  const cases: Array<[string, Caller, QueryResult?]> = [
    ['staff (the manager floor)', { role: 'staff' }],
    ['a viewer', { role: 'viewer' }],
    [
      'a manager without stock:adjust',
      {
        permissions: ROLE_PERMISSIONS.manager.filter((p) => p !== 'stock:adjust'),
      },
    ],
    ['receiving switched off', { modules: new Set<ModuleId>(['purchase_orders'] as ModuleId[]) }],
    [
      'the first post already landed',
      {},
      rpcError({ code: '55000', message: 'idempotency_conflict' }),
    ],
    ['a closed PO', {}, rpcError({ code: 'P0001', message: 'po_already_closed' })],
    ['the ledger refusal', {}, rpcError({ code: '42501', message: 'forbidden' })],
    [
      'the permission refusal',
      {},
      rpcError({ code: '42501', message: 'forbidden', hint: 'permission' }),
    ],
    ['a missing PO', {}, rpcError({ code: 'P0002', message: 'po_not_found' })],
    ['a missing line', {}, rpcError({ code: 'P0002', message: 'po_line_not_found' })],
    ['a negative quantity', {}, rpcError({ code: 'P0001', message: 'negative_quantity' })],
    ['a lot-tracked item', {}, rpcError({ code: 'P0001', message: 'lot_required' })],
    ['lots that do not add up', {}, rpcError({ code: 'P0001', message: 'lot_qty_mismatch' })],
    ['too many serials', {}, rpcError({ code: 'P0001', message: 'serial_count_exceeds_quantity' })],
    ['serials required', {}, rpcError({ code: 'P0001', message: 'serials_required' })],
    [
      'a serial already registered',
      {},
      rpcError({
        code: '23505',
        message: 'duplicate key value violates unique constraint',
        details: 'Key exists in serial_registry.',
      }),
    ],
    [
      'a kit line',
      {},
      rpcError({ code: 'P0001', message: 'A kit cannot be received.', hint: 'po_line_bundle' }),
    ],
    ['an unexpected database error', {}, rpcError({ code: 'XX000', message: 'boom' })],
  ];

  it.each(cases)('%s', async (_name, caller, rpc) => {
    const { status, body } = await postAs(caller, rpc);
    expect(status).toBeGreaterThanOrEqual(400);
    const reason = body.details?.reason;
    if (reason !== undefined) expect(REASONS_INSTALLED_PHONES_MAP).toContain(reason);
  });

  it('and the first-post-landed conflict still carries its reason', async () => {
    const { status, body } = await postAs(
      {},
      rpcError({ code: '55000', message: 'idempotency_conflict' }),
    );
    expect(status).toBe(409);
    expect(body.details).toEqual({ reason: 'idempotency_conflict' });
  });
});
