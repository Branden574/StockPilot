import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RECEIVE_GATE_CHECKING_COPY,
  RECEIVE_GATE_OFFLINE_COPY,
  RECEIVE_GATE_UNKNOWN_COPY,
  RECEIVE_MANAGER_POSTS_COPY,
  receivingGate,
  ROLES,
  type Role,
} from '@stockpilot/core';

import {
  canEditReceiptQuantities,
  fetchReceiveFacts,
  forgetReceiveGates,
  ReceiveGateResponseError,
  receiveFactsFromMe,
  receiveFooter,
  receiveGateFromFacts,
  receiveGateKey,
  receiveGateOf,
  receiveGateState,
  rememberedReceiveFacts,
  type ReceiveGateFacts,
  type ReceiveGateState,
} from './receive-gate';

const api = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ api }));

/**
 * F4-1 on the phone: who may post a receipt (and record its checklist) is
 * core receivingGate, fed /api/v1/me/permissions, never guessed, and a draft
 * asks nothing and shows nothing (F2-5's review mode).
 */

const ALL = ['stock:adjust', 'purchase_orders:read', 'purchase_orders:manage'];

const facts = (role: Role, permissions = ALL): ReceiveGateFacts =>
  receiveFactsFromMe({ role, permissions });

const known = (role: Role, permissions = ALL): ReceiveGateState => ({
  kind: 'known',
  facts: facts(role, permissions),
});

beforeEach(() => {
  api.mockReset();
  forgetReceiveGates();
});

describe('reading /api/v1/me/permissions', () => {
  it('takes the role and the three permissions the gate needs', () => {
    expect(receiveFactsFromMe({ role: 'manager', permissions: ['stock:adjust', 'x'] })).toEqual({
      role: 'manager',
      canAdjust: true,
      canReadPo: false,
      canManagePo: false,
    });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['no role', { permissions: [] }],
    ['an unknown role', { role: 'superuser', permissions: [] }],
    ['permissions that are not a list', { role: 'owner', permissions: 'all' }],
  ])('%s is an unexpected answer, never a guess', (_l, res) => {
    expect(() => receiveFactsFromMe(res)).toThrow(ReceiveGateResponseError);
  });

  it('feeds core receivingGate for every role, with Receiving on or off', () => {
    for (const role of ROLES) {
      for (const receivingOn of [true, false]) {
        const f = facts(role);
        expect(receiveGateFromFacts(f, receivingOn)).toEqual(receivingGate({ ...f, receivingOn }));
      }
    }
  });

  it('remembers the answer for this account and workspace only', async () => {
    api.mockResolvedValueOnce({ role: 'admin', permissions: ALL });
    await expect(fetchReceiveFacts('u1', 'o1')).resolves.toMatchObject({ role: 'admin' });
    expect(api).toHaveBeenCalledWith('/api/v1/me/permissions');
    expect(rememberedReceiveFacts('u1', 'o1')?.role).toBe('admin');
    expect(rememberedReceiveFacts('u1', 'o2')).toBeNull();
    expect(rememberedReceiveFacts('u2', 'o1')).toBeNull();
    expect(rememberedReceiveFacts(null, 'o1')).toBeNull();
  });

  it('a failed or malformed check throws and remembers nothing', async () => {
    api.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchReceiveFacts('u1', 'o1')).rejects.toThrow('offline');
    api.mockResolvedValueOnce({ role: 'nope' });
    await expect(fetchReceiveFacts('u1', 'o1')).rejects.toThrow(ReceiveGateResponseError);
    expect(rememberedReceiveFacts('u1', 'o1')).toBeNull();
  });
});

describe('what the screen knows', () => {
  const key = receiveGateKey('u1', 'o1');

  it('an answer counts only for the account and workspace it was asked under', () => {
    const f = facts('manager');
    expect(
      receiveGateState({ answer: { key: key!, facts: f }, key, remembered: null, offline: false }),
    ).toEqual({
      kind: 'known',
      facts: f,
    });
    // A workspace switch: the old answer is not this workspace's.
    expect(
      receiveGateState({
        answer: { key: key!, facts: f },
        key: receiveGateKey('u1', 'o2'),
        remembered: null,
        offline: false,
      }),
    ).toEqual({ kind: 'loading' });
  });

  it('a failed check falls back to the answer remembered this session, else says it could not check', () => {
    const f = facts('admin');
    expect(
      receiveGateState({ answer: { key: key!, failed: true }, key, remembered: f, offline: false }),
    ).toEqual({ kind: 'known', facts: f });
    expect(
      receiveGateState({
        answer: { key: key!, failed: true },
        key,
        remembered: null,
        offline: false,
      }),
    ).toEqual({ kind: 'unknown', offline: false });
  });

  it('offline with nothing known says posting needs a connection, never "checking"', () => {
    expect(receiveGateState({ answer: null, key, remembered: null, offline: true })).toEqual({
      kind: 'unknown',
      offline: true,
    });
    expect(receiveGateState({ answer: null, key, remembered: null, offline: false })).toEqual({
      kind: 'loading',
    });
    expect(receiveGateState({ answer: null, key: null, remembered: null, offline: false })).toEqual(
      {
        kind: 'loading',
      },
    );
  });

  it('the gate is read only from a known answer', () => {
    expect(receiveGateOf({ kind: 'loading' }, true)).toBeNull();
    expect(receiveGateOf({ kind: 'unknown', offline: false }, true)).toBeNull();
    expect(receiveGateOf(known('manager'), true)?.canRecordChecklist).toBe(true);
    expect(receiveGateOf(known('manager'), false)?.canRecordChecklist).toBe(false);
  });
});

describe('the quantities and the footer', () => {
  // Mutation caught: quantities editable on stock:adjust alone (staff hold it
  // by default, typed everything, and were refused only at Post).
  it('quantities take input only on a known yes, and never on a draft', () => {
    expect(canEditReceiptQuantities({ reviewOnly: false, gate: known('manager') })).toBe(true);
    expect(canEditReceiptQuantities({ reviewOnly: false, gate: known('owner') })).toBe(true);
    expect(canEditReceiptQuantities({ reviewOnly: true, gate: known('owner') })).toBe(false);
    expect(canEditReceiptQuantities({ reviewOnly: false, gate: known('staff') })).toBe(false);
    expect(canEditReceiptQuantities({ reviewOnly: false, gate: known('viewer') })).toBe(false);
    expect(
      canEditReceiptQuantities({
        reviewOnly: false,
        gate: known('manager', ['purchase_orders:read']),
      }),
    ).toBe(false);
    expect(canEditReceiptQuantities({ reviewOnly: false, gate: { kind: 'loading' } })).toBe(false);
    expect(
      canEditReceiptQuantities({ reviewOnly: false, gate: { kind: 'unknown', offline: true } }),
    ).toBe(false);
  });

  const footer = (
    gate: ReceiveGateState,
    over: Partial<Parameters<typeof receiveFooter>[0]> = {},
  ) => receiveFooter({ reviewOnly: false, gate, posting: false, anyReceivable: true, ...over });

  it('a draft shows no footer at all, whatever is known', () => {
    expect(footer(known('owner'), { reviewOnly: true })).toEqual({ kind: 'none' });
    expect(footer({ kind: 'loading' }, { reviewOnly: true })).toEqual({ kind: 'none' });
  });

  it('before an answer it says so; it never guesses', () => {
    expect(footer({ kind: 'loading' })).toEqual({
      kind: 'checking',
      text: RECEIVE_GATE_CHECKING_COPY,
    });
    expect(footer({ kind: 'unknown', offline: false })).toEqual({
      kind: 'unknown',
      text: RECEIVE_GATE_UNKNOWN_COPY,
      retry: true,
    });
    expect(footer({ kind: 'unknown', offline: true })).toEqual({
      kind: 'unknown',
      text: RECEIVE_GATE_OFFLINE_COPY,
      retry: false,
    });
  });

  // Mutation caught: Post receipt for staff or viewers (the ledger refuses them).
  it('staff and viewers are told a manager posts receipts', () => {
    for (const role of ['staff', 'viewer'] as const) {
      expect(footer(known(role))).toEqual({
        kind: 'manager_posts',
        text: RECEIVE_MANAGER_POSTS_COPY,
      });
    }
  });

  it('a manager who can post sees Post receipt, as before', () => {
    expect(footer(known('manager'))).toEqual({
      kind: 'post',
      label: 'Post receipt',
      disabled: false,
    });
    expect(footer(known('manager'), { posting: true })).toEqual({
      kind: 'post',
      label: 'Posting…',
      disabled: true,
    });
    expect(footer(known('manager'), { anyReceivable: false })).toEqual({
      kind: 'post',
      label: 'Fully received',
      disabled: true,
    });
  });
});
