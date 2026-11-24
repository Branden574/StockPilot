import { describe, expect, it } from 'vitest';

import { policyTextHash } from './policy-hash';
import {
  findForbiddenPolicyCharacter,
  normalizePolicyBody,
  normalizePolicyTitle,
  parsePolicyText,
  policyBodyProblem,
  policyTitleProblem,
} from './policy-text';

/**
 * Every function a stored or posted text goes through runs in time linear in
 * the text's length: a body the database accepts must not hold the website's
 * server or a phone's JavaScript thread (review 2026-11-24, M1: trimming line
 * ends with / +$/ took 325 ms for 29,999 spaces then "x", and 3.5 s for
 * 100,000). For each hostile shape: the time at N and at 2N characters (the
 * fastest of several runs, each of several calls, after a warm-up), held to
 * a generous ceiling, and the ratio of the two to well under the 4 that a
 * quadratic time gives.
 */
const N = 30_000;
const CALLS = 5;
const RUNS = 5;
const RATIO_MAX = 3;
const CEILING_MS = 150;

function fastest(fn: (s: string) => unknown, text: string): number {
  fn(text);
  let best = Infinity;
  for (let r = 0; r < RUNS; r += 1) {
    const t0 = performance.now();
    for (let c = 0; c < CALLS; c += 1) fn(text);
    best = Math.min(best, (performance.now() - t0) / CALLS);
  }
  return best;
}

const SHAPES: ReadonlyArray<[string, (n: number) => string]> = [
  ['spaces then a letter', (n) => ' '.repeat(n - 1) + 'x'],
  ['tabs then a letter', (n) => '\t'.repeat(n - 1) + 'x'],
  ['space and line feed in turn, then a letter', (n) => ' \n'.repeat(n / 2 - 1) + 'xy'],
  ['line feeds then a letter', (n) => '\n'.repeat(n - 1) + 'x'],
  ['a letter then line feeds', (n) => 'x' + '\n'.repeat(n - 1)],
  ['line feed pairs between letters', (n) => 'x\n\n'.repeat(n / 3)],
  ['carriage returns then a letter', (n) => '\r'.repeat(n - 1) + 'x'],
  ['spaces, a line feed, a letter, in turn', (n) => '   \nx'.repeat(n / 5)],
  ['hashes and dashes', (n) => '# - '.repeat(n / 4)],
];

const FNS: ReadonlyArray<[string, (s: string) => unknown]> = [
  ['normalizePolicyBody', normalizePolicyBody],
  ['policyBodyProblem', policyBodyProblem],
  ['parsePolicyText', parsePolicyText],
  ['normalizePolicyTitle', normalizePolicyTitle],
  ['policyTitleProblem', policyTitleProblem],
  ['findForbiddenPolicyCharacter', findForbiddenPolicyCharacter],
  ['policyTextHash', (s) => policyTextHash('Title', s)],
];

describe('the text functions run in linear time', () => {
  for (const [shape, make] of SHAPES) {
    for (const [name, fn] of FNS) {
      it(`${name}: ${shape}`, () => {
        const one = fastest(fn, make(N));
        const two = fastest(fn, make(2 * N));
        expect(two, `${name} took ${two.toFixed(2)} ms at ${2 * N}`).toBeLessThan(CEILING_MS);
        // Below a tenth of a millisecond the clock's own step is the ratio; the ceiling decides.
        if (one >= 0.1) {
          expect(two / one, `${name}: ${one.toFixed(3)} ms then ${two.toFixed(3)} ms`).toBeLessThan(
            RATIO_MAX,
          );
        }
      });
    }
  }

  it('a body of 1,000,000 spaces then a letter is normalised and parsed in well under a second', () => {
    const big = ' '.repeat(999_999) + 'x';
    const t0 = performance.now();
    expect(normalizePolicyBody(big)).toBe(big);
    expect(parsePolicyText(big)).toEqual([{ kind: 'paragraph', lines: [big] }]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
