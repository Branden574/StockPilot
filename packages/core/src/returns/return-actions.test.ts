import { describe, expect, it } from 'vitest';

import { RETURN_STATUS_LABELS, type ReturnStatus } from '../orders/order-returns-view';
import { EXCHANGE_STATUSES, returnWaitingDays, type ExchangeStatus } from './exchange-status';
import { defaultExchangeReviewState, exchangeReviewDecision, exchangeReviewOptions, exchangeReviewProblem } from './exchange-view';
import {
  availableReturnActions,
  exchangeActionConsequences,
  REPLACEMENT_ACTIONS,
  replacementClassOf,
  RETURN_ACTION_LABELS,
  returnActionLabel,
  stepsForAction,
  stillWaitingPrompt,
  type ReplacementClass,
  type ReturnAction,
  type ReturnActions,
} from './return-actions';

const STATUSES = Object.keys(RETURN_STATUS_LABELS) as ReturnStatus[];
const NO_MANAGE = "You don't have permission to manage returns.";
const NO_ORDERS = 'Approving the replacement needs order approval permission.';
// Fix round 1 (verification L3): once the exchange was approved nothing is
// being approved; the words say what the viewer cannot do.
const NO_ORDERS_AFTER = 'Changing, cancelling, releasing, preparing or issuing the replacement needs order approval permission.';
const NO_ORDERS_AFTER_CANCEL =
  'Changing, cancelling, releasing, preparing or issuing the replacement, and cancelling this return, need order approval permission.';

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
  ['approved', 'replacement_cancelled', 'none', 'receive', ['issue_replacement', 'close_as_return_only', 'cancel']],
  ['received', 'ready_to_pick', 'undrawn', 'get_replacement_ready', ['process', 'change_replacement', 'cancel_replacement']],
  ['received', 'replacement_cancelled', 'none', 'process', ['issue_replacement', 'close_as_return_only']],
  ['received', 'declined', 'none', 'process', ['change_destination']],
  ['received', 'in_progress', 'drawn', 'process', ['change_destination', 'open_replacement', 'cancel_replacement']],
  ['received', 'ready_for_pickup', 'drawn', 'process', ['change_destination', 'hand_over', 'cancel_replacement']],
  ['received', 'handed_over_return_open', 'handed_over', 'process', ['change_destination', 'open_replacement']],
  // RX-2 review fix P16: a replacement not in stock can be changed at
  // received too (approved and closed offer it; the database allows it).
  ['received', 'unavailable', 'undrawn', 'process', ['change_replacement', 'change_destination', 'open_replacement', 'cancel_replacement']],
  ['closed', 'ready_to_pick', 'undrawn', 'get_replacement_ready', ['change_replacement', 'cancel_replacement']],
  ['closed', 'unavailable', 'undrawn', 'open_replacement', ['change_replacement', 'cancel_replacement']],
  ['closed', 'in_progress', 'undrawn', 'open_replacement', ['cancel_replacement']],
  ['closed', 'ready_for_pickup', 'drawn', 'hand_over', ['cancel_replacement']],
  ['closed', 'out_for_delivery', 'drawn', 'hand_over', ['cancel_replacement']],
  ['closed', 'partly_handed_over', 'handed_over', 'open_replacement', []],
  ['closed', 'replacement_cancelled', 'none', 'issue_replacement', ['close_as_return_only']],
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
    ).toEqual({ primary: 'process', secondary: [], readOnlyReason: NO_ORDERS_AFTER });
  });

  // RX-2 review fix P1: a viewer with Manage returns but not order approval
  // can still approve the RETURN of a requested exchange: the review shows,
  // offers only "Decline the exchange, return only" (the database asks for
  // order approval only to approve or add a replacement), starts there, and
  // says why the other two choices are off. Never an approval that would send
  // an approve decision the database refuses.
  it('the review declines what the viewer cannot approve', () => {
    const requested = { status: 'requested' as const, exchangeStatus: 'requested' as const, viewerCanManageReturns: true };
    expect(availableReturnActions({ ...requested, viewerCanApproveOrders: false })).toEqual({
      primary: 'approve',
      secondary: ['deny', 'cancel'],
      readOnlyReason:
        'Approving the replacement needs order approval permission. You can still approve the return: choose Decline the exchange, return only.',
    });
    expect(availableReturnActions({ ...requested, viewerCanApproveOrders: false, itemIsHere: true }).primary).toBe('approve_and_receive');

    const line = { id: 'x1', requestedItemId: 'l', requestNote: null };
    const viewer = { canApproveOrders: false };
    expect(exchangeReviewOptions(line, viewer)).toEqual([
      { kind: 'as_requested', label: 'Approve as requested. Needs order approval permission.', disabled: true },
      { kind: 'change', label: 'Change replacement. Needs order approval permission.', disabled: true },
      { kind: 'decline', label: 'Decline the exchange, return only', disabled: false },
    ]);
    // The review starts on the one choice this viewer can make.
    const start = defaultExchangeReviewState(viewer);
    expect(start).toEqual({ kind: 'decline', reason: '' });
    // Approving or changing the replacement is refused before anything is
    // sent; a decline with its reason goes.
    expect(exchangeReviewProblem(line, { kind: 'as_requested' }, viewer)).toBe(NO_ORDERS);
    expect(exchangeReviewProblem(line, { kind: 'change', itemId: 'l', label: 'L', free: 3, quantity: 1, reason: '' }, viewer)).toBe(NO_ORDERS);
    expect(exchangeReviewProblem(line, start, viewer)).toBe('Reason for declining the exchange (required)');
    expect(exchangeReviewProblem(line, { kind: 'decline', reason: 'No order approval' }, viewer)).toBeNull();
    expect(exchangeReviewDecision(line, { kind: 'decline', reason: 'No order approval' })).toEqual({
      action: 'decline',
      exchangeLineId: 'x1',
      reason: 'No order approval',
    });

    // With order approval nothing changes: every choice, starting as requested.
    expect(availableReturnActions({ ...requested, viewerCanApproveOrders: true }).readOnlyReason).toBeNull();
    expect(exchangeReviewOptions(line, { canApproveOrders: true })).toEqual([
      { kind: 'as_requested', label: 'Approve as requested', disabled: false },
      { kind: 'change', label: 'Change replacement…', disabled: false },
      { kind: 'decline', label: 'Decline the exchange, return only', disabled: false },
    ]);
    expect(defaultExchangeReviewState({ canApproveOrders: true })).toEqual({ kind: 'as_requested' });
    expect(exchangeReviewProblem(line, { kind: 'as_requested' }, { canApproveOrders: true })).toBeNull();
    // A note-only request cannot be approved as requested by anyone.
    expect(exchangeReviewOptions({ ...line, requestedItemId: null }, { canApproveOrders: true })[0]).toEqual({
      kind: 'as_requested',
      label: 'Approve as requested',
      disabled: true,
    });
    // A return without an exchange says nothing about it.
    expect(availableReturnActions({ status: 'requested', viewerCanManageReturns: true, viewerCanApproveOrders: false }).readOnlyReason).toBeNull();
  });

  // RX-3 fix round 1 (desk check M3; RX-2 verify C-4): a note-only request
  // ("warehouse will review", the common case at launch) opened at "Approve as
  // requested", a choice that is off for it, and Approve then answered
  // "Choose the replacement". It opens at Change replacement… with nothing
  // chosen yet, at the quantity coming back; a decline-only viewer still
  // starts at the decline.
  it('a note-only request opens at Change replacement, never at the choice that is off', () => {
    const noteOnly = { requestedItemId: null, requestedQuantity: 2, returnedQuantity: 3 };
    const start = defaultExchangeReviewState({ canApproveOrders: true }, noteOnly);
    expect(start).toEqual({ kind: 'change', itemId: null, label: null, free: null, quantity: 2, reason: '' });
    const options = exchangeReviewOptions(noteOnly, { canApproveOrders: true });
    expect(options.find((o) => o.kind === start.kind)?.disabled).toBe(false);
    expect(exchangeReviewProblem({ id: 'x1', requestedItemId: null, requestNote: 'Needs a bigger one' }, start)).toBe('Choose the replacement');
    // Fewer coming back than asked: the quantity follows what comes back.
    expect(defaultExchangeReviewState({ canApproveOrders: true }, { ...noteOnly, returnedQuantity: 1 })).toMatchObject({ kind: 'change', quantity: 1 });
    // A decline-only viewer starts at the decline, as for any request.
    expect(defaultExchangeReviewState({ canApproveOrders: false }, noteOnly)).toEqual({ kind: 'decline', reason: '' });
    // A request for a size still starts as requested.
    expect(defaultExchangeReviewState({ canApproveOrders: true }, { ...noteOnly, requestedItemId: 'item-l' })).toEqual({ kind: 'as_requested' });
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

  // Desk check F9: after a replacement cancel the exchange can end for good,
  // so even a closed RMA stops inviting a new replacement; without order
  // approval (no new order can be issued) it is the closed RMA's primary.
  it('a cancelled replacement can be closed as return only; without order approval that is the closed RMA\'s primary', () => {
    const base = {
      exchangeStatus: 'replacement_cancelled' as const,
      hasExchange: true,
      replacementClass: 'none' as const,
      hasApprovedExchange: true,
      viewerCanManageReturns: true,
    };
    expect(availableReturnActions({ ...base, status: 'closed', viewerCanApproveOrders: true })).toEqual({
      primary: 'issue_replacement',
      secondary: ['close_as_return_only'],
      readOnlyReason: null,
    });
    expect(availableReturnActions({ ...base, status: 'closed', viewerCanApproveOrders: false })).toEqual({
      primary: 'close_as_return_only',
      secondary: [],
      readOnlyReason: NO_ORDERS_AFTER,
    });
    expect(RETURN_ACTION_LABELS.close_as_return_only).toBe('Close as return only');
    // Once closed as return only the exchange reads declined: nothing more is offered on a closed RMA.
    expect(availableReturnActions({ ...base, status: 'closed', exchangeStatus: 'declined', viewerCanApproveOrders: true })).toEqual({
      primary: null,
      secondary: [],
      readOnlyReason: null,
    });
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

// RX-2 review fix P2: what happens to the replacement, in one set of words for
// the web dialogs and the phone sheets (Cancel return, Cancel replacement,
// Change replacement, Issue a new replacement).
describe('exchangeActionConsequences (web dialogs and phone sheets)', () => {
  const texts = (lines: Array<{ key: string; text: string }>) => lines.map((l) => `${l.key}: ${l.text}`);

  it('Cancel return: the replacement not handed over is cancelled too (named), part handed over, all handed over', () => {
    expect(texts(exchangeActionConsequences('cancel', { replacementStatus: 'approved', replacementOrderNumber: 12, held: 1 }))).toEqual([
      'effect: The return closes as cancelled. Its replacement order SO-000012 is cancelled too and the reserved items are freed.',
    ]);
    expect(
      texts(exchangeActionConsequences('cancel', { replacementStatus: 'backordered', anythingHandedOver: true, replacementOrderNumber: 18 })),
    ).toEqual([
      'effect: The return closes as cancelled. What was already handed over stays handed over; the rest of the replacement is never sent.',
    ]);
    expect(
      texts(exchangeActionConsequences('cancel', { replacementStatus: 'completed', anythingHandedOver: true, replacementOrderNumber: 17 })),
    ).toEqual(['effect: The return closes as cancelled. The replacement was already handed over and stays as it is.']);
    // Nothing reserved (on backorder): nothing is said to be freed.
    expect(texts(exchangeActionConsequences('cancel', { replacementStatus: 'approved', replacementOrderNumber: 16, held: 0 }))).toEqual([
      'effect: The return closes as cancelled. Its replacement order SO-000016 is cancelled too.',
    ]);
    // No live replacement (requested, declined, cancelled): nothing about one.
    expect(exchangeActionConsequences('cancel', { replacementStatus: null })).toEqual([]);
    expect(exchangeActionConsequences('cancel', { replacementStatus: 'cancelled' })).toEqual([]);
    // Picked or on its way: the database refuses the cancel (replacement_in_progress).
    expect(texts(exchangeActionConsequences('cancel', { replacementStatus: 'staged_for_pickup', replacementOrderNumber: 12 }))).toEqual([
      'effect: The replacement is already picked or on its way. Hand it over first. If none of it was handed over yet, you can cancel the replacement instead.',
    ]);
  });

  it('Cancel replacement: freed and the return unchanged; picked first says Staging; in transit asks the driver', () => {
    expect(texts(exchangeActionConsequences('cancel_replacement', { replacementStatus: 'approved', held: 1 }))).toEqual([
      'effect: The replacement order is cancelled and its reserved items are freed. The return itself does not change: afterwards, issue a new replacement or close it as a return only.',
    ]);
    expect(texts(exchangeActionConsequences('cancel_replacement', { replacementStatus: 'staged_for_pickup', held: 0 }))).toEqual([
      'drawn: The picked items go back to Staging on record. Put them in the staging area.',
      'effect: The replacement order is cancelled. The return itself does not change: afterwards, issue a new replacement or close it as a return only.',
    ]);
    expect(texts(exchangeActionConsequences('cancel_replacement', { replacementStatus: 'in_transit' }))).toEqual([
      'drawn: The picked items go back to Staging on record. Put them in the staging area.',
      'in_transit: Ask the driver to bring it back.',
      'effect: The replacement order is cancelled. The return itself does not change: afterwards, issue a new replacement or close it as a return only.',
    ]);
    expect(texts(exchangeActionConsequences('cancel_replacement', { replacementStatus: 'approved', held: 0 }))).toEqual([
      'effect: The replacement order is cancelled. The return itself does not change: afterwards, issue a new replacement or close it as a return only.',
    ]);
  });

  it('Change replacement and Issue a new replacement say what is created', () => {
    expect(texts(exchangeActionConsequences('change_replacement', { replacementStatus: 'approved' }))).toEqual([
      'effect: The current replacement order is cancelled and a new one is created and reserved in the same step.',
    ]);
    expect(texts(exchangeActionConsequences('issue_replacement', { replacementStatus: null }))).toEqual([
      'effect: A new replacement order is created and reserved.',
    ]);
  });

  it('never says the return stays open (the RMA may be closed), whatever the replacement is', () => {
    const statuses = [null, 'approved', 'pick_slip_generated', 'picking_in_progress', 'picking_complete', 'packing_slip_generated',
      'staged_for_pickup', 'staged_for_delivery', 'in_transit', 'backordered', 'completed', 'cancelled', 'denied'];
    for (const action of ['cancel', 'cancel_replacement', 'change_replacement', 'issue_replacement'] as const)
      for (const replacementStatus of statuses)
        for (const anythingHandedOver of [true, false])
          for (const held of [0, 1, null]) {
            const lines = exchangeActionConsequences(action, { replacementStatus, anythingHandedOver, held, replacementOrderNumber: 12 });
            for (const l of lines) expect(l.text, `${action} ${String(replacementStatus)}`).not.toMatch(/stays open/i);
          }
  });
});

// RX-2 fix round 1 (independent verification 2026-10-11).
describe('RX-2 fix round 1: what a viewer without order approval is offered and told', () => {
  it('a decline-only viewer approves the return, never "& exchange" (verification L3)', () => {
    expect(returnActionLabel('approve', { hasExchange: true, canApproveOrders: true })).toBe('Approve return & exchange');
    expect(returnActionLabel('approve', { hasExchange: true, canApproveOrders: false })).toBe('Approve return');
    // An older caller that does not say keeps the exchange words.
    expect(returnActionLabel('approve', { hasExchange: true })).toBe('Approve return & exchange');
  });

  it('after approval the reason says what needs order approval, naming the return cancel when it was dropped (verification L3)', () => {
    const approved = {
      status: 'approved' as const,
      exchangeStatus: 'waiting_for_return' as const,
      hasExchange: true,
      replacementClass: 'undrawn' as const,
      viewerCanManageReturns: true,
      viewerCanApproveOrders: false,
    };
    expect(availableReturnActions({ ...approved, hasApprovedExchange: true })).toEqual({
      primary: 'receive',
      secondary: [],
      readOnlyReason: NO_ORDERS_AFTER_CANCEL,
    });
    expect(availableReturnActions({ ...approved, status: 'received', exchangeStatus: 'ready_to_pick' }).readOnlyReason).toBe(NO_ORDERS_AFTER);
  });

  it('"Hand over" is offered only with order approval; without it the replacement is opened (verification L4)', () => {
    const base = { hasExchange: true, replacementClass: 'drawn' as const, hasApprovedExchange: true, viewerCanManageReturns: true };
    for (const ex of ['ready_for_pickup', 'out_for_delivery'] as const) {
      const closedWith = availableReturnActions({ ...base, status: 'closed', exchangeStatus: ex, viewerCanApproveOrders: true });
      expect(closedWith.primary).toBe('hand_over');
      const closedWithout = availableReturnActions({ ...base, status: 'closed', exchangeStatus: ex, viewerCanApproveOrders: false });
      expect(closedWithout.primary).toBe('open_replacement');
      const approvedWithout = availableReturnActions({ ...base, status: 'approved', exchangeStatus: ex, viewerCanApproveOrders: false });
      expect(approvedWithout.secondary).toContain('open_replacement');
      expect([approvedWithout.primary, ...approvedWithout.secondary]).not.toContain('hand_over');
      const receivedWithout = availableReturnActions({ ...base, status: 'received', exchangeStatus: ex, viewerCanApproveOrders: false });
      expect([receivedWithout.primary, ...receivedWithout.secondary]).not.toContain('hand_over');
    }
  });
});

// RX-2 review fix P17, built in RX-3: the 14-day "still waiting" prompt (plan
// 3.10, D28). Nothing expires; the prompt only names the buttons that end the
// wait, for a viewer who has them.
describe('the still-waiting prompt (review fix P17)', () => {
  const offered = (input: Parameters<typeof availableReturnActions>[0]): ReturnAction[] => {
    const a = availableReturnActions(input);
    return [a.primary, ...a.secondary].filter((x): x is ReturnAction => x !== null);
  };
  const approver = { viewerCanManageReturns: true, viewerCanApproveOrders: true, hasExchange: true, hasApprovedExchange: true };

  it('from 14 days after approval, reserved or not in stock, for a viewer offered Cancel replacement', () => {
    const waiting = offered({ ...approver, status: 'approved', exchangeStatus: 'waiting_for_return', replacementClass: 'undrawn' });
    expect(stillWaitingPrompt({ status: 'approved', exchangeStatus: 'waiting_for_return', waitingDays: 15, offered: waiting, held: 1 })).toBe(
      'Waiting 15 days. Still waiting for the returned item? Cancel replacement frees the reserved items; Cancel return ends the return too.',
    );
    expect(stillWaitingPrompt({ status: 'approved', exchangeStatus: 'waiting_for_return', waitingDays: 14, offered: waiting })).toMatch(
      /^Waiting 14 days\. Still waiting for the returned item\?/,
    );
    const short = offered({ ...approver, status: 'approved', exchangeStatus: 'unavailable', replacementClass: 'undrawn' });
    // Nothing held (not in stock): nothing is said to be freed.
    expect(stillWaitingPrompt({ status: 'approved', exchangeStatus: 'unavailable', waitingDays: 20, offered: short, held: 0 })).toBe(
      'Waiting 20 days. Still waiting for the returned item? Cancel replacement cancels the replacement order; Cancel return ends the return too.',
    );
  });

  // RX-3 fix round 1 (desk check L5): the words name only buttons the viewer
  // is offered. RX-2's fix round 1 changes the offered sets, so Cancel return
  // can be missing beside Cancel replacement.
  it('names Cancel return only when it is offered', () => {
    expect(stillWaitingPrompt({ status: 'approved', exchangeStatus: 'waiting_for_return', waitingDays: 15, offered: ['cancel_replacement'], held: 1 })).toBe(
      'Waiting 15 days. Still waiting for the returned item? Cancel replacement frees the reserved items.',
    );
    expect(stillWaitingPrompt({ status: 'approved', exchangeStatus: 'unavailable', waitingDays: 15, offered: ['cancel_replacement', null], held: 0 })).toBe(
      'Waiting 15 days. Still waiting for the returned item? Cancel replacement cancels the replacement order.',
    );
    expect(
      stillWaitingPrompt({ status: 'approved', exchangeStatus: 'waiting_for_return', waitingDays: 15, offered: ['cancel_replacement', 'cancel'], held: 1 }),
    ).toMatch(/; Cancel return ends the return too\.$/);
  });

  it('not before 14 days, not once the item is in, not for another exchange state, and not for a viewer without the button', () => {
    const waiting = offered({ ...approver, status: 'approved', exchangeStatus: 'waiting_for_return', replacementClass: 'undrawn' });
    expect(stillWaitingPrompt({ status: 'approved', exchangeStatus: 'waiting_for_return', waitingDays: 13, offered: waiting })).toBeNull();
    expect(stillWaitingPrompt({ status: 'approved', exchangeStatus: 'waiting_for_return', waitingDays: null, offered: waiting })).toBeNull();
    expect(stillWaitingPrompt({ status: 'received', exchangeStatus: 'ready_to_pick', waitingDays: 30, offered: waiting })).toBeNull();
    for (const ex of EXCHANGE_STATUSES.filter((s) => s !== 'waiting_for_return' && s !== 'unavailable')) {
      expect(stillWaitingPrompt({ status: 'approved', exchangeStatus: ex, waitingDays: 30, offered: waiting }), ex).toBeNull();
    }
    // Manage returns without order approval: no Cancel replacement, no prompt.
    const noOrders = offered({ ...approver, viewerCanApproveOrders: false, status: 'approved', exchangeStatus: 'waiting_for_return', replacementClass: 'undrawn' });
    expect(noOrders).not.toContain('cancel_replacement');
    expect(stillWaitingPrompt({ status: 'approved', exchangeStatus: 'waiting_for_return', waitingDays: 30, offered: noOrders })).toBeNull();
  });
});

describe('returnWaitingDays: the view rule for a screen holding approvedAt (P17)', () => {
  const approvedAt = '2026-10-01T12:00:00.000Z';
  const at = (iso: string) => Date.parse(iso);
  it('whole days since approval while approved', () => {
    expect(returnWaitingDays('approved', approvedAt, at('2026-10-01T12:00:00.000Z'))).toBe(0);
    expect(returnWaitingDays('approved', approvedAt, at('2026-10-15T11:59:59.000Z'))).toBe(13);
    expect(returnWaitingDays('approved', approvedAt, at('2026-10-15T12:00:00.000Z'))).toBe(14);
  });
  it('null when not approved, or with no readable approval time; never negative', () => {
    expect(returnWaitingDays('received', approvedAt, at('2026-10-20T00:00:00Z'))).toBeNull();
    expect(returnWaitingDays('approved', null)).toBeNull();
    expect(returnWaitingDays('approved', 'not a date')).toBeNull();
    expect(returnWaitingDays('approved', approvedAt, at('2026-09-30T00:00:00Z'))).toBe(0);
  });
});
