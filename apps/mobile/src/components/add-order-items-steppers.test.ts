import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { addItemsStepperLabel } from './add-order-items';

/**
 * THE ADD-ITEMS SHEET'S QUANTITY STEPPERS (F2-2 walk, O5).
 *
 * Every row's - and + read "Decrease quantity" / "Increase quantity", so a
 * VoiceOver user moving through the list heard the same two words for every
 * item, and each was a 32x32 button (a 6pt hitSlop widened the touch but not
 * the element VoiceOver outlines). Each stepper now names its item and is a
 * 44pt frame around the same 32pt box.
 */

describe('addItemsStepperLabel: the stepper names its item', () => {
  it('says which way and which item', () => {
    expect(addItemsStepperLabel(1, 'L4L - Pen Black & Rose Gold')).toBe(
      'Increase quantity of L4L - Pen Black & Rose Gold',
    );
    expect(addItemsStepperLabel(-1, 'Hold Base Item')).toBe('Decrease quantity of Hold Base Item');
  });

  it('an item with no usable name still says what the button does', () => {
    expect(addItemsStepperLabel(1, '   ')).toBe('Increase quantity');
    expect(addItemsStepperLabel(-1, '')).toBe('Decrease quantity');
  });
});

describe('add-order-items-sheet.tsx: the steppers', () => {
  const src = readFileSync(path.resolve(__dirname, './add-order-items-sheet.tsx'), 'utf8');
  const stepBtn = src.slice(src.indexOf('const stepBtn = ('), src.indexOf('return (\n    <Modal'));

  // Mutation caught: the generic label put back, or the row's name not passed.
  it('each stepper is labelled with its row name', () => {
    expect(stepBtn).toContain('accessibilityLabel={addItemsStepperLabel(delta, name)}');
    expect(src).toContain("{stepBtn('−', row.id, row.name, -1, qty <= 0 || submitting)}");
    expect(src).toContain("{stepBtn('+', row.id, row.name, 1, submitting)}");
    expect(src).not.toMatch(/'Increase quantity'|'Decrease quantity'/);
  });

  // Mutation caught: the 44pt frame shrunk back to the 32pt box, or hitSlop
  // back in place of the frame.
  it('each stepper is a 44pt frame around the 32pt box, with no hitSlop', () => {
    expect(stepBtn).toMatch(/width: MIN_TAP,\s+height: MIN_TAP,/);
    expect(stepBtn).toMatch(/width: 32,\s+height: 32,/);
    expect(stepBtn).not.toContain('hitSlop');
  });

  // The frames are 6pt wider than the box on every side; the group gives the
  // 6pt back (gap 8 -> 2, margin -6) so the boxes, the count and the row's
  // height stay where they were.
  it('the stepper group takes the frames back so nothing moves', () => {
    expect(src).toContain(
      "<View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, margin: -6 }}>",
    );
  });
});
