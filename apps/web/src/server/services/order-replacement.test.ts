import { describe, expect, it, vi } from 'vitest';

import type { ModuleId } from '@stockpilot/core';

import { makeServiceContext, makeSupabaseStub } from '@/test/supabase-mock';

vi.mock('@/lib/error-reporter', () => ({ reportError: vi.fn() }));

import { exchangeChipState, loadReplacementInfo, replacementRefusal } from './order-replacement';

/**
 * The replacement order's block on the order page, the slips and the phone
 * (returns RX-2, plan 3.6.9): the banner facts from return_overview (every
 * member), the release's name and reason only for holders of returns:read
 * or returns:manage, the gate words, and the slips' and driver's lines.
 */

const ORDER = 'ord-r';
const RMA = 'rma-1';

const OVERVIEW = {
  id: RMA,
  return_number: 'RMA-20261005-ABC123',
  status: 'approved',
  order_request_id: 'ord-orig',
  order_number: 103,
  replacement_order_id: ORDER,
  exchange_status: 'waiting_for_return',
  released_early: false,
  lines: [{ line_id: 'rl-1', item_id: 'item-m', quantity: 1 }],
};

function ctxFor(results: Record<string, unknown>, opts: { permissions?: string[]; modules?: ModuleId[] } = {}) {
  const stub = makeSupabaseStub({
    'return_overview.select': { data: [OVERVIEW], error: null },
    'inventory_items.select': {
      data: [{ id: 'item-m', name: 'Walk New Hire Shirt', variant_size: 'M', variant_width: null, variant_color: null, jersey_number: null }],
      error: null,
    },
    'user_profiles.select': { data: [{ full_name: 'Dana Diaz', email: 'dana@example.com' }], error: null },
    ...results,
  } as never);
  const ctx = makeServiceContext(stub.client, {
    role: 'manager',
    enabledModules: new Set<ModuleId>(opts.modules ?? ['orders', 'returns']),
    ...(opts.permissions ? { permissions: new Set(opts.permissions) } : {}),
  });
  return { stub, ctx };
}

describe('replacementRefusal', () => {
  it('maps the five replacement hints and leaves every other error alone', () => {
    expect(replacementRefusal({ hint: 'replacement_waiting_for_return' })).toMatchObject({
      code: 'conflict',
      details: { reason: 'replacement_waiting_for_return' },
    });
    expect(replacementRefusal({ hint: 'replacement_link_immutable' })?.code).toBe('forbidden');
    expect(replacementRefusal({ hint: 'returns_manage' })).toBeNull();
    expect(replacementRefusal({ message: 'replacement_waiting_for_return' })).toBeNull();
    expect(replacementRefusal(null)).toBeNull();
  });
});

describe('loadReplacementInfo', () => {
  it('an ordinary order has no block and reads nothing', async () => {
    const { stub, ctx } = ctxFor({});
    expect(await loadReplacementInfo(ctx as never, { id: ORDER, status: 'approved', replacement_for_return_id: null })).toBeNull();
    expect(stub.fromCalls).toEqual([]);
  });

  it('a gated replacement: the banner, "waiting", the slips\' line and the driver\'s line', async () => {
    const { ctx } = ctxFor({ 'return_decisions.select': { data: [{ kind: 'replacement_issued', revision: 2, reason: null, actor_user_id: 'u1', created_at: 't0' }], error: null } });
    const info = await loadReplacementInfo(ctx as never, { id: ORDER, status: 'approved', replacement_for_return_id: RMA });
    expect(info).toMatchObject({
      returnId: RMA,
      returnNumber: 'RMA-20261005-ABC123',
      originalOrderId: 'ord-orig',
      originalOrderNumber: 103,
      live: true,
      exchangeStatus: 'waiting_for_return',
      waitingForReturn: true,
      releasedEarly: false,
      returnReceived: false,
      revision: 2,
      canOpenReturn: true,
      canReleaseEarly: true,
      returnedItems: [{ itemId: 'item-m', label: 'Walk New Hire Shirt, M', quantity: 1 }],
      slipLine: 'Exchange replacement for RMA-20261005-ABC123 (returned item: Walk New Hire Shirt, M ×1, not yet received)',
      driverLine: 'Collect the returned item: Walk New Hire Shirt, M ×1 (RMA-20261005-ABC123)',
    });
  });

  it('released early: staff read who and why; others see only that it was released', async () => {
    const decisions = {
      'return_decisions.select': {
        data: [{ kind: 'released_early', revision: null, reason: 'Swap at delivery: the driver collects the returned item.', actor_user_id: 'u1', created_at: 't1' }],
        error: null,
      },
      'return_overview.select': { data: [{ ...OVERVIEW, released_early: true, exchange_status: 'ready_to_pick' }], error: null },
    };
    const staff = ctxFor(decisions);
    const a = await loadReplacementInfo(staff.ctx as never, { id: ORDER, status: 'approved', replacement_for_return_id: RMA });
    expect(a).toMatchObject({ waitingForReturn: false, releasedEarly: true });
    expect(a?.release).toEqual({ byName: 'Dana Diaz', reason: 'Swap at delivery: the driver collects the returned item.', at: 't1' });

    // A member without returns:read or returns:manage: no decision read at all.
    const member = ctxFor(decisions, { permissions: ['orders:request'] });
    const b = await loadReplacementInfo(member.ctx as never, { id: ORDER, status: 'approved', replacement_for_return_id: RMA });
    expect(member.stub.fromCalls).not.toContain('return_decisions');
    expect(b).toMatchObject({ releasedEarly: true, release: null, canOpenReturn: false, canReleaseEarly: false, waitingForReturn: false });
  });

  it('received: the gate is open and the driver has nothing to collect', async () => {
    const { ctx } = ctxFor({ 'return_overview.select': { data: [{ ...OVERVIEW, status: 'received', exchange_status: 'ready_to_pick' }], error: null } });
    const info = await loadReplacementInfo(ctx as never, { id: ORDER, status: 'approved', replacement_for_return_id: RMA });
    expect(info).toMatchObject({ waitingForReturn: false, returnReceived: true, driverLine: null });
    expect(info?.slipLine).toMatch(/, received\)$/);
  });

  it('a cancelled earlier replacement is not the live one: no gate words', async () => {
    const { ctx } = ctxFor({ 'return_overview.select': { data: [{ ...OVERVIEW, replacement_order_id: 'ord-newer' }], error: null } });
    const info = await loadReplacementInfo(ctx as never, { id: ORDER, status: 'cancelled', replacement_for_return_id: RMA });
    expect(info).toMatchObject({ live: false, waitingForReturn: false });
  });

  it('the returns module off: the RMA cannot be opened or released from here', async () => {
    const { ctx } = ctxFor({}, { modules: ['orders'] });
    const info = await loadReplacementInfo(ctx as never, { id: ORDER, status: 'approved', replacement_for_return_id: RMA });
    expect(info).toMatchObject({ canOpenReturn: false, canReleaseEarly: false });
  });
});

describe('exchangeChipState', () => {
  it('only the two states the gate decides have words', () => {
    expect(exchangeChipState('waiting_for_return')).toBe('Waiting for return');
    expect(exchangeChipState('ready_to_pick')).toBe('Ready to pick');
    for (const s of ['none', 'requested', 'in_progress', 'completed', 'unavailable'] as const) expect(exchangeChipState(s)).toBeNull();
  });
});
