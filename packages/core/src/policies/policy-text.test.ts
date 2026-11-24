import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_POLICY_CODE_POINTS,
  POLICY_BODY_MAX,
  POLICY_BODY_MAX_LINES,
  POLICY_TITLE_MAX,
  findForbiddenPolicyCharacter,
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
