import * as path from 'node:path';

import { ALLOWED_TRANSITIONS } from '@stockpilot/core';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { parseTsx, readSource } from './__fixtures__/jsx-touch-audit';
import { screenFunction, stateInitializer } from './__fixtures__/screen-functions';
import { orderManagerActions, type OrderManagerActionsInput } from './order-manager-actions';
import { keepReasonDialogOpen } from './order-reason-dialog';

/**
 * After a failed Deny or Reopen picking, the order screen's reason dialog
 * closes when the order no longer offers that action (docket B60).
 *
 * THE DEFECT (simulator walk 5, 2026-10-31). Two phones on one pending order:
 * phone A approved it; phone B, still showing it pending, typed a reason and
 * tapped Deny. "Could not update order / Request not found or no longer
 * pending approval." After OK the Deny dialog was still up, with the typed
 * reason, the keyboard and a Deny the server would refuse again. Only after
 * Cancel did the screen show the order as APPROVED: since B10, runAction reads
 * the order again after a refusal, but the dialog never looked at it.
 */

const SCREEN = 'app/order/[id].tsx';

describe('keepReasonDialogOpen', () => {
  it('a success closes the dialog, whatever the order offers now', () => {
    expect(keepReasonDialogOpen(true, true)).toBe(false);
    expect(keepReasonDialogOpen(true, false)).toBe(false);
  });

  it('a failure keeps the typed reason while the order still offers the action', () => {
    // No answer (a timeout: nothing was read again, so the order as shown
    // still offers it), or a refusal that left the order where it was.
    expect(keepReasonDialogOpen(false, true)).toBe(true);
  });

  it('a failure closes the dialog once the order no longer offers the action', () => {
    expect(keepReasonDialogOpen(false, false)).toBe(false);
  });
});

/**
 * The check reads `managerActions.deny` and `managerActions.reopenPicking`.
 * Each button sits deeper: Deny inside the section and the Approve block,
 * Reopen picking inside the section at one of two statuses. Each gate implies
 * every condition around its button, for every status and viewer, so the
 * check closes a dialog exactly when the screen behind it stops showing the
 * button.
 */
describe('the gates the check reads are the conditions that show the buttons', () => {
  const statuses = Object.keys(ALLOWED_TRANSITIONS);
  const viewers: Partial<OrderManagerActionsInput>[] = [
    { canApproveOrders: true, canAssignDelivery: true, isManagerByRole: true },
    { canApproveOrders: true },
    { canApproveOrders: true, isViewerRole: true },
    { canApproveOrders: false, isManagerByRole: true },
    { isAssignedDriver: true, hasAssignedDriver: true },
  ];

  it('Deny is offered only where the section and Approve show; Reopen picking only in the section at its two statuses', () => {
    expect(statuses).toContain('pending_approval');
    let denied = 0;
    let reopened = 0;
    for (const status of statuses) {
      for (const viewer of viewers) {
        for (const machineOffersReopen of [true, false]) {
          for (const fulfillmentType of ['pickup', 'delivery']) {
            const a = orderManagerActions({
              status,
              fulfillmentType,
              canApproveOrders: false,
              canAssignDelivery: false,
              isManagerByRole: false,
              isAssignedDriver: false,
              hasAssignedDriver: false,
              isViewerRole: false,
              machineOffersReopen,
              ...viewer,
            });
            const where = `${status} ${JSON.stringify(viewer)} reopen:${machineOffersReopen}`;
            if (a.deny) {
              denied += 1;
              expect(a.showSection && a.approve, where).toBe(true);
            }
            if (a.reopenPicking) {
              reopened += 1;
              expect(a.showSection, where).toBe(true);
              expect(['picking_complete', 'packing_slip_generated'], where).toContain(status);
            }
          }
        }
      }
    }
    // The grid reaches both gates.
    expect(denied).toBeGreaterThan(0);
    expect(reopened).toBeGreaterThan(0);
  });
});

describe("the order screen's reason dialogs after a failure", () => {
  /** What each handler does, in order. */
  function recorder() {
    const log: unknown[][] = [];
    return { log, set: (name: string) => (value: unknown) => log.push([name, value]) };
  }

  function submitDeny(answer: boolean) {
    const r = recorder();
    const act = vi.fn(async (body: unknown) => {
      r.log.push(['act', body]);
      return answer;
    });
    const run = screenFunction<() => Promise<void>>(SCREEN, 'submitDeny', {
      acting: null,
      denyReason: '  Duplicate of another request.  ',
      Alert: { alert: vi.fn() },
      act,
      setDenyOpen: r.set('open'),
      setDenyReason: r.set('reason'),
      setFailedReasonDialog: r.set('check'),
    });
    return { run, act, ...r };
  }

  function reopenPicking(answer: boolean) {
    const r = recorder();
    const act = vi.fn(async (body: unknown) => {
      r.log.push(['act', body]);
      return answer;
    });
    const run = screenFunction<() => Promise<void>>(SCREEN, 'reopenPicking', {
      acting: null,
      reopenReason: 'Two units were short on the shelf.',
      Alert: { alert: vi.fn() },
      act,
      setReopenOpen: r.set('open'),
      setReopenReason: r.set('reason'),
      setFailedReasonDialog: r.set('check'),
    });
    return { run, act, ...r };
  }

  /** The check, run with the screen's own dismiss functions. */
  function settle(gates: { deny: boolean; reopenPicking: boolean }) {
    const r = recorder();
    const run = screenFunction<(dialog: 'deny' | 'reopen') => void>(
      SCREEN,
      'settleFailedReasonDialog',
      {
        managerActions: gates,
        keepReasonDialogOpen,
        setFailedReasonDialog: r.set('check'),
        dismissDenyModal: screenFunction(SCREEN, 'dismissDenyModal', {
          setDenyOpen: r.set('deny open'),
          setDenyReason: r.set('deny reason'),
        }),
        dismissReopenModal: screenFunction(SCREEN, 'dismissReopenModal', {
          setReopenOpen: r.set('reopen open'),
          setReopenReason: r.set('reopen reason'),
        }),
      },
    );
    return { run, ...r };
  }

  it('starts with no dialog to check', () => {
    expect(stateInitializer(SCREEN, 'failedReasonDialog', {})).toBeNull();
  });

  // Mutation caught: the dialog left as it was after a failure (the defect),
  // or closed before the order is read again.
  it('a failed Deny keeps the dialog and its reason, and asks for the check once the action is over', async () => {
    const { run, act, log } = submitDeny(false);
    await run();
    expect(act).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      ['act', { action: 'deny', reason: 'Duplicate of another request.' }],
      ['check', 'deny'],
    ]);
  });

  it('a failed Reopen picking does the same', async () => {
    const { run, act, log } = reopenPicking(false);
    await run();
    expect(act).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      ['act', { action: 'reopen_picking', reason: 'Two units were short on the shelf.' }],
      ['check', 'reopen'],
    ]);
  });

  it('a Deny or Reopen picking that goes through still closes its dialog and clears the reason at once', async () => {
    for (const { run, log } of [submitDeny(true), reopenPicking(true)]) {
      await run();
      expect(log.slice(1)).toEqual([
        ['open', false],
        ['reason', ''],
      ]);
    }
  });

  // Mutation caught: the check reading another gate, or never closing.
  it('the check closes the Deny dialog and clears its reason when the order no longer offers Deny', () => {
    const { run, log } = settle({ deny: false, reopenPicking: true });
    run('deny');
    expect(log).toEqual([
      ['check', null],
      ['deny open', false],
      ['deny reason', ''],
    ]);
  });

  it('the check closes the Reopen picking dialog and clears its reason when the order no longer offers it', () => {
    const { run, log } = settle({ deny: true, reopenPicking: false });
    run('reopen');
    expect(log).toEqual([
      ['check', null],
      ['reopen open', false],
      ['reopen reason', ''],
    ]);
  });

  // Mutation caught: the check closing on any failure (a timeout would lose
  // the typed reason), or reading the other dialog's gate.
  it('the check keeps each dialog, with its reason, while the order still offers its action', () => {
    const deny = settle({ deny: true, reopenPicking: false });
    deny.run('deny');
    expect(deny.log).toEqual([['check', null]]);
    const reopen = settle({ deny: false, reopenPicking: true });
    reopen.run('reopen');
    expect(reopen.log).toEqual([['check', null]]);
  });

  // The check needs the order runAction left on screen (read again after a
  // refusal), which exists only in the render after the failure: an effect
  // runs it then. The check clears its own request, so it runs once.
  it('an effect runs the check in the render after the failure, once', () => {
    const sf = parseTsx(readSource(path.resolve(__dirname, '../..', SCREEN)), SCREEN);
    const effects: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        n.expression.getText(sf) === 'React.useEffect' &&
        n.getText(sf).includes('failedReasonDialog')
      ) {
        effects.push(
          n
            .getText(sf)
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/\s+/g, ' '),
        );
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(effects).toEqual([
      'React.useEffect(() => { if (failedReasonDialog !== null) settleFailedReasonDialog(failedReasonDialog); })',
    ]);
  });
});
