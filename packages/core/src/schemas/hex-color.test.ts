import { describe, expect, it } from 'vitest';

import { HEX_COLOR_PATTERN, hexColorSchema, safeHexColor } from './hex-color';
import { createProcedureCategorySchema, updateProcedureCategorySchema } from './procedures';
import { createTagSchema, updateTagSchema } from './tags';

/**
 * STORED COLOURS: ONE FORM, CHECKED WHERE SAVED AND WHERE DRAWN (docket T14).
 *
 * Category, tag and procedure-category colours are plain text columns. The
 * app's own pickers write `#` and six hex digits, but a manager can write the
 * column through the Data API (RLS allows it; no CHECK), and React's server
 * renderer copies a style value into the HTML as given (it escapes HTML, not
 * CSS). So `#000;position:fixed;inset:0` added declarations to the category
 * label on every member's Items and Books page. These values are the ones the
 * security review built.
 */

const WRITTEN_BY_THE_APP = [
  '#6366f1',
  '#94a3b8',
  '#475569',
  '#ABCDEF',
  '#AbCdEf',
  '#000000',
  '#ffffff',
];

const NOT_A_STORED_COLOUR = [
  '',
  ' ',
  '#000;position:fixed;inset:0;z-index:2147483647;background:#fff;font-size:40px',
  '#6366f1;',
  '#6366f1;position:fixed',
  'red;position:fixed',
  ' #6366f1',
  '#6366f1 ',
  '#6366f1\n',
  '\n#6366f1',
  '#6366f1\u0000',
  '#fff',
  '#ffff',
  '#6366f1ff',
  '#gggggg',
  '6366f1',
  '##6366f1',
  'red',
  'transparent',
  'currentColor',
  'rgb(0,0,0)',
  'hsl(0 0% 0%)',
  'var(--accent)',
  'url(https://x.example/a.png)',
  'expression(alert(1))',
  '#000" onmouseover="x',
  '#000</style><b>x</b>',
];

describe('safeHexColor (draw side)', () => {
  it('keeps a colour in the form the app writes, unchanged', () => {
    for (const value of WRITTEN_BY_THE_APP) {
      expect(safeHexColor(value), value).toBe(value);
    }
  });

  it('refuses anything else, so the caller draws its default colour', () => {
    for (const value of NOT_A_STORED_COLOUR) {
      expect(safeHexColor(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('refuses a missing value and a value of another type', () => {
    for (const value of [null, undefined, 0, 6513393, true, {}, ['#6366f1']]) {
      expect(safeHexColor(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('the pattern is anchored at both ends', () => {
    expect(HEX_COLOR_PATTERN.test('#6366f1')).toBe(true);
    expect(HEX_COLOR_PATTERN.test('x#6366f1')).toBe(false);
    expect(HEX_COLOR_PATTERN.test('#6366f1x')).toBe(false);
  });
});

describe('the save-side schemas accept only that form', () => {
  it('hexColorSchema', () => {
    for (const value of WRITTEN_BY_THE_APP) {
      expect(hexColorSchema.safeParse(value).success, value).toBe(true);
    }
    for (const value of NOT_A_STORED_COLOUR) {
      const parsed = hexColorSchema.safeParse(value);
      expect(parsed.success, JSON.stringify(value)).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe('Use a hex color like #6366f1');
    }
  });

  it('tags: create and update refuse an injected colour, keep a hex one and a cleared one', () => {
    for (const schema of [createTagSchema, updateTagSchema]) {
      for (const value of NOT_A_STORED_COLOUR) {
        expect(
          schema.safeParse({ name: 'Fragile', color: value }).success,
          JSON.stringify(value),
        ).toBe(false);
      }
      expect(schema.safeParse({ name: 'Fragile', color: '#f97316' }).success).toBe(true);
      expect(schema.safeParse({ name: 'Fragile', color: null }).success).toBe(true);
    }
  });

  it('procedure categories: create and update refuse an injected colour, keep a hex one and a cleared one', () => {
    for (const schema of [createProcedureCategorySchema, updateProcedureCategorySchema]) {
      for (const value of NOT_A_STORED_COLOUR) {
        expect(
          schema.safeParse({ name: 'Safety', color: value }).success,
          JSON.stringify(value),
        ).toBe(false);
      }
      expect(schema.safeParse({ name: 'Safety', color: '#dc2626' }).success).toBe(true);
      expect(schema.safeParse({ name: 'Safety', color: null }).success).toBe(true);
    }
  });
});
