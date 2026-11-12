import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

// The global setup stubs audit to a no-op; this file asserts on it.
const auditSpy = vi.fn(async (..._args: unknown[]) => {});
vi.mock('@/server/services/audit', () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));

import { recordReturnRequestDrafted } from './return-request-draft';

const ORDER = 'b3f1c2d4-1111-4222-8333-444455556666';
const RMA = 'RMA-20261110-AB12CD';
const REQUESTER = 'user-requester';

function stubFor(over: { order?: unknown; ret?: unknown } = {}) {
  return makeSupabaseStub({
    'order_requests.select': {
      data: over.order === undefined ? { id: ORDER, requester_user_id: REQUESTER } : over.order,
      error: null,
    },
    'returns.select': {
      data:
        over.ret === undefined
          ? { id: 'ret-1', status: 'requested', source: 'requester', return_number: RMA }
          : over.ret,
      error: null,
    },
  });
}

// The returns module is off by default (core registry), so every context
// that should pass the module gate names it.
const ON = new Set<ModuleId>(['orders', 'returns'] as ModuleId[]);
const ctxFor = (client: unknown, over: Parameters<typeof makeServiceContext>[1] = {}) =>
  makeServiceContext(client, { enabledModules: ON, ...over });

const INPUT = { orderId: ORDER, returnNumber: RMA, isCondensed: false, surface: 'order' as const };

function filtersOf(stub: ReturnType<typeof makeSupabaseStub>, key: string): unknown[][] {
  const methods = stub.chains.get(key) ?? [];
  const args = stub.chainArgs.get(key) ?? [];
  return methods.map((m, i) => [m, ...(args[i] ?? [])]).filter(([m]) => m === 'eq');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordReturnRequestDrafted', () => {
  it("writes one row for the order's own requester, a staff member with no returns permission", async () => {
    const stub = stubFor();
    const ctx = ctxFor(stub.client, { role: 'staff', userId: REQUESTER });
    const res = await recordReturnRequestDrafted(ctx as never, INPUT);
    expect(res).toEqual({ recorded: true });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    const [payload, passedCtx] = auditSpy.mock.calls[0]! as [Record<string, unknown>, unknown];
    expect(payload).toEqual({
      event: 'order.return_request_drafted',
      entityType: 'order_request',
      entityId: ORDER,
      extra: { return_number: RMA, is_condensed: false, surface: 'order' },
    });
    // The actor and the organization are the context's, never the caller's input.
    expect(passedCtx).toBe(ctx);
  });

  it('reads the order and the return inside the caller organization only', async () => {
    const stub = stubFor();
    const ctx = ctxFor(stub.client, { role: 'staff', userId: REQUESTER, organizationId: 'org-a' });
    await recordReturnRequestDrafted(ctx as never, INPUT);
    expect(filtersOf(stub, 'order_requests.select')).toEqual(
      expect.arrayContaining([
        ['eq', 'id', ORDER],
        ['eq', 'organization_id', 'org-a'],
      ]),
    );
    expect(filtersOf(stub, 'returns.select')).toEqual(
      expect.arrayContaining([
        ['eq', 'organization_id', 'org-a'],
        ['eq', 'order_request_id', ORDER],
        ['eq', 'return_number', RMA],
      ]),
    );
  });

  it('writes for a member who can read returns and is not the requester', async () => {
    const stub = stubFor();
    const ctx = ctxFor(stub.client, { role: 'manager', userId: 'someone-else' });
    const res = await recordReturnRequestDrafted(ctx as never, { ...INPUT, surface: 'return', isCondensed: true });
    expect(res).toEqual({ recorded: true });
    expect((auditSpy.mock.calls[0]![0] as { extra: unknown }).extra).toEqual({
      return_number: RMA,
      is_condensed: true,
      surface: 'return',
    });
  });

  it('writes for a viewer who was granted returns:read', async () => {
    const stub = stubFor();
    const ctx = ctxFor(stub.client, {
      role: 'viewer',
      userId: 'someone-else',
      permissions: new Set(['returns:read']),
    });
    expect(await recordReturnRequestDrafted(ctx as never, INPUT)).toEqual({ recorded: true });
  });

  it('writes nothing for a member who is neither the requester nor a returns reader', async () => {
    for (const role of ['staff', 'viewer'] as const) {
      const stub = stubFor();
      const ctx = ctxFor(stub.client, { role, userId: 'someone-else' });
      expect(await recordReturnRequestDrafted(ctx as never, INPUT)).toEqual({ recorded: false });
    }
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("writes nothing for another organization's order (the scoped read finds no row)", async () => {
    const stub = stubFor({ order: null });
    const ctx = ctxFor(stub.client, { role: 'admin' });
    expect(await recordReturnRequestDrafted(ctx as never, INPUT)).toEqual({ recorded: false });
    expect(auditSpy).not.toHaveBeenCalled();
    // Refused before the return is looked up at all.
    expect(stub.fromCalls).toEqual(['order_requests']);
  });

  it('writes nothing when no return with that number is on that order', async () => {
    const stub = stubFor({ ret: null });
    const ctx = ctxFor(stub.client, { role: 'staff', userId: REQUESTER });
    expect(await recordReturnRequestDrafted(ctx as never, INPUT)).toEqual({ recorded: false });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('writes nothing for a closed, denied or cancelled return', async () => {
    for (const status of ['closed', 'denied', 'cancelled']) {
      const stub = stubFor({ ret: { id: 'r', status, source: 'requester', return_number: RMA } });
      const ctx = ctxFor(stub.client, { role: 'manager' });
      expect(await recordReturnRequestDrafted(ctx as never, INPUT), status).toEqual({ recorded: false });
    }
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('a requester with no returns permission records only a return they asked for themselves', async () => {
    const stub = stubFor({ ret: { id: 'r', status: 'requested', source: 'internal', return_number: RMA } });
    const ctx = ctxFor(stub.client, { role: 'staff', userId: REQUESTER });
    expect(await recordReturnRequestDrafted(ctx as never, INPUT)).toEqual({ recorded: false });
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('writes nothing while the returns module is off', async () => {
    const stub = stubFor();
    const ctx = ctxFor(stub.client, {
      role: 'admin',
      enabledModules: new Set<ModuleId>(['orders'] as ModuleId[]),
    });
    expect(await recordReturnRequestDrafted(ctx as never, INPUT)).toEqual({ recorded: false });
    expect(auditSpy).not.toHaveBeenCalled();
    expect(stub.fromCalls).toEqual([]);
  });

  it('writes nothing for a malformed input, and never stores extra keys', async () => {
    const stub = stubFor();
    const ctx = ctxFor(stub.client, { role: 'admin' });
    for (const bad of [
      null,
      {},
      { ...INPUT, orderId: 'not-a-uuid' },
      { ...INPUT, returnNumber: '' },
      { ...INPUT, returnNumber: 'RMA-1\nx' },
      { ...INPUT, returnNumber: 'R'.repeat(65) },
      { ...INPUT, isCondensed: 'yes' },
      { ...INPUT, surface: 'portal' },
    ]) {
      expect(await recordReturnRequestDrafted(ctx as never, bad)).toEqual({ recorded: false });
    }
    expect(auditSpy).not.toHaveBeenCalled();

    await recordReturnRequestDrafted(ctx as never, {
      ...INPUT,
      to: 'someone@example.test',
      body: 'BODY TEXT',
      url: 'https://outlook.cloud.microsoft/x',
    });
    const serialized = JSON.stringify(auditSpy.mock.calls[0]![0]);
    for (const forbidden of ['example.test', 'BODY TEXT', 'outlook', 'mailto:']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('never throws: a failed read is nothing recorded', async () => {
    const client = {
      from: () => {
        throw new Error('network down');
      },
    };
    const ctx = ctxFor(client, { role: 'admin' });
    await expect(recordReturnRequestDrafted(ctx as never, INPUT)).resolves.toEqual({ recorded: false });
  });
});
