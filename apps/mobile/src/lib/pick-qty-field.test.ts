import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PICK_QTY_DIGITS,
  PICK_QTY_FIELD_MIN_WIDTH,
  PICK_QTY_FONT_SIZE,
  PICK_QTY_MAX_FONT_SIZE_MULTIPLIER,
  pickQtyFieldWidthFor,
} from './pick-qty-field';
import { TYPE_CEILING } from './theme';

/**
 * THE DIGITAL PICK'S QUANTITY FIELD AT THE LARGEST TEXT SIZE (F2-2 walk, AX5).
 *
 * The field was a fixed 84pt box whose 16pt text was not capped, so at AX5
 * (about 3.57x, 57pt) "30" showed as "3": two digits need about 68pt of text
 * and the box had 58pt inside its padding. The typed quantity now stops
 * growing at the input ceiling (TYPE_CEILING.input, 24pt), the policy for a
 * TextInput in a bordered box, and the field is at least as wide as three
 * digits at that size. It is also a 44pt target (it was 38pt tall).
 */

// JetBrains Mono advances every glyph 0.6em.
const digitsWidth = (n: number, fontSize: number) => n * 0.6 * fontSize;
// The field's own padding (12 each side) and border (1 each side), and room
// for the caret, as digital-pick.tsx draws it.
const INSIDE = 2 * 12 + 2 * 1 + 2;

describe('the quantity field fits its digits at every text size', () => {
  it('the typed quantity stops growing at the input ceiling (24pt)', () => {
    expect(PICK_QTY_FONT_SIZE * PICK_QTY_MAX_FONT_SIZE_MULTIPLIER).toBe(TYPE_CEILING.input);
    expect(PICK_QTY_MAX_FONT_SIZE_MULTIPLIER).toBeGreaterThan(1); // it still grows, to the ceiling
  });

  it('at the cap, three digits fit inside the field with its padding, border and caret', () => {
    expect(PICK_QTY_DIGITS).toBe(3);
    const atCap = PICK_QTY_FONT_SIZE * PICK_QTY_MAX_FONT_SIZE_MULTIPLIER;
    expect(PICK_QTY_FIELD_MIN_WIDTH).toBeGreaterThanOrEqual(INSIDE + digitsWidth(3, atCap));
    // The walk's failing case: "30" at AX5. Uncapped it needed 68pt of text in
    // 58pt; capped it needs 28.8pt.
    expect(INSIDE + digitsWidth(2, 16 * 3.57)).toBeGreaterThan(84);
    expect(INSIDE + digitsWidth(2, atCap)).toBeLessThanOrEqual(PICK_QTY_FIELD_MIN_WIDTH);
  });

  it('the width is worked out from the digits at the capped size, and never below the 84pt it was', () => {
    expect(pickQtyFieldWidthFor(1)).toBe(84);
    expect(pickQtyFieldWidthFor(3)).toBe(84);
    // More digits than the field is built for still get room.
    expect(pickQtyFieldWidthFor(5)).toBe(Math.ceil(INSIDE + digitsWidth(5, 24)));
    expect(PICK_QTY_FIELD_MIN_WIDTH).toBe(pickQtyFieldWidthFor(PICK_QTY_DIGITS));
  });
});

describe('digital-pick.tsx draws the field with these numbers', () => {
  const src = readFileSync(path.resolve(__dirname, '../components/digital-pick.tsx'), 'utf8');

  // Mutation caught: the cap removed (the text grows past the box again), the
  // fixed 84 width put back, or the 44pt height dropped.
  it('caps the text, sizes the box from it, and is a 44pt target', () => {
    expect(src).toContain('maxFontSizeMultiplier={PICK_QTY_MAX_FONT_SIZE_MULTIPLIER}');
    expect(src).toContain('minWidth: PICK_QTY_FIELD_MIN_WIDTH,');
    expect(src).toContain('minHeight: MIN_TAP,');
    expect(src).toContain('fontSize: PICK_QTY_FONT_SIZE,');
    expect(src).not.toMatch(/\bwidth: 84\b/);
  });

  // At the largest sizes the "of 30" text and Save no longer fit beside the
  // field on a phone: the row wraps instead of pushing Save off the card.
  it('the field row wraps at large text sizes', () => {
    expect(src).toMatch(/flexDirection: 'row',\s+flexWrap: 'wrap',\s+alignItems: 'center',\s+gap: 10,/);
  });
});
