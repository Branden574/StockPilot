import { describe, expect, it, vi } from 'vitest';

import { RETURN_ERROR_WORDS, type ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

vi.mock('@/lib/auth/warehouse', () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock('./audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('./integration-events', () => ({ dispatchEvent: vi.fn(async () => {}) }));

import { OrderRequestsService } from './order-requests';

/**
 * Returns RX-2 review S4 (deferred to and built in RX-3): a lock the database
 * stopped waiting for (55P03), a statement that ran out of time (57014) and
 * a deadlock the database resolved by rolling this call back (40P01) all
 * mean "someone else was changing this order or its items; nothing was
 * written; send it again". Every order function the service calls answers
 * that as a retryable 409 "Busy. Try again." (plan 3.11), never as an
 * internal error. 40P01 reaches the order side when an RMA create with an
 * exchange (key-share on the items) meets an order function that locks the
 * same items for update in id order (approve_partial, hold_order_stock,
 * resume_fulfillment, complete_picking): RX-2 review S3 and S4.
 */

const ORDER = '11111111-1111-4111-8111-111111111111';
const LINE = '22222222-2222-4222-8222-222222222222';
const PICKER = '33333333-3333-4333-8333-333333333333';

function svc(stub: ReturnType<typeof makeSupabaseStub>) {
  return new (OrderRequestsService as unknown as new (ctx: unknown) => OrderRequestsService)(
    makeServiceContext(stub.client, { role: 'admin', enabledModules: new Set<ModuleId>(['orders', 'returns']) }),
  );
}

const BUSY: ReadonlyArray<[string, NonNullable<QueryResult['error']>]> = [
  ['a lock wait (55P03)', { code: '55P03', message: 'canceling statement due to lock timeout' }],
  ['a statement timeout (57014)', { code: '57014', message: 'canceling statement due to statement timeout' }],
  ['a deadlock the server resolved (40P01)', { code: '40P01', message: 'deadlock detected' }],
];

/** Each order function the service calls through an inline mapper. */
const CALLS: ReadonlyArray<[string, (s: OrderRequestsService) => Promise<unknown>]> = [
  ['approve_order_request', (s) => s.approve(ORDER)],
  ['approve_partial', (s) => s.approvePartial(ORDER)],
  ['partial_pick_line', (s) => s.recordPickedLine(ORDER, LINE, 1)],
  ['complete_picking', (s) => s.completePicking(ORDER)],
  ['resume_fulfillment', (s) => s.resumeFulfillment(ORDER)],
  ['reopen_picking', (s) => s.reopenPicking(ORDER, 'Recount the shelf')],
  ['close_partial', (s) => s.closePartial(ORDER)],
  ['confirm_physical_signature', (s) => s.confirmPhysicalSignature(ORDER, 'Pat Lee')],
  ['claim_picking', (s) => s.claimPicking(ORDER)],
  ['assign_picking', (s) => s.assignPicking(ORDER, PICKER)],
  ['release_picking', (s) => s.releasePicking(ORDER)],
  ['cancel_order_request', (s) => s.cancel(ORDER, 'No longer needed')],
];

function stubFor(rpc: string, error: NonNullable<QueryResult['error']>) {
  return makeSupabaseStub({
    'order_requests.select.maybeSingle': { data: { id: ORDER, warehouse_id: 'wh-1', status: 'approved' }, error: null },
    'order_request_lines.select.maybeSingle': { data: { id: LINE }, error: null },
    'order_request_lines.select': { data: [], error: null },
    [`rpc:${rpc}`]: { data: null, error },
  });
}

describe.each(CALLS)('%s', (rpc, call) => {
  it.each(BUSY)('%s: 409 "Busy. Try again.", retryable, never an internal error', async (_label, error) => {
    const stub = stubFor(rpc, error);
    const e = await call(svc(stub)).catch((x: unknown) => x);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual([rpc]);
    expect(e).toMatchObject({
      code: 'conflict',
      message: RETURN_ERROR_WORDS.busy,
      details: { reason: 'busy', retryable: true },
    });
  });

  it('anything else unknown stays an internal error with no database text', async () => {
    const stub = stubFor(rpc, { code: 'XX000', message: 'relation "order_requests" secret' });
    const e = await call(svc(stub)).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'internal_error' });
    expect((e as Error).message).not.toMatch(/order_requests|secret/);
  });
});

describe('generatePickSlip (the gated status write)', () => {
  it.each(BUSY)('%s on the write: busy, retryable', async (_label, error) => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { id: ORDER, warehouse_id: 'wh-1', status: 'approved' }, error: null },
      'order_requests.update': { data: null, error },
    });
    const e = await svc(stub).generatePickSlip(ORDER).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'conflict', message: RETURN_ERROR_WORDS.busy, details: { reason: 'busy', retryable: true } });
  });

  it('the return-first gate keeps its own words (a hint before the code)', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select.maybeSingle': { data: { id: ORDER, warehouse_id: 'wh-1', status: 'approved' }, error: null },
      'order_requests.update': {
        data: null,
        error: { code: 'P0001', hint: 'replacement_waiting_for_return', message: 'replacement_waiting_for_return' },
      },
    });
    const e = await svc(stub).generatePickSlip(ORDER).catch((x: unknown) => x);
    expect(e).toMatchObject({ details: { reason: 'replacement_waiting_for_return' } });
  });
});
