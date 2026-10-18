import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import {
  TOUCHABLE_TAG,
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { palette, type Palette } from './theme';

/**
 * THE STAGING WORKLIST, READ AS SOURCE (redesign package P5.9b).
 *
 * app/(drawer)/staging.tsx took the redesign's look on the per-mode palette:
 * informational words in muted ink3 or stronger (they were the faint ink4 at
 * 3.0-3.6:1), the per-mode refusal tone for a failed load and a stale age,
 * the All / Books / Items filter as the reference's segmented switch, History
 * and Place at the 44pt minimum, the order chip as a recessed panel whose two
 * actions carry the control border. These pin that look and every word.
 *
 * What the screen does stays pinned where it was: staging-screen-wiring
 * (the shared endpoint, Place through the transfer route, the server's
 * canPlace, the shared formatters), order-f2-3-wiring (put away from an
 * order, Back to the order) and item-history-wiring (History on every row).
 * The screen is read with the TypeScript parser (the mobile suite has no
 * React Native renderer), and its colours are measured with the palette.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const STAGING = 'app/(drawer)/staging.tsx';

const MODES: [string, Palette][] = [
  ['light', palette('light')],
  ['dark', palette('dark')],
];

function sourceOf(file: string): string {
  return readSource(path.join(MOBILE_ROOT, file));
}

function treeOf(file: string): ts.SourceFile {
  return parseTsx(sourceOf(file), file);
}

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The same, with every run of whitespace made one space. */
function flatCode(file: string): string {
  return codeOnly(sourceOf(file)).replace(/\s+/g, ' ');
}

/** Every element of a file that matches, with the tree it came from. */
function elements(file: string, match: (el: JsxNode, sf: ts.SourceFile) => boolean) {
  const sf = treeOf(file);
  const els: JsxNode[] = [];
  walkJsx(sf, (el) => {
    if (match(el, sf)) els.push(el);
  });
  return { sf, els };
}

function where(file: string, el: JsxNode, sf: ts.SourceFile): string {
  const { line } = sf.getLineAndCharacterOfPosition(el.getStart(sf));
  return `${file}:${line + 1} <${tagOf(el, sf)}>`;
}

/** Everything a person can read or hear in a file: JSX text and literals. */
function wordsOf(file: string): string[] {
  const sf = treeOf(file);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const t = n.getText(sf).replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text);
    } else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** A StyleSheet entry `  name: { ... }` of a file, as source text. */
function styleBlock(file: string, name: string): string {
  const m = new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(sourceOf(file));
  expect(m, `styles.${name} in ${file}`).not.toBeNull();
  return m![1]!;
}

describe('the per-mode palette', () => {
  it('no fixed colours, no single-mode accents, no legacy theme, no well on paper2', () => {
    const code = codeOnly(sourceOf(STAGING));
    expect(code).toContain("import { useTheme } from '@/lib/use-theme';");
    expect(code).not.toMatch(/\bACCENT\b/);
    expect(code).not.toMatch(/\btheme\./);
    expect(code).not.toMatch(/['"`]#[0-9a-f]{3,8}['"`]/i);
    expect(code).not.toMatch(/rgba?\(/);
    expect(code).not.toMatch(/\bc\.(paper2|ink5)\b/);
  });

  // Mutation caught: any word put back in c.ink4 (the SKU, TO PLACE, the age,
  // the disabled-Place reason, a card label).
  it('the faint ink4 colours the empty-state glyph only, never words', () => {
    const code = codeOnly(sourceOf(STAGING));
    expect((code.match(/\bc\.ink4\b/g) ?? []).length).toBe(1);
    expect(code).toContain('<LayoutList size={32} color={c.ink4} strokeWidth={1.3} />');
  });

  it('every colour given to words or glyphs is a text token of the palette', () => {
    const TEXT_TOKENS = new Set(['critText', 'ink', 'ink2', 'ink3', 'ink4']);
    for (const m of codeOnly(sourceOf(STAGING)).matchAll(/\bcolor=\{[^}]*\}/g)) {
      for (const t of m[0].matchAll(/\bc\.(\w+)/g)) {
        expect(TEXT_TOKENS.has(t[1]!), m[0]).toBe(true);
      }
    }
  });
});

describe('VoiceOver', () => {
  // Mutation caught: the row's role or hint dropped (it had neither before
  // this package: VoiceOver read the card's words with no trait).
  it('a row is a button that says it opens the item', () => {
    const { sf, els } = elements(
      STAGING,
      (el, s) => tagOf(el, s) === 'Pressable' && attrText(el, 'onPress', s) === 'onOpenItem',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(els[0]!, 'accessibilityHint', sf)).toBe('Opens the item');
  });

  it('every touchable is a button', () => {
    const { sf, els } = elements(STAGING, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    expect(els.length).toBeGreaterThan(0);
    for (const el of els) {
      expect(attrText(el, 'accessibilityRole', sf), where(STAGING, el, sf)).toBe('button');
    }
  });
});

describe('the worklist', () => {
  const code = flatCode(STAGING);

  // Mutation caught: the segment's minHeight dropped (the old chips were
  // about 32pt), or the selected ring back on the 1.4:1 hairline.
  it('the All / Books / Items filter is the segmented switch: 44pt segments, a 3:1 ring, a semibold choice', () => {
    expect(styleBlock(STAGING, 'segment')).toMatch(/minHeight: MIN_TAP,/);
    expect(styleBlock(STAGING, 'filterRow')).toMatch(/padding: 3,[\s\S]*borderRadius: 10,/);
    expect(code).toContain('<View style={[styles.filterRow, { backgroundColor: c.sunk }]}>');
    expect(code).toContain(
      "style={({ pressed }) => [ styles.segment, { borderColor: active ? c.ink3 : 'transparent', backgroundColor: active ? c.card : 'transparent', opacity: pressed ? 0.7 : 1, }, ]}",
    );
    expect(code).toContain(
      '<Body size={13} color={active ? c.ink : c.ink3} maxFontSizeMultiplier={SEGMENT_CAP} style={[styles.segmentLabel, active && styles.segmentLabelOn]} > {opt.label} </Body>',
    );
    expect(code).toContain('const SEGMENT_CAP = capTo(13, TYPE_CEILING.control);');
    expect(code).toContain('segmentLabelOn: { fontFamily: FONT.displaySemi },');
  });

  it('History and Place are 44pt targets (the shared small button is 36pt)', () => {
    expect(code).toContain('const TAP = { minHeight: MIN_TAP };');
    expect(code).toContain("import { MIN_TAP } from '@/components/item-verification-card';");
    const { sf, els } = elements(STAGING, (el, s) => tagOf(el, s) === 'Button');
    expect(els.map((el) => attrText(el, 'size', sf))).toEqual(['sm', 'sm', 'sm']);
    expect(els.map((el) => attrText(el, 'style', sf))).toEqual(['TAP', 'TAP', 'TAP']);
    expect(styleBlock(STAGING, 'footer')).toMatch(/minHeight: MIN_TAP,/);
  });

  it('a failed load is said in the refusal tone and announced; the cells keep their words', () => {
    expect(code).toContain(
      '<Body size={13} color={c.critText} accessibilityRole="alert"> {error} </Body>',
    );
    expect(code).toContain('<Mono size={11.5} color={stale ? c.critText : c.ink3}> {age} </Mono>');
    expect(code).toContain(
      "<Mono size={11} color={c.ink3} style={{ textAlign: 'right' }}> {disabledReason} </Mono>",
    );
    expect(code).toContain('<Mono size={10} tracking={0.12} upper color={c.ink3}> {label} </Mono>');
    const words = wordsOf(STAGING);
    for (const w of [
      'PUT AWAY',
      'Staging',
      'worklist.',
      'TO PLACE',
      'SOURCE PO / RECEIPT',
      'RECEIVED',
      'WAREHOUSE',
      'History',
      'Place',
      'Pull down to try again.',
      'Nothing to place.',
      'Received (staged) or unplaced stock appears here.',
      'Shows every item in Staging',
      'Returns to the order',
      'Could not load the staging worklist.',
      'Back',
      'Open menu',
    ]) {
      expect(words, w).toContain(w);
    }
  });

  it('the order chip: a recessed panel; its two actions are controls (the stronger border)', () => {
    const fn = code.slice(code.indexOf('function StagingFilterChipCard('));
    expect(fn).toContain('borderColor: c.hair2, backgroundColor: c.card,');
    expect(fn).toContain('backgroundColor: c.sunk,');
  });
});

/**
 * WCAG contrast of every word and mark the worklist draws, in both modes
 * (AA: 4.5:1 for words, 3:1 for glyphs and marks).
 */
describe('contrast, both modes', () => {
  const WORDS: [keyof Palette, keyof Palette, string][] = [
    ['ink', 'card', 'names, quantities, card values'],
    ['ink2', 'card', 'card values (the shared formatters)'],
    ['ink3', 'card', 'the SKU, TO PLACE, card labels, the age, the disabled-Place reason'],
    ['ink3', 'paper', 'the eyebrow, the invalid-link note, Pull down to try again.'],
    ['ink', 'card', "the selected segment's words"],
    ['ink3', 'sunk', "an idle segment, the order chip's notes"],
    ['ink', 'sunk', "the order chip's headline"],
    ['ink2', 'sunk', "the order chip's empty sentence"],
    ['critText', 'paper', 'the load error'],
    ['critText', 'card', 'a stale age'],
  ];
  const MARKS: [keyof Palette, keyof Palette, string][] = [
    ['ink3', 'sunk', 'the selected segment ring'],
    ['ink', 'card', 'the History glyph'],
    ['ink4', 'paper', 'the empty-state glyph'],
  ];

  it.each(MODES)('%s: words at 4.5:1 or more', (_mode, c) => {
    for (const [fg, bg, what] of WORDS) {
      expect(contrast(c[fg], c[bg]), `${fg} on ${bg}: ${what}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it.each(MODES)('%s: marks at 3:1 or more', (_mode, c) => {
    for (const [fg, bg, what] of MARKS) {
      expect(contrast(c[fg], c[bg]), `${fg} on ${bg}: ${what}`).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  // Why the ring is ink3: the faint ink4 is just under 3:1 on the light
  // track, and the reference's hairline ring far under it.
  it('the light track would not carry an ink4 or hairline ring', () => {
    const light = palette('light');
    expect(contrast(light.ink4, light.sunk)).toBeLessThan(AA_UI);
    expect(contrast(light.hair2, light.sunk)).toBeLessThan(AA_UI);
  });
});
