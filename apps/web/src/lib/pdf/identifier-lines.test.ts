import { describe, expect, it } from 'vitest';

import { width } from '@/test/pdf-font-metrics';

import { breakIdentifierLines } from './identifier-lines';

const SIZE = 8.5;

describe('breakIdentifierLines', () => {
  it('returns a value that fits unchanged', () => {
    expect(breakIdentifierLines('BK-0001', 119, SIZE)).toBe('BK-0001');
    expect(breakIdentifierLines('9780262033848', 61.5, SIZE)).toBe('9780262033848');
    expect(breakIdentifierLines('', 10, SIZE)).toBe('');
  });

  it("ends a line just after the identifier's own separator", () => {
    // 'MATH-GRADE5-WORKBOOK-' is 118.53pt at 8.5pt, one hair past the 118.5pt
    // box, so the line ends after the separator before it.
    expect(breakIdentifierLines('MATH-GRADE5-WORKBOOK-2026-ED2-XL', 118.5, SIZE)).toBe(
      'MATH-GRADE5-\nWORKBOOK-2026-ED2-XL',
    );
    expect(breakIdentifierLines('MATH-GRADE5-WORKBOOK-2026-ED2-XL-EXTRA', 143.5, SIZE)).toBe(
      'MATH-GRADE5-WORKBOOK-2026-\nED2-XL-EXTRA',
    );
  });

  it('breaks between characters when no separator falls on the line', () => {
    // Thirty digits are 141.78pt; thirty-one would be 146.5pt.
    expect(breakIdentifierLines('012345678901234567890123456789012345', 143.5, SIZE)).toBe(
      '012345678901234567890123456789\n012345',
    );
  });

  it('never leaves a separator alone on a line', () => {
    // 'ABCDEFGHIJ' fills the first line, so the second one starts with the
    // '-'. Ending that line after the '-' would print a line of only '-'.
    const box = width('ABCDEFGHIJ', 'Helvetica', SIZE) + 0.01;
    const lines = breakIdentifierLines('ABCDEFGHIJ-KLMNOPQRST', box, SIZE).split('\n');
    expect(lines[0]).toBe('ABCDEFGHIJ');
    for (const line of lines) expect(line).not.toBe('-');
  });

  it('puts one character on a line when the box is narrower than one', () => {
    expect(breakIdentifierLines('AB-1', 1, SIZE)).toBe('A\nB\n-\n1');
  });

  it('never splits a character outside the basic plane', () => {
    const lines = breakIdentifierLines('AB\u{1D538}CD\u{1D538}EF', 8, SIZE).split('\n');
    for (const line of lines) {
      expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(line).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
    expect(lines.join('')).toBe('AB\u{1D538}CD\u{1D538}EF');
  });

  it('keeps every character, in order, on lines that each fit the box', () => {
    const values = [
      'MATH-GRADE5-WORKBOOK-2026-ED2-XL',
      'SKU-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789-ABCDEFG',
      '012345678901234567890123456789012345678901234567890',
      'SCI_GRADE7/LAB.KIT:2026 EXTRA-LONG-VALUE',
      'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
      '978-0-262-03384-8',
    ];
    for (const value of values) {
      for (const box of [30, 61.5, 106.3, 118.5, 143.5]) {
        const lines = breakIdentifierLines(value, box, SIZE).split('\n');
        expect(lines.join('')).toBe(value);
        for (const line of lines) {
          if (line.length > 1) expect(width(line, 'Helvetica', SIZE)).toBeLessThanOrEqual(box);
        }
      }
    }
  });
});
