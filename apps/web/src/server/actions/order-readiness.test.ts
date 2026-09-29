import { beforeEach, describe, expect, it, vi } from 'vitest';

import { READINESS_FORBIDDEN_COPY, READINESS_ORDER_NOT_FOUND_COPY, type ModuleId } from '@stockpilot/core';

import { withContext } from '@/server/services/context';
import { orderReadinessFacts, visibleItemFacts } from '@/test/order-readiness-facts';
import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

/**
 * The approve-partial dialog's re-read (F2-3): the REAL action and the REAL
 * OrderReadinessService against a Supabase stub; only the request context and
 * the error reporter are faked. It reads THIS order's facts as the caller,
 * writes nothing, never throws, and answers only an approver (its one caller
 * follows approve partial and resume, which both assert orders:approve).
 */

vi.mock('@/server/services/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/services/context')>()),
  withContext: vi.fn(),
}));
vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn(async () => undefined) }));

import { readOrderReadinessAction } from './order-readiness';

const ORDER = '33333333-3333-4333-8333-333333333333';

function arrange(
  rpc: { data: unknown; error: { message: string; code?: string; hint?: string } | null },
  opts: { permissions?: string[]; role?: 'manager' | 'staff' | 'viewer' } = {},
) {
  const stub = makeSupabaseStub({ 'rpc:order_readiness_facts': rpc });
  vi.mocked(withContext).mockResolvedValue(
    makeServiceContext(stub.client, {
      role: opts.role ?? 'manager',
      enabledModules: new Set<ModuleId>(['orders']),
      ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
    }) as never,
  );
  return stub;
}

const approvedFacts = () =>
  orderReadinessFacts(
    ORDER,
    'approved',
    [{ lineId: 'L1', itemId: 'maus', requested: 40 }],
    [visibleItemFacts('maus', { here: { rack: 36 }, heldOwn: 34, heldOtherOrders: 2 })],
  );

beforeEach(() => {
  vi.mocked(withContext).mockReset();
});

describe('readOrderReadinessAction (F2-3)', () => {
  it("reads THIS order's facts as the caller, once, and answers core's assessment (the holds it has now)", async () => {
    const stub = arrange({ data: approvedFacts(), error: null });

    const res = await readOrderReadinessAction({ id: ORDER });

    expect(stub.rpcCalls).toEqual([{ name: 'order_readiness_facts', args: { p_order_id: ORDER } }]);
    expect(stub.fromCalls).toEqual([]);
    expect(res.state).toBe('ok');
    if (res.state !== 'ok' || res.assessment.phase !== 'to_pick') throw new Error('to_pick expected');
    expect(res.assessment.order.id).toBe(ORDER);
    expect(res.assessment.items[0]!.facts!.heldOwn).toBe(34);
  });

  it('staff granted orders:approve are answered too (the permission, not the role)', async () => {
    arrange({ data: approvedFacts(), error: null }, { role: 'staff', permissions: ['orders:approve'] });
    expect((await readOrderReadinessAction({ id: ORDER })).state).toBe('ok');
  });

  it('anyone without orders:approve is refused before any read', async () => {
    const stub = arrange(
      { data: approvedFacts(), error: null },
      { role: 'staff', permissions: ['orders:read', 'items:update'] },
    );

    expect(await readOrderReadinessAction({ id: ORDER })).toEqual({
      state: 'failed',
      message: READINESS_FORBIDDEN_COPY,
    });
    expect(stub.rpcCalls).toEqual([]);
  });

  it('a malformed id is refused before the context is even read', async () => {
    expect(await readOrderReadinessAction({ id: 'not-a-uuid' })).toEqual({
      state: 'failed',
      message: READINESS_ORDER_NOT_FOUND_COPY,
    });
    expect(withContext).not.toHaveBeenCalled();
  });

  it('a failed read is `failed`, never an empty answer and never a throw', async () => {
    arrange({ data: null, error: { message: 'boom', code: 'XX000' } });
    const res = await readOrderReadinessAction({ id: ORDER });
    expect(res.state).toBe('failed');
  });

  it('a context that cannot start (signed out, no organization) is `failed`, not a redirect out of the dialog', async () => {
    vi.mocked(withContext).mockRejectedValue(new Error('NEXT_REDIRECT'));
    expect(await readOrderReadinessAction({ id: ORDER })).toEqual({
      state: 'failed',
      message: 'Could not check readiness.',
    });
  });
});
