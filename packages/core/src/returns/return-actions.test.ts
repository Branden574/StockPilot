import { describe, expect, it } from 'vitest';

import { RETURN_STATUS_LABELS, type ReturnStatus } from '../orders/order-returns-view';
import { EXCHANGE_STATUSES, type ExchangeStatus } from './exchange-status';
import {
  availableReturnActions,
  REPLACEMENT_ACTIONS,
  replacementClassOf,
  RETURN_ACTION_LABELS,
  returnActionLabel,
  stepsForAction,
  type ReplacementClass,
  type ReturnAction,
  type ReturnActions,
} from './return-actions';

const STATUSES = Object.keys(RETURN_STATUS_LABELS) as ReturnStatus[];
const NO_MANAGE = "You don't have permission to manage returns.";
const NO_ORDERS = 'Approving the replacement needs order approval permission.';

/** The plan 3.9 return-only rows, written out once. */
function expected(status: ReturnStatus, canManage: boolean, itemIsHere: boolean): ReturnActions {
  const terminal = status === 'closed' || status === 'denied' || status === 'cancelled';
  if (terminal) return { primary: null, secondary: [], readOnlyReason: null };
  if (!canManage) return { primary: null, secondary: [], readOnlyReason: NO_MANAGE };
  if (status === 'requested') {
    return { primary: itemIsHere ? 'approve_and_receive' : 'approve', secondary: ['deny', 'cancel'], readOnlyReason: null };
  }
  if (status === 'approved') return { primary: 'receive', secondary: ['change_destination', 'cancel'], readOnlyReason: null };
  return { primary: 'process', secondary: ['change_destination'], readOnlyReason: null };
}

describe('availableReturnActions (return-only rows, exhaustive)', () => {
  const rows: [ReturnStatus, boolean, boolean][] = [];
  for (const s of STATUSES) for (const m of [true, false]) for (const h of [true, false]) rows.push([s, m, h]);

  it.each(rows)('status %s, manage %s, item here %s', (status, canManage, itemIsHere) => {
    expect(availableReturnActions({ status, viewerCanManageReturns: canManage, itemIsHere })).toEqual(
      expected(status, canManage, itemIsHere),
    );
    expect(availableReturnActions({ status, viewerCanManageReturns: canManage, itemIsHere, exchangeStatus: 'none' })).toEqual(
      expected(status, canManage, itemIsHere),
    );
  });

  it('"Approve and receive" appears only with the switch on (off by default, D21)', () => {
    expect(availableReturnActions({ status: 'requested', viewerCanManageReturns: true }).primary).toBe('approve');
    expect(availableReturnActions({ status: 'requested', viewerCanManageReturns: true, itemIsHere: true }).primary).toBe(
      'approve_and_receive',
    );
  });

  it('an unknown status offers nothing', () => {
    expect(availableReturnActions({ status: 'mystery', viewerCanManageReturns: true })).toEqual({
      primary: null,
      secondary: [],
      readOnlyReason: null,
    });
  });
});

// ── The exchange rows (plan 3.9) ───────────────────────────────────────────

type Row = [status: ReturnStatus, ex: ExchangeStatus, cls: ReplacementClass, primary: ReturnAction | null, secondary: ReturnAction[]];

/** Plan 3.9's table, written out once (the viewer may manage returns and approve orders). */
const TABLE: Row[] = [
  ['requested', 'requested', 'none', 'approve', ['deny', 'cancel']],
  ['approved', 'declined', 'none', 'receive', ['change_destination', 'cancel']],
  ['approved', 'waiting_for_return', 'undrawn', 'receive', ['release_early', 'change_replacement', 'cancel_replacement', 'cancel']],
  ['approved', 'unavailable', 'undrawn', 'receive', ['change_replacement', 'open_replacement', 'cancel_replacement', 'cancel']],
  ['approved', 'ready_to_pick', 'undrawn', 'receive', ['get_replacement_ready', 'open_replacement', 'cancel_replacement']],
  ['approved', 'in_progress', 'undrawn', 'receive', ['open_replacement', 'cancel_replacement']],
  ['approved', 'in_progress', 'drawn', 'receive', ['open_replacement', 'cancel_replacement']],
  ['approved', 'ready_for_pickup', 'drawn', 'receive', ['hand_over', 'cancel_replacement']],
  ['approved', 'out_for_delivery', 'drawn', 'receive', ['hand_over', 'cancel_replacement']],
  ['approved', 'partly_handed_over', 'handed_over', 'receive', ['open_replacement', 'cancel']],
  ['approved', 'handed_over_return_open', 'handed_over', 'receive', ['cancel']],
  ['approved', 'replacement_cancelled', 'none', 'receive', ['issue_replacement', 'cancel']],
  ['received', 'ready_to_pick', 'undrawn', 'get_replacement_ready', ['process', 'change_replacement', 'cancel_replacement']],
  ['received', 'replacement_cancelled', 'none', 'process', ['issue_replacement']],
  ['received', 'declined', 'none', 'process', ['change_destination']],
  ['received', 'in_progress', 'drawn', 'process', ['change_destination', 'open_replacement', 'cancel_replacement']],
  ['received', 'ready_for_pickup', 'drawn', 'process', ['change_destination', 'hand_over', 'cancel_replacement']],
  ['received', 'handed_over_return_open', 'handed_over', 'process', ['change_destination', 'open_replacement']],
  ['received', 'unavailable', 'undrawn', 'process', ['change_destination', 'open_replacement', 'cancel_replacement']],
  ['closed', 'ready_to_pick', 'undrawn', 'get_replacement_ready', ['change_replacement', 'cancel_replacement']],
  ['closed', 'unavailable', 'undrawn', 'open_replacement', ['change_replacement', 'cancel_replacement']],
  ['closed', 'in_progress', 'undrawn', 'open_replacement', ['cancel_replacement']],
  ['closed', 'ready_for_pickup', 'drawn', 'hand_over', ['cancel_replacement']],
  ['closed', 'out_for_delivery', 'drawn', 'hand_over', ['cancel_replacement']],
  ['closed', 'partly_handed_over', 'handed_over', 'open_replacement', []],
  ['closed', 'replacement_cancelled', 'none', 'issue_replacement', []],
  ['closed', 'completed', 'handed_over', null, []],
  ['closed', 'declined', 'none', null, []],
  ['denied', 'cancelled', 'none', null, []],
  ['cancelled', 'cancelled', 'none', null, []],
  ['cancelled', 'handed_over_return_cancelled', 'handed_over', null, []],
];

describe('availableReturnActions (exchange rows, plan 3.9)', () => {
  it.each(TABLE)('%s / %s / %s', (status, ex, cls, primary, secondary) => {
    expect(
      availableReturnActions({
        status,
        exchangeStatus: ex,
        hasExchange: true,
        replacementClass: cls,
        hasApprovedExchange: true,
        viewerCanManageReturns: true,
        viewerCanApproveOrders: true,
      }),
    ).toEqual({ primary, secondary, readOnlyReason: null });
  });

  it('covers every exchange status at least once', () => {
    const covered = new Set(TABLE.map((r) => r[1]));
    for (const s of EXCHANGE_STATUSES.filter((x) => x !== 'none')) expect(covered.has(s)).toBe(true);
  });

  it('without order approval the replacement actions go, the return actions stay, and the screen says why', () => {
    for (const [status, ex, cls] of TABLE) {
      const r = availableReturnActions({
        status,
        exchangeStatus: ex,
        hasExchange: true,
        replacementClass: cls,
        hasApprovedExchange: true,
        viewerCanManageReturns: true,
        viewerCanApproveOrders: false,
      });
      const all = [r.primary, ...r.secondary].filter((a): a is ReturnAction => a !== null);
      for (const a of all) expect(REPLACEMENT_ACTIONS.includes(a)).toBe(false);
      // Cancelling an RMA whose exchange was approved needs order approval too.
      expect(all).not.toContain('cancel');
    }
    expect(
      availableReturnActions({
        status: 'received',
        exchangeStatus: 'ready_to_pick',
        hasExchange: true,
        replacementClass: 'undrawn',
        viewerCanManageReturns: true,
        viewerCanApproveOrders: false,
      }),
    ).toEqual({ primary: 'process', secondary: [], readOnlyReason: NO_ORDERS });
    // A requested exchange can still be approved (the review declines what the viewer cannot approve).
    expect(
      availableReturnActions({ status: 'requested', exchangeStatus: 'requested', viewerCanManageReturns: true, viewerCanApproveOrders: false }),
    ).toEqual({ primary: 'approve', secondary: ['deny', 'cancel'], readOnlyReason: null });
  });

  it('a viewer who cannot manage returns sees the exchange read-only', () => {
    expect(
      availableReturnActions({ status: 'approved', exchangeStatus: 'waiting_for_return', viewerCanManageReturns: false, viewerCanApproveOrders: true }),
    ).toEqual({ primary: null, secondary: [], readOnlyReason: NO_MANAGE });
    // A finished exchange shows nothing to anyone.
    expect(availableReturnActions({ status: 'closed', exchangeStatus: 'completed', viewerCanManageReturns: false })).toEqual({
      primary: null,
      secondary: [],
      readOnlyReason: null,
    });
  });

  it('the class decides change and cancel: a picked replacement is only cancelled, a handed-over one neither', () => {
    const base = { status: 'received' as const, viewerCanManageReturns: true, viewerCanApproveOrders: true, hasExchange: true };
    expect(availableReturnActions({ ...base, exchangeStatus: 'ready_to_pick', replacementClass: 'drawn' }).secondary).toEqual([
      'process',
      'cancel_replacement',
    ]);
    expect(availableReturnActions({ ...base, exchangeStatus: 'ready_to_pick', replacementClass: 'handed_over' }).secondary).toEqual([
      'process',
    ]);
  });

  it('labels every action; an exchange approval reads "Approve return & exchange"', () => {
    for (const a of Object.keys(RETURN_ACTION_LABELS) as ReturnAction[]) expect(RETURN_ACTION_LABELS[a]).toBeTruthy();
    expect(returnActionLabel('approve', { hasExchange: true })).toBe('Approve return & exchange');
    expect(returnActionLabel('approve')).toBe('Approve return');
    expect(RETURN_ACTION_LABELS.release_early).toBe('Release replacement before return is received');
    expect(RETURN_ACTION_LABELS.hand_over).toBe('Hand over');
  });

  it('maps the step actions to the steps endpoint and nothing else', () => {
    expect(stepsForAction('approve_and_receive')).toEqual(['approve']);
    expect(stepsForAction('receive')).toEqual(['receive']);
    expect(stepsForAction('process')).toEqual(['process']);
    expect(stepsForAction('deny')).toBeNull();
    expect(stepsForAction('get_replacement_ready')).toBeNull();
  });
});

describe('replacementClassOf (the SQL _return_replacement_class)', () => {
  it.each([
    ['approved', false, 'undrawn'],
    ['pick_slip_generated', false, 'undrawn'],
    ['picking_in_progress', false, 'undrawn'],
    ['backordered', false, 'undrawn'],
    ['backordered', true, 'handed_over'],
    ['picking_complete', false, 'drawn'],
    ['packing_slip_generated', false, 'drawn'],
    ['staged_for_pickup', false, 'drawn'],
    ['staged_for_delivery', false, 'drawn'],
    ['in_transit', false, 'drawn'],
    ['completed', true, 'handed_over'],
    ['cancelled', false, 'none'],
    ['denied', false, 'none'],
    [null, false, 'none'],
    // Desk check F2: a backorder resumed into picking again (or picked
    // again) after part was handed over is still handed over: Cancel and
    // Change replacement would let a new replacement send those units twice.
    ['pick_slip_generated', true, 'handed_over'],
    ['picking_in_progress', true, 'handed_over'],
    ['picking_complete', true, 'handed_over'],
    ['packing_slip_generated', true, 'handed_over'],
    ['staged_for_pickup', true, 'handed_over'],
    ['staged_for_delivery', true, 'handed_over'],
    ['in_transit', true, 'handed_over'],
    ['cancelled', true, 'none'],
  ] as const)('%s (handed over %s) is %s', (status, handed, cls) => {
    expect(replacementClassOf(status, handed)).toBe(cls);
  });

  it('a resumed partial hand-over offers neither Change nor Cancel replacement (desk check F2)', () => {
    for (const status of ['approved', 'received', 'closed'] as const) {
      const a = availableReturnActions({
        status,
        exchangeStatus: 'in_progress',
        hasExchange: true,
        replacementClass: replacementClassOf('pick_slip_generated', true),
        hasApprovedExchange: true,
        viewerCanManageReturns: true,
        viewerCanApproveOrders: true,
      });
      const all = [a.primary, ...a.secondary];
      expect(all, status).not.toContain('cancel_replacement');
      expect(all, status).not.toContain('change_replacement');
    }
  });
});
