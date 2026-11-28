import { describe, expect, it } from 'vitest';

import {
  POLICY_COMBINING_MARK_RANGES,
  POLICY_MARK_RUN_MAX,
  findPolicyMarkRun,
} from './policy-text';

/**
 * The marks the core counts, checked against this engine's own Unicode tables,
 * code point by code point (review round 2, M2). The time guard is sound when
 * every code point this engine's normaliser treats as a non-starter (a
 * canonical combining class other than 0 at the start of its decomposition) is
 * counted: then the core never normalises a run of more than
 * POLICY_MARK_RUN_MAX of them, and so never more than 3 + 2 x 30 non-starters in
 * a row (the bounds below), whatever the text.
 */
const ENGINE_UNICODE = process.versions.unicode ?? '';
const MARK = /\p{M}/u;
const MARK_OR_UNASSIGNED = /[\p{M}\p{Cn}]/u;
/** U+0345 has the highest class (240): a code point that starts with any lower class moves before it. */
const CLASS_240 = '\u0345';

/** One flag per code point: is it in the list (a table, so the sweeps below stay quick). */
const LISTED = new Uint8Array(0x110000);
for (const [lo, hi] of POLICY_COMBINING_MARK_RANGES) LISTED.fill(1, lo, hi + 1);
const isListed = (cp: number) => LISTED[cp] === 1;
/** The sweeps below visit all 1,112,064 code points; on a busy machine that can take seconds. */
const SWEEP_MS = 60_000;

function startsWithNonStarter(ch: string): boolean {
  return ch === CLASS_240 || (CLASS_240 + ch).normalize('NFD') !== CLASS_240 + ch.normalize('NFD');
}

function everyCodePoint(fn: (cp: number, ch: string) => void): void {
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    fn(cp, String.fromCodePoint(cp));
  }
}

describe('the list of combining marks', () => {
  it('is sorted ranges that neither overlap nor touch', () => {
    let last = -2;
    for (const [lo, hi] of POLICY_COMBINING_MARK_RANGES) {
      expect(lo, lo.toString(16)).toBeGreaterThan(last + 1);
      expect(hi).toBeGreaterThanOrEqual(lo);
      last = hi;
    }
    expect(POLICY_COMBINING_MARK_RANGES[0]).toEqual([0x0300, 0x036f]);
  });

  it('names only what this engine calls a mark or unassigned (never a letter or a symbol)', () => {
    for (const [lo, hi] of POLICY_COMBINING_MARK_RANGES) {
      for (let cp = lo; cp <= hi; cp += 1) {
        expect(MARK_OR_UNASSIGNED.test(String.fromCodePoint(cp)), cp.toString(16)).toBe(true);
      }
    }
  });

  it.runIf(ENGINE_UNICODE === '17.0')(
    'is exactly the marks of Unicode 17.0, and holds every code point a 17.0 normaliser can reorder',
    () => {
      const missing: string[] = [];
      const extra: string[] = [];
      everyCodePoint((cp, ch) => {
        const mark = MARK.test(ch);
        if (mark && !isListed(cp)) missing.push(cp.toString(16));
        if (!mark && isListed(cp)) extra.push(cp.toString(16));
        if (startsWithNonStarter(ch) && !isListed(cp))
          missing.push(`non-starter ${cp.toString(16)}`);
      });
      expect(missing).toEqual([]);
      expect(extra).toEqual([]);
    },
    SWEEP_MS,
  );
});

describe('the core counts every code point this engine can reorder', () => {
  it('nothing below U+0300 is a mark or unassigned (the fast path)', () => {
    for (let cp = 0; cp < 0x0300; cp += 1) {
      expect(MARK_OR_UNASSIGNED.test(String.fromCodePoint(cp)), cp.toString(16)).toBe(false);
    }
  });

  it(
    'every code point whose decomposition starts with a non-starter is counted',
    () => {
      const notCounted: string[] = [];
      let nonStarters = 0;
      everyCodePoint((cp, ch) => {
        if (!startsWithNonStarter(ch)) return;
        nonStarters += 1;
        if (findPolicyMarkRun('x' + ch.repeat(POLICY_MARK_RUN_MAX + 1)) === null) {
          notCounted.push(cp.toString(16));
        }
      });
      expect(nonStarters).toBeGreaterThan(900);
      expect(notCounted).toEqual([]);
    },
    SWEEP_MS,
  );

  it(
    'bounds the non-starters in a row the normaliser can meet: at most 3 after any first character, at most 2 in a counted mark',
    () => {
      let trailing = 0;
      let perMark = 0;
      everyCodePoint((cp, ch) => {
        const parts = [...ch.normalize('NFD')];
        let t = 0;
        for (let i = parts.length - 1; i >= 0 && startsWithNonStarter(parts[i]!); i -= 1) t += 1;
        if (!startsWithNonStarter(ch)) trailing = Math.max(trailing, t);
        if (isListed(cp)) perMark = Math.max(perMark, parts.filter(startsWithNonStarter).length);
      });
      expect(trailing).toBeLessThanOrEqual(3);
      expect(perMark).toBeLessThanOrEqual(2);
    },
    SWEEP_MS,
  );
});
