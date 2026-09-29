import {
  PUT_AWAY_NEEDS_TRANSFER_COPY,
  putAwayLineAccessibilityLabel,
  type OrderReadinessResult,
  type Permission,
} from '@stockpilot/core';
import { describe, expect, it } from 'vitest';

import {
  FX_ITEM_A,
  FX_ITEM_B,
  FX_ORDER,
  fxFacts,
  fxItem,
  fxLine,
  fxResult,
} from './__fixtures__/readiness-facts';
import { canPutAwayStock, orderPutAwayView, stagingPutAwayRoute } from './order-put-away';

/**
 * PUT AWAY FROM THE ORDER, ON THE PHONE (F2-3): which lines offer "Put away",
 * what the readiness card offers, who may, and where it goes. Real
 * assessments (core's parser and assessment over the function's answer).
 * Each test names the mutation it catches.
 */

/** Maus I: 6 on a rack and 4 in Staging for 10 asked; Notebooks ready. */
const MAUS_IN_STAGING = fxResult(
  fxFacts({
    lines: [fxLine('line-1', FX_ITEM_A, 10), fxLine('line-2', FX_ITEM_B, 5)],
    items: [
      fxItem(FX_ITEM_A, { here: { rack: 6, site: 0, unplaced: 0, staging: 4 } }),
      fxItem(FX_ITEM_B),
    ],
  }),
);

function lineOf(result: OrderReadinessResult, lineId: string) {
  if (result.state !== 'ok' || result.assessment.phase !== 'to_pick') throw new Error('not to_pick');
  return result.assessment.lines.find((l) => l.lineId === lineId)!;
}

describe('canPutAwayStock (the gate Place asserts: stock:transfer)', () => {
  it('by the role default while the effective set loads', () => {
    expect(canPutAwayStock('staff', undefined)).toBe(true);
    expect(canPutAwayStock('viewer', undefined)).toBe(false);
  });

  it('by the effective set once it has loaded: overrides apply, and no manager shortcut (the server has none)', () => {
    // Mutation caught: a manager bypass the staging route does not make
    // (canPlace = can(ctx, 'stock:transfer')), offering a list whose Place
    // is then missing.
    expect(canPutAwayStock('manager', new Set<Permission>(['orders:approve']))).toBe(false);
    expect(canPutAwayStock('viewer', new Set<Permission>(['stock:transfer']))).toBe(true);
  });

  it('no role, or one this build does not know: no', () => {
    expect(canPutAwayStock(null, undefined)).toBe(false);
    expect(canPutAwayStock('', undefined)).toBe(false);
    expect(canPutAwayStock('robot', undefined)).toBe(false);
  });
});

describe('orderPutAwayView', () => {
  it('the line with units in Staging offers "Put away" (its item only); the card offers "Put away 1 item"', () => {
    const view = orderPutAwayView({ readiness: MAUS_IN_STAGING, fullPanel: true, canTransfer: true });
    expect(view.lines.get('line-1')).toEqual({ kind: 'link', label: 'Put away', itemIds: [FX_ITEM_A] });
    expect(view.lines.has('line-2')).toBe(false);
    expect(view.strip).toEqual({ kind: 'link', label: 'Put away 1 item', itemIds: [FX_ITEM_A] });
    expect(putAwayLineAccessibilityLabel(lineOf(MAUS_IN_STAGING, 'line-1'))).toBe(
      'Put away 4 of Maus I from Staging',
    );
  });

  it('a SHORT line with units in Staging still offers them (the state is the worst bucket; the sentence names them)', () => {
    // Mutation caught: offering only lines in the needs_put_away state.
    const short = fxResult(
      fxFacts({
        lines: [fxLine('line-1', FX_ITEM_A, 20)],
        items: [
          fxItem(FX_ITEM_A, { onHand: 14, here: { rack: 10, site: 0, unplaced: 0, staging: 4 } }),
        ],
      }),
    );
    expect(lineOf(short, 'line-1').state).toBe('short');
    const view = orderPutAwayView({ readiness: short, fullPanel: true, canTransfer: true });
    expect(view.lines.get('line-1')?.kind).toBe('link');
    expect(view.strip).toMatchObject({ kind: 'link', itemIds: [FX_ITEM_A] });
  });

  it('two lines of one item count the item once on the card', () => {
    // Mutation caught: counting lines instead of items ("Put away 2 items"
    // for one item, and the item twice in the link).
    const dup = fxResult(
      fxFacts({
        lines: [fxLine('line-1', FX_ITEM_A, 3), fxLine('line-2', FX_ITEM_A, 7)],
        items: [fxItem(FX_ITEM_A, { here: { rack: 0, site: 0, unplaced: 0, staging: 10 } })],
      }),
    );
    const view = orderPutAwayView({ readiness: dup, fullPanel: true, canTransfer: true });
    expect(view.strip).toEqual({ kind: 'link', label: 'Put away 1 item', itemIds: [FX_ITEM_A] });
    expect([...view.lines.keys()]).toEqual(['line-1', 'line-2']);
  });

  it('without stock:transfer: core’s sentence once, on the card; no line offers a link (the web page’s layout)', () => {
    // Mutation caught: dropping the gate (a link to a list whose Place is
    // missing).
    const view = orderPutAwayView({ readiness: MAUS_IN_STAGING, fullPanel: true, canTransfer: false });
    expect(view.strip).toEqual({ kind: 'needs_permission', message: PUT_AWAY_NEEDS_TRANSFER_COPY });
    expect(view.lines.size).toBe(0);
    expect(PUT_AWAY_NEEDS_TRANSFER_COPY).toBe('Putting stock away needs the Transfer stock permission.');
  });

  it('nothing in Staging: nothing offered', () => {
    const ready = fxResult(
      fxFacts({ lines: [fxLine('line-1', FX_ITEM_A, 5)], items: [fxItem(FX_ITEM_A)] }),
    );
    const view = orderPutAwayView({ readiness: ready, fullPanel: true, canTransfer: true });
    expect(view.strip).toEqual({ kind: 'none' });
    expect(view.lines.size).toBe(0);
  });

  it('the requester’s sentence, a failed or missing check, a capped order, or a picked order: nothing', () => {
    const none = { strip: { kind: 'none' }, lines: new Map() };
    expect(orderPutAwayView({ readiness: MAUS_IN_STAGING, fullPanel: false, canTransfer: true })).toEqual(none);
    expect(
      orderPutAwayView({ readiness: { state: 'failed', message: 'x' }, fullPanel: true, canTransfer: true }),
    ).toEqual(none);
    expect(orderPutAwayView({ readiness: null, fullPanel: true, canTransfer: true })).toEqual(none);
    const capped = fxResult(fxFacts({ linesCapped: true, lines: [], items: [] }));
    expect(orderPutAwayView({ readiness: capped, fullPanel: true, canTransfer: true })).toEqual(none);
    const picked = fxResult(
      fxFacts({
        status: 'picking_complete',
        phase: 'picked',
        lines: [fxLine('line-1', FX_ITEM_A, 10, { picked: 6 })],
        items: [],
      }),
    );
    expect(orderPutAwayView({ readiness: picked, fullPanel: true, canTransfer: true })).toEqual(none);
  });
});

describe('stagingPutAwayRoute', () => {
  it('the Staging tab, with core’s params (a comma list and the order)', () => {
    expect(stagingPutAwayRoute(FX_ORDER, [FX_ITEM_A, FX_ITEM_B])).toEqual({
      pathname: '/staging',
      params: { itemIds: `${FX_ITEM_A},${FX_ITEM_B}`, orderId: FX_ORDER },
    });
  });
});
