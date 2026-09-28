import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const reportError = vi.hoisted(() => vi.fn(async (_err: unknown, _ctx: unknown) => {}));
vi.mock('@/lib/error-reporter', () => ({ reportError }));

import {
  DEFAULT_MODULE_IDS,
  READINESS_FORBIDDEN_COPY,
  READINESS_MODULE_OFF_COPY,
  READINESS_ORDER_NOT_FOUND_COPY,
  type ModuleId,
} from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub, type QueryResult } from '@/test/supabase-mock';

import { ServiceError } from './context';
import { mapReadinessRpcError, OrderReadinessService } from './order-readiness';

/**
 * OrderReadinessService (F2-1): the order id only, the RPC, the parser, core's
 * assessment. Every refusal maps to a service error, and a failure is never an
 * empty or green answer. The RPC answers below are shapes
 * order_readiness_facts (0377) really returns.
 */

const ORDER = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const WH = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-28T17:42:00Z');

function facts(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    observedAt: '2026-09-28T17:41:59.000+00:00',
    phase: 'to_pick',
    linesCapped: false,
    order: { id: ORDER, orderNumber: 17, status: 'pending_approval', warehouseId: WH, neededBy: null, fulfillmentType: 'pickup' },
    lines: [{ lineId: 'line-1', itemId: ITEM, requested: 4, fulfilled: 0, picked: null, createdAt: '2026-09-27T10:00:00+00:00' }],
    items: [
      {
        itemId: ITEM,
        visible: true,
        name: 'Maus I',
        sku: 'MAUS-1',
        supplierId: null,
        itemWarehouseId: WH,
        deleted: false,
        archived: false,
        isBundle: false,
        onHand: 10,
        heldOwn: 0,
        heldOtherOrders: 0,
        heldRentals: 0,
        here: { rack: 6, site: 0, unplaced: 0, staging: 4 },
        elsewhere: { pickable: 0, staging: 0 },
        stagingSources: [{ locationId: 'loc-stg', quantity: 4 }],
        stagingHiddenQty: 0,
        pendingOthers: { orders: 0, units: 0 },
        committedOtherShortfall: 0,
        inbound: { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
        drafts: { rows: [], hiddenRemaining: 0, truncated: false, truncatedRemaining: 0 },
      },
    ],
    ...over,
  };
}

function build(answer: QueryResult, modules: Iterable<ModuleId> = DEFAULT_MODULE_IDS) {
  const stub = makeSupabaseStub({ 'rpc:order_readiness_facts': answer });
  const ctx = makeServiceContext(stub.client, { enabledModules: new Set<ModuleId>(modules), organizationId: 'org-1' });
  const svc = new OrderReadinessService(ctx as never, () => NOW);
  return { stub, svc };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ServiceError);
  return (err as ServiceError).code;
}

beforeEach(() => reportError.mockClear());

describe('OrderReadinessService.get', () => {
  it('sends the order id and nothing else (never a client-supplied org)', async () => {
    const { stub, svc } = build({ data: facts(), error: null });
    await svc.get(ORDER);
    expect(stub.rpcCalls).toEqual([{ name: 'order_readiness_facts', args: { p_order_id: ORDER } }]);
    expect(stub.fromCalls).toEqual([]);
  });

  it('parses and assesses the facts with core', async () => {
    const { svc } = build({ data: facts(), error: null });
    const a = await svc.get(ORDER);
    expect(a.phase).toBe('to_pick');
    if (a.phase !== 'to_pick') return;
    expect(a.lines[0]).toMatchObject({ state: 'ready', units: { ready: 4 } });
    expect(a.observedAt).toBe('2026-09-28T17:41:59.000+00:00');
  });

  it('judges the needed-by against the service clock', async () => {
    const past = facts({
      order: { id: ORDER, orderNumber: 17, status: 'pending_approval', warehouseId: WH, neededBy: '2026-09-20T17:00:00+00:00', fulfillmentType: 'pickup' },
    });
    const { svc } = build({ data: past, error: null });
    const a = await svc.get(ORDER);
    expect(a.phase === 'to_pick' && a.rollup.neededBySignal).toBe('past_due');
  });

  it('the Orders module off: module_disabled, and the database is not asked', async () => {
    const { stub, svc } = build({ data: facts(), error: null }, [...DEFAULT_MODULE_IDS].filter((m) => m !== 'orders'));
    expect(await codeOf(svc.get(ORDER))).toBe('module_disabled');
    expect(stub.rpcCalls).toEqual([]);
  });

  it('an id that is not a uuid is not an order (never a 22P02 from the database)', async () => {
    const { stub, svc } = build({ data: facts(), error: null });
    expect(await codeOf(svc.get('not-a-uuid'))).toBe('not_found');
    expect(await codeOf(svc.get("'; drop table x; --"))).toBe('not_found');
    expect(stub.rpcCalls).toEqual([]);
  });

  it.each([
    ['P0002 order_request_not_found', { message: 'order_request_not_found', code: 'P0002' }, 'not_found'],
    ['42501 unauthenticated', { message: 'unauthenticated', code: '42501' }, 'forbidden'],
    ['P0001 module_disabled (hint)', { message: 'module_disabled', code: 'P0001', hint: 'module_disabled' }, 'module_disabled'],
    ['a statement timeout', { message: 'canceling statement due to statement timeout', code: '57014' }, 'internal_error'],
    ['a gateway error with no body', { message: '', code: '' }, 'internal_error'],
  ])('maps %s', async (_name, error, code) => {
    const { svc } = build({ data: null, error });
    expect(await codeOf(svc.get(ORDER))).toBe(code);
  });

  it('keeps the raw database text server-side only', () => {
    const e = mapReadinessRpcError({ message: 'relation "x" does not exist', code: '42P01' }, { status: 500 });
    expect(e.code).toBe('internal_error');
    expect(e.message).toBe('An internal error occurred. Please try again.');
    expect(e.internalDetail).toContain('relation "x" does not exist');
    const empty = mapReadinessRpcError({ message: '' }, { status: 502, statusText: 'Bad Gateway' });
    expect(empty.internalDetail).toContain('HTTP 502 Bad Gateway');
  });

  it.each([
    ['null data', null],
    ['an array', [facts()]],
    ['another version', facts({ v: 2 })],
    ['a quantity as a string', facts({ lines: [{ lineId: 'l', itemId: ITEM, requested: '4', fulfilled: 0, picked: null, createdAt: '2026-09-27T10:00:00Z' }] })],
    ['a line with no item facts', facts({ items: [] })],
  ])('a malformed answer (%s) is an internal error, never an empty answer', async (_name, data) => {
    const { svc } = build({ data, error: null });
    expect(await codeOf(svc.get(ORDER))).toBe('internal_error');
  });

  it('an order id in upper case is the same order (the database answers in lower case)', async () => {
    const lower = '0a0f2100-0000-4000-8000-00000000abcd';
    const { stub, svc } = build({
      data: facts({
        order: { id: lower, orderNumber: 17, status: 'pending_approval', warehouseId: WH, neededBy: null, fulfillmentType: 'pickup' },
      }),
      error: null,
    });
    const a = await svc.get(lower.toUpperCase());
    expect(a.phase).toBe('to_pick');
    // Asked once, in the form the database answers in.
    expect(stub.rpcCalls).toEqual([{ name: 'order_readiness_facts', args: { p_order_id: lower } }]);
    expect((await svc.result(lower.toUpperCase())).state).toBe('ok');
    expect(reportError).not.toHaveBeenCalled();
  });

  it('an EXECUTE grant that went missing is a fault (reported), never "not allowed"', async () => {
    // The function's own 42501 says 'unauthenticated'; Postgres raises 42501
    // for a missing grant too (the 0318 hazard). Only the first is forbidden.
    const denied = { message: 'permission denied for function order_readiness_facts', code: '42501' };
    const { svc } = build({ data: null, error: denied });
    expect(await codeOf(svc.get(ORDER))).toBe('internal_error');
    expect(mapReadinessRpcError({ message: 'unauthenticated', code: '42501' }).code).toBe('forbidden');
    const r = await svc.result(ORDER);
    expect(r).toEqual({ state: 'failed', message: 'An internal error occurred. Please try again.' });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('an answer about another order is refused', async () => {
    const other = facts({
      order: { id: '44444444-4444-4444-8444-444444444444', orderNumber: 18, status: 'pending_approval', warehouseId: WH, neededBy: null, fulfillmentType: 'pickup' },
    });
    const { svc } = build({ data: other, error: null });
    expect(await codeOf(svc.get(ORDER))).toBe('internal_error');
  });
});

describe('OrderReadinessService.result', () => {
  it('wraps a good answer', async () => {
    const { svc } = build({ data: facts(), error: null });
    const r = await svc.result(ORDER);
    expect(r.state).toBe('ok');
  });

  it('turns ANY failure into failed (never ready, never empty), and reports internal ones', async () => {
    const { svc } = build({ data: null, error: { message: 'boom', code: 'XX000' } });
    const r = await svc.result(ORDER);
    expect(r).toEqual({ state: 'failed', message: 'An internal error occurred. Please try again.' });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({ tag: 'orders.readiness_failed', organizationId: 'org-1' });
  });

  it('a malformed answer is failed too', async () => {
    const { svc } = build({ data: { v: 1 }, error: null });
    expect((await svc.result(ORDER)).state).toBe('failed');
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('a refusal is failed with its own words, and is not reported as a fault', async () => {
    const { svc } = build({ data: null, error: { message: 'order_request_not_found', code: 'P0002' } });
    expect(await svc.result(ORDER)).toEqual({ state: 'failed', message: 'Order not found.' });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("every refusal's words are core's, so the web strip and the phone name it the same way", async () => {
    const notFound = build({ data: null, error: { message: 'order_request_not_found', code: 'P0002' } });
    expect(await notFound.svc.result(ORDER)).toEqual({ state: 'failed', message: READINESS_ORDER_NOT_FOUND_COPY });
    const signedOut = build({ data: null, error: { message: 'unauthenticated', code: '42501' } });
    expect(await signedOut.svc.result(ORDER)).toEqual({ state: 'failed', message: READINESS_FORBIDDEN_COPY });
    const off = build({ data: null, error: { message: 'module_disabled', code: 'P0001', hint: 'module_disabled' } });
    expect(await off.svc.result(ORDER)).toEqual({ state: 'failed', message: READINESS_MODULE_OFF_COPY });
    const offHere = build({ data: facts(), error: null }, [...DEFAULT_MODULE_IDS].filter((m) => m !== 'orders'));
    expect(await offHere.svc.result(ORDER)).toEqual({ state: 'failed', message: READINESS_MODULE_OFF_COPY });
    expect(reportError).not.toHaveBeenCalled();
  });
});
