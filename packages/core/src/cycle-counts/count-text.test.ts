import { describe, expect, it } from 'vitest';

import { countFromText } from './count-text';

/**
 * The one rule every cycle-count box reads a box by (web and phone). A count
 * must never record a number other than the one in the box: the phone read
 * boxes with parseFloat ("1.2.3" saved 1.2, "2,5" saved 2), and the web with
 * Number() ("1e3" saved 1000, "0x10" saved 16).
 */
describe('countFromText', () => {
  it('reads a plain number of zero or more, decimals and all', () => {
    expect(countFromText('0')).toBe(0);
    expect(countFromText('5')).toBe(5);
    expect(countFromText('007')).toBe(7);
    expect(countFromText('2.5')).toBe(2.5);
    expect(countFromText('2.7')).toBe(2.7);
    expect(countFromText('0.5')).toBe(0.5);
    expect(countFromText('.25')).toBe(0.25);
    expect(countFromText('3.1416')).toBe(3.1416);
    expect(countFromText('1000000')).toBe(1000000);
    // On the way to "5.5": the count so far.
    expect(countFromText('5.')).toBe(5);
  });

  it('ignores spaces around the number', () => {
    expect(countFromText(' 3 ')).toBe(3);
    expect(countFromText('\t4.2\n')).toBe(4.2);
  });

  it('an empty box, a lone point and a lone minus sign hold no count', () => {
    for (const raw of ['', '   ', '.', '-', ' . ']) expect(countFromText(raw), raw).toBeNull();
  });

  it('a negative number is not a count', () => {
    for (const raw of ['-4', '-0.5', '-0']) expect(countFromText(raw), raw).toBeNull();
  });

  it('a second point or a comma is not a count, never the number before it', () => {
    for (const raw of ['1.2.3', '2,5', '1,000', '5..', '..5', '2.5.'])
      expect(countFromText(raw), raw).toBeNull();
  });

  it('a sign, an exponent, another base or words are not a count', () => {
    for (const raw of [
      '+5',
      '1e3',
      '1E3',
      '0x10',
      '0b11',
      '0o7',
      'Infinity',
      'NaN',
      '5abc',
      'abc',
      '5 5',
    ])
      expect(countFromText(raw), raw).toBeNull();
  });
});
