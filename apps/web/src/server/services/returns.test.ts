import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

import type { ModuleId } from '@stockpilot/core';

/**
 * RMAService over the 0395 database functions (returns RX-1). The service
 * never writes a return table: every transition is one RPC, its refusals are
 * mapped by hint (core return-error-map), and audit, the integration event,
 * the outbox and the requester notifications run only for the call that
 * answered `changed: true`.
 *
 * The 0153/0154 SQL body pins that lived here (G8) are gone: the restated
 * disposition body and its reverse-replace proof are pinned in pgTAP
 * (supabase/tests/0395_returns_lifecycle_original_rack.test.sql A20/A21,
 * and 0373 P3).
 */

const auditMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('@/server/services/audit', () => ({ audit: auditMock, insertAuditRowReported: vi.fn(async () => true) }));
vi.mock('./audit', () => ({ audit: auditMock, insertAuditRowReported: vi.fn(async () => true) }));

const dispatchMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('./integration-events', () => ({ dispatchEvent: dispatchMock }));

const notifyRequester = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
const notifyStaff = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('./returns-notify', () => ({
  notifyRequesterReturnEvent: notifyRequester,
  notifyStaffNewReturnRequest: notifyStaff,
}));

const workbenchMock = vi.hoisted(() => vi.fn(async (_ctx: unknown, id: string) => ({ return: { id }, marker: 'workbench' })));
vi.mock('./returns-workbench', () => ({
  buildReturnWorkbench: workbenchMock,
  buildReturnListPage: vi.fn(async () => ({ rows: [] })),
}));

const invalidateMock = vi.hoisted(() => vi.fn());
vi.mock('./lib/inventory-list-cache', () => ({ invalidateInventoryListAfterWrite: invalidateMock }));

import { ServiceError } from './context';
import { RMAService, returnRpcError } from './returns';

const RETURNS_MODULES = new Set<ModuleId>(['returns']);
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const OLINE_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ITEM_ID = '44444444-4444-4444-8444-444444444444';
const RET_ID = '55555555-5555-4555-8555-555555555555';
const RLINE_ID = '66666666-6666-4666-8666-666666666666';
const KEY = '77777777-7777-4777-8777-777777777777';

const COMPLETED_ORDER = { id: ORDER_ID, organization_id: 'org-test', status: 'completed' };

const HEADER = {
  id: RET_ID,
  organization_id: 'org-test',
  order_request_id: ORDER_ID,
  return_number: 'RMA-20261005-ABC123',
  status: 'requested',
  source: 'requester',
  order_request: { order_number: 103, warehouse_id: 'wh-1' },
};

function svcFor(results: Record<string, unknown>, ctx: Parameters<typeof makeServiceContext>[1] = {}) {
  const stub = makeSupabaseStub({
    'returns.select': { data: [HEADER], error: null },
    'return_lines.select': { data: [], error: null },
    ...results,
  } as never);
  const svc = new RMAService(makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES, ...ctx }));
  return { stub, svc };
}

const DECISION = { lines: [{ returnLineId: RLINE_ID, disposition: 'restock' as const, restock: { target: 'original' as const } }] };

function rpcError(hint: string, code = 'P0001', details: string | null = null) {
  return { data: null, error: { code, hint, message: hint, details } };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('database refusals are mapped by hint', () => {
  it.each([
    ['return_changed', 'conflict'],
    ['invalid_status_transition', 'conflict'],
    ['restock_location_not_offered', 'validation_error'],
    ['returns_manage', 'forbidden'],
    ['warehouse_write', 'forbidden'],
    ['return_not_found', 'not_found'],
    ['module_disabled', 'module_disabled'],
    ['idempotency_conflict', 'conflict'],
    ['exchange_not_available', 'validation_error'],
  ])('%s -> %s with details.reason', (hint, code) => {
    const e = returnRpcError({ code: 'P0001', hint, message: 'x' });
    expect(e).toBeInstanceOf(ServiceError);
    expect(e.code).toBe(code);
    expect(e.details?.reason).toBe(hint);
  });

  it('a lock wait is a retryable busy conflict; an unknown error is internal and keeps no raw text', () => {
    expect(returnRpcError({ code: '55P03', message: 'lock timeout' })).toMatchObject({
      code: 'conflict',
      details: { reason: 'busy', retryable: true },
    });
    const internal = returnRpcError({ code: '23505', message: 'duplicate key value violates unique constraint "x"' });
    expect(internal.code).toBe('internal_error');
    expect(internal.message).not.toMatch(/duplicate key/);
    expect(internal.details).toEqual({ reason: 'failed' });
  });

  it('carries a structured detail (rule and location) and a bare-token detail (the status)', () => {
    expect(
      returnRpcError({ code: 'P0001', hint: 'restock_location_unavailable', message: 'x', details: '{"rule":"archived","locationId":"l1"}' })
        .details,
    ).toEqual({ reason: 'restock_location_unavailable', detail: { rule: 'archived', locationId: 'l1' } });
    expect(returnRpcError({ code: 'P0001', hint: 'invalid_status_transition', message: 'x', details: 'approved' }).details).toEqual({
      reason: 'invalid_status_transition',
      detail: 'approved',
    });
  });
});

describe('createFromOrder (create_return_request)', () => {
  const INPUT = { reasonCode: 'damaged' as const, lines: [{ orderRequestLineId: OLINE_ID, quantity: 3, disposition: 'restock' as const }] };

  it('calls the function once with the key, the canonical body and the item-is-here switch; audits and dispatches once', async () => {
    const { stub, svc } = svcFor({
      'rpc:create_return_request': {
        data: { changed: true, replay: false, returnId: RET_ID, returnNumber: 'RMA-1', status: 'requested', channel: 'counter' },
        error: null,
      },
    });
    const created = await svc.createFromOrder(ORDER_ID, { ...INPUT, itemIsHere: true }, { idempotencyKey: KEY });
    const call = stub.rpcCalls.find((c) => c.name === 'create_return_request')!;
    expect(call.args).toEqual({
      p_order_id: ORDER_ID,
      p_request: {
        reasonCode: 'damaged',
        notes: null,
        itemIsHere: true,
        lines: [{ orderRequestLineId: OLINE_ID, quantity: 3, disposition: 'restock' }],
      },
      p_key: KEY,
    });
    expect(created).toMatchObject({ id: RET_ID, replay: false, channel: 'counter' });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0]).toMatchObject({ event: 'return.created', extra: { source: 'internal', channel: 'counter' } });
    expect(dispatchMock).toHaveBeenCalledWith('org-test', 'return.created', expect.objectContaining({ orderNumber: 'SO-000103' }));
    // A staff-created return pings nobody (G11).
    expect(notifyStaff).not.toHaveBeenCalled();
    // The service never writes a return table itself.
    expect(stub.fromCalls.filter((t) => t === 'returns' || t === 'return_lines')).toEqual(['returns', 'return_lines']);
    expect(stub.chainsAll.get('returns.insert')).toBeUndefined();
    expect(stub.chainsAll.get('return_lines.insert')).toBeUndefined();
  });

  it('mints a fresh key for a body without one (installed phones, plan A-4)', async () => {
    const { stub, svc } = svcFor({
      'rpc:create_return_request': { data: { changed: true, replay: false, returnId: RET_ID, returnNumber: 'RMA-1', status: 'requested', channel: 'staff' }, error: null },
    });
    await svc.createFromOrder(ORDER_ID, INPUT);
    expect((stub.rpcCalls[0]!.args as { p_key: string }).p_key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('a replay writes no audit, sends no event and publishes nothing', async () => {
    const { stub, svc } = svcFor({
      'rpc:create_return_request': { data: { changed: false, replay: true, returnId: RET_ID, returnNumber: 'RMA-1', status: 'requested', channel: 'staff' }, error: null },
    });
    const created = await svc.createFromOrder(ORDER_ID, INPUT, { idempotencyKey: KEY });
    expect(created.replay).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(stub.rpcCalls.map((c) => c.name)).not.toContain('publish_outbox');
  });

  it.each([
    ['return_exceeds_fulfilled', 'validation_error'],
    ['order_not_returnable', 'validation_error'],
    ['idempotency_conflict', 'conflict'],
    ['exchange_not_available', 'validation_error'],
    ['warehouse_write', 'forbidden'],
  ])('maps the refusal %s', async (hint, code) => {
    const { svc } = svcFor({ 'rpc:create_return_request': rpcError(hint) });
    await expect(svc.createFromOrder(ORDER_ID, INPUT)).rejects.toMatchObject({ code, details: { reason: hint } });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('refuses a fractional quantity before the database (whole units only, G10)', async () => {
    const { stub, svc } = svcFor({});
    await expect(
      svc.createFromOrder(ORDER_ID, { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1.5, disposition: 'restock' }] }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('refuses a client item that is not the source line item (never coerced)', async () => {
    const { stub, svc } = svcFor({ 'order_request_lines.select': { data: [{ id: OLINE_ID, item_id: ITEM_ID }], error: null } });
    await expect(
      svc.createFromOrder(ORDER_ID, { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, disposition: 'restock', itemId: OTHER_ITEM_ID }] }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('passes an exchange field through so the RX-1 hook refuses it in the database', async () => {
    const { stub, svc } = svcFor({ 'rpc:create_return_request': rpcError('exchange_not_available') });
    await expect(
      svc.createFromOrder(ORDER_ID, { lines: [{ orderRequestLineId: OLINE_ID, quantity: 1, exchange: { itemId: ITEM_ID } }] }),
    ).rejects.toMatchObject({ details: { reason: 'exchange_not_available' } });
    const body = (stub.rpcCalls[0]!.args as { p_request: { lines: Array<Record<string, unknown>> } }).p_request;
    expect(body.lines[0]).toHaveProperty('exchange');
  });
});

describe('approve (approve_return)', () => {
  it('sends the expected revision, the decision and receiveNow; audits approval and plan; notifies the requester', async () => {
    const { stub, svc } = svcFor({
      'rpc:approve_return': { data: { changed: true, replay: false, returnId: RET_ID, revision: 1, status: 'approved', replacement: null }, error: null },
    });
    const answer = await svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION });
    expect(stub.rpcCalls.find((c) => c.name === 'approve_return')!.args).toEqual({
      p_return_id: RET_ID,
      p_expected_revision: 0,
      p_decision: DECISION,
      p_receive_now: false,
    });
    expect(answer).toEqual({ changed: true, replay: false, status: 'approved', revision: 1 });
    expect(auditMock.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual(['return.approved', 'return.disposition_planned']);
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      extra: { revision: 1, channel: 'staff', plan: [{ returnLineId: RLINE_ID, disposition: 'restock', target: 'original', locationId: null }] },
    });
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'approved', channel: 'staff', source: 'requester' }));
    // Approval moves no stock: no ledger function is ever called.
    expect(stub.rpcCalls.map((c) => c.name)).not.toContain('process_return_disposition');
    expect(stub.rpcCalls.map((c) => c.name)).not.toContain('close_return');
  });

  it('"Approve and receive" (the counter) also audits the receipt on the counter channel', async () => {
    const { svc } = svcFor({
      'rpc:approve_return': { data: { changed: true, replay: false, returnId: RET_ID, revision: 1, status: 'received' }, error: null },
    });
    await svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION, receiveNow: true });
    expect(auditMock.mock.calls.map((c) => (c[0] as { event: string }).event)).toEqual([
      'return.approved',
      'return.disposition_planned',
      'return.received',
    ]);
    expect(dispatchMock).toHaveBeenCalledWith('org-test', 'return.received', expect.anything());
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'approved', channel: 'counter' }));
  });

  it('a replay (double click) emits nothing', async () => {
    const { svc } = svcFor({ 'rpc:approve_return': { data: { changed: false, replay: true, revision: 1, status: 'approved' }, error: null } });
    const answer = await svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION });
    expect(answer).toMatchObject({ changed: false, replay: true });
    expect(auditMock).not.toHaveBeenCalled();
    expect(notifyRequester).not.toHaveBeenCalled();
  });

  it('another decision at the same revision is a conflict (two managers)', async () => {
    const { svc } = svcFor({ 'rpc:approve_return': rpcError('return_changed') });
    await expect(svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'return_changed' },
    });
  });

  it('refuses scrap with a destination before the database (brief 10)', async () => {
    const { stub, svc } = svcFor({});
    await expect(
      svc.approve(RET_ID, { expectedRevision: 0, decision: { lines: [{ returnLineId: RLINE_ID, disposition: 'scrap', restock: { target: 'original' } }] } as never }),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.rpcCalls).toHaveLength(0);
  });
});

describe('deny, receive, cancel, plan', () => {
  it('deny needs a reason before the database, then audits with it and tells the requester without it', async () => {
    const { stub, svc } = svcFor({ 'rpc:deny_return': { data: { changed: true, status: 'denied', deniedBy: 'user-test', deniedAt: '2026-10-05T10:00:00Z' }, error: null } });
    await expect(svc.deny(RET_ID, '   ')).rejects.toMatchObject({ code: 'validation_error' });
    expect(stub.rpcCalls).toHaveLength(0);
    await svc.deny(RET_ID, ' Not ours ');
    expect(stub.rpcCalls[0]!.args).toEqual({ p_return_id: RET_ID, p_reason: 'Not ours' });
    expect(auditMock.mock.calls[0]![0]).toMatchObject({ event: 'return.denied', reason: 'Not ours' });
    const notified = notifyRequester.mock.calls[0]![0] as Record<string, unknown>;
    expect(notified).toMatchObject({ event: 'denied' });
    expect(JSON.stringify(notified)).not.toContain('Not ours');
  });

  it('receive answers "already" with who received it, and emits nothing (P24)', async () => {
    const { svc } = svcFor({
      'rpc:receive_return': { data: { changed: false, status: 'received', receivedBy: '88888888-8888-4888-8888-888888888888', receivedAt: '2026-10-05T10:00:00Z' }, error: null },
      'user_profiles.select': { data: [{ full_name: 'Dana Keeler', email: 'dana@example.com' }], error: null },
    });
    const answer = await svc.receive(RET_ID);
    expect(answer).toMatchObject({ changed: false, status: 'received', byName: 'Dana Keeler', at: '2026-10-05T10:00:00Z' });
    expect(auditMock).not.toHaveBeenCalled();
    expect(notifyRequester).not.toHaveBeenCalled();
  });

  it('receive that changes audits, dispatches return.received and tells the requester', async () => {
    const { svc } = svcFor({ 'rpc:receive_return': { data: { changed: true, status: 'received', receivedBy: 'user-test', receivedAt: 'now' }, error: null } });
    await svc.receive(RET_ID);
    expect(auditMock.mock.calls[0]![0]).toMatchObject({ event: 'return.received' });
    expect(dispatchMock).toHaveBeenCalledWith('org-test', 'return.received', expect.anything());
    expect(notifyRequester).toHaveBeenCalledWith(expect.objectContaining({ event: 'received', channel: 'staff' }));
  });

  it('cancel sends the revision and the optional reason', async () => {
    const { stub, svc } = svcFor({ 'rpc:cancel_return': { data: { changed: true, status: 'cancelled', revision: 1 }, error: null } });
    await svc.cancel(RET_ID, { expectedRevision: 0, reason: 'Sent by mistake' });
    expect(stub.rpcCalls[0]!.args).toEqual({ p_return_id: RET_ID, p_expected_revision: 0, p_reason: 'Sent by mistake' });
    expect(auditMock.mock.calls[0]![0]).toMatchObject({ event: 'return.cancelled', reason: 'Sent by mistake' });
    expect(dispatchMock).toHaveBeenCalledWith('org-test', 'return.cancelled', expect.anything());
  });

  it('an identical plan appends nothing and audits nothing', async () => {
    const { svc } = svcFor({ 'rpc:plan_return_dispositions': { data: { changed: false, appended: 0, planSeq: 7 }, error: null } });
    const answer = await svc.planDispositions(RET_ID, DECISION.lines);
    expect(answer).toEqual({ changed: false, appended: 0, planSeq: 7 });
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('close (close_return)', () => {
  it('a failed revalidation is refused with its rule, nothing moved, and the refusal is audited', async () => {
    const { svc } = svcFor({
      'rpc:close_return': rpcError('restock_location_unavailable', 'P0001', '{"rule":"archived","locationId":"loc-1"}'),
    });
    await expect(svc.close(RET_ID)).rejects.toMatchObject({
      code: 'validation_error',
      message: 'Original rack is no longer available.',
      details: { reason: 'restock_location_unavailable', detail: { rule: 'archived', locationId: 'loc-1' } },
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      event: 'return.restock_location_unavailable',
      extra: { detail: { rule: 'archived', locationId: 'loc-1' } },
    });
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('a close that moved stock audits per line, publishes the outbox event and invalidates the inventory list', async () => {
    const { stub, svc } = svcFor({
      'rpc:close_return': {
        data: {
          changed: true,
          status: 'closed',
          closedBy: 'user-test',
          closedAt: 'now',
          legs: [{ itemId: ITEM_ID, locationId: 'loc-31c', quantity: 1, destination: 'rack' }],
          lines: [
            {
              returnLineId: RLINE_ID,
              itemId: ITEM_ID,
              quantity: 1,
              disposition: 'restock',
              target: 'original',
              locationId: null,
              legs: [{ itemId: ITEM_ID, locationId: 'loc-31c', quantity: 1, destination: 'rack' }],
            },
          ],
        },
        error: null,
      },
      'return_lines.select': { data: [{ quantity: 1, order_request_line: { unit_cost_at_request: 12.5 } }], error: null },
    });
    const answer = await svc.close(RET_ID, { expectedPlanSeq: 4 });
    expect(stub.rpcCalls[0]!.args).toEqual({ p_return_id: RET_ID, p_lines: null, p_expected_plan_seq: 4 });
    expect(answer.lines[0]).toMatchObject({ target: 'original', legs: [{ locationId: 'loc-31c', destination: 'rack' }] });
    expect(auditMock.mock.calls[0]![0]).toMatchObject({
      event: 'return.closed',
      extra: { lines: [{ returnLineId: RLINE_ID, disposition: 'restock', destination: 'original', locationIds: ['loc-31c'] }] },
    });
    const outbox = stub.rpcCalls.find((c) => c.name === 'publish_outbox')!;
    expect(outbox.args).toMatchObject({ p_topic: 'return.closed', p_dedupe_key: `return.closed:${RET_ID}`, p_payload: { total: 12.5 } });
    expect(invalidateMock).toHaveBeenCalledWith('org-test', 'return.close');
  });

  it('"already closed" emits nothing and names who closed it', async () => {
    const { svc } = svcFor({
      'rpc:close_return': { data: { changed: false, status: 'closed', closedBy: '88888888-8888-4888-8888-888888888888', closedAt: 'then' }, error: null },
      'user_profiles.select': { data: [{ full_name: null, email: 'dana@example.com' }], error: null },
    });
    const answer = await svc.close(RET_ID);
    expect(answer).toMatchObject({ changed: false, byName: 'dana@example.com' });
    expect(auditMock).not.toHaveBeenCalled();
    expect(invalidateMock).not.toHaveBeenCalled();
  });

  it('a destination changed at processing travels in the same call (C-9)', async () => {
    const { stub, svc } = svcFor({ 'rpc:close_return': { data: { changed: true, status: 'closed', lines: [], legs: [] }, error: null } });
    await svc.close(RET_ID, { lines: [{ returnLineId: RLINE_ID, disposition: 'restock', restock: { target: 'staging' } }] });
    expect((stub.rpcCalls[0]!.args as { p_lines: unknown }).p_lines).toEqual([
      { returnLineId: RLINE_ID, disposition: 'restock', restock: { target: 'staging' } },
    ]);
  });
});

describe('runSteps (the steps endpoint)', () => {
  it('runs approve then process, reports done and already, and returns the workbench', async () => {
    const { stub, svc } = svcFor({
      'rpc:approve_return': { data: { changed: false, replay: true, revision: 1, status: 'received' }, error: null },
      'rpc:close_return': { data: { changed: true, status: 'closed', lines: [], legs: [] }, error: null },
    });
    const result = await svc.runSteps(RET_ID, {
      steps: ['approve', 'process'],
      expectedRevision: 0,
      expectedPlanSeq: null,
      approve: DECISION,
      receiveNow: true,
      process: null,
    } as never);
    expect(result.ran).toEqual([
      { step: 'approve', outcome: 'already' },
      { step: 'process', outcome: 'done' },
    ]);
    expect(stub.rpcCalls.map((c) => c.name).filter((n) => n !== 'publish_outbox')).toEqual(['approve_return', 'close_return']);
    expect(result.workbench).toMatchObject({ marker: 'workbench' });
  });

  it('stops at the first refusal; earlier steps stay committed', async () => {
    const { stub, svc } = svcFor({
      'rpc:receive_return': { data: { changed: true, status: 'received' }, error: null },
      'rpc:close_return': rpcError('restock_location_unavailable', 'P0001', '{"rule":"archived","locationId":"l"}'),
    });
    const result = await svc.runSteps(RET_ID, { steps: ['receive', 'process'] } as never);
    expect(result.ran).toEqual([
      { step: 'receive', outcome: 'done' },
      { step: 'process', outcome: 'refused', reason: 'restock_location_unavailable', message: 'Original rack is no longer available.' },
    ]);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['receive_return', 'close_return']);
    expect(workbenchMock).toHaveBeenCalledTimes(1);
  });
});

describe('gates (the service is the friendly early refusal; the functions decide)', () => {
  it('module off: module_disabled before any call', async () => {
    const { stub, svc } = svcFor({}, { enabledModules: new Set<ModuleId>() });
    await expect(svc.receive(RET_ID)).rejects.toMatchObject({ code: 'module_disabled' });
    expect(stub.rpcCalls).toHaveLength(0);
  });

  it('a staff member without returns:manage is refused every write; returns:read reads', async () => {
    const { svc } = svcFor({ 'returns.select': { data: [], error: null } }, { role: 'staff' });
    await expect(svc.close(RET_ID)).rejects.toMatchObject({ code: 'forbidden' });
    const reader = svcFor({ 'returns.select': { data: [], error: null } }, { role: 'viewer', permissions: new Set(['returns:read']) });
    await expect(reader.svc.list()).resolves.toEqual([]);
    await expect(reader.svc.approve(RET_ID, { expectedRevision: 0, decision: DECISION })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a staff member GRANTED returns:manage passes the service gate (the database checks the warehouse)', async () => {
    const { stub, svc } = svcFor(
      { 'rpc:receive_return': { data: { changed: true, status: 'received' }, error: null } },
      { role: 'staff', permissions: new Set(['returns:manage']) },
    );
    await svc.receive(RET_ID);
    expect(stub.rpcCalls.map((c) => c.name)).toEqual(['receive_return']);
  });

  it('the MFA floor applies to writes (aal2_required)', async () => {
    const { svc } = svcFor({}, { mfaRequired: true, mfaSatisfied: false });
    await expect(svc.receive(RET_ID)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('the workbench and the list need returns:read or returns:manage', async () => {
    const { svc } = svcFor({}, { role: 'viewer' });
    await expect(svc.workbench(RET_ID)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(svc.listPage({})).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('RMAService.returnableLinesForOrder (durable budget)', () => {
  it('reports remaining = quantity_fulfilled - returned_quantity (durable base)', async () => {
    // Fulfilled 10, durably returned 4, no pending demand → remaining 6. The
    // base is read straight off the source line (never a SUM over prior
    // return headers, which a cancel could deflate).
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
  });

  it('subtracts live PENDING return demand from remaining (matches the DB cap trigger)', async () => {
    // Fulfilled 10, durably returned 4, plus 3 units pending on a live
    // 'approved' (unapplied) return → offer only 3. A cancelled row's 5 units
    // are excluded — cancelling a pending return releases exactly its own
    // demand, never applied budget.
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
      'return_lines.select': {
        data: [
          {
            order_request_line_id: OLINE_ID,
            quantity: 3,
            applied: false,
            return: { status: 'approved' },
          },
          {
            order_request_line_id: OLINE_ID,
            quantity: 5,
            applied: false,
            return: { status: 'cancelled' },
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
    expect(lines[0]).toMatchObject({ quantityFulfilled: 10, quantityRemaining: 3 });
  });

  it('omits a line whose budget is fully consumed by PENDING demand', async () => {
    const stub = makeSupabaseStub({
      'order_requests.select': { data: [COMPLETED_ORDER], error: null },
      'order_request_lines.select': {
        data: [
          {
            id: OLINE_ID,
            item_id: ITEM_ID,
            quantity_fulfilled: 10,
            returned_quantity: 0,
            item: { id: ITEM_ID, name: 'Widget', sku: 'W-1' },
          },
        ],
        error: null,
      },
      'return_lines.select': {
        data: [
          {
            order_request_line_id: OLINE_ID,
            quantity: 10,
            applied: false,
            return: { status: 'requested' },
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

// ── Parent order handle (SO number) ────────────────────────────────────────
// `returns` stores only the FK order_request_id and no number snapshot, so the
// reads embed the parent order's order_number. Every returns surface prints
// formatOrderNumber(order_number) and falls back to the id prefix, because
// order_number is null on orders created before it existed.
describe('RMAService reads carry the parent order number', () => {
  it('list() embeds order_number and flattens the embed onto the row', async () => {
    const stub = makeSupabaseStub({
      'returns.select': {
        data: [
          {
            id: 'ret-1',
            organization_id: 'org-test',
            order_request_id: ORDER_ID,
            status: 'requested',
            order_request: { order_number: 49 },
          },
        ],
        error: null,
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    const rows = await svc.list();
    expect(rows[0]).toMatchObject({ id: 'ret-1', order_number: 49 });
    // The raw embed must not leak onto the row the pages consume.
    expect(rows[0]).not.toHaveProperty('order_request');
    // Wiring: the select has to ask the parent order for its number.
    expect(String(stub.chainArgs.get('returns.select')?.[0]?.[0])).toContain(
      'order_requests!order_request_id',
    );
  });

  it('list() reports order_number null for a legacy order with no number', async () => {
    const stub = makeSupabaseStub({
      'returns.select': {
        data: [
          {
            id: 'ret-1',
            organization_id: 'org-test',
            order_request_id: ORDER_ID,
            status: 'requested',
            order_request: { order_number: null },
          },
        ],
        error: null,
      },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await expect(svc.list()).resolves.toMatchObject([{ order_number: null }]);
  });

  it('get() surfaces order_number on the detail header', async () => {
    const stub = makeSupabaseStub({
      'returns.select': {
        data: [
          {
            id: 'ret-1',
            organization_id: 'org-test',
            order_request_id: ORDER_ID,
            status: 'closed',
            order_request: { order_number: 1234 },
          },
        ],
        error: null,
      },
      'return_lines.select': { data: [], error: null },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    const detail = await svc.get('ret-1');
    expect(detail).toMatchObject({ id: 'ret-1', order_number: 1234 });
    expect(detail).not.toHaveProperty('order_request');
  });

  it('get() tolerates a missing embed (order_number null, never undefined)', async () => {
    const stub = makeSupabaseStub({
      'returns.select': {
        data: [{ id: 'ret-1', organization_id: 'org-test', order_request_id: ORDER_ID, status: 'closed' }],
        error: null,
      },
      'return_lines.select': { data: [], error: null },
    });
    const svc = new RMAService(
      makeServiceContext(stub.client, { role: 'manager', enabledModules: RETURNS_MODULES }),
    );

    await expect(svc.get('ret-1')).resolves.toMatchObject({ order_number: null });
  });
});


describe('guards over the returns code', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const service = readFileSync(join(HERE, 'returns.ts'), 'utf8');

  it('RMAService never writes a return table itself (every write is a database function)', () => {
    expect(service).not.toMatch(/from\(['"]returns['"]\)\s*\.\s*(insert|update|upsert|delete)/);
    expect(service).not.toMatch(/from\(['"]return_lines['"]\)\s*\.\s*(insert|update|upsert|delete)/);
    expect(service).not.toMatch(/from\(['"]return_decisions['"]\)\s*\.\s*(insert|update|upsert|delete)/);
  });

  it('never reads order_requests.return_token for a link (0392: the side table only)', () => {
    expect(service).not.toMatch(/return_token/);
  });

  /**
   * Plan 3.1.4: RX-2 gives returns and order_requests a second relationship
   * (the replacement link). Every embed between them must name its
   * constraint or PostgREST answers PGRST201. Scans the web and the phone.
   */
  it('no embed between returns and order_requests is left unhinted (web and phone)', () => {
    const roots = [
      join(HERE, '..', '..'),
      join(HERE, '..', '..', '..', '..', 'mobile', 'app'),
      join(HERE, '..', '..', '..', '..', 'mobile', 'src'),
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === 'node_modules' || name.startsWith('.')) continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    roots.forEach(walk);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // A read FROM returns that embeds order_requests, or FROM order_requests
      // that embeds returns, within the same query chain.
      for (const m of text.matchAll(/from\(['"](returns|order_requests)['"]\)([\s\S]{0,700}?)(?=\.from\(|$)/g)) {
        const parent = m[1];
        const chain = m[2] ?? '';
        const child = parent === 'returns' ? 'order_requests' : 'returns';
        const unhinted = new RegExp(`(^|[\\s,:(\`'"])${child}\\s*\\(`);
        if (unhinted.test(chain)) offenders.push(`${file.split('/apps/')[1]}: ${parent} -> ${child}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the guard sees an unhinted embed', () => {
    const chain = ".select('*, order_request:order_requests (order_number)')";
    expect(/(^|[\s,:(`'"])order_requests\s*\(/.test(chain)).toBe(true);
    expect(/(^|[\s,:(`'"])order_requests\s*\(/.test(".select('*, order_request:order_requests!order_request_id (order_number)')")).toBe(false);
  });
});
