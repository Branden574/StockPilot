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

const COMPLETED_ORDER = {
  id: ORDER_ID,
  organization_id: 'org-test',
  status: 'completed',
};

const ORDER_LINE = {
  id: OLINE_ID,
  order_request_id: ORDER_ID,
  item_id: ITEM_ID,
  quantity_fulfilled: 10,
};

/**
 * Builds a stub for a returnable order with one fulfilled line and (by default)
 * no prior returns. Tests override individual keys (the order status, the prior
 * return_lines, etc.).
 */
function makeCreateStub(overrides: Record<string, unknown> = {}) {
  return makeSupabaseStub({
    'order_requests.select': { data: [COMPLETED_ORDER], error: null },
    'order_request_lines.select': { data: [ORDER_LINE], error: null },
    // Prior returns for this source line — none by default.
    'return_lines.select': { data: [], error: null },
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

  it('rejects an over-return that exceeds fulfilled when summed across prior live returns', async () => {
    // Line fulfilled 10; a prior live return already claimed 8. A new return of
    // 3 would total 11 > 10 → reject.
    const stub = makeCreateStub({
      'return_lines.select': {
        data: [
          { order_request_line_id: OLINE_ID, quantity: 8, returns: { status: 'approved' } },
        ],
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

  it('ignores cancelled/denied prior returns when computing remaining quantity', async () => {
    // Prior returns for this line totalling 8, but BOTH are cancelled/denied →
    // they do not count, so a new return of 3 (<= 10) is allowed.
    const stub = makeCreateStub({
      'return_lines.select': {
        data: [
          { order_request_line_id: OLINE_ID, quantity: 5, returns: { status: 'cancelled' } },
          { order_request_line_id: OLINE_ID, quantity: 3, returns: { status: 'denied' } },
        ],
        error: null,
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    const result = await svc.createFromOrder(ORDER_ID, VALID_INPUT);
    expect(result.status).toBe('requested');
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
    expect(payload.notes).toBe('duplicate request');
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
