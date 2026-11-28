import { describe, expect, it } from 'vitest';

import {
  VENDOR_RISK_HIDDEN_CHARACTERS,
  VENDOR_RISK_OVERRIDE_REASON_MIN,
  vendorRiskCleanText,
  vendorRiskOverrideReasonOk,
  vendorRiskReasonCount,
  vendorRiskTextOk,
} from './rules';

/**
 * The two helpers the vendor risk pages use (added for the web half; review
 * of 0481, round 3, follow-ups 1 and 3): cleaning typed text of core's hidden
 * characters before it is sent, and the reason counter. Every invisible
 * character here is written as an escape, never literally.
 */

const ZWJ = '\u200D';
const VS16 = '\uFE0F';
const SHY = '\u00AD';
const ZWSP = '\u200B';
const BOM = '\uFEFF';
const LSEP = '\u2028';
const BRAILLE_BLANK = '\u2800';

describe('vendorRiskCleanText', () => {
  it('takes out what a phone emoji keyboard and pasted text add, and says how many', () => {
    const heart = `Signed by both sides ❤${VS16}`;
    expect(vendorRiskCleanText(heart)).toEqual({ text: 'Signed by both sides ❤', removed: 1 });
    const family = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`;
    expect(vendorRiskCleanText(family)).toEqual({
      text: '\u{1F468}\u{1F469}\u{1F467}',
      removed: 2,
    });
    expect(vendorRiskCleanText(`co${SHY}operate${ZWSP} now${BOM}`)).toEqual({
      text: 'cooperate now',
      removed: 3,
    });
  });

  it('a line separator becomes a line break, not nothing', () => {
    expect(vendorRiskCleanText(`first line${LSEP}second line`)).toEqual({
      text: 'first line\nsecond line',
      removed: 1,
    });
  });

  it('plain text, line breaks and tabs are left as they are', () => {
    const plain = 'Contract clause 7.2,\n\tsigned 2026-03-01 (both sides). Escuela Núñez';
    expect(vendorRiskCleanText(plain)).toEqual({ text: plain, removed: 0 });
  });

  it('cleans every code point of core list: what is left always passes the hidden part of the text rule', () => {
    for (const [lo, hi] of VENDOR_RISK_HIDDEN_CHARACTERS) {
      for (const cp of [lo, hi, Math.floor((lo + hi) / 2)]) {
        const dirty = `note ${String.fromCodePoint(cp)} text`;
        expect(vendorRiskTextOk(dirty, 1, 1000), cp.toString(16)).toBe(false);
        const { text, removed } = vendorRiskCleanText(dirty);
        expect(removed, cp.toString(16)).toBe(1);
        expect(vendorRiskTextOk(text, 1, 1000), cp.toString(16)).toBe(true);
      }
    }
  });
});

describe('vendorRiskReasonCount', () => {
  it('counts what is seen: runs of spaces are one, the ends trimmed', () => {
    const c = vendorRiskReasonCount('  The   vendor  ');
    expect(c.seen).toBe('The vendor'.length);
    expect(c.different).toBe(new Set('Thevndor'.split('')).size);
  });

  it('an emoji, a flag or a letter with its accent is one character', () => {
    expect(vendorRiskReasonCount('\u{1F1FA}\u{1F1F8}').seen).toBe(1);
    expect(vendorRiskReasonCount('e\u0301').seen).toBe(1);
    expect(vendorRiskReasonCount('\u{1F44D}\u{1F3FD}').seen).toBe(1);
  });

  it('the blank braille cell counts as a space', () => {
    const c = vendorRiskReasonCount(`ab${BRAILLE_BLANK}${BRAILLE_BLANK}cd`);
    expect(c.seen).toBe(5);
    expect(c.different).toBe(4);
  });

  it('asks more than the database floor where graphemes are fewer than code points', () => {
    // Ten flags are twenty code points with more than five different ones:
    // the database takes it, the page counts ten characters and does not.
    const flags =
      '\u{1F1FA}\u{1F1F8}\u{1F1EC}\u{1F1E7}\u{1F1EB}\u{1F1F7}\u{1F1E9}\u{1F1EA}\u{1F1EE}\u{1F1F9}'.repeat(
        2,
      );
    expect(vendorRiskOverrideReasonOk(flags)).toBe(true);
    const c = vendorRiskReasonCount(flags);
    expect(c.seen).toBe(10);
    expect(c.ok).toBe(false);
  });

  it('a hidden character is reported and the reason is not ok until it is cleaned', () => {
    const reason = `The vendor signed our agreement${ZWSP} today.`;
    const c = vendorRiskReasonCount(reason);
    expect(c.hidden).toBe(true);
    expect(c.ok).toBe(false);
    const cleaned = vendorRiskReasonCount(vendorRiskCleanText(reason).text);
    expect(cleaned.hidden).toBe(false);
    expect(cleaned.ok).toBe(true);
  });

  it('the floor: 19 seen is not enough, 20 is; four different is not enough, five is', () => {
    expect(
      vendorRiskReasonCount('abcde'.repeat(4).slice(0, VENDOR_RISK_OVERRIDE_REASON_MIN - 1)).ok,
    ).toBe(false);
    expect(vendorRiskReasonCount('abcde'.repeat(4)).ok).toBe(true);
    expect(vendorRiskReasonCount('abcd'.repeat(5)).ok).toBe(false);
  });

  it('whatever the page takes, the database takes (never the other way round)', () => {
    const samples = [
      'abcde'.repeat(4),
      'Signed by both sides on the first of March.',
      `  spaced    out    reason   with   words  `,
      'x'.repeat(2001),
      'Núñez y compañía firmaron el acuerdo de datos.',
      '\u{1F1FA}\u{1F1F8}'.repeat(25),
      `${'a'}${ZWJ.repeat(19)}`,
      'ab ab ab ab ab ab ab ab ab ab',
      'אבגדה וזחטי ךכלםמ',
    ];
    for (const s of samples) {
      if (vendorRiskReasonCount(s).ok) expect(vendorRiskOverrideReasonOk(s), s).toBe(true);
    }
  });

  it('too long is said, by the database count', () => {
    expect(vendorRiskReasonCount('abcdef'.repeat(334)).tooLong).toBe(true);
    expect(vendorRiskReasonCount('abcdef'.repeat(333)).tooLong).toBe(false);
  });
});
