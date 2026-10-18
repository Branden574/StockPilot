import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import {
  TOUCHABLE_TAG,
  attr,
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import { palette, type Palette } from './theme';

/**
 * THE RENTAL SCREENS, READ AS SOURCE (redesign package P5.9b).
 *
 * The Rentals list (src/screens/rentals.tsx, also the optional Rentals tab),
 * a rental (app/rentals/[id].tsx) and the checkout (app/rentals/new.tsx) took
 * the redesign's look on the per-mode palette. These pin what had to survive
 * and what changed:
 *
 *   - every word, eyebrow and failure sentence, and the web hand-off;
 *   - the Checkouts / Items switch as the reference's segmented switch, with
 *     the same button role and selected state the chips had;
 *   - a failed read in DataListScreen's `failed` panel (CONFLICTS D25), the
 *     stale banner on the warning wash;
 *   - every control a 44pt target: the checkout's steppers, warehouse
 *     choices, Try again and Change (they were 32-38pt, some with hitSlop),
 *     and the rental's Try again;
 *   - the checkout's text boxes on the shared Field's recipe (muted ink3
 *     labels and hints, the stronger border, named for VoiceOver), and its
 *     item search showing its focus as they do.
 *
 * The behaviour stays pinned where it was: rental-checkout-wiring,
 * rental-detail-wiring, rental-items and rental-screens-a11y. The screens are
 * read with the TypeScript parser (the mobile suite has no React Native
 * renderer), and the colours each names are measured with the palette.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const LIST = 'src/screens/rentals.tsx';
const RENTAL = 'app/rentals/[id].tsx';
const CHECKOUT = 'app/rentals/new.tsx';
const FILES = [LIST, RENTAL, CHECKOUT];

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

/** A StyleSheet entry `  name: { ... }` of a file, as source text. */
function styleBlock(file: string, name: string): string {
  const m = new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(sourceOf(file));
  expect(m, `styles.${name} in ${file}`).not.toBeNull();
  return m![1]!;
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

describe('the per-mode palette on the three rental screens', () => {
  it.each(FILES)('%s: no fixed colours, no single-mode accents, no faint words', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).toContain("import { useTheme } from '@/lib/use-theme';");
    expect(code).not.toMatch(/\bACCENT\b/);
    expect(code).not.toMatch(/\btheme\./);
    expect(code).not.toMatch(/['"`]#[0-9a-f]{3,8}['"`]/i);
    expect(code).not.toMatch(/rgba?\(/);
    // paper2 is the card colour in dark; ink5 and ink4 are under AA as words
    // and placeholders. None of these screens draws an ink4 glyph either.
    expect(code).not.toMatch(/\bc\.(paper2|ink5|ink4)\b/);
  });

  // Mutation caught: a word in a token that is not a text colour.
  it.each(FILES)('%s: every colour given to words or glyphs is a text token', (file) => {
    const TEXT_TOKENS = new Set(['accent', 'critText', 'ink', 'ink2', 'ink3', 'paper', 'warnText']);
    for (const m of codeOnly(sourceOf(file)).matchAll(
      /\b(?:color|placeholderTextColor)=\{[^}]*\}/g,
    )) {
      for (const t of m[0].matchAll(/\bc\.(\w+)/g)) {
        expect(TEXT_TOKENS.has(t[1]!), `${file}: ${m[0]}`).toBe(true);
      }
    }
  });
});

describe('Rentals list', () => {
  const code = flatCode(LIST);

  // Mutation caught: the role, the selected state or the 44pt minimum dropped
  // from a segment; the switch's choice wired to anything but setView.
  it('Checkouts / Items is a segmented switch of two buttons that say which is shown', () => {
    expect(code).not.toContain("from '@/components/ui/chip'");
    expect(code).toContain('const viewSwitch = <ViewSwitch view={view} onChange={setView} />;');
    const { sf, els } = elements(
      LIST,
      (el, s) => attrText(el, 'onPress', s) === '() => onChange(value)',
    );
    expect(els).toHaveLength(1);
    const seg = els[0]!;
    expect(tagOf(seg, sf)).toBe('Pressable');
    expect(attrText(seg, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(seg, 'accessibilityState', sf)).toBe('{ selected: active }');
    expect(code).toContain("{segment('checkouts', 'Checkouts')} {segment('items', 'Items')}");
    expect(code).toContain('const active = view === value;');
    expect(styleBlock(LIST, 'segment')).toMatch(/minHeight: 44,/);
    expect(styleBlock(LIST, 'track')).toMatch(/padding: 3,[\s\S]*borderRadius: 10,/);
    expect(code).toContain("borderColor: active ? c.ink3 : 'transparent',");
    expect(code).toContain('<View style={[styles.track, { backgroundColor: c.sunk }]}>');
    expect(code).toContain('const SEGMENT_CAP = capTo(13, TYPE_CEILING.control);');
  });

  it('both views say a failed read in their own words (D25); the empty words stay the empty words', () => {
    expect(code).toContain(
      "failed={ noWorkspace || current?.failed ? { title: noWorkspace ? RENTAL_LIST_NO_WORKSPACE_TITLE : 'Could not load rental items.', body: 'Check your connection and pull down to try again.', } : null }",
    );
    expect(code).toContain(
      "failed={ noWorkspace || checkoutsFailed ? { title: noWorkspace ? RENTAL_LIST_NO_WORKSPACE_TITLE : 'Could not load rentals.', body: 'Check your connection and pull down to try again.', } : null }",
    );
    expect(code).toContain('emptyTitle="No rental items yet."');
    expect(code).toContain(
      'emptyBody="Rental items are the canopies, supplies and equipment staff check out. Add them on the web under Rentals."',
    );
    expect(code).toContain('emptyTitle="No rentals yet."');
    expect(code).toContain(
      'emptyBody="Check out reusable assets (canopies, supplies, equipment) on the web. Track returns and overdue items here."',
    );
  });

  it('the stale banner: the warning wash, the warning glyph, the words announced', () => {
    expect(code).toContain('<View style={[styles.stale, { backgroundColor: c.warnWash }]}>');
    expect(code).toContain(
      '<Body size={13.5} color={c.warnText} accessibilityRole="alert" style={{ flex: 1 }}> {rentalListStaleCopy(shown.staleReason)} </Body>',
    );
    expect(code).toMatch(/<TriangleAlert size=\{16\} color=\{c\.warnText\}/);
  });

  it("the cards' lines are muted ink3, with their words", () => {
    expect(code).toContain(
      '<Mono size={10.5} tracking={0.18} upper color={c.ink3}> — {rental.warehouse.name} </Mono>',
    );
    expect(code).toContain(
      "<Mono size={11.5} tracking={0.04} color={c.ink3} style={{ marginTop: 4 }}> out {rentalDayLabel(rental.checked_out_at, timeZone)} {' · due '} {rentalDayLabel(rental.expected_return_at, timeZone)} </Mono>",
    );
    expect(code).toContain(
      "{item.sku ?? 'No SKU'} {' · '} {item.onHand} on hand {item.reserved > 0 ? ` · ${item.reserved} out` : ''}",
    );
    for (const w of ['OVER-LENT', 'NONE', 'ALL OUT', ' FREE']) expect(wordsOf(LIST)).toContain(w);
  });
});

describe('Rental', () => {
  const code = flatCode(RENTAL);

  // Mutation caught: Try again back at its 36pt (the style's minHeight gone).
  it('Try again is a 44pt target with the control border', () => {
    expect(styleBlock(RENTAL, 'chip')).toMatch(/minHeight: 44,/);
    expect(code).toContain(
      "styles.chip, { marginTop: 12, alignSelf: 'flex-start', borderColor: c.hair2,",
    );
  });

  it('the email lines, the overdue date and the note take the per-mode tones', () => {
    expect(code).toContain(
      "const color = line.tone === 'recorded' ? c.accent : line.tone === 'warn' ? c.warnText : line.tone === 'upcoming' ? c.ink2 : c.ink3;",
    );
    expect(code).toContain('color={overdue ? c.critText : undefined}');
    expect(code).toContain('color={borrower.email ? undefined : c.warnText}');
    expect(code).toContain(
      '<Mono size={10.5} tracking={0.12} upper color={c.ink3}> {label} </Mono>',
    );
  });

  it('the web hand-off is the secondary button, with its words', () => {
    const { sf, els } = elements(RENTAL, (el, s) => tagOf(el, s) === 'Button');
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'variant', sf)).toBe('outline');
    expect(code).toContain('{webAction}');
    for (const w of [
      'BORROWER',
      'EMAILS TO THE BORROWER',
      'DETAILS',
      'CHECKED OUT',
      'EXPECTED RETURN',
      'RETURNED',
      'CANCELLED',
      'CANCELLATION REASON',
      'RETURN NOTES',
      'NOTES',
      'No items on this rental.',
      'Try again',
      'This rental is not available. It may belong to a warehouse you cannot see.',
      'Back',
    ]) {
      expect(wordsOf(RENTAL), w).toContain(w);
    }
  });
});

describe('Check out', () => {
  const code = flatCode(CHECKOUT);

  // Mutation caught: hitSlop back on any control (a target VoiceOver does
  // not outline, and that loses to a neighbour), or any touchable without a
  // 44pt frame.
  it('every control is a real 44pt target, never hitSlop', () => {
    const { sf, els } = elements(CHECKOUT, (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)));
    expect(els.length).toBeGreaterThan(0);
    for (const el of els) {
      expect(attr(el, 'hitSlop', sf), where(CHECKOUT, el, sf)).toBeUndefined();
      const styles = [...(attrText(el, 'style', sf) ?? '').matchAll(/styles\.(\w+)/g)].map(
        (m) => m[1]!,
      );
      expect(styles.length, where(CHECKOUT, el, sf)).toBeGreaterThan(0);
      const framed = styles.some((name) =>
        /(?:minHeight|height): 44,/.test(styleBlock(CHECKOUT, name)),
      );
      expect(framed, `${where(CHECKOUT, el, sf)} (${styles.join(', ')})`).toBe(true);
    }
    expect(styleBlock(CHECKOUT, 'step')).toMatch(/width: 44,\s*height: 44,/);
    expect(styleBlock(CHECKOUT, 'option')).toMatch(/minHeight: 44,/);
    expect(styleBlock(CHECKOUT, 'action')).toMatch(/minHeight: 44,/);
  });

  it('the steppers keep their names and states, on the stronger border', () => {
    expect(code).toContain(
      'style={[ styles.step, { borderColor: c.hair2, backgroundColor: c.card, opacity: qty === 0 ? 0.35 : 1, }, ]}',
    );
    expect(code).toContain(
      'style={[ styles.step, { borderColor: c.hair2, backgroundColor: c.card, opacity: qty >= avail ? 0.35 : 1, }, ]}',
    );
    expect(code).toContain('<Minus size={16} color={c.ink} strokeWidth={2} />');
    expect(code).toContain('<Plus size={16} color={c.ink} strokeWidth={2} />');
  });

  it('a warehouse choice: the recessed chip, ink when chosen', () => {
    expect(code).toContain(
      'styles.option, { borderColor: active ? c.ink : c.hair2, backgroundColor: active ? c.ink : c.sunk, opacity: pressed ? 0.85 : 1, },',
    );
    expect(code).toContain('color={active ? c.paper : c.ink}');
  });

  // Mutation caught: the old fixed `height: 40` (clipped the typed words at
  // the larger text sizes) or the faint placeholder.
  it('the item search: a bordered box that grows with its words, a muted ink3 hint, named', () => {
    expect(styleBlock(CHECKOUT, 'search')).toMatch(/minHeight: 44,/);
    expect(code).not.toMatch(/\bheight: 40\b/);
    expect(code).toContain('<Search size={14} color={c.ink3} strokeWidth={1.5} />');
    expect(code).toContain(
      'placeholder="Search rental items" placeholderTextColor={c.ink3} autoCapitalize="none" accessibilityLabel="Search rental items"',
    );
  });

  // Mutation caught: the search box back on a constant border (DESIGN-SPEC
  // 6.3: never a search field with no visible focus), or focus and blur not
  // wired to the search's own input.
  it('the item search shows its focus as the text boxes do: the border deepens to ink', () => {
    expect(code).toContain('const [searchFocused, setSearchFocused] = React.useState(false);');
    expect(code).toContain(
      'styles.search, { borderColor: searchFocused ? c.ink : c.hair2, backgroundColor: c.card },',
    );
    const { sf, els } = elements(
      CHECKOUT,
      (el, s) =>
        tagOf(el, s) === 'TextInput' &&
        attrText(el, 'accessibilityLabel', s) === 'Search rental items',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'onFocus', sf)).toBe('() => setSearchFocused(true)');
    expect(attrText(els[0]!, 'onBlur', sf)).toBe('() => setSearchFocused(false)');
    expect(attrText(els[0]!, 'onChangeText', sf)).toBe('setSearch');
  });

  it("the text boxes: the shared Field's recipe, named by their label, focus and blur still reach the caller", () => {
    const fn = code.slice(code.indexOf('function Field('));
    expect(fn).toContain('<Mono size={10} tracking={0.12} upper color={c.ink3}> {label} </Mono>');
    expect(fn).toContain('<TextInput accessibilityLabel={label} {...rest}');
    expect(fn).toContain('onBlur?.(e);');
    expect(fn).toContain('onFocus?.(e);');
    expect(fn).toContain('placeholderTextColor={c.ink3}');
    expect(fn).toContain('borderColor: focused ? c.ink : c.hair2,');
    expect(fn).toContain('backgroundColor: c.card,');
    // Typed words stay uncapped (the Dynamic Type policy): no cap is set.
    expect(fn).not.toContain('maxFontSizeMultiplier');
  });

  it('the warnings are the per-mode warning tone; the section labels muted ink3', () => {
    expect(code).toContain(
      '<Body size={12} color={c.warnText}> {BORROWER_EMAIL_FORMAT_ERROR} </Body>',
    );
    expect(code).toContain('<Body size={13} color={c.warnText}> {message} </Body>');
    expect(code).toContain(
      '<Mono size={10.5} tracking={0.12} upper color={c.ink3}> {label} </Mono>',
    );
    expect(code).toContain(
      '<Mono size={10.5} tracking={0.18} upper color={c.ink3}> RETURN BY </Mono>',
    );
    expect(code).toContain("{it.sku ? `${it.sku} · ` : ''} {avail} AVAILABLE");
  });

  it('every word stays', () => {
    const words = wordsOf(CHECKOUT);
    for (const w of [
      'RENTALS · NEW CHECKOUT',
      'Check',
      'out.',
      'WAREHOUSE',
      'Could not load warehouses.',
      'No active warehouses to check out from. Add one on the web first.',
      'Search rental items',
      'Choose a warehouse above to see its rental items.',
      'Could not load rental items.',
      'No rental items in this warehouse. Mark an item as a rental on the web first.',
      'No rental items match that search.',
      'AVAILABLE',
      'BORROWER',
      'FULL NAME',
      'Search team members, or type anyone’s name',
      'EMAIL (OPTIONAL)',
      'borrower@company.com',
      'They do not need a StockPilot account.',
      'EXPECTED RETURN',
      'DAYS FROM TODAY',
      'RETURN BY',
      'NOTES',
      'ANY CONTEXT (OPTIONAL)',
      'Check out',
      'Saving…',
      'Cancel',
      'Try again',
      'Change',
      'Change borrower',
      'Looking up team members…',
      'Try loading team members again',
      'You do not have permission to check out rentals.',
    ]) {
      expect(words, w).toContain(w);
    }
  });
});

/**
 * WCAG contrast of every word and mark these screens draw, in both modes
 * (AA: 4.5:1 for words, 3:1 for glyphs and marks).
 */
describe('contrast, both modes', () => {
  const WORDS: [keyof Palette, keyof Palette, string][] = [
    ['ink', 'card', 'names, the selected segment, typed words'],
    ['ink3', 'card', 'labels, hints, meta lines, placeholders'],
    ['ink3', 'paper', 'eyebrows'],
    ['ink3', 'sunk', 'an idle segment'],
    ['ink2', 'card', 'Try again, Change, an upcoming email line'],
    ['ink', 'sunk', 'an idle warehouse choice'],
    ['paper', 'ink', 'the chosen warehouse'],
    ['warnText', 'card', 'the email error, a failed read, the no-email note'],
    ['warnText', 'warnWash', 'the stale banner'],
    ['critText', 'card', 'an overdue expected return'],
  ];
  const MARKS: [keyof Palette, keyof Palette, string][] = [
    ['ink3', 'sunk', 'the selected segment ring'],
    ['accent', 'card', 'an email recorded as sent'],
    ['warnText', 'card', 'an email warning'],
    ['ink3', 'card', 'no email, the search glyph'],
    ['ink', 'card', 'the stepper glyphs, the border of a focused text box or search'],
    ['warnText', 'warnWash', "the stale banner's glyph"],
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
});
