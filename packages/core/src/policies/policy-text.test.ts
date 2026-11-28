import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_POLICY_CODE_POINTS,
  POLICY_BODY_MAX,
  POLICY_BODY_MAX_LINES,
  POLICY_BODY_RAW_MAX,
  POLICY_COMBINING_MARK_RANGES,
  POLICY_MARK_RUN_MAX,
  POLICY_TITLE_MAX,
  POLICY_TITLE_RAW_MAX,
  findForbiddenPolicyCharacter,
  findPolicyMarkRun,
  isPolicyAckMethod,
  isPolicyChange,
  isPolicyKind,
  isPolicyStatus,
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

/** A small deterministic generator, so a failure is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const PIECES = [
  'a',
  'Z',
  ' ',
  '  ',
  '\t',
  '\n',
  '\r',
  '\r\n',
  '\n\n\n',
  '# ',
  '- ',
  '#',
  '-',
  '## ',
  '* ',
  '1. ',
  'é',
  'e\u0301',
  'Å',
  'A\u030a',
  '\u00a0',
  '—',
  '“',
  '’',
  '<b>',
  '[x](https://example.test)',
  '中文',
  '\u{1F600}',
];
function randomText(r: () => number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i += 1) s += PIECES[Math.floor(r() * PIECES.length)]!;
  return s;
}

describe('the normal form of a body', () => {
  it('applies each step in order', () => {
    expect(normalizePolicyBody('e\u0301')).toBe('é');
    expect(normalizePolicyBody('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    expect(normalizePolicyBody('a\tb')).toBe('a b');
    expect(normalizePolicyBody('a  \nb \n c ')).toBe('a\nb\n c');
    expect(normalizePolicyBody('a\n\n\n\nb\n\n\nc\n\nd')).toBe('a\n\nb\n\nc\n\nd');
    expect(normalizePolicyBody('\n\n a\n\n')).toBe(' a');
    expect(normalizePolicyBody('a\n   \n\n  \nb')).toBe('a\n\nb');
    expect(normalizePolicyBody('   \n\t\n')).toBe('');
    // A non-breaking space is a character, not a space to remove.
    expect(normalizePolicyBody('a\u00a0')).toBe('a\u00a0');
  });

  it('is idempotent and always in normal form (2,000 random texts)', () => {
    const r = rng(482);
    for (let i = 0; i < 2000; i += 1) {
      const raw = randomText(r, 1 + Math.floor(r() * 40));
      const once = normalizePolicyBody(raw);
      expect(normalizePolicyBody(once)).toBe(once);
      expect(once).toBe(once.normalize('NFC'));
      expect(once).not.toMatch(/\r|\t| \n| $|\n\n\n|^\n|\n$/);
      if (once !== '') expect(policyBodyProblem(once)).toBeNull();
    }
  });
});

describe('the normal form of a title', () => {
  it('is one line with single spaces, trimmed, NFC', () => {
    expect(normalizePolicyTitle('  Data \t handling\npolicy  ')).toBe('Data handling policy');
    expect(normalizePolicyTitle('Cafe\u0301')).toBe('Café');
    expect(normalizePolicyTitle('a\r\nb')).toBe('a b');
    expect(normalizePolicyTitle(' \n ')).toBe('');
  });
  it('is idempotent (2,000 random titles)', () => {
    const r = rng(1482);
    for (let i = 0; i < 2000; i += 1) {
      const once = normalizePolicyTitle(randomText(r, 1 + Math.floor(r() * 12)));
      expect(normalizePolicyTitle(once)).toBe(once);
      expect(once).not.toMatch(/[\r\n\t]|  |^ | $/);
    }
  });
});

describe('the limits and the refused characters', () => {
  it('counts code points, as Postgres char_length does', () => {
    expect(policyTextLength('abc')).toBe(3);
    expect(policyTextLength('\u{1F600}')).toBe(1);
    expect('\u{1F600}'.length).toBe(2);
  });

  it('holds a title to 1..120 and a body to 1..30,000 code points', () => {
    expect(POLICY_TITLE_MAX).toBe(120);
    expect(POLICY_BODY_MAX).toBe(30000);
    expect(policyTitleProblem('')).toBe('empty');
    expect(policyTitleProblem('t'.repeat(120))).toBeNull();
    expect(policyTitleProblem('t'.repeat(121))).toBe('too_long');
    expect(policyTitleProblem('\u{1F600}'.repeat(120))).toBeNull();
    expect(policyBodyProblem('')).toBe('empty');
    expect(policyBodyProblem('b'.repeat(30000))).toBeNull();
    expect(policyBodyProblem('b'.repeat(30001))).toBe('too_long');
  });

  it('holds a body to 600 lines (599 line feeds), counted on the text as given', () => {
    expect(POLICY_BODY_MAX_LINES).toBe(600);
    expect(policyLineCount('a')).toBe(1);
    expect(policyLineCount('a\n\nb')).toBe(3);
    const lines = (n: number) => Array.from({ length: n }, () => 'a').join('\n');
    expect(policyBodyProblem(lines(600))).toBeNull();
    expect(policyBodyProblem(lines(601))).toBe('too_many_lines');
    // Empty lines count: 300 paragraphs of one line each are 599 lines.
    expect(policyBodyProblem(Array.from({ length: 300 }, () => 'a').join('\n\n'))).toBeNull();
    expect(policyBodyProblem(Array.from({ length: 301 }, () => 'a').join('\n\n'))).toBe(
      'too_many_lines',
    );
    // Checked after the length and before the characters, as the database orders them.
    expect(policyBodyProblem('b'.repeat(30001) + '\n'.repeat(700))).toBe('too_long');
    expect(policyBodyProblem(lines(601) + '\u200b')).toBe('too_many_lines');
  });

  it('refuses every listed range at both ends, and allows the code point on either side', () => {
    for (const [lo, hi] of FORBIDDEN_POLICY_CODE_POINTS) {
      for (const cp of [lo, hi]) {
        if (cp === 0) continue; // Postgres text cannot hold NUL at all
        const text = `a${String.fromCodePoint(cp)}b`;
        expect(findForbiddenPolicyCharacter(text), cp.toString(16)).toEqual({
          codePoint: cp,
          index: 1,
        });
        expect(policyBodyProblem(text), cp.toString(16)).toBe('forbidden_character');
        expect(policyTitleProblem(text), cp.toString(16)).toBe('forbidden_character');
      }
    }
    const allowed = [
      0x0a, 0x20, 0x7e, 0xa0, 0xac, 0xae, 0x200a, 0x2010, 0x2027, 0x202f, 0x205f, 0x2065, 0x2070,
      0xfefe, 0xff00, 0xfff8, 0x10000, 0xdffff, 0xe0080, 0xe01f0,
    ];
    for (const cp of allowed) {
      if (cp === 0x0a) continue;
      expect(
        findForbiddenPolicyCharacter(`a${String.fromCodePoint(cp)}b`),
        cp.toString(16),
      ).toBeNull();
    }
    expect(policyBodyProblem('a\nb')).toBeNull();
  });

  it('refuses a lone surrogate (it has no UTF-8 form)', () => {
    expect(policyBodyProblem('a\ud800b')).toBe('forbidden_character');
    expect(policyBodyProblem('a\udc00')).toBe('forbidden_character');
    expect(policyBodyProblem('a\u{1F600}')).toBeNull();
  });

  it('names a text that is not in normal form, in the order the database checks', () => {
    expect(policyBodyProblem('a \nb')).toBe('not_normal_form');
    expect(policyBodyProblem('a\n\n\nb')).toBe('not_normal_form');
    expect(policyBodyProblem('\na')).toBe('not_normal_form');
    expect(policyBodyProblem('a\n')).toBe('not_normal_form');
    expect(policyBodyProblem('e\u0301')).toBe('not_normal_form');
    expect(policyBodyProblem(' ')).toBe('not_normal_form');
    // A carriage return and a tab are refused characters before anything else.
    expect(policyBodyProblem('a\r\nb')).toBe('forbidden_character');
    expect(policyBodyProblem('a\tb')).toBe('forbidden_character');
    expect(policyTitleProblem('a\nb')).toBe('not_normal_form');
    expect(policyTitleProblem('a  b')).toBe('not_normal_form');
    expect(policyTitleProblem(' a')).toBe('not_normal_form');
    expect(policyTitleProblem('a ')).toBe('not_normal_form');
    expect(policyTitleProblem('t'.repeat(121) + '\u200b')).toBe('too_long');
  });

  it('knows the kinds, states, changes and methods', () => {
    expect(['acceptable_use', 'data_handling', 'other'].every(isPolicyKind)).toBe(true);
    expect(isPolicyKind('security')).toBe(false);
    expect(['draft', 'published', 'retired'].every(isPolicyStatus)).toBe(true);
    expect(isPolicyStatus('deleted')).toBe(false);
    expect(['new_version', 'correction'].every(isPolicyChange)).toBe(true);
    expect(isPolicyChange('minor')).toBe(false);
    expect(['web', 'phone'].every(isPolicyAckMethod)).toBe(true);
    expect(isPolicyAckMethod('email')).toBe(false);
    expect(isPolicyKind(undefined)).toBe(false);
  });
});

describe('the parser', () => {
  it('reads headings, bullets and paragraphs, and nothing else', () => {
    const body = [
      '# Purpose',
      'This applies to everyone.',
      'A second line of the same paragraph.',
      '',
      '- one',
      '- two',
      'After the list, a paragraph.',
      '# Next',
      '## not a heading',
      '#not a heading either',
      '-not a bullet',
      '* not a bullet',
      '1. not a list',
      '<b>markup</b> and [a link](https://example.test) and **bold**',
    ].join('\n');
    expect(parsePolicyText(body)).toEqual([
      { kind: 'heading', text: 'Purpose' },
      {
        kind: 'paragraph',
        lines: ['This applies to everyone.', 'A second line of the same paragraph.'],
      },
      { kind: 'bullets', items: ['one', 'two'] },
      { kind: 'paragraph', lines: ['After the list, a paragraph.'] },
      { kind: 'heading', text: 'Next' },
      {
        kind: 'paragraph',
        lines: [
          '## not a heading',
          '#not a heading either',
          '-not a bullet',
          '* not a bullet',
          '1. not a list',
          '<b>markup</b> and [a link](https://example.test) and **bold**',
        ],
      },
    ]);
  });

  it('starts a list after a paragraph line, and a "# " or "- " with nothing after is plain text', () => {
    expect(parsePolicyText('Text\n- item')).toEqual([
      { kind: 'paragraph', lines: ['Text'] },
      { kind: 'bullets', items: ['item'] },
    ]);
    // "# " and "- " lose their trailing space in normal form: plain text.
    expect(parsePolicyText('# \n- ')).toEqual([{ kind: 'paragraph', lines: ['#', '-'] }]);
    expect(parsePolicyText('#  Two spaces')).toEqual([{ kind: 'heading', text: ' Two spaces' }]);
    expect(parsePolicyText('')).toEqual([]);
    expect(parsePolicyText('\n\n')).toEqual([]);
  });

  it('normalises first, so a stored body and its raw form give the same blocks', () => {
    expect(parsePolicyText('# A\r\n\r\n\r\n- x \t\r\n')).toEqual(parsePolicyText('# A\n\n- x'));
  });

  it('never throws, and its plain text reads back as the same blocks (2,000 random texts)', () => {
    const r = rng(2482);
    for (let i = 0; i < 2000; i += 1) {
      const body = normalizePolicyBody(randomText(r, 1 + Math.floor(r() * 50)));
      const blocks = parsePolicyText(body);
      const text = policyBlocksToText(blocks);
      expect(parsePolicyText(text)).toEqual(blocks);
      expect(normalizePolicyBody(text)).toBe(text);
      for (const b of blocks) {
        if (b.kind === 'heading') expect(b.text.length).toBeGreaterThan(0);
        if (b.kind === 'paragraph') expect(b.lines.every((l) => l.length > 0)).toBe(true);
        if (b.kind === 'bullets') expect(b.items.every((l) => l.length > 0)).toBe(true);
      }
    }
  });
});

/** `n` combining marks: acute (class 230) and grave below (220) in turn, so out of canonical order. */
const outOfOrder = (n: number) => '\u0301\u0316'.repeat(Math.ceil(n / 2)).slice(0, n);
const ACUTE = '\u0301';
const OL_ONAL_MU = '\u{1E5EE}'; // a mark of Unicode 16.0 (class 230), one the database's Postgres 17 does not know
const OL_ONAL_IKIR = '\u{1E5EF}'; // (class 220)
const UNASSIGNED = '\u0378'; // unassigned in Unicode 17.0

describe('runs of combining marks (review round 2, M2)', () => {
  it('allows 30 marks in a row and refuses 31, in a title and a body, in order or not', () => {
    expect(POLICY_MARK_RUN_MAX).toBe(30);
    // "x" has no precomposed form with these marks, so the in-order text is in normal form.
    expect(policyBodyProblem('x' + ACUTE.repeat(30))).toBeNull();
    expect(policyBodyProblem('x' + ACUTE.repeat(31))).toBe('too_many_marks');
    expect(policyTitleProblem('x' + ACUTE.repeat(30))).toBeNull();
    expect(policyTitleProblem('x' + ACUTE.repeat(31))).toBe('too_many_marks');
    expect(policyBodyProblem('x' + outOfOrder(30))).toBe('not_normal_form');
    expect(policyBodyProblem('x' + outOfOrder(31))).toBe('too_many_marks');
    expect(policyBodyProblem('x' + '\u0316'.repeat(15) + ACUTE.repeat(15))).toBeNull();
    // Runs are counted apart: a letter ends a run; a run at the very start counts too.
    expect(policyBodyProblem('x' + ACUTE.repeat(30) + 'x' + ACUTE.repeat(30))).toBeNull();
    expect(policyBodyProblem(ACUTE.repeat(31))).toBe('too_many_marks');
    expect(findPolicyMarkRun('ab' + ACUTE.repeat(30) + 'c' + ACUTE.repeat(40) + 'd')).toEqual({
      index: 33,
      length: 40,
    });
    expect(findPolicyMarkRun('x' + ACUTE.repeat(30))).toBeNull();
  });

  it('counts the marks of any script, those Postgres 17 does not know, and code points Unicode 17.0 left unassigned', () => {
    expect(policyBodyProblem('x' + OL_ONAL_MU.repeat(30))).toBeNull();
    expect(policyBodyProblem('x' + OL_ONAL_MU.repeat(31))).toBe('too_many_marks');
    expect(policyBodyProblem('x' + OL_ONAL_MU + OL_ONAL_IKIR)).toBe('not_normal_form');
    // The database does not count an unassigned code point; the core does (the stricter side).
    expect(policyBodyProblem('x' + UNASSIGNED.repeat(30))).toBeNull();
    expect(policyBodyProblem('x' + UNASSIGNED.repeat(31))).toBe('too_many_marks');
    // Marks and unassigned code points count together.
    expect(policyBodyProblem('x' + ACUTE.repeat(20) + UNASSIGNED.repeat(11))).toBe(
      'too_many_marks',
    );
    // Tibetan vowel sign II is two marks in normal form: 15 make 30, 16 make 32.
    expect(preparePolicyBody('\u0F40' + '\u0F73'.repeat(15))).toEqual({
      body: '\u0F40' + '\u0F71'.repeat(15) + '\u0F72'.repeat(15),
      problem: null,
    });
    expect(preparePolicyBody('\u0F40' + '\u0F73'.repeat(16)).problem).toBe('too_many_marks');
  });

  it('refuses the marks after the length, the lines and the refused characters, and before the normal form', () => {
    const lines = (n: number) => Array.from({ length: n }, () => 'a').join('\n');
    expect(policyBodyProblem('b'.repeat(30000) + ACUTE.repeat(31))).toBe('too_long');
    expect(policyBodyProblem(lines(601) + ACUTE.repeat(31))).toBe('too_many_lines');
    expect(policyBodyProblem('x\u202e' + ACUTE.repeat(31))).toBe('forbidden_character');
    expect(policyBodyProblem('x' + ACUTE.repeat(31) + ' ')).toBe('too_many_marks');
    expect(policyTitleProblem('t'.repeat(89) + ACUTE.repeat(31))).toBe('too_many_marks');
    expect(policyTitleProblem('t'.repeat(90) + ACUTE.repeat(31))).toBe('too_long');
    expect(policyTitleProblem('x\u200b' + ACUTE.repeat(31))).toBe('forbidden_character');
    expect(policyTitleProblem('x' + ACUTE.repeat(31) + '  y')).toBe('too_many_marks');
  });

  it('counts every listed range at both of its ends, and not the code point beside it', () => {
    expect(POLICY_COMBINING_MARK_RANGES.length).toBe(327);
    for (const [lo, hi] of POLICY_COMBINING_MARK_RANGES) {
      for (const cp of [lo, hi]) {
        const ch = String.fromCodePoint(cp);
        expect(findPolicyMarkRun('x' + ch.repeat(31)), cp.toString(16)).not.toBeNull();
        expect(findPolicyMarkRun('x' + ch.repeat(30)), cp.toString(16)).toBeNull();
      }
      for (const cp of [lo - 1, hi + 1]) {
        if (/[\p{M}\p{Cn}]/u.test(String.fromCodePoint(cp))) continue; // this engine counts it
        expect(
          findPolicyMarkRun('x' + String.fromCodePoint(cp).repeat(31)),
          cp.toString(16),
        ).toBeNull();
      }
    }
  });
});

describe('the writers check the raw text before normalising it', () => {
  it('refuse a raw text over the raw limit as too long, and return it unnormalised', () => {
    expect(POLICY_BODY_RAW_MAX).toBe(32000);
    expect(POLICY_TITLE_RAW_MAX).toBe(240);
    const big = 'e\u0301'.repeat(16001); // 32,002 code points, NFD
    expect(normalizePolicyBody(big)).toBe(big);
    expect(preparePolicyBody(big)).toEqual({ body: big, problem: 'too_long' });
    expect(preparePolicyTitle('t'.repeat(241))).toEqual({
      title: 't'.repeat(241),
      problem: 'too_long',
    });
    expect(normalizePolicyTitle(' '.repeat(241))).toBe(' '.repeat(241));
    // Within the raw limit the text is normalised, then held to 30,000.
    expect(preparePolicyBody('b'.repeat(31000)).problem).toBe('too_long');
    const spaced = ('b'.repeat(45) + '    \r\n').repeat(590) + 'end';
    expect(policyTextLength(spaced)).toBe(30093); // 27,143 in normal form: accepted
    expect(preparePolicyBody(spaced)).toEqual({
      body: ('b'.repeat(45) + '\n').repeat(590) + 'end',
      problem: null,
    });
  });

  it('refuse a raw run of more than 30 marks without normalising, whatever else the text holds', () => {
    const raw = 'a\r\n\tx' + outOfOrder(31);
    expect(normalizePolicyBody(raw)).toBe(raw);
    expect(normalizePolicyTitle(raw)).toBe(raw);
    expect(preparePolicyBody(raw)).toEqual({ body: raw, problem: 'too_many_marks' });
    expect(preparePolicyTitle(raw)).toEqual({ title: raw, problem: 'too_many_marks' });
    // The two refusals stay refusals (normalising is still idempotent on them).
    expect(normalizePolicyBody(normalizePolicyBody(raw))).toBe(raw);
  });

  it("normalise and check everything else, in the database's order", () => {
    expect(preparePolicyBody('  # A\r\n\r\n\r\n- x \t\r\n')).toEqual({
      body: '  # A\n\n- x',
      problem: null,
    });
    expect(preparePolicyBody(' \r\n\t')).toEqual({ body: '', problem: 'empty' });
    expect(preparePolicyBody('a\u200bb')).toEqual({
      body: 'a\u200bb',
      problem: 'forbidden_character',
    });
    expect(preparePolicyTitle('  Data \t handling\npolicy  ')).toEqual({
      title: 'Data handling policy',
      problem: null,
    });
    expect(preparePolicyTitle('Cafe\u0301')).toEqual({ title: 'Café', problem: null });
  });
});

describe('the reader never normalises a long run of marks', () => {
  it('shows each run of more than 30 marks as one replacement character, and normalises the rest', () => {
    expect(parsePolicyText('x' + outOfOrder(40) + 'y\n# T' + ACUTE.repeat(31))).toEqual([
      { kind: 'paragraph', lines: ['x\uFFFDy'] },
      { kind: 'heading', text: 'T\uFFFD' },
    ]);
    // A run of 30, out of order, is put in order (canonical order: 220 before 230).
    expect(parsePolicyText('x' + outOfOrder(30))).toEqual([
      { kind: 'paragraph', lines: ['x' + '\u0316'.repeat(15) + ACUTE.repeat(15)] },
    ]);
    expect(parsePolicyText(UNASSIGNED.repeat(31) + ' z')).toEqual([
      { kind: 'paragraph', lines: ['\uFFFD z'] },
    ]);
  });

  it('reads the body the review stored (Ol Onal marks Postgres 17 does not know) as one character', () => {
    const stored = 'x' + OL_ONAL_MU.repeat(14999) + OL_ONAL_IKIR.repeat(15000);
    expect(policyTextLength(stored)).toBe(30000);
    expect(parsePolicyText(stored)).toEqual([{ kind: 'paragraph', lines: ['x\uFFFD'] }]);
    expect(policyBodyProblem(stored)).toBe('too_many_marks');
  });
});
