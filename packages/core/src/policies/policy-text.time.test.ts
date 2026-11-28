import { describe, expect, it } from 'vitest';

import { policyBodyHasStarterNote } from './policy-copy';
import { policyTextHash, utf8Bytes } from './policy-hash';
import {
  findForbiddenPolicyCharacter,
  findPolicyMarkRun,
  normalizePolicyBody,
  normalizePolicyTitle,
  parsePolicyText,
  policyBlocksToText,
  policyBodyProblem,
  policyLineCount,
  policyTextLength,
  policyTitleProblem,
  preparePolicyBody,
  preparePolicyTitle,
} from './policy-text';

/**
 * Every exported function a stored or posted text goes through runs in time
 * linear in the text's length, on any input: a body the database accepts, or
 * one written around the website's check, must not hold the website's server
 * or a phone's JavaScript thread. Review 2026-11-24, M1: trimming line ends
 * with / +$/ took 325 ms for 29,999 spaces then "x". Review 2026-11-27, M2:
 * Unicode normalisation of a run of combining marks out of order took 651 ms
 * at 30,000 characters and 41.6 s at 240,000.
 *
 * For each hostile shape and each function: the two sizes N and 2N are timed
 * in turn, run after run (so a busy machine slows both alike), each run long
 * enough to read the clock well, after a warm-up. The median time at 2N (what a
 * caller waits) is held to a hard ceiling. The ratio of the fastest run at 2N
 * to the fastest at N (the function's own cost, without the collector's pauses,
 * which grow with what a test file run in parallel holds) is held well under
 * the 4 that a quadratic time gives (linear is 2). N and 2N are both within the
 * raw limits, so the writers do their whole work at both sizes; 240,000
 * characters is held to a ceiling.
 */
const N = 15_000;
const RUNS = 7;
/** A run lasts at least this long (as many calls as that takes at N, at least 2). */
const RUN_MS = 1;
const RATIO_MAX = 3;
const RATIO_FLOOR_MS = 0.2;
const CEILING_MS = 150;
const BIG = 240_000;
const BIG_CEILING_MS = 300;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Times `fn` on `one` and `two` in turn: the median time of each (per call), and the fastest at `two` over the fastest at `one`. */
function timePair(
  fn: (s: string) => unknown,
  one: string,
  two: string,
): { one: number; two: number; ratio: number } {
  fn(one);
  fn(two);
  const t0 = performance.now();
  fn(one);
  const single = performance.now() - t0;
  const calls = Math.min(200, Math.max(2, Math.ceil(RUN_MS / Math.max(single, 0.001))));
  const ones: number[] = [];
  const twos: number[] = [];
  for (let r = 0; r < RUNS; r += 1) {
    const a = performance.now();
    for (let c = 0; c < calls; c += 1) fn(one);
    const b = performance.now();
    for (let c = 0; c < calls; c += 1) fn(two);
    const e = performance.now();
    ones.push((b - a) / calls);
    twos.push((e - b) / calls);
  }
  return {
    one: median(ones),
    two: median(twos),
    ratio: Math.min(...twos) / Math.max(Math.min(...ones), 0.000001),
  };
}

/** `s` repeated to about `n` code points. */
const fill = (s: string, n: number) => s.repeat(Math.max(1, Math.floor(n / [...s].length)));

const ACUTE = '\u0301'; // class 230
const GRAVE_BELOW = '\u0316'; // class 220
const KA = '\u0F40';
const II = '\u0F73'; // Tibetan vowel sign II: two marks (classes 129, 130) in normal form

const SHAPES: ReadonlyArray<[string, (n: number) => string]> = [
  ['spaces then a letter', (n) => ' '.repeat(n - 1) + 'x'],
  ['tabs then a letter', (n) => '\t'.repeat(n - 1) + 'x'],
  ['space and line feed in turn, then a letter', (n) => ' \n'.repeat(n / 2 - 1) + 'xy'],
  ['line feeds then a letter', (n) => '\n'.repeat(n - 1) + 'x'],
  ['a letter then line feeds', (n) => 'x' + '\n'.repeat(n - 1)],
  ['line feed pairs between letters', (n) => fill('x\n\n', n)],
  ['carriage returns then a letter', (n) => '\r'.repeat(n - 1) + 'x'],
  ['spaces, a line feed, a letter, in turn', (n) => fill('   \nx', n)],
  ['hashes and dashes', (n) => fill('# - ', n)],
  // Combining marks (M2), in canonical order and out of it.
  ['one mark (230) after a letter, in order', (n) => 'x' + ACUTE.repeat(n - 1)],
  ['marks 230 and 220 in turn, out of order', (n) => 'x' + fill(ACUTE + GRAVE_BELOW, n - 1)],
  [
    'marks 230 then 220, out of order',
    (n) => 'x' + ACUTE.repeat(n / 2) + GRAVE_BELOW.repeat(n / 2 - 1),
  ],
  [
    'marks 220 then 230, in order',
    (n) => 'x' + GRAVE_BELOW.repeat(n / 2) + ACUTE.repeat(n / 2 - 1),
  ],
  ['Tibetan II, out of order once decomposed', (n) => KA + II.repeat(n - 1)],
  ['Greek dialytika tonos (U+0344)', (n) => 'x' + '\u0344'.repeat(n - 1)],
  [
    'Ol Onal 230 then 220 (the stored body of the review)',
    (n) => 'x' + '\u{1E5EE}'.repeat(n / 2) + '\u{1E5EF}'.repeat(n / 2 - 1),
  ],
  ['code points unassigned in Unicode 17.0', (n) => 'x' + '\u0378'.repeat(n - 1)],
  [
    'runs of 30 marks out of order between letters',
    (n) => fill('x' + (ACUTE + GRAVE_BELOW).repeat(15), n),
  ],
  [
    'runs of 30 marks in order between letters',
    (n) => fill('x' + GRAVE_BELOW.repeat(15) + ACUTE.repeat(15), n),
  ],
  ['runs of 15 Tibetan II (30 marks once decomposed)', (n) => fill(KA + II.repeat(15), n)],
  ['runs of 30 Tibetan II (60 marks once decomposed)', (n) => fill(KA + II.repeat(30), n)],
  ['decomposed accents that compose', (n) => fill('e' + ACUTE, n)],
  ['Hangul jamo that compose', (n) => fill('\u1100\u1161\u11A8', n)],
  ['ideographs', (n) => '\u4E2D'.repeat(n)],
];

const FNS: ReadonlyArray<[string, (s: string) => unknown]> = [
  ['normalizePolicyBody', normalizePolicyBody],
  ['normalizePolicyTitle', normalizePolicyTitle],
  ['policyBodyProblem', policyBodyProblem],
  ['policyTitleProblem', policyTitleProblem],
  ['preparePolicyBody', preparePolicyBody],
  ['preparePolicyTitle', preparePolicyTitle],
  ['parsePolicyText', parsePolicyText],
  ['policyBlocksToText of the parse', (s) => policyBlocksToText(parsePolicyText(s))],
  ['findForbiddenPolicyCharacter', findForbiddenPolicyCharacter],
  ['findPolicyMarkRun', findPolicyMarkRun],
  ['policyTextLength', policyTextLength],
  ['policyLineCount', policyLineCount],
  ['policyTextHash', (s) => policyTextHash('Title', s)],
  ['utf8Bytes', utf8Bytes],
  ['policyBodyHasStarterNote', policyBodyHasStarterNote],
];

describe('the text functions run in linear time', () => {
  for (const [shape, make] of SHAPES) {
    for (const [name, fn] of FNS) {
      it(`${name}: ${shape}`, () => {
        const { one, two, ratio } = timePair(fn, make(N), make(2 * N));
        expect(two, `${name} took ${two.toFixed(2)} ms at ${2 * N}`).toBeLessThan(CEILING_MS);
        // Below a fifth of a millisecond a call is the collector's and the clock's; the ceiling decides.
        if (one >= RATIO_FLOOR_MS) {
          expect(
            ratio,
            `${name}: ${one.toFixed(3)} ms then ${two.toFixed(3)} ms (fastest runs: ratio ${ratio.toFixed(2)})`,
          ).toBeLessThan(RATIO_MAX);
        }
      });
    }
  }

  it(`every function answers each shape of ${BIG.toLocaleString('en')} characters within ${BIG_CEILING_MS} ms`, () => {
    const slow: string[] = [];
    for (const [shape, make] of SHAPES) {
      const text = make(BIG);
      for (const [name, fn] of FNS) {
        fn(text);
        const t0 = performance.now();
        fn(text);
        const ms = performance.now() - t0;
        if (ms >= BIG_CEILING_MS) slow.push(`${name}: ${shape}: ${ms.toFixed(0)} ms`);
      }
    }
    expect(slow).toEqual([]);
  });

  it('a body of 1,000,000 spaces then a letter is parsed in well under a second, and refused before normalising', () => {
    const big = ' '.repeat(999_999) + 'x';
    const t0 = performance.now();
    expect(normalizePolicyBody(big)).toBe(big);
    expect(preparePolicyBody(big).problem).toBe('too_long');
    expect(parsePolicyText(big)).toEqual([{ kind: 'paragraph', lines: [big] }]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
