/**
 * F2-2 (the SO-000100 slice) on the phone: the digital pick's Complete asks
 * first, in core's words, whenever a line comes up short, the pick would fail,
 * or stock could not be checked. The decision is core's
 * digitalPickCompletionConfirm (the web digital pick's too); these pin it as
 * the phone uses it, with the phone's Alert message and buttons. What must
 * hold:
 *   • SO-000100 (the pens at 0 of 60) names the pens line;
 *   • the projection is over what the picker ENTERED, never the facts' own
 *     picked numbers (a NULL there would read as core's one-click pick);
 *   • a pick that would fail on Staging stock says so;
 *   • a failed, missing or out-of-date check never skips the confirm;
 *   • nothing to say: no confirm, picking completes at once.
 */
import {
  assessOrderReadiness,
  COMPLETION_CONFIRM_LABEL,
  COMPLETION_CONFIRM_TITLE,
  COMPLETION_REVIEW_LABEL,
  digitalPickCompletionConfirm,
  parseOrderReadinessFacts,
  type OrderReadinessResult,
  type PickCompletionLine,
} from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import { completionConfirmButtons, completionConfirmMessage } from './pick-completion';

const ORDER = '0a000000-0000-0000-0000-00000000f2a1';
const WH = '0a000000-0000-0000-0000-0000000000a1';
const PENS = '0a000000-0000-0000-0000-0000000000e1';
const NOTEBOOKS = '0a000000-0000-0000-0000-0000000000e2';
const PEN_NAME = 'L4L - Pen Black & Rose Gold';

function item(itemId: string, over: Record<string, unknown> = {}) {
  return {
    itemId,
    visible: true,
    name: itemId === PENS ? PEN_NAME : 'Notebooks',
    sku: null,
    supplierId: null,
    itemWarehouseId: WH,
    deleted: false,
    archived: false,
    isBundle: false,
    onHand: 30,
    heldOwn: 30,
    heldOtherOrders: 0,
    heldRentals: 0,
    here: { rack: 30, site: 0, unplaced: 0, staging: 0 },
    elsewhere: { pickable: 0, staging: 0 },
    stagingSources: [],
    stagingHiddenQty: 0,
    pendingOthers: null,
    committedOtherShortfall: 0,
    inbound: null,
    drafts: null,
    ...over,
  };
}

/** SO-000100 at picking: 60 pens (written off to 0) and 30 notebooks. */
function readiness(
  over: { items?: unknown[]; lines?: unknown[]; linesCapped?: boolean } = {},
): OrderReadinessResult {
  const facts = parseOrderReadinessFacts({
    v: 1,
    observedAt: '2026-09-22T18:46:30Z',
    phase: 'to_pick',
    linesCapped: over.linesCapped ?? false,
    order: {
      id: ORDER,
      orderNumber: 100,
      status: 'picking_in_progress',
      warehouseId: WH,
      neededBy: null,
      fulfillmentType: 'delivery',
    },
    lines: over.lines ?? [
      {
        lineId: 'line-nb',
        itemId: NOTEBOOKS,
        requested: 30,
        fulfilled: 0,
        picked: null,
        createdAt: '2026-09-21T23:05:00Z',
      },
      {
        lineId: 'line-pens',
        itemId: PENS,
        requested: 60,
        fulfilled: 0,
        picked: null,
        createdAt: '2026-09-21T23:05:01Z',
      },
    ],
    items: over.items ?? [
      item(NOTEBOOKS),
      item(PENS, { onHand: 0, heldOwn: 0, here: { rack: 0, site: 0, unplaced: 0, staging: 0 } }),
    ],
  });
  return {
    state: 'ok',
    assessment: assessOrderReadiness(facts, { now: new Date('2026-09-22T18:47:00Z') }),
  };
}

const entered = (nb: number, pens: number): PickCompletionLine[] => [
  { id: 'line-nb', itemName: 'Notebooks', owed: 30, picking: nb },
  { id: 'line-pens', itemName: PEN_NAME, owed: 60, picking: pens },
];

const SO_000100_SENTENCE = `Not everything will be picked. ${PEN_NAME}: 0 of 60. It will be owed at hand-over, or you can remove it from the order first.`;
const NOT_CHECKED = "Stock couldn't be checked. Picking may come up short.";

describe('digitalPickCompletionConfirm', () => {
  it('SO-000100: the pens line is named, with core’s title and buttons', () => {
    const confirm = digitalPickCompletionConfirm(entered(30, 0), readiness());
    expect(confirm).toEqual({
      title: COMPLETION_CONFIRM_TITLE,
      paragraphs: [SO_000100_SENTENCE],
      reviewLabel: COMPLETION_REVIEW_LABEL,
      confirmLabel: COMPLETION_CONFIRM_LABEL,
      focusLineId: 'line-pens',
    });
    expect(COMPLETION_CONFIRM_TITLE).toBe('Before you complete picking');
    expect(COMPLETION_REVIEW_LABEL).toBe('Review short lines');
    expect(COMPLETION_CONFIRM_LABEL).toBe('Complete picking');
  });

  // Mutation caught: projecting the facts as they are. Their picked numbers
  // are NULL (nothing saved yet), which core reads as the one-click pick
  // (each line takes what is available), so the typed 0 would never show.
  it('projects what the picker entered, not the facts’ own picked numbers', () => {
    const plenty = readiness({
      items: [
        item(NOTEBOOKS),
        item(PENS, {
          onHand: 60,
          heldOwn: 60,
          here: { rack: 60, site: 0, unplaced: 0, staging: 0 },
        }),
      ],
    });
    const confirm = digitalPickCompletionConfirm(entered(30, 0), plenty);
    expect(confirm?.paragraphs).toEqual([SO_000100_SENTENCE]);
    // Entered in full: nothing to say, picking completes at once.
    expect(digitalPickCompletionConfirm(entered(30, 60), plenty)).toBeNull();
  });

  it('says when the pick would fail on stock that is still in Staging', () => {
    const staged = readiness({
      lines: [
        {
          lineId: 'line-nb',
          itemId: NOTEBOOKS,
          requested: 10,
          fulfilled: 0,
          picked: null,
          createdAt: '2026-09-21T23:05:00Z',
        },
      ],
      items: [
        item(NOTEBOOKS, {
          onHand: 10,
          heldOwn: 10,
          here: { rack: 6, site: 0, unplaced: 0, staging: 4 },
        }),
      ],
    });
    const confirm = digitalPickCompletionConfirm(
      [{ id: 'line-nb', itemName: 'Notebooks', owed: 10, picking: 10 }],
      staged,
    );
    expect(confirm?.paragraphs).toEqual([
      "Picking can't finish until 4 of Notebooks in Staging are put away.",
    ]);
    expect(confirm?.focusLineId).toBe('line-nb');
  });

  // Mutation caught: skipping the confirm when the check failed.
  it('a failed check never skips the confirm, and still names what was entered short', () => {
    const failed: OrderReadinessResult = { state: 'failed', message: "Couldn't check readiness." };
    expect(digitalPickCompletionConfirm(entered(30, 60), failed)).toEqual({
      title: COMPLETION_CONFIRM_TITLE,
      paragraphs: [NOT_CHECKED],
      reviewLabel: COMPLETION_REVIEW_LABEL,
      confirmLabel: COMPLETION_CONFIRM_LABEL,
      focusLineId: null,
    });
    const short = digitalPickCompletionConfirm(entered(30, 0), failed);
    expect(short?.paragraphs).toEqual([SO_000100_SENTENCE, NOT_CHECKED]);
    expect(short?.focusLineId).toBe('line-pens');
  });

  it('a check that was not read is treated the same way', () => {
    expect(digitalPickCompletionConfirm(entered(30, 60), null)?.paragraphs).toEqual([NOT_CHECKED]);
    expect(digitalPickCompletionConfirm(entered(30, 60), undefined)?.paragraphs).toEqual([
      NOT_CHECKED,
    ]);
  });

  // Mutation caught: projecting against a check made before a line was added
  // or removed (the added line would be missing from the projection).
  it('a check about another set of lines (one added or removed since) is not trusted', () => {
    const three = [
      ...entered(30, 60),
      { id: 'line-new', itemName: 'Erasers', owed: 5, picking: 5 },
    ];
    expect(digitalPickCompletionConfirm(three, readiness())?.paragraphs).toEqual([NOT_CHECKED]);
    expect(
      digitalPickCompletionConfirm(entered(30, 60).slice(0, 1), readiness())?.paragraphs,
    ).toEqual([NOT_CHECKED]);
  });

  it('an order with too many lines to check says so, with what was entered short', () => {
    const capped = readiness({ linesCapped: true, lines: [], items: [] });
    const confirm = digitalPickCompletionConfirm(entered(30, 0), capped);
    expect(confirm?.paragraphs[0]).toBe(SO_000100_SENTENCE);
    expect(confirm?.paragraphs.slice(1)).toEqual([
      "This order has more than 200 lines, so readiness isn't checked.",
      'Picking may come up short.',
    ]);
    expect(confirm?.focusLineId).toBe('line-pens');
  });

  it('an item the picker cannot read is named as unchecked', () => {
    const hidden = readiness({
      items: [item(NOTEBOOKS), { itemId: PENS, visible: false }],
    });
    const confirm = digitalPickCompletionConfirm(entered(30, 60), hidden);
    expect(confirm?.paragraphs).toEqual([
      "Stock couldn't be checked for 1 item. Picking may come up short.",
    ]);
  });
});

describe('the confirm’s message and buttons', () => {
  it('each paragraph on its own; Review is the cancel (default) button and hands the line over', () => {
    const confirm = digitalPickCompletionConfirm(entered(30, 0), {
      state: 'failed',
      message: 'x',
    })!;
    expect(completionConfirmMessage(confirm)).toBe(`${SO_000100_SENTENCE}\n\n${NOT_CHECKED}`);
    const onReview = vi.fn();
    const onComplete = vi.fn();
    const buttons = completionConfirmButtons(confirm, { onReview, onComplete });
    expect(buttons.map((b) => [b.text, b.style ?? 'default'])).toEqual([
      ['Review short lines', 'cancel'],
      ['Complete picking', 'default'],
    ]);
    buttons[0]!.onPress!();
    expect(onReview).toHaveBeenCalledWith('line-pens');
    expect(onComplete).not.toHaveBeenCalled();
    buttons[1]!.onPress!();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
