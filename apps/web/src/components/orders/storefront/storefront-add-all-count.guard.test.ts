import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The number in the cart shows in full beside "Add all".
 *
 * With "Add all" beside it the stepper is narrow: about 133 px in a list row
 * (a 210 px cell) and from 128 px on a grid card. Two buttons, the border and
 * the IN CART label left 18 px for the count in every list row and 15 to 25 px
 * on cards 224 to 263 px wide, so 100 drew as "10" and 10000 as "10"; at 520 px
 * wide, with 44 px buttons, a card showed no count at all (measured in
 * Chromium with the app's fonts, 2026-11-10). The label is what goes: the
 * stepper beside "Add all" shows the count alone, as the list row already did
 * at 639.98 px and under for the same reason.
 *
 * The room is worked out here from the stylesheet's own numbers. A digit of
 * the 13 px count is 7.73 px wide in JetBrains Mono and 9.66 px in the face
 * drawn until that font has loaded; a line holds 10,000 at most, five digits.
 */
const CSS = readFileSync(path.resolve(__dirname, 'storefront.css'), 'utf8');

const PHONE = '@media (max-width: 639.98px)';
const DIGITS = 5;
const DIGIT_PX = 7.73;
const DIGIT_PX_BEFORE_FONT_LOADS = 9.66;
/** "IN CART" at 10.5 px with its 6 px margin, as drawn (46.6 + 6). */
const LABEL_PX = 52.6;

interface Rule {
  selectors: string[];
  body: string;
  /** The @media the rule sits in, or null at the top of the file. */
  at: string | null;
}

function parse(css: string): Rule[] {
  const rules: Rule[] = [];
  const walk = (text: string, at: string | null) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim().replace(/\s+/g, ' ');
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      const inner = text.slice(open + 1, j - 1);
      if (/^@(media|container|supports)\b/.test(head)) walk(inner, head);
      else if (!head.startsWith('@')) {
        rules.push({ selectors: head.split(',').map((s) => s.trim()), body: inner, at });
      }
      i = j;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ''), null);
  return rules;
}

const RULES = parse(CSS);

/** The last value a rule for exactly this selector gives the property, at the top of the file or in one @media. */
function declared(selector: string, prop: string, at: string | null = null): string | undefined {
  let value: string | undefined;
  for (const rule of RULES) {
    if (rule.at !== at || !rule.selectors.includes(selector)) continue;
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+);`).exec(rule.body);
    if (m) value = m[1]!.trim();
  }
  return value;
}

const px = (value: string | undefined): number => {
  expect(value, 'a px value').toMatch(/^\d+(\.\d+)?px$/);
  return parseFloat(value!);
};

/** Every selector that hides the stepper's label, with the @media it is in. */
const LABEL_HIDERS = RULES.flatMap((rule) =>
  /(?:^|;)\s*display\s*:\s*none\s*;/.test(rule.body)
    ? rule.selectors.filter((s) => /\.in-lbl$/.test(s)).map((s) => ({ selector: s, at: rule.at }))
    : [],
);

const labelDropped = (surface: '.sf-row' | '.sf-card' | '.sf-drawer-foot', at: string | null) =>
  LABEL_HIDERS.some(
    (h) =>
      (h.at === null || h.at === at) &&
      (h.selector === `.sp-storefront ${surface} .sf-ctl .in-lbl` ||
        h.selector === '.sp-storefront .sf-ctl .in-lbl'),
  );

/** The two stepper buttons and the border, from the stepper's own rule. */
function stepperChrome(at: string | null): number {
  const columns =
    (at && declared('.sp-storefront .sf-step', 'grid-template-columns', at)) ||
    declared('.sp-storefront .sf-step', 'grid-template-columns');
  const m = /^(\d+)px 1fr (\d+)px$/.exec(columns ?? '');
  expect(m, `stepper columns "${columns}"`).not.toBeNull();
  const border = /^(\d+)px solid /.exec(declared('.sp-storefront .sf-step', 'border') ?? '');
  expect(border, 'stepper border').not.toBeNull();
  return Number(m![1]) + Number(m![2]) + 2 * Number(border![1]);
}

/** The least width the stepper has while "Add all" sits beside it: its flex basis (it wraps under before it shrinks). */
function stepperBesideAddAll(): number {
  const flex = /^3 1 (\d+)px$/.exec(declared('.sp-storefront .sf-ctl > .sf-step', 'flex') ?? '');
  expect(flex, 'the main control keeps its base width beside Add all').not.toBeNull();
  return Number(flex![1]);
}

function countRoom(surface: '.sf-row' | '.sf-card' | '.sf-drawer-foot', at: string | null) {
  const stepper =
    surface === '.sf-row' && at === PHONE
      ? px(declared('.sp-storefront .sf-row .sf-ctl', 'width', PHONE))
      : stepperBesideAddAll();
  return stepper - stepperChrome(at) - (labelDropped(surface, at) ? 0 : LABEL_PX);
}

describe('the count beside Add all', () => {
  it('drops the IN CART label in a list row and on a grid card at every width', () => {
    expect(declared('.sp-storefront .sf-row .sf-ctl .in-lbl', 'display')).toBe('none');
    expect(declared('.sp-storefront .sf-card .sf-ctl .in-lbl', 'display')).toBe('none');
  });

  it('drops it in the quick view too at 639.98 px and under, where the buttons are 44 px', () => {
    expect(declared('.sp-storefront .sf-ctl .in-lbl', 'display', PHONE)).toBe('none');
  });

  it('has room for five digits in a list row and on a grid card, in either face', () => {
    for (const surface of ['.sf-row', '.sf-card'] as const) {
      expect(countRoom(surface, null), surface).toBeGreaterThanOrEqual(
        DIGITS * DIGIT_PX_BEFORE_FONT_LOADS,
      );
    }
    expect(countRoom('.sf-row', PHONE)).toBeGreaterThanOrEqual(DIGITS * DIGIT_PX_BEFORE_FONT_LOADS);
  });

  // 128 - 88 - 2 = 38 px at the narrowest: 10000 is 38.67 px from edge to edge
  // and its ink 37 px, so it shows whole (photographed at the card width where
  // the button is about to wrap under). The face drawn before the font loads
  // needs 48.3 px there: on cards 224 to 237 px wide in a window under 640 px
  // it cuts 10000 until the font is in. Left as it is: more room would move
  // where the button wraps, and with it cards that have no "Add all".
  it('has room for five digits beside 44 px buttons on a card and in the quick view', () => {
    for (const surface of ['.sf-card', '.sf-drawer-foot'] as const) {
      expect(countRoom(surface, PHONE), surface).toBeGreaterThanOrEqual(
        Math.floor(DIGITS * DIGIT_PX),
      );
    }
  });

  it('keeps the 44 px buttons and the base width the button wraps at', () => {
    expect(stepperChrome(null)).toBe(66);
    expect(stepperChrome(PHONE)).toBe(90);
    expect(stepperBesideAddAll()).toBe(128);
    // Add to cart and the stepper share that width, so "Add all" does not
    // jump when one turns into the other.
    const shared = RULES.find(
      (r) => r.at === null && r.selectors.includes('.sp-storefront .sf-ctl > .sf-step'),
    );
    expect(shared?.selectors).toContain('.sp-storefront .sf-ctl > .sf-add');
  });

  it('never hides the label of a stepper that has no Add all beside it', () => {
    expect(LABEL_HIDERS.length).toBeGreaterThan(0);
    // `.sf-ctl` is drawn only around a control that has the button.
    for (const h of LABEL_HIDERS) expect(h.selector, h.selector).toContain(' .sf-ctl ');
  });

  it('keeps the label in the quick view above 639.98 px, where it has 130 px to spare', () => {
    expect(labelDropped('.sf-drawer-foot', null)).toBe(false);
    expect(labelDropped('.sf-drawer-foot', PHONE)).toBe(true);
  });
});
