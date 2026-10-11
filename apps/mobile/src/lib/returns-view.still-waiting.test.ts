import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MobileReplacement, MobileReturnExchange, MobileReturnWorkbench } from './returns-api';
import { NO_EXCHANGE, workbenchActionHint, workbenchActions, workbenchStillWaiting } from './returns-view';

/**
 * RX-2 review fix P17, built in RX-3: the workbench's 14-day prompt on the
 * phone and the iPad (plan 3.10, D28). From 14 whole days after approval,
 * while the returned item is still out and the replacement waits for it, a
 * viewer offered Cancel replacement reads core's words under the next-step
 * bar, naming the two buttons that end the wait. Nothing expires.
 */

const APPROVED_AT = '2026-10-01T12:00:00.000Z';
const at = (iso: string) => Date.parse(iso);
const DAY_15 = at('2026-10-16T12:00:00.000Z');

function replacement(held: number): MobileReplacement {
  return { orderId: 'rep', orderNumber: 104, status: 'approved', fulfillmentType: 'pickup', live: true, class: 'undrawn', owed: 1, held, short: held < 1, lines: [] };
}

function workbench(
  status: string,
  ex: Partial<MobileReturnExchange>,
  viewer = { canManageReturns: true, canApproveOrders: true, canReadDecisions: true },
): MobileReturnWorkbench {
  return {
    return: { id: 'r1', status, approvedAt: APPROVED_AT },
    viewer,
    lines: [],
    createdOnCounter: false,
    exchange: { ...NO_EXCHANGE, kind: 'exchange', hasApprovedExchange: true, ...ex },
  } as unknown as MobileReturnWorkbench;
}

function prompt(wb: MobileReturnWorkbench, now = DAY_15): string | null {
  return workbenchStillWaiting(wb, workbenchActions(wb, { itemIsHere: false, online: true, busy: false }), now);
}

describe("the workbench's 14-day prompt (P17)", () => {
  it('waiting for the returned item with the replacement reserved: the two buttons that end the wait', () => {
    const wb = workbench('approved', { status: 'waiting_for_return', replacement: replacement(1) });
    expect(prompt(wb)).toBe(
      'Waiting 15 days. Still waiting for the returned item? Cancel replacement frees the reserved items; Cancel return ends the return too.',
    );
    // Day 14 is the first day it shows.
    expect(prompt(wb, at('2026-10-15T12:00:00.000Z'))).toMatch(/^Waiting 14 days\. /);
    expect(prompt(wb, at('2026-10-15T11:59:59.000Z'))).toBeNull();
  });

  it('a replacement not in stock holds nothing, so nothing is said to be freed', () => {
    const wb = workbench('approved', { status: 'unavailable', replacement: replacement(0) });
    expect(prompt(wb)).toBe(
      'Waiting 15 days. Still waiting for the returned item? Cancel replacement cancels the replacement order; Cancel return ends the return too.',
    );
  });

  it('not once the item is in, not for a return only, and not for a viewer without Cancel replacement', () => {
    expect(prompt(workbench('received', { status: 'ready_to_pick', replacement: replacement(1) }))).toBeNull();
    expect(prompt(workbench('approved', { ...NO_EXCHANGE }))).toBeNull();
    expect(prompt(workbench('approved', { status: 'ready_to_pick', replacement: replacement(1), releasedEarly: true }))).toBeNull();
    // Manage returns without order approval: no Cancel replacement, no prompt.
    const noOrders = workbench(
      'approved',
      { status: 'waiting_for_return', replacement: replacement(1) },
      { canManageReturns: true, canApproveOrders: false, canReadDecisions: true },
    );
    expect(prompt(noOrders)).toBeNull();
  });

  it('with no readable approval time there is no age, so no prompt', () => {
    const wb = workbench('approved', { status: 'waiting_for_return', replacement: replacement(1) });
    const noTime = { ...wb, return: { ...wb.return, approvedAt: null } };
    expect(prompt(noTime as MobileReturnWorkbench)).toBeNull();
  });

  it('the workbench shows it under the next-step bar, from this helper and the actions it draws', () => {
    const view = readFileSync(path.resolve(__dirname, '../components/return-workbench-view.tsx'), 'utf8');
    const code = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toContain('const stillWaiting = workbenchStillWaiting(wb, actions);');
    // Inside the next-step bar's card: after its buttons, before the disabled reason.
    const bar = code.slice(code.indexOf('{actions.primary ? ('), code.indexOf('{actions.disabledReason ? ('));
    expect(bar).toContain('{stillWaiting ? (');
  });
});

// RX-3 fix round 1 (desk check L3): the web ties the prompt to Cancel
// replacement and Cancel return (aria-describedby); the phone showed it as
// text only. It is now the VoiceOver hint of both buttons, after any reason
// the button is off and its own help.
describe("the prompt is the cancel buttons' VoiceOver hint (P17, L3)", () => {
  const WAITING = 'Waiting 15 days. Still waiting for the returned item? Cancel replacement frees the reserved items.';
  it('Cancel replacement and Cancel return carry it; other buttons do not', () => {
    expect(workbenchActionHint('cancel_replacement', { disabledReason: null, stillWaiting: WAITING })).toBe(WAITING);
    expect(workbenchActionHint('cancel', { disabledReason: null, stillWaiting: WAITING })).toBe(WAITING);
    expect(workbenchActionHint('receive', { disabledReason: null, stillWaiting: WAITING })).toBeUndefined();
    expect(workbenchActionHint('cancel', { disabledReason: null, stillWaiting: null })).toBeUndefined();
  });

  it('why a button is off comes first', () => {
    expect(workbenchActionHint('cancel', { disabledReason: 'Needs a connection.', stillWaiting: WAITING })).toBe('Needs a connection.');
  });

  it('the screen uses it for the primary and every secondary button', () => {
    const src = readFileSync(path.resolve(__dirname, '../components/return-workbench-view.tsx'), 'utf8');
    expect(src).toContain('accessibilityHint={workbenchActionHint(actions.primary, { disabledReason: actions.disabledReason, stillWaiting })}');
    expect(src).toContain('accessibilityHint={workbenchActionHint(a, { disabledReason: actions.disabledReason, stillWaiting })}');
  });
});
