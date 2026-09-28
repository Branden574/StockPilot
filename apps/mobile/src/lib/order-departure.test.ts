/**
 * F2-2 (the SO-000100 slice) on the phone: before an order with units nobody
 * picked is staged, sent out for delivery or signed for, the phone says which
 * lines are short, in core's words (describeDepartureRisk, the web page's
 * too). Null at a shortfall of 0, so the common case gains no friction.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  departureConfirmButtons,
  orderDepartureRisk,
  type DepartureOrderLine,
} from './order-departure';

const PENS: DepartureOrderLine = {
  orderRequestLineId: 'line-pens',
  name: 'L4L - Pen Black & Rose Gold',
  requested: 60,
  fulfilled: 0,
  picked: 0,
};
const NOTEBOOKS: DepartureOrderLine = {
  orderRequestLineId: 'line-nb',
  name: 'Notebooks',
  requested: 30,
  fulfilled: 0,
  picked: 30,
};

/** SO-000100 as it left: the notebooks picked, the pens at 0 of 60. */
const SO_000100 = (status: string) => ({ status, lines: [NOTEBOOKS, PENS] });

describe('orderDepartureRisk', () => {
  it('SO-000100 before it went out for delivery: the plan’s sentence, word for word', () => {
    const risk = orderDepartureRisk(SO_000100('staged_for_delivery'), 'in_transit');
    expect(risk).not.toBeNull();
    expect(risk!.title).toBe('Not everything is picked');
    expect(risk!.message).toBe(
      "1 line is short: 0 of 60 L4L - Pen Black & Rose Gold. Once the order is out for delivery its lines can't be changed, and these units will be owed at hand-over.",
    );
    expect(risk!.confirmLabel).toBe('Send it anyway');
    expect(risk!.cancelLabel).toBe('Fix the order');
    expect(risk!.lines.map((l) => l.lineId)).toEqual(['line-pens']);
  });

  it('staging and the signatures have their own go-ahead', () => {
    expect(orderDepartureRisk(SO_000100('packing_slip_generated'), 'stage')!.confirmLabel).toBe(
      'Stage it anyway',
    );
    expect(orderDepartureRisk(SO_000100('staged_for_pickup'), 'signature')!.confirmLabel).toBe(
      'Record signature anyway',
    );
    // Out for delivery the lines are final: "Go back", not "Fix the order".
    const final = orderDepartureRisk(SO_000100('in_transit'), 'signature')!;
    expect(final.confirmLabel).toBe('Record signature anyway');
    expect(final.cancelLabel).toBe('Go back');
  });

  // Mutation caught: confirming on every departure (the common case must
  // gain no friction), or confirming before picking has settled.
  it('is null at a shortfall of 0, and before picking has settled', () => {
    const picked = { ...PENS, picked: 60 };
    expect(
      orderDepartureRisk(
        { status: 'staged_for_delivery', lines: [NOTEBOOKS, picked] },
        'in_transit',
      ),
    ).toBeNull();
    // Handed over counts: 20 handed over + 40 picked owes nothing more.
    expect(
      orderDepartureRisk(
        { status: 'staged_for_pickup', lines: [{ ...PENS, fulfilled: 20, picked: 40 }] },
        'signature',
      ),
    ).toBeNull();
    expect(orderDepartureRisk(SO_000100('picking_in_progress'), 'stage')).toBeNull();
    expect(orderDepartureRisk(SO_000100('completed'), 'signature')).toBeNull();
  });

  it('names what was picked against what is owed (requested less handed over)', () => {
    const risk = orderDepartureRisk(
      { status: 'staged_for_pickup', lines: [{ ...PENS, fulfilled: 10, picked: 20 }] },
      'signature',
    );
    expect(risk!.message).toMatch(/^1 line is short: 20 of 50 L4L - Pen Black & Rose Gold\./);
  });
});

describe('departureConfirmButtons', () => {
  it('going back is the cancel (default) button and hands the first short line to open', () => {
    const risk = orderDepartureRisk(SO_000100('staged_for_delivery'), 'in_transit')!;
    const onFix = vi.fn();
    const onProceed = vi.fn();
    const buttons = departureConfirmButtons(risk, { onFix, onProceed });
    expect(buttons.map((b) => [b.text, b.style ?? 'default'])).toEqual([
      ['Fix the order', 'cancel'],
      ['Send it anyway', 'default'],
    ]);
    buttons[0]!.onPress!();
    expect(onFix).toHaveBeenCalledWith('line-pens');
    expect(onProceed).not.toHaveBeenCalled();
    buttons[1]!.onPress!();
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  it('once the lines are final, going back opens nothing', () => {
    const risk = orderDepartureRisk(SO_000100('in_transit'), 'signature')!;
    const onFix = vi.fn();
    departureConfirmButtons(risk, { onFix, onProceed: vi.fn() })[0]!.onPress!();
    expect(onFix).toHaveBeenCalledWith(null);
  });
});
