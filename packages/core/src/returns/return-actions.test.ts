import { describe, expect, it } from 'vitest';

import { RETURN_STATUS_LABELS, type ReturnStatus } from '../orders/order-returns-view';
import { availableReturnActions, RETURN_ACTION_LABELS, stepsForAction, type ReturnActions } from './return-actions';

const STATUSES = Object.keys(RETURN_STATUS_LABELS) as ReturnStatus[];

/** The plan 3.9 return-only rows, written out once. */
function expected(status: ReturnStatus, canManage: boolean, itemIsHere: boolean, hasExchange: boolean): ReturnActions {
  const terminal = status === 'closed' || status === 'denied' || status === 'cancelled';
  if (terminal) return { primary: null, secondary: [], readOnlyReason: null };
  if (!canManage) return { primary: null, secondary: [], readOnlyReason: "You don't have permission to manage returns." };
  if (hasExchange) return { primary: null, secondary: [], readOnlyReason: null };
  if (status === 'requested') {
    return { primary: itemIsHere ? 'approve_and_receive' : 'approve', secondary: ['deny', 'cancel'], readOnlyReason: null };
  }
  if (status === 'approved') return { primary: 'receive', secondary: ['change_destination', 'cancel'], readOnlyReason: null };
  return { primary: 'process', secondary: ['change_destination'], readOnlyReason: null };
}

describe('availableReturnActions (return-only rows, exhaustive)', () => {
  const rows: [ReturnStatus, boolean, boolean, boolean][] = [];
  for (const s of STATUSES)
    for (const m of [true, false])
      for (const h of [true, false])
        for (const x of [true, false]) rows.push([s, m, h, x]);

  it.each(rows)('status %s, manage %s, item here %s, exchange %s', (status, canManage, itemIsHere, hasExchange) => {
    expect(
      availableReturnActions({ status, viewerCanManageReturns: canManage, itemIsHere, hasExchange }),
    ).toEqual(expected(status, canManage, itemIsHere, hasExchange));
  });

  it('"Approve and receive" appears only with the switch on (off by default, D21)', () => {
    expect(availableReturnActions({ status: 'requested', viewerCanManageReturns: true }).primary).toBe('approve');
    expect(availableReturnActions({ status: 'requested', viewerCanManageReturns: true, itemIsHere: true }).primary).toBe(
      'approve_and_receive',
    );
  });

  it('an exchange status other than none is read-only in RX-1', () => {
    expect(availableReturnActions({ status: 'approved', viewerCanManageReturns: true, exchangeStatus: 'waiting_for_return' })).toEqual({
      primary: null,
      secondary: [],
      readOnlyReason: null,
    });
    expect(availableReturnActions({ status: 'approved', viewerCanManageReturns: true, exchangeStatus: 'none' }).primary).toBe('receive');
  });

  it('an unknown status offers nothing', () => {
    expect(availableReturnActions({ status: 'mystery', viewerCanManageReturns: true })).toEqual({
      primary: null,
      secondary: [],
      readOnlyReason: null,
    });
  });

  it('labels every action and maps the step actions to the steps endpoint', () => {
    expect(RETURN_ACTION_LABELS.approve_and_receive).toBe('Approve and receive');
    expect(RETURN_ACTION_LABELS.process).toBe('Process return');
    expect(stepsForAction('approve_and_receive')).toEqual(['approve']);
    expect(stepsForAction('receive')).toEqual(['receive']);
    expect(stepsForAction('process')).toEqual(['process']);
    expect(stepsForAction('deny')).toBeNull();
  });
});
