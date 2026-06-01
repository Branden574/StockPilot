import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { ModuleId } from '@stockpilot/core';

// audit is side-effecting; stub it so the service runs in isolation.
vi.mock('@/server/services/audit', () => ({
  audit: vi.fn(async () => undefined),
}));

import { RMAService } from './returns';
import { ServiceError } from './context';

const RETURNS_MODULES = new Set<ModuleId>(['returns']);

// Real UUIDs — the createFromOrder schema validates orderRequestLineId as a
// uuid, so the fixtures must be uuid-shaped.
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const OLINE_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
// A DIFFERENT item — used to prove a return line can never restock an item
// other than the one fulfilled on its source line.
const OTHER_ITEM_ID = '44444444-4444-4444-8444-444444444444';

const COMPLETED_ORDER = {
  id: ORDER_ID,
  organization_id: 'org-test',
  status: 'completed',
};

// The source line: fulfilled 10, none yet returned (returned_quantity 0). The
// DURABLE budget the service reads is quantity_fulfilled - returned_quantity.
const ORDER_LINE = {
  id: OLINE_ID,
  order_request_id: ORDER_ID,
  item_id: ITEM_ID,
  quantity_fulfilled: 10,
  returned_quantity: 0,
};

/**
 * Builds a stub for a returnable order with one fulfilled line. The remaining
 * returnable budget is derived from the source line's returned_quantity
 * (durable, 0153) — NOT from a SUM over prior return rows. Tests override the
 * source line (its returned_quantity / item_id) to exercise the budget.
 */
function makeCreateStub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'order_requests.select': { data: [COMPLETED_ORDER], error: null },
    'order_request_lines.select': { data: [ORDER_LINE], error: null },
    'returns.insert': {
      data: [
        {
          id: 'ret-1',
          organization_id: 'org-test',
          order_request_id: ORDER_ID,
          return_number: 'RMA-20260531-ABCDEF',
          status: 'requested',
          source: 'internal',
        },
      ],
      error: null,
    },
    'return_lines.insert': {
      data: [
        {
          id: 'rline-1',
          return_id: 'ret-1',
          organization_id: 'org-test',
          order_request_line_id: OLINE_ID,
          item_id: ITEM_ID,
          quantity: 3,
          disposition: 'restock',
          applied: false,
        },
      ],
      error: null,
    },
    ...overrides,
  });
}

const VALID_INPUT = {
  reasonCode: 'damaged' as const,
  lines: [{ orderRequestLineId: OLINE_ID, quantity: 3, disposition: 'restock' as const }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RMAService.createFromOrder', () => {
  it('creates a requested return + lines for a returnable order', async () => {
    const stub = makeCreateStub();
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    const result = await svc.createFromOrder(ORDER_ID, VALID_INPUT);

    expect(result.id).toBe('ret-1');
    expect(result.status).toBe('requested');
    expect(result.lines).toHaveLength(1);
    expect(stub.fromCalls).toContain('returns');
    expect(stub.fromCalls).toContain('return_lines');
  });

  it('rejects a non-returnable (not completed/delivered) order', async () => {
    const stub = makeCreateStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, status: 'approved' }],
        error: null,
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await expect(svc.createFromOrder(ORDER_ID, VALID_INPUT)).rejects.toMatchObject({
      code: 'validation_error',
    });
    // Nothing was inserted.
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('accepts a legacy "delivered" order', async () => {
    const stub = makeCreateStub({
      'order_requests.select': {
        data: [{ ...COMPLETED_ORDER, status: 'delivered' }],
        error: null,
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    const result = await svc.createFromOrder(ORDER_ID, VALID_INPUT);
    expect(result.status).toBe('requested');
  });

  it('rejects a quantity greater than the fulfilled quantity', async () => {
    const stub = makeCreateStub();
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await expect(
      svc.createFromOrder(ORDER_ID, {
        lines: [{ orderRequestLineId: OLINE_ID, quantity: 11, disposition: 'restock' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('rejects an over-return using the DURABLE budget (quantity_fulfilled - returned_quantity)', async () => {
    // Line fulfilled 10; 8 units already RETURNED (durable returned_quantity=8,
    // incremented at apply-time in process_return_disposition). A new return of
    // 3 would consume 11 of 10 fulfilled → reject. The budget is read straight
    // off the source line, NOT summed from prior return rows.
    const stub = makeCreateStub({
      'order_request_lines.select': {
        data: [{ ...ORDER_LINE, returned_quantity: 8 }],
        error: null,
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await expect(svc.createFromOrder(ORDER_ID, VALID_INPUT)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('over-return across MULTIPLE returns: 60 then 60 against fulfilled 100 → second rejected (budget 40)', async () => {
    // First return of 60 against a fresh line (returned_quantity 0, fulfilled
    // 100) is allowed.
    const firstStub = makeCreateStub({
      'order_requests.select': { data: [COMPLETED_ORDER], error: null },
      'order_request_lines.select': {
        data: [{ ...ORDER_LINE, quantity_fulfilled: 100, returned_quantity: 0 }],
        error: null,
      },
    });
    const firstSvc = new RMAService(
      makeServiceContext(firstStub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(
      firstSvc.createFromOrder(ORDER_ID, {
        lines: [{ orderRequestLineId: OLINE_ID, quantity: 60, disposition: 'restock' }],
      }),
    ).resolves.toMatchObject({ status: 'requested' });

    // After that return is received+closed, the disposition RPC increments the
    // source line's returned_quantity to 60. A SECOND return of 60 now exceeds
    // the remaining durable budget (100 - 60 = 40) → reject. Crucially the cap
    // is the durable returned_quantity, so flipping/cancelling the first return
    // header could not free it.
    const secondStub = makeCreateStub({
      'order_requests.select': { data: [COMPLETED_ORDER], error: null },
      'order_request_lines.select': {
        data: [{ ...ORDER_LINE, quantity_fulfilled: 100, returned_quantity: 60 }],
        error: null,
      },
    });
    const secondSvc = new RMAService(
      makeServiceContext(secondStub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(
      secondSvc.createFromOrder(ORDER_ID, {
        lines: [{ orderRequestLineId: OLINE_ID, quantity: 60, disposition: 'restock' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(secondStub.fromCalls).not.toContain('returns');
  });

  it('the cap reads the DURABLE returned_quantity — NOT a SUM over the return_lines table', async () => {
    // Defends the status-flip/delete exploit: a cancelled/denied/deleted return
    // header must not free budget. We prove the service computes remaining from
    // order_request_lines.returned_quantity by checking it NEVER queries
    // return_lines to build the cap (no SUM over mutable return rows). Here the
    // line is fully consumed durably (returned 10 of 10) so even a return of 1
    // is rejected, regardless of how many return rows exist.
    const stub = makeCreateStub({
      'order_request_lines.select': {
        data: [{ ...ORDER_LINE, returned_quantity: 10 }],
        error: null,
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await expect(
      svc.createFromOrder(ORDER_ID, {
        lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, disposition: 'restock' }],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    // The over-return validation must NOT depend on a return_lines SELECT — the
    // cap is the durable budget on the source line. (return_lines is only
    // touched on a successful INSERT, which never happens for a rejected create.)
    expect(stub.fromCalls).not.toContain('return_lines');
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('cross-item: a return line whose item != the source line item is rejected', async () => {
    // The source line fulfilled ITEM_ID. A return line that explicitly claims a
    // DIFFERENT item (OTHER_ITEM_ID) must be rejected — no path may restock an
    // item other than the one fulfilled on that source line.
    const stub = makeCreateStub();
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await expect(
      svc.createFromOrder(ORDER_ID, {
        lines: [
          {
            orderRequestLineId: OLINE_ID,
            quantity: 3,
            disposition: 'restock',
            itemId: OTHER_ITEM_ID,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.fromCalls).not.toContain('returns');
  });

  it('stamps the return line item from the SOURCE line (never from the client)', async () => {
    // When the caller omits itemId (the normal path), the inserted return line
    // takes its item_id from the order line — so it is structurally impossible
    // to restock a different item than the one fulfilled.
    const stub = makeCreateStub();
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await svc.createFromOrder(ORDER_ID, VALID_INPUT);

    const insertArgs = stub.chainArgs.get('return_lines.insert')?.[0]?.[0] as
      | Array<{ item_id: string; order_request_line_id: string }>
      | undefined;
    expect(insertArgs).toBeTruthy();
    expect(insertArgs?.[0]?.item_id).toBe(ITEM_ID);
    expect(insertArgs?.[0]?.order_request_line_id).toBe(OLINE_ID);
  });

  it('rejects a line that does not belong to the order', async () => {
    const stub = makeCreateStub({
      'order_request_lines.select': { data: [], error: null }, // line not found on this order
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await expect(svc.createFromOrder(ORDER_ID, VALID_INPUT)).rejects.toMatchObject({
      code: 'validation_error',
    });
  });
});

describe('RMAService lifecycle transitions', () => {
  function makeReturnStub(status: string, overrides: Record<string, unknown> = {}) {
    return makeSupabaseStub({
      'returns.select': {
        data: [{ id: 'ret-1', organization_id: 'org-test', order_request_id: ORDER_ID, status }],
        error: null,
      },
      // The CAS update echoes back the new row.
      'returns.update': {
        data: [{ id: 'ret-1', organization_id: 'org-test', order_request_id: ORDER_ID, status }],
        error: null,
      },
      ...overrides,
    });
  }

  it('approve: requested → approved', async () => {
    const stub = makeReturnStub('requested');
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.approve('ret-1')).resolves.toBeTruthy();
    // The update CAS'd on the prior status.
    const updateArgs = stub.chainArgs.get('returns.update');
    const payload = updateArgs?.[0]?.[0] as Record<string, unknown>;
    expect(payload.status).toBe('approved');
  });

  it('approve: rejects an illegal transition (closed → approved)', async () => {
    const stub = makeReturnStub('closed');
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.approve('ret-1')).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('receive: approved → received WITHOUT touching inventory (no RPC)', async () => {
    const stub = makeReturnStub('approved');
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.receive('ret-1')).resolves.toBeTruthy();
    // receive is a pure transition — the disposition RPC must NOT run here.
    expect(stub.rpcCalls.find((c) => c.name === 'process_return_disposition')).toBeUndefined();
    const payload = stub.chainArgs.get('returns.update')?.[0]?.[0] as Record<string, unknown>;
    expect(payload.status).toBe('received');
  });

  it('receive: rejects from requested (must be approved first)', async () => {
    const stub = makeReturnStub('requested');
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.receive('ret-1')).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('close: received → closed applies the disposition via the RPC exactly ONCE', async () => {
    const stub = makeReturnStub('received', {
      'rpc:process_return_disposition': {
        data: {
          id: 'ret-1',
          organization_id: 'org-test',
          order_request_id: ORDER_ID,
          status: 'closed',
        },
        error: null,
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    const result = await svc.close('ret-1');

    expect(result.status).toBe('closed');
    // The disposition RPC ran EXACTLY once with the return id.
    const dispositionCalls = stub.rpcCalls.filter(
      (c) => c.name === 'process_return_disposition',
    );
    expect(dispositionCalls).toHaveLength(1);
    expect(dispositionCalls[0]?.args).toMatchObject({ p_return_id: 'ret-1' });
  });

  it('close: publishes a return.closed outbox event with the credit total (Phase B)', async () => {
    const stub = makeReturnStub('received', {
      'rpc:process_return_disposition': {
        data: {
          id: 'ret-1',
          organization_id: 'org-test',
          order_request_id: ORDER_ID,
          return_number: 'RMA-1',
          status: 'closed',
        },
        error: null,
      },
      // publishReturnClosed reads the lines (joined to the source order line's
      // unit_cost_at_request) to compute the informational total.
      'return_lines.select': {
        data: [
          { quantity: 2, order_request_line: { unit_cost_at_request: 5 } },
          { quantity: 1, order_request_line: { unit_cost_at_request: 3 } },
        ],
        error: null,
      },
      'rpc:publish_outbox': { data: null, error: null },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await svc.close('ret-1');

    const publish = stub.rpcCalls.find((c) => c.name === 'publish_outbox');
    expect(publish).toBeTruthy();
    expect(publish?.args).toMatchObject({
      p_topic: 'return.closed',
      p_aggregate_type: 'return',
      p_aggregate_id: 'ret-1',
      p_dedupe_key: 'return.closed:ret-1',
      p_payload: { orderRequestId: ORDER_ID, lineCount: 2, total: 13 },
    });
  });

  it('close: a second close on an already-closed return is rejected (disposition applied once)', async () => {
    const stub = makeReturnStub('closed');
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.close('ret-1')).rejects.toMatchObject({ code: 'validation_error' });
    // No disposition RPC fires for an illegal transition.
    expect(stub.rpcCalls.find((c) => c.name === 'process_return_disposition')).toBeUndefined();
  });

  it('close: maps the RPC invalid_status_transition error to a validation_error', async () => {
    const stub = makeReturnStub('received', {
      'rpc:process_return_disposition': {
        data: null,
        error: { message: 'invalid_status_transition', code: 'P0001' },
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.close('ret-1')).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('cancel: requested → cancelled', async () => {
    const stub = makeReturnStub('requested');
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.cancel('ret-1')).resolves.toBeTruthy();
    const payload = stub.chainArgs.get('returns.update')?.[0]?.[0] as Record<string, unknown>;
    expect(payload.status).toBe('cancelled');
  });

  it('cancel: rejects from received (on the close-and-dispose path)', async () => {
    const stub = makeReturnStub('received');
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.cancel('ret-1')).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('deny: requested → denied with reason', async () => {
    const stub = makeReturnStub('requested');
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.deny('ret-1', 'duplicate request')).resolves.toBeTruthy();
    const payload = stub.chainArgs.get('returns.update')?.[0]?.[0] as Record<string, unknown>;
    expect(payload.status).toBe('denied');
    // The reason goes to the dedicated denial_reason column (0154), NOT notes —
    // so it can't clobber creation-time notes from createFromOrder.
    expect(payload.denial_reason).toBe('duplicate request');
    expect(payload.notes).toBeUndefined();
  });
});

describe('RMAService module + permission gating', () => {
  it('createFromOrder throws module_disabled when returns is off', async () => {
    const stub = makeCreateStub();
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: new Set<ModuleId>() }),
    );
    await expect(svc.createFromOrder(ORDER_ID, VALID_INPUT)).rejects.toBeInstanceOf(ServiceError);
    await expect(svc.createFromOrder(ORDER_ID, VALID_INPUT)).rejects.toMatchObject({
      code: 'module_disabled',
    });
  });

  it('createFromOrder throws forbidden for a staff member (no returns:manage)', async () => {
    const stub = makeCreateStub();
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'staff', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.createFromOrder(ORDER_ID, VALID_INPUT)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('close throws forbidden for a viewer (no returns:manage)', async () => {
    const stub = makeSupabaseStub({});
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'viewer', enabledModules: RETURNS_MODULES }),
    );
    await expect(svc.close('ret-1')).rejects.toMatchObject({ code: 'forbidden' });
    expect(stub.rpcCalls.find((c) => c.name === 'process_return_disposition')).toBeUndefined();
  });

  it('list throws module_disabled when returns is off', async () => {
    const stub = makeSupabaseStub({ 'returns.select': { data: [], error: null } });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: new Set<ModuleId>() }),
    );
    await expect(svc.list()).rejects.toMatchObject({ code: 'module_disabled' });
  });
});

describe('RMAService.returnableLinesForOrder (durable budget)', () => {
  it('reports remaining = quantity_fulfilled - returned_quantity (durable, not a SUM)', async () => {
    // Fulfilled 10, durably returned 4 → remaining 6. Read straight off the
    // source line; no return_lines SUM is involved.
    const stub = makeSupabaseStub({
      'order_requests.select': { data: [COMPLETED_ORDER], error: null },
      'order_request_lines.select': {
        data: [
          {
            id: OLINE_ID,
            item_id: ITEM_ID,
            quantity_fulfilled: 10,
            returned_quantity: 4,
            item: { id: ITEM_ID, name: 'Widget', sku: 'W-1' },
          },
        ],
        error: null,
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    const lines = await svc.returnableLinesForOrder(ORDER_ID);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      orderRequestLineId: OLINE_ID,
      itemId: ITEM_ID,
      quantityFulfilled: 10,
      quantityRemaining: 6,
    });
    // The remaining budget must NOT be derived from a return_lines SUM.
    expect(stub.fromCalls).not.toContain('return_lines');
  });

  it('omits a line whose durable budget is fully consumed (returned_quantity == fulfilled)', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': { data: [COMPLETED_ORDER], error: null },
      'order_request_lines.select': {
        data: [
          {
            id: OLINE_ID,
            item_id: ITEM_ID,
            quantity_fulfilled: 10,
            returned_quantity: 10,
            item: { id: ITEM_ID, name: 'Widget', sku: 'W-1' },
          },
        ],
        error: null,
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await expect(svc.returnableLinesForOrder(ORDER_ID)).resolves.toEqual([]);
  });
});

// ── DB inventory-correctness invariants ────────────────────────────────────
// The scrap NET-ZERO write and the apply-once / returned_quantity increment
// live in the process_return_disposition RPC (migrations 0153/0154), which the
// service invokes via rpc('process_return_disposition'). There is no JS-level
// adjust_stock in returns.ts to mock, so these regression guards assert against
// the COMMITTED migration SQL — they fail loudly if a future edit reintroduces
// the double-decrement (bare -qty scrap) or drops the durable-budget increment.
describe('process_return_disposition DB invariants (migration SQL)', () => {
  // Derive the migrations dir from THIS file's location (apps/web/src/server/
  // services) so the test does not depend on the process cwd:
  //   …/apps/web/src/server/services → up 5 → repo root → supabase/migrations.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = join(thisDir, '..', '..', '..', '..', '..', 'supabase', 'migrations');
  const sql0153 = readFileSync(join(migrationsDir, '0153_returns.sql'), 'utf8');
  const sql0154 = readFileSync(
    join(migrationsDir, '0154_returns_status_machine_db_guard.sql'),
    'utf8',
  );
  // 0154 redefines process_return_disposition (adds the layer-2 budget backstop)
  // so it is the authoritative on-disk definition; test it. 0153 carries the
  // original; assert both encode the net-zero scrap.
  const dispositions = [
    { name: '0153', sql: sql0153 },
    { name: '0154', sql: sql0154 },
  ];

  for (const { name, sql } of dispositions) {
    it(`${name}: SCRAP is net-zero — receives (+qty 'return') THEN writes off (-qty 'loss'), never a bare single decrement`, () => {
      // Both legs of the net-zero scrap must be present: a +qty 'return' receive
      // and a -qty 'loss' write-off. -v_line.quantity into a 'loss' movement is
      // the write-off leg; v_line.quantity (positive) into a 'return' movement is
      // the receive leg. If scrap were a bare single -qty 'loss' (the
      // double-decrement bug), the receive leg would be absent.
      expect(sql).toContain("'return'"); // the receive leg movement_type
      expect(sql).toContain("'loss'"); // the write-off leg movement_type
      expect(sql).toContain('v_prev + v_line.quantity'); // receive: on-hand += qty
      expect(sql).toContain('v_prev - v_line.quantity'); // write-off: on-hand -= qty
      // The scrap branch performs the -qty leg ONLY inside `if ... = 'scrap'`.
      const scrapBranch = sql.slice(sql.indexOf("if v_line.disposition = 'scrap'"));
      expect(scrapBranch).toContain('v_prev - v_line.quantity');
      expect(scrapBranch).toContain("'loss'");
    });

    it(`${name}: applies each line ONCE (one-way 'applied' latch) and increments the DURABLE returned_quantity`, () => {
      // Idempotency: only unapplied lines are processed, and each flips applied.
      expect(sql).toContain('rl.applied = false');
      expect(sql).toContain('set applied = true');
      // Durable budget consumed at apply-time on the immutable source line.
      expect(sql).toContain('set returned_quantity = returned_quantity + v_line.quantity');
      // Inventory only moves for a RECEIVED return (status gate).
      expect(sql).toContain("v_return.status <> 'received'");
    });
  }

  it('0154: process_return_disposition re-asserts the durable cap before moving stock (returned + qty <= fulfilled)', () => {
    // Layer-2 backstop reads the durable returned_quantity (not a SUM) and locks
    // the source line FOR UPDATE before consuming budget.
    expect(sql0154).toContain('orl.quantity_fulfilled, orl.returned_quantity');
    expect(sql0154).toContain('v_returned + v_line.quantity > v_fulfilled');
    expect(sql0154).toContain('return_exceeds_fulfilled');
  });
});
