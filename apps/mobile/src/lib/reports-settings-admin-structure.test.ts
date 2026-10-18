import * as path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { AA_TEXT, AA_UI, contrast } from '../components/ui/__fixtures__/contrast';
import { BUTTON_RADIUS, PHOTO_BACKGROUND, buttonTone } from '../components/ui/tones';
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
 * THE PHONE REPORTS, SETTINGS AND ADMIN SCREENS, READ AS SOURCE (redesign
 * package P5.10b: the Reports hub, Book Order Totals and its sheets, Settings
 * and its four pages, and the eight admin screens).
 *
 * These screens moved onto the per-mode palette: no single-mode accent for a
 * word or a fill, no faint ink for a word, a recessed fill (sunk) for a well
 * on a card, the stronger border on a control, the shared checkbox in the
 * report's status rows. The look is all that moved. These pin what had to
 * survive it (every word, spoken name, role and state, the gates and the
 * flows) and the defects fixed on the way, and measure every colour pair the
 * screens now draw, in both modes.
 *
 * The mobile suite has no React Native renderer, so the screens are read with
 * the TypeScript parser, the way scanner-structure.test.ts and
 * header-chip-a11y.test.ts read theirs, and the colours each screen names are
 * measured with the palette they come from.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

const LIGHT = palette('light');
const DARK = palette('dark');
const MODES: [string, Palette][] = [
  ['light', LIGHT],
  ['dark', DARK],
];

const REPORTS_HUB = 'src/screens/reports.tsx';
const BOT_LIST = 'app/reports/book-order-totals/index.tsx';
const BOT_ORDERS = 'app/reports/book-order-totals/[itemId].tsx';
const SHEET_PARTS = 'src/components/book-order-sheet-parts.tsx';
const CHARTER_SHEET = 'src/components/book-order-charter-sheet.tsx';
const DATES_SHEET = 'src/components/book-order-dates-sheet.tsx';
const FILTERS_SHEET = 'src/components/book-order-filters-sheet.tsx';
const EXPORT_SHEET = 'src/components/book-order-export-sheet.tsx';
const BOOK_COVER = 'src/components/book-cover.tsx';

const REPORT_FILES = [
  REPORTS_HUB,
  BOT_LIST,
  BOT_ORDERS,
  SHEET_PARTS,
  CHARTER_SHEET,
  DATES_SHEET,
  FILTERS_SHEET,
  EXPORT_SHEET,
  BOOK_COVER,
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

/** One file's code with every run of white space made one space. */
function flatCode(file: string): string {
  return codeOnly(sourceOf(file)).replace(/\s+/g, ' ');
}

/** The declaration of `function name(...)`, comments dropped. */
function functionNamed(
  file: string,
  name: string,
): { sf: ts.SourceFile; fn: ts.FunctionDeclaration } {
  const sf = treeOf(file);
  let fn: ts.FunctionDeclaration | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) fn = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(fn, `function ${name} not found in ${file}`).not.toBeNull();
  return { sf, fn: fn! };
}

/** Every JSX element under `root` with its JSX ancestors (outermost first). */
function elementsIn(root: ts.Node): { el: JsxNode; ancestors: JsxNode[] }[] {
  const out: { el: JsxNode; ancestors: JsxNode[] }[] = [];
  walkJsx(root, (el, ancestors) => out.push({ el, ancestors: [...ancestors] }));
  return out;
}

/** The words an element shows: its JSX text, children joined. */
function textOf(el: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.getText(sf).trim());
    ts.forEachChild(n, visit);
  };
  visit(el);
  return parts.filter(Boolean).join(' ');
}

/** Named imports a file takes from lib/theme. */
function themeImports(file: string): string[] {
  const sf = treeOf(file);
  const names: string[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    if (st.moduleSpecifier.text !== '@/lib/theme') continue;
    const b = st.importClause?.namedBindings;
    if (b && ts.isNamedImports(b))
      for (const el of b.elements) names.push((el.propertyName ?? el.name).text);
  }
  return names;
}

/** The modules a file imports from. */
function importsOf(file: string): string[] {
  return treeOf(file)
    .statements.filter(ts.isImportDeclaration)
    .map((st) => (st.moduleSpecifier as ts.StringLiteral).text);
}

/**
 * Where each read of `c.<token>` sits: `<tag>.<prop>`, the JSX element that
 * takes it and the attribute or style key it is given to; `?` when it is not
 * inside a JSX element (a variable worked out before the return).
 */
function tokenSites(file: string, token: keyof Palette): string[] {
  const sf = treeOf(file);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'c' &&
      n.name.text === token
    ) {
      let key = '?';
      let tag = '?';
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (key === '?' && (ts.isPropertyAssignment(p) || ts.isJsxAttribute(p))) {
          key = p.name.getText(sf);
        }
        if (ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) {
          tag = p.tagName.getText(sf);
          break;
        }
        if (ts.isJsxElement(p)) break;
      }
      out.push(`${tag}.${key}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.sort();
}

/** The text primitives a screen writes words with. */
const TEXT_TAGS = new Set(['Body', 'Mono', 'Display', 'Eyebrow', 'FieldLabel', 'Text', 'Em']);

/**
 * Every colour a word is given in a file, as source: the `color` of a text
 * primitive, a `color:` inside its style, and every placeholder colour.
 */
function wordColours(file: string): string[] {
  const sf = treeOf(file);
  const out: string[] = [];
  walkJsx(sf, (el) => {
    const tag = tagOf(el, sf);
    if (TEXT_TAGS.has(tag)) {
      const colour = attrText(el, 'color', sf);
      if (colour !== undefined) out.push(colour);
      const style = attrText(el, 'style', sf) ?? '';
      for (const m of style.matchAll(/\bcolor: ([^,}\]]+)/g)) out.push(m[1]!.trim());
    }
    const placeholder = attrText(el, 'placeholderTextColor', sf);
    if (placeholder !== undefined) out.push(placeholder);
  });
  return out;
}

/** A faint ink, or a mode-independent accent, named in a colour expression. */
const FAINT_OR_SINGLE_MODE = /\bc\.ink[45]\b|\bACCENT\.|#[0-9a-f]{3,8}\b|rgba?\(/i;

/** The `name: {...}` block of a StyleSheet in the source, as text. */
function styleBlock(file: string, name: string): string {
  const src = codeOnly(sourceOf(file));
  const m = new RegExp(`\\n\\s*${name}: \\{([^}]*)\\}`).exec(src);
  expect(m, `${file} has no style ${name}`).not.toBeNull();
  return m![1]!;
}

// ── Book Order Totals: the shared option row (P2.5b hand-off) ────────────

describe('Book Order Totals sheets: the option row', () => {
  const { sf, fn } = functionNamed(SHEET_PARTS, 'OptionRow');
  const els = elementsIn(fn);
  const row = els.find((n) => tagOf(n.el, sf) === 'Pressable')!;

  it('the row is the one press target, announced as a radio or a checkbox with its state, as before', () => {
    expect(els.filter((n) => TOUCHABLE_TAG.test(tagOf(n.el, sf)))).toHaveLength(1);
    expect(attrText(row.el, 'accessibilityRole', sf)).toBe(
      "kind === 'radio' ? 'radio' : 'checkbox'",
    );
    expect(attrText(row.el, 'accessibilityState', sf)).toBe(
      "kind === 'radio' ? { selected } : { checked: selected }",
    );
    expect(attrText(row.el, 'accessibilityLabel', sf)).toBe(
      'detail ? `${label}. ${detail}` : label',
    );
    expect(attrText(row.el, 'onPress', sf)).toBe('onPress');
    expect(styleBlock(SHEET_PARTS, 'option')).toMatch(/minHeight: SHEET_MIN_TAP,/);
    expect(sourceOf(SHEET_PARTS)).toContain('export const SHEET_MIN_TAP = 44;');
  });

  it('a check row draws the shared CheckboxMark, inside the row, with the row state', () => {
    const marks = els.filter((n) => tagOf(n.el, sf) === 'CheckboxMark');
    expect(marks).toHaveLength(1);
    expect(attrText(marks[0]!.el, 'checked', sf)).toBe('selected');
    expect(marks[0]!.ancestors).toContain(row.el);
    expect(importsOf(SHEET_PARTS)).toContain('@/components/ui/checkbox');
    // The hand-drawn box and its tick are gone.
    expect(importsOf(SHEET_PARTS)).not.toContain('lucide-react-native');
    expect(flatCode(SHEET_PARTS)).toContain(
      "{kind === 'check' ? ( <CheckboxMark checked={selected} /> ) : (",
    );
  });

  it('a radio is a 22pt ring: the ink4 mark edge when clear, the ink ring and dot when chosen', () => {
    expect(flatCode(SHEET_PARTS)).toContain(
      '<View style={[styles.radio, { borderColor: selected ? c.ink : c.ink4 }]}> {selected ? <View style={[styles.radioFill, { backgroundColor: c.ink }]} /> : null}',
    );
    const ring = styleBlock(SHEET_PARTS, 'radio');
    expect(ring).toMatch(/width: 22,\s*height: 22,\s*borderRadius: 11,\s*borderWidth: 1\.5,/);
    // The faint ink5 edge (1.8-2.1:1) is gone from the file.
    expect(tokenSites(SHEET_PARTS, 'ink5')).toEqual([]);
    expect(tokenSites(SHEET_PARTS, 'ink4')).toEqual(['View.borderColor']);
  });

  it.each(MODES)(
    '%s: both clear edges and the chosen dot stand out at 3:1 on the card and the page',
    (_m, p) => {
      for (const ground of [p.card, p.paper]) {
        expect(contrast(p.ink4, ground)).toBeGreaterThanOrEqual(AA_UI);
        expect(contrast(p.ink, ground)).toBeGreaterThanOrEqual(AA_UI);
      }
      // Before: the ink5 edge, under 3:1 on both grounds in both modes.
      expect(contrast(p.ink5, p.card)).toBeLessThan(AA_UI);
      expect(contrast(p.ink5, p.paper)).toBeLessThan(AA_UI);
    },
  );

  it('the measured ratios, both modes', () => {
    const r = (a: string, b: string) => Math.round(contrast(a, b) * 100) / 100;
    expect([r(LIGHT.ink4, LIGHT.card), r(LIGHT.ink4, LIGHT.paper)]).toEqual([3.33, 3.18]);
    expect([r(DARK.ink4, DARK.card), r(DARK.ink4, DARK.paper)]).toEqual([3.43, 3.61]);
  });
});

// ── Book Order Totals: the four sheets ───────────────────────────────────

describe('Book Order Totals sheets: the per-mode palette', () => {
  it.each([CHARTER_SHEET, DATES_SHEET, FILTERS_SHEET, EXPORT_SHEET, SHEET_PARTS])(
    '%s takes no single-mode accent and no faint ink for a word',
    (file) => {
      expect(themeImports(file)).not.toContain('ACCENT');
      expect(themeImports(file)).not.toContain('theme');
      expect(wordColours(file).filter((x) => FAINT_OR_SINGLE_MODE.test(x))).toEqual([]);
    },
  );

  it('the refusals take the per-mode refusal red, the offline line the warning words', () => {
    expect(flatCode(DATES_SHEET)).toContain(
      '<Body size={12.5} color={c.critText} accessibilityRole="alert"> {problems.dates} </Body>',
    );
    expect(flatCode(DATES_SHEET)).toContain('borderColor: invalid ? c.critText : c.hair2,');
    expect(flatCode(FILTERS_SHEET)).toContain(
      '<Body size={13} color={c.critText} accessibilityRole="alert"> {problems.status} </Body>',
    );
    expect(flatCode(EXPORT_SHEET)).toContain(
      '<Body size={13.5} color={c.warnText} accessibilityRole="alert"> {BOOK_REPORT_EXPORT_OFFLINE} </Body>',
    );
    expect(flatCode(EXPORT_SHEET)).toContain(
      '<Body size={13.5} color={c.critText} accessibilityRole="alert"> {error} </Body>',
    );
  });

  it('the charter search, the date tiles and the typed dates are wells: the recessed fill and the control border', () => {
    expect(flatCode(CHARTER_SHEET)).toContain(
      '<View style={[styles.searchBox, { backgroundColor: c.sunk, borderColor: c.hair2 }]}> <Search size={16} color={c.ink3} strokeWidth={1.4} />',
    );
    expect(flatCode(CHARTER_SHEET)).toContain('placeholderTextColor={c.ink3}');
    expect(flatCode(DATES_SHEET)).toContain(
      'borderColor: editing === which ? c.ink : c.hair2, borderWidth: editing === which ? 1.5 : 1, backgroundColor: c.sunk,',
    );
    expect(flatCode(DATES_SHEET)).toContain('color={tile.chosen ? c.ink : c.ink3}');
    expect(flatCode(DATES_SHEET)).toContain('placeholderTextColor={c.ink3}');
    expect(flatCode(DATES_SHEET)).toContain(
      'borderColor: invalid ? c.critText : c.hair2, backgroundColor: c.sunk, fontFamily: FONT.mono,',
    );
  });

  it('each export format is the outline button recipe at 52pt: the card fill, the control border, radius 14', () => {
    expect(flatCode(EXPORT_SHEET)).toContain(
      '{ borderColor: c.hair2, backgroundColor: c.card, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },',
    );
    expect(styleBlock(EXPORT_SHEET, 'choice')).toMatch(
      /minHeight: 52,[\s\S]*borderRadius: BUTTON_RADIUS\.md,/,
    );
    expect(BUTTON_RADIUS.md).toBe(14);
    for (const [, p] of MODES) {
      const outline = buttonTone('outline', p);
      expect(outline.bg).toBe(p.card);
      expect(outline.border).toBe(p.hair2);
    }
  });

  it.each(MODES)('%s: every pair the sheets draw reads at AA', (_m, p) => {
    // Rows, headings and details on the sheet's card.
    for (const t of [p.ink, p.ink3, p.critText, p.warnText])
      expect(contrast(t, p.card)).toBeGreaterThanOrEqual(AA_TEXT);
    // Typed words, placeholders and an unchosen tile in a well.
    for (const t of [p.ink, p.ink3]) expect(contrast(t, p.sunk)).toBeGreaterThanOrEqual(AA_TEXT);
    // The search glyph in its well, and the invalid date's edge on the card.
    expect(contrast(p.ink3, p.sunk)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast(p.critText, p.card)).toBeGreaterThanOrEqual(AA_UI);
    // The tile being edited: its ink edge on the well.
    expect(contrast(p.ink, p.sunk)).toBeGreaterThanOrEqual(AA_UI);
  });

  it('the scrims, headings, close buttons and Apply are unchanged', () => {
    for (const file of [CHARTER_SHEET, DATES_SHEET, FILTERS_SHEET, EXPORT_SHEET]) {
      expect(flatCode(file)).toContain(
        "backgroundColor: mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'",
      );
    }
    expect(flatCode(CHARTER_SHEET)).toContain('accessibilityLabel="Close charter choices"');
    expect(flatCode(DATES_SHEET)).toContain('accessibilityLabel="Close date choices"');
    expect(flatCode(FILTERS_SHEET)).toContain('accessibilityLabel="Close filters"');
    expect(flatCode(EXPORT_SHEET)).toContain('accessibilityLabel="Close export"');
    expect(flatCode(FILTERS_SHEET)).toContain(
      'onPress={() => setDraft(resetBookReportDraft(draft))}',
    );
    expect(flatCode(FILTERS_SHEET)).toMatch(/<Button onPress=\{apply\} disabled=\{!valid\}/);
    expect(flatCode(DATES_SHEET)).toMatch(/<Button onPress=\{apply\} disabled=\{!complete\}/);
  });
});

// ── Book Order Totals: covers ────────────────────────────────────────────

describe('Book Order Totals: covers on the photo ground', () => {
  it('a cover sits on the photo ground (white in both modes); the placeholder on the recessed fill', () => {
    expect(flatCode(BOOK_COVER)).toContain(
      'backgroundColor: showImage ? PHOTO_BACKGROUND : c.sunk,',
    );
    expect(flatCode(BOOK_COVER)).toContain('borderColor: c.hair,');
    expect(flatCode(BOOK_COVER)).toContain(
      '<BookOpen size={Math.round(width * 0.42)} color={c.ink3} strokeWidth={1.4} />',
    );
    expect(PHOTO_BACKGROUND).toBe('#ffffff');
    expect(tokenSites(BOOK_COVER, 'paper2')).toEqual([]);
    expect(tokenSites(BOOK_COVER, 'ink4')).toEqual([]);
  });

  it.each(MODES)('%s: the placeholder glyph stands out from its fill at 3:1', (_m, p) => {
    expect(contrast(p.ink3, p.sunk)).toBeGreaterThanOrEqual(AA_UI);
  });

  it('keeps contain, the spoken names and the failure swap', () => {
    const cover = flatCode(BOOK_COVER);
    expect(cover).toContain('contentFit="contain"');
    expect(cover).toContain(
      'accessibilityLabel={bookCoverPlaceholderLabel({ uri, failedUri, failed })}',
    );
    expect(cover).toContain(
      'accessibilityRole="imagebutton" accessibilityLabel={bookCoverAlt(title)}',
    );
    expect(cover).toContain('accessibilityHint="Opens the cover larger"');
    expect(cover).toContain('onError={() => setFailedUri(uri)}');
  });
});

// ── Book Order Totals: the list and the orders behind a book ─────────────

describe('Book Order Totals screens: the per-mode palette', () => {
  it.each([BOT_LIST, BOT_ORDERS])(
    '%s gives no word a faint ink or a single-mode accent',
    (file) => {
      expect(themeImports(file)).not.toContain('ACCENT');
      expect(wordColours(file).filter((x) => FAINT_OR_SINGLE_MODE.test(x))).toEqual([]);
      expect(tokenSites(file, 'ink4')).toEqual([]);
      expect(tokenSites(file, 'ink5')).toEqual([]);
      expect(tokenSites(file, 'paper2')).toEqual([]);
    },
  );

  it('the search box is the reference toolbar search: the card fill, the control border, a muted icon and placeholder', () => {
    const list = flatCode(BOT_LIST);
    expect(list).toContain(
      '<View style={[styles.searchBox, { backgroundColor: c.card, borderColor: c.hair2 }]}> <Search size={16} color={c.ink3} strokeWidth={1.4} />',
    );
    expect(list).toContain('placeholder="Title, SKU or ISBN" placeholderTextColor={c.ink3}');
  });

  it('a chip at its default is the recessed fill with the control border; a set filter the card with the muted-ink edge', () => {
    expect(flatCode(BOT_LIST)).toContain(
      '{ borderColor: set ? c.ink3 : c.hair2, backgroundColor: set ? c.card : c.sunk },',
    );
  });

  it.each(MODES)('%s: the chips, the search and the rows read at AA', (_m, p) => {
    // Chip words on either fill, search words on the card, rows on the card.
    for (const ground of [p.sunk, p.card])
      expect(contrast(p.ink, ground)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(p.ink3, p.card)).toBeGreaterThanOrEqual(AA_TEXT);
    // A set chip's edge on the page: what tells it from an unset one.
    expect(contrast(p.ink3, p.paper)).toBeGreaterThanOrEqual(AA_UI);
    // The book's place line (it was the faint ink4) on the card and the page.
    expect(contrast(p.ink3, p.paper)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("the book's place line is the muted ink on the list and the drill-down", () => {
    expect(flatCode(BOT_LIST)).toContain(
      '{place ? ( <Mono size={11.5} color={c.ink3} style={{ marginTop: 2 }}> {place} </Mono> ) : null}',
    );
    expect(flatCode(BOT_ORDERS)).toContain(
      '{place ? ( <Mono size={12} color={c.ink3}> {place} </Mono> ) : null}',
    );
  });

  it('keeps the eyebrows, the title, the search words and the export and refresh chips', () => {
    const list = flatCode(BOT_LIST);
    expect(list).toContain('<Eyebrow>REPORTS</Eyebrow>');
    expect(list).toContain('{BOOK_REPORT_TITLE}');
    expect(list).toContain('accessibilityLabel="Search books"');
    expect(list).toContain(
      'accessibilityHint="Searches title, SKU and ISBN across the whole report"',
    );
    expect(list).toContain(
      '<IconChip icon={RefreshCw} onPress={onRefresh} accessibilityLabel="Refresh" minTap />',
    );
    expect(list).toContain(
      '<IconChip icon={Download} onPress={onExport} accessibilityLabel="Export" minTap />',
    );
    expect(flatCode(BOT_ORDERS)).toContain('<Eyebrow>BOOK ORDER TOTALS · ORDERS</Eyebrow>');
  });
});

// ── The Reports hub ──────────────────────────────────────────────────────

describe('Reports hub: the look', () => {
  const hub = flatCode(REPORTS_HUB);

  it('no glow: MintWash is gone, and the hero card is the flat card', () => {
    expect(importsOf(REPORTS_HUB)).not.toContain('@/components/ui/mint-wash');
    expect(hub).not.toContain('MintWash');
    expect(hub).not.toContain('washPos');
    expect(styleBlock(REPORTS_HUB, 'activityCard')).toMatch(
      /^\s*marginTop: 20,\s*padding: 22,\s*$/,
    );
  });

  // CONFLICTS D26: the four tiles drew the same made-up lines for every
  // workspace. Mutation caught: a spark prop put back on any tile.
  it('the tiles show the real figures only: no made-up charts', () => {
    const sf = treeOf(REPORTS_HUB);
    const tiles: JsxNode[] = [];
    walkJsx(sf, (el) => {
      if (tagOf(el, sf) === 'StatCard') tiles.push(el);
    });
    expect(tiles.map((t) => [attrText(t, 'label', sf), attrText(t, 'unit', sf)])).toEqual([
      ['ITEMS', 'SKUs'],
      ['VALUE', 'value.unit'],
      ['LOW', 'SKUs'],
      ['OUT', 'SKUs'],
    ]);
    for (const t of tiles) {
      expect(attr(t, 'spark', sf)).toBeUndefined();
      expect(attr(t, 'sparkKind', sf)).toBeUndefined();
    }
    expect(tiles.map((t) => attrText(t, 'value', sf))).toEqual([
      'summary.itemCount.toLocaleString()',
      'value.value',
      'summary.lowStockCount.toLocaleString()',
      'summary.outOfStockCount.toLocaleString()',
    ]);
  });

  it('takes no single-mode accent; the row dots are the per-mode marks', () => {
    expect(themeImports(REPORTS_HUB)).not.toContain('ACCENT');
    expect(wordColours(REPORTS_HUB).filter((x) => FAINT_OR_SINGLE_MODE.test(x))).toEqual([]);
    expect(tokenSites(REPORTS_HUB, 'ink4')).toEqual([]);
    expect(hub).toContain(
      "function reportRowTint(tone: 'ok' | 'warn' | 'crit' | 'default', c: Palette): string { if (tone === 'ok') return c.accent; if (tone === 'warn') return c.warnText; if (tone === 'crit') return c.critText; return c.ink3; }",
    );
    expect(hub).toContain('const tint = reportRowTint(tone, c);');
    expect(hub).toContain('<Mono size={13} color={c.ink3} tracking={0.04}> movements </Mono>');
  });

  it.each(MODES)(
    '%s: the dots stand out from the card at 3:1, and the words read at AA',
    (_m, p) => {
      for (const dot of [p.accent, p.warnText, p.critText, p.ink3])
        expect(contrast(dot, p.card)).toBeGreaterThanOrEqual(AA_UI);
      // "movements" (it was the faint ink4) and the hero line on the card.
      expect(contrast(p.ink3, p.card)).toBeGreaterThanOrEqual(AA_TEXT);
      // The web hand-off: the outline button's words on its fill.
      const outline = buttonTone('outline', p);
      expect(contrast(outline.fg, outline.bg)).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it('"Full report on web" is a named button in a 44pt frame that wraps, opening the same page', () => {
    const { sf, fn } = functionNamed(REPORTS_HUB, 'WebReportLink');
    const touch = elementsIn(fn).filter((n) => TOUCHABLE_TAG.test(tagOf(n.el, sf)));
    expect(touch).toHaveLength(1);
    const link = touch[0]!.el;
    expect(attrText(link, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(link, 'accessibilityLabel', sf)).toBe('Full report on web');
    expect(textOf(link, sf)).toBe('Full report on web');
    const frame = styleBlock(REPORTS_HUB, 'webLink');
    expect(frame).toMatch(/minHeight: MIN_TAP,/);
    expect(frame).not.toMatch(/\bheight:/);
    expect(frame).toMatch(/borderRadius: BUTTON_RADIUS\.sm,/);
    expect(hub).toContain('const MIN_TAP = 44;');
    expect(hub).toContain("const tone = buttonTone('outline', c);");
    // The label is content, uncapped, and may wrap.
    const label = elementsIn(fn).find((n) => tagOf(n.el, sf) === 'Body')!;
    expect(attr(label.el, 'numberOfLines', sf)).toBeUndefined();
    expect(attr(label.el, 'maxFontSizeMultiplier', sf)).toBeUndefined();
    expect(hub).toContain(
      "<WebReportLink onPress={() => Linking.openURL('https://stockpilotusa.com/dashboard/reports').catch(() => undefined) } />",
    );
  });

  it('keeps every word, the Book Order Totals entry and the figure rows', () => {
    for (const words of [
      '<Eyebrow>ANALYTICS</Eyebrow>',
      'Reports <Em>& insights.</Em>',
      '<Eyebrow>REPORTS</Eyebrow>',
      '<Eyebrow>LAST 30 DAYS</Eyebrow>',
      'Receives, adjusts, transfers, returns posted to the ledger.',
      'title="Inventory health"',
      'title="Stockout exposure"',
      'title="Avg value / SKU"',
      'title="Below reorder"',
      'accessibilityLabel={`${BOOK_REPORT_TITLE}. ${BOOK_REPORT_CARD_DESCRIPTION}`}',
      'accessibilityHint="Opens the report"',
      "router.push('/reports/book-order-totals' as Href)",
      '<IconChip icon={Menu} onPress={openDrawer} accessibilityLabel="Open menu" minTap />',
      '{BOOK_REPORT_KPI_LOAD_ERROR}',
    ]) {
      expect(hub).toContain(words);
    }
  });
});

describe('the report files: words never take a faint ink', () => {
  it.each(REPORT_FILES)('%s', (file) => {
    expect(wordColours(file).filter((x) => /\bc\.ink[45]\b/.test(x))).toEqual([]);
  });
});

// ── Settings ─────────────────────────────────────────────────────────────

const SETTINGS = 'app/(drawer)/settings.tsx';
const CHANGE_EMAIL = 'app/(drawer)/settings/change-email.tsx';
const CUSTOMIZE_TABS = 'app/(drawer)/settings/customize-tabs.tsx';
const INTEGRATIONS = 'app/(drawer)/settings/integrations.tsx';
const UNSENT_WORK = 'app/(drawer)/settings/rejected-work.tsx';

const SETTINGS_FILES = [SETTINGS, CHANGE_EMAIL, CUSTOMIZE_TABS, INTEGRATIONS, UNSENT_WORK];

/** Evaluates a condition the screen wrote, as written, with the names given. */
function runCondition(expression: string, names: Record<string, unknown>): unknown {
  const keys = Object.keys(names);
  const fn = new Function(...keys, `return (${expression});`) as (...args: unknown[]) => unknown;
  return fn(...keys.map((k) => names[k]));
}

describe('Settings pages: the per-mode palette', () => {
  it.each(SETTINGS_FILES)(
    '%s takes no single-mode accent and gives no word a faint ink',
    (file) => {
      expect(themeImports(file)).not.toContain('ACCENT');
      expect(themeImports(file)).not.toContain('theme');
      expect(wordColours(file).filter((x) => FAINT_OR_SINGLE_MODE.test(x))).toEqual([]);
      // No fixed hex or translucent colour anywhere in the file.
      expect(codeOnly(sourceOf(file))).not.toMatch(/'#[0-9a-f]{3,8}'|rgba\(/i);
    },
  );

  // What ink4 may still draw in these files: glyphs beside words, never the
  // words (the chevrons, the mail glyph in its field, the plug, an
  // unavailable tab's icon).
  it('the faint ink4 is left only on glyphs', () => {
    expect(tokenSites(SETTINGS, 'ink4')).toEqual(['ChevronLeft.color']);
    expect(tokenSites(CHANGE_EMAIL, 'ink4')).toEqual(['Mail.color']);
    expect(tokenSites(CUSTOMIZE_TABS, 'ink4')).toEqual(['SlotIcon.color']);
    expect(tokenSites(INTEGRATIONS, 'ink4')).toEqual(['Plug.color', 'Plug.color']);
    expect(tokenSites(UNSENT_WORK, 'ink4')).toEqual([]);
    for (const file of SETTINGS_FILES) expect(tokenSites(file, 'ink5')).toEqual([]);
  });

  it.each(MODES)('%s: every word reads at AA on the card and the page; glyphs at 3:1', (_m, p) => {
    for (const ground of [p.card, p.paper]) {
      for (const t of [p.ink, p.ink3, p.critText, p.warnText])
        expect(contrast(t, ground)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(p.ink4, ground)).toBeGreaterThanOrEqual(AA_UI);
    }
    // The integrations error: the refusal words on the refusal wash.
    expect(contrast(p.critText, p.critWash)).toBeGreaterThanOrEqual(AA_TEXT);
    // The sync row icons beside their pills, on the card.
    for (const t of [p.accent, p.warnText, p.critText])
      expect(contrast(t, p.card)).toBeGreaterThanOrEqual(AA_UI);
  });
});

describe('Settings: the account screen', () => {
  const settings = flatCode(SETTINGS);

  it("a row's detail, the email and the version footer are the muted ink; Sign out the per-mode red", () => {
    expect(settings).toContain(
      "<Mono size={11.5} tracking={0.04} color={c.ink3} style={{ marginTop: 3 }}> {profile.email ?? ''} </Mono>",
    );
    expect(settings).toContain('<Body size={13.5} color={c.ink3}');
    expect(settings).toContain('<LogOut size={16} color={c.critText} strokeWidth={1.5} />');
    expect(settings).toMatch(/<Body size=\{14\.5\} color=\{c\.critText\}[^>]*> Sign out <\/Body>/);
    expect(settings).toContain(
      "<Mono size={10} tracking={0.1} color={c.ink3} style={{ flexShrink: 1, minWidth: 0 }}> {OTA_DATE ? `v${APP_VERSION} · ${OTA_DATE}${OTA_ID ? ` · #${OTA_ID}` : ''}` : `v${APP_VERSION}`} </Mono>",
    );
  });

  it('every row and Sign out are named buttons; Sign out is a 44pt frame and keeps its tap', () => {
    const { sf, fn } = functionNamed(SETTINGS, 'SettingRow');
    const rowTouch = elementsIn(fn).filter((n) => TOUCHABLE_TAG.test(tagOf(n.el, sf)));
    expect(rowTouch).toHaveLength(1);
    expect(attrText(rowTouch[0]!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(rowTouch[0]!.el, 'onPress', sf)).toBe('onPress');
    expect(settings).toMatch(
      /<Pressable onPress=\{\(\) => void signOut\(\)\} hitSlop=\{10\} accessibilityRole="button" style=\{\(\{ pressed \}\) => \(\{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, minHeight: MIN_TAP,/,
    );
    expect(settings).toContain('const MIN_TAP = 44;');
  });

  // The defect: the Face ID switch sat inside an outer Pressable that iOS
  // made one VoiceOver element; its double tap landed on the outer, which had
  // no handler while the switch could be turned on, so it could not be
  // flipped without sight. Mutation caught: the switch wrapped again, or its
  // name dropped.
  it('the Face ID switch is its own VoiceOver element while it can be turned on, named for what it does', () => {
    const sf = treeOf(SETTINGS);
    const toggles = elementsIn(sf).filter((n) => tagOf(n.el, sf) === 'Toggle');
    expect(toggles).toHaveLength(2);
    for (const t of toggles) {
      expect(attrText(t.el, 'accessibilityLabel', sf)).toBe('`${biometricLabel} unlock`');
      expect(attrText(t.el, 'onValueChange', sf)).toBe('toggleBiometric');
      expect(attrText(t.el, 'value', sf)).toBe('biometricEnabled && biometricSupported');
    }
    // The two branches of the row, by the screen's own condition.
    let branch: ts.ConditionalExpression | null = null;
    const visit = (n: ts.Node) => {
      if (
        ts.isConditionalExpression(n) &&
        n.condition.getText(sf) === 'biometricSupported' &&
        n.whenTrue.getText(sf).includes('<SettingRow')
      ) {
        branch = n;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(branch).not.toBeNull();
    const supported = elementsIn(branch!.whenTrue);
    const notYet = elementsIn(branch!.whenFalse);
    // Supported: no touchable above the switch.
    const onSwitch = supported.find((n) => tagOf(n.el, sf) === 'Toggle')!;
    expect(onSwitch.ancestors.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toEqual([]);
    expect(supported.filter((n) => TOUCHABLE_TAG.test(tagOf(n.el, sf)))).toEqual([]);
    // Not supported yet: the whole row is one button that says why.
    const outer = notYet.find((n) => TOUCHABLE_TAG.test(tagOf(n.el, sf)))!;
    expect(attrText(outer.el, 'onPress', sf)).toBe('() => toggleBiometric(true)');
    expect(attrText(outer.el, 'accessibilityRole', sf)).toBe('button');
    expect(flatCode(SETTINGS)).toContain(
      "detail={cap && !cap.hasHardware ? 'No hardware' : 'Tap to enrol'}",
    );
  });

  it('keeps every row, web page, confirmation and the account deletion with the typed DELETE', () => {
    for (const words of [
      '<Eyebrow>SETTINGS</Eyebrow>',
      'Account<Em>.</Em>',
      'title="Workspaces" detail="View sites"',
      "router.push('/locations?return=/settings')",
      "Linking.openURL('https://stockpilotusa.com/dashboard/settings/profile')",
      "router.push('/settings/change-email' as never)",
      "router.push('/notifications?return=/settings')",
      'title="Send test push" detail="To this device"',
      "'/api/v1/push/test'",
      "router.push('/settings/integrations' as never)",
      "Linking.openURL('https://stockpilotusa.com/dashboard/settings/security')",
      'title="Customize tab bar" detail="Home + up to 5"',
      "router.push('/settings/customize-tabs' as never)",
      'title="Theme" detail="Auto"',
      'title="Sync" detail="Wi-Fi + cellular"',
      "router.push('/settings/rejected-work' as never)",
      'title="Offline cache" detail="Tap to clear"',
      'title="Delete my account" detail="Permanent"',
      'onPress={() => confirmDeleteAccount(signOut)}',
      "Linking.openURL('mailto:hello@stockpilot.app?subject=StockPilot%20mobile%20support')",
      "Linking.openURL('https://stockpilotusa.com/privacy')",
      "Linking.openURL('https://stockpilotusa.com/terms')",
      'title="What\'s new" detail={`v${APP_VERSION}`}',
      "'Type DELETE to confirm'",
      "if ((input ?? '').trim() !== 'DELETE') {",
      "body: { confirm: 'DELETE' },",
      "'Delete forever'",
      'DELETE_ACCOUNT_CONFIRM_COPY',
      "const showIntegrations = enabledModules.has('integrations') && isAdmin;",
    ]) {
      expect(settings).toContain(words);
    }
  });
});

describe('Settings: Change email', () => {
  const email = flatCode(CHANGE_EMAIL);

  it('a refused request is said in the per-mode red, as an alert (it was a fixed red, read as plain text)', () => {
    expect(email).toContain(
      '<Body size={13} color={c.critText} accessibilityRole="alert"> {formError} </Body>',
    );
    expect(email).not.toContain('#b42318');
  });

  it('the card labels are the muted ink', () => {
    for (const label of ['SIGN-IN EMAIL', 'PENDING CHANGE']) {
      expect(email).toContain(
        `<Mono size={10} tracking={0.12} upper color={c.ink3}> ${label} </Mono>`,
      );
    }
    expect(email).toContain(
      "<Mono size={10} tracking={0.12} upper color={c.ink3}> {pending ? 'CHANGE TO A DIFFERENT ADDRESS' : 'CHANGE EMAIL'} </Mono>",
    );
  });

  // The defect: the eye was an unnamed, roleless Pressable with hitSlop, so
  // VoiceOver found an element with no words. Mutation caught: the name, the
  // role or the frame dropped, or hitSlop back.
  it("the password's eye is a named button in a 44pt frame that shows or hides it", () => {
    const sf = treeOf(CHANGE_EMAIL);
    const eyes = elementsIn(sf).filter(
      (n) =>
        TOUCHABLE_TAG.test(tagOf(n.el, sf)) &&
        attrText(n.el, 'onPress', sf) === '() => setShowPw((p) => !p)',
    );
    expect(eyes).toHaveLength(1);
    const eye = eyes[0]!.el;
    expect(attrText(eye, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(eye, 'accessibilityLabel', sf)).toBe(
      "showPw ? 'Hide password' : 'Show password'",
    );
    expect(attr(eye, 'hitSlop', sf)).toBeUndefined();
    const frame = styleBlock(CHANGE_EMAIL, 'eye');
    expect(frame).toMatch(/minWidth: 44,\s*minHeight: 44,\s*marginRight: -13,/);
    // The eye is a control: its glyph in the muted ink (3:1 and more).
    expect(email).toContain('<EyeOff size={18} color={c.ink3} strokeWidth={1.4} />');
    expect(email).toContain('<Eye size={18} color={c.ink3} strokeWidth={1.4} />');
    expect(email).toContain('secureTextEntry={!showPw}');
  });

  it('keeps every state, word and request', () => {
    for (const words of [
      "api<Status>('/api/v1/account/email')",
      "'/api/v1/account/email/request'",
      "'/api/v1/account/email/resend'",
      "'/api/v1/account/email/cancel'",
      "'Re-authentication needed'",
      "{busy === 'resend' ? 'Sending…' : 'Resend links'}",
      'Use a different address',
      "{busy === 'cancel' ? 'Cancelling…' : 'Cancel change'}",
      'label="NEW EMAIL"',
      'label="CURRENT PASSWORD"',
      "{busy === 'request' ? 'Sending…' : 'Send verification'}",
      'Keep the pending address',
      "'Check both inboxes'",
      "'Cancel this email change?'",
      "<Pill status=\"ok\">{pending ? 'CURRENT' : 'VERIFIED'}</Pill>",
      "<Pill status={expired ? 'crit' : 'warn'}>{expired ? 'EXPIRED' : 'PENDING'}</Pill>",
    ]) {
      expect(email).toContain(words);
    }
  });
});

describe('Settings: Customize tab bar', () => {
  const tabs = flatCode(CUSTOMIZE_TABS);

  it('every word reads in the muted ink or stronger: the hints, the note, a greyed choice, the preview', () => {
    expect(tabs).toContain(
      '<Mono size={10} tracking={0.1} color={c.ink3}> HOME IS ALWAYS FIRST · {slots.length} OF {MAX_TAB_SLOTS} SLOTS USED </Mono>',
    );
    expect(tabs).toContain('color={unavailable ? c.ink3 : undefined}');
    expect(tabs).toContain('UNAVAILABLE RIGHT NOW — HIDDEN FROM THE BAR');
    expect(tabs).toContain('const tint = active ? c.ink : c.ink3;');
    expect(tabs).toContain(
      '<Mono size={10.5} tracking={0.04} color={c.ink3} style={{ marginTop: 3 }}> Home · Items · Books · POs · Scan </Mono>',
    );
    expect(tabs).toContain('<Mono size={10} tracking={0.1} color={c.ink3}> {text} </Mono>');
  });

  // Each chip was a 30pt box plus hitSlop 6 (a 42pt target), 8pt apart, so
  // two neighbours' slop overlapped. Mutation caught: hitSlop back, the frame
  // under 44pt or given a fixed size, or a gap that lets frames overlap.
  it('each reorder, add and remove chip is the same 30pt chip in a real 44pt frame, side by side', () => {
    const { sf, fn } = functionNamed(CUSTOMIZE_TABS, 'ControlChip');
    const els = elementsIn(fn);
    const touch = els.filter((n) => TOUCHABLE_TAG.test(tagOf(n.el, sf)));
    expect(touch).toHaveLength(1);
    const frame = touch[0]!.el;
    expect(attr(frame, 'hitSlop', sf)).toBeUndefined();
    expect(attrText(frame, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(frame, 'accessibilityLabel', sf)).toBe('label');
    expect(attrText(frame, 'accessibilityState', sf)).toBe('{ disabled }');
    expect(attrText(frame, 'disabled', sf)).toBe('disabled');
    expect(styleBlock(CUSTOMIZE_TABS, 'controlFrame')).toMatch(
      /minWidth: 44,\s*minHeight: 44,\s*marginVertical: -7,/,
    );
    expect(styleBlock(CUSTOMIZE_TABS, 'control')).toMatch(/width: 30,\s*height: 30,/);
    expect(styleBlock(CUSTOMIZE_TABS, 'controls')).not.toMatch(/gap/);
    expect(tabs).toContain('<View style={[styles.control, { borderColor: c.hair2 }]}>');
    // The frame's 7pt above and below fits in the row's 12pt padding.
    expect(styleBlock(CUSTOMIZE_TABS, 'row')).toMatch(/paddingVertical: 12,/);
  });

  it('keeps the bounds, the words, the persistence, Reset and the preview', () => {
    for (const words of [
      '<Eyebrow>SETTINGS · TAB BAR</Eyebrow>',
      'Bottom <Em>tabs.</Em>',
      'label={`Move ${cand.settingsLabel} up`}',
      'label={`Move ${cand.settingsLabel} down`}',
      'label={`Remove ${cand.settingsLabel} from the bar`}',
      'label={`Add ${cand.settingsLabel} to the bar`}',
      'disabled={idx === 0}',
      'disabled={idx === slots.length - 1}',
      'disabled={atMin}',
      'disabled={atMax}',
      'text={`MINIMUM ${MIN_TAB_SLOTS} TABS — ADD ANOTHER BEFORE REMOVING ONE.`}',
      'text={`MAXIMUM ${MAX_TAB_SLOTS} TABS — REMOVE ONE TO ADD ANOTHER.`}',
      'Everything available to you is already in your bar.',
      'void saveTabSlots(userId, next);',
      'void resetTabSlots(userId);',
      'Reset to default',
      'adjustsFontSizeToFit minimumFontScale={PREVIEW_MIN_FONT_SCALE} allowFontScaling={false}',
      'previewLabelStyleForCount( 1 + previewSlots.length,',
      'if (reduceMotion) return;',
    ]) {
      expect(tabs).toContain(words);
    }
    expect(tabs).toMatch(/<Pressable onPress=\{reset\} accessibilityRole="button"/);
  });
});

describe('Settings: Integrations', () => {
  const qbo = flatCode(INTEGRATIONS);

  it('a failed read is the refusal tone: the per-mode red on its wash (it was a fixed red over a translucent edge)', () => {
    expect(qbo).toContain(
      '<Card padding={14} style={{ marginTop: 14, backgroundColor: c.critWash, borderColor: c.critWash }} > <Body size={13.5} color={c.critText}> {error} </Body>',
    );
    expect(qbo).toContain('<Body size={13} color={c.critText} style={{ marginTop: 4 }}>');
  });

  it("each sync row's status word is a status pill in its tone, beside the same icon in that tone", () => {
    expect(qbo).toContain(
      "const HEALTH_ICON: Record<SyncHealthStatus, { Icon: typeof CheckCircle2; status: 'ok' | 'warn' | 'crit' }> = { success: { Icon: CheckCircle2, status: 'ok' }, pending: { Icon: CircleDashed, status: 'warn' }, error: { Icon: XCircle, status: 'crit' }, dead: { Icon: XCircle, status: 'crit' }, };",
    );
    expect(qbo).toContain(
      "function healthColor(status: 'ok' | 'warn' | 'crit', c: Palette): string { if (status === 'ok') return c.accent; if (status === 'warn') return c.warnText; return c.critText; }",
    );
    expect(qbo).toContain('<Pill status={status} dot={false}> {row.status.toUpperCase()} </Pill>');
    expect(qbo).toContain(
      'const { Icon, status } = HEALTH_ICON[row.status] ?? HEALTH_ICON.pending;',
    );
  });

  it('keeps the gates, the states, the mapping and the destructive confirm', () => {
    for (const words of [
      "const allowed = enabled.has('integrations') && isAdmin;",
      "'Integrations isn’t enabled.'",
      "'Admins only.'",
      'title="Access denied."',
      'NOT CONNECTED',
      'QuickBooks Online',
      'label="REALM"',
      'label="LAST SYNCED"',
      'LAST ERROR',
      'label="Bill expense account id"',
      'label="Inventory asset account id"',
      'label="Valuation offset account id"',
      "{saving ? 'Saving…' : 'Save mapping'}",
      "'Disconnect QuickBooks?'",
      'Disconnect QuickBooks',
      'No sync activity yet. Exported documents and their status will appear here.',
      '<Eyebrow>SETTINGS · INTEGRATIONS</Eyebrow>',
      "{ label: 'CONNECTED', status: 'ok' }",
    ]) {
      expect(qbo).toContain(words);
    }
  });
});

describe('Settings: Unsent work', () => {
  const unsent = flatCode(UNSENT_WORK);

  // The defect (the failed-read class of D25): a local read that threw left
  // both lists empty, and the screen said "Nothing was left unsent." over
  // work it could not read. The condition the screen renders is run here.
  it('"Nothing was left unsent." only after both reads answered; a failed read is said with Try again', () => {
    const m = /const nothing = ([^;]+);/.exec(unsent);
    expect(m).not.toBeNull();
    const nothing = (state: {
      readFailed: boolean;
      rows: unknown[] | null;
      held: unknown[] | null;
    }) => runCondition(m![1]!, state);
    expect(nothing({ readFailed: false, rows: [], held: [] })).toBe(true);
    expect(nothing({ readFailed: true, rows: [], held: [] })).toBe(false);
    expect(nothing({ readFailed: false, rows: [{}], held: [] })).toBe(false);
    expect(nothing({ readFailed: false, rows: null, held: [] })).toBe(false);
    // Both catches set the flag; a read that answers clears it.
    expect(unsent).toMatch(
      /setRows\(\[\]\); failed = true; \} try \{ setHeld\(await listHeld\(REJECTED_KEEP_MAX\)\); \} catch \(e\) \{ console\.warn\('\[rejected-work\] could not read the held work', e\); setHeld\(\[\]\); failed = true; \} setReadFailed\(failed\);/,
    );
    expect(unsent).toContain(
      '{readFailed ? ( <Card padding={16} style={{ marginTop: 18, gap: 12 }}> <Body size={14.5} color={c.critText} accessibilityRole="alert"> Could not read the unsent work saved on this device. </Body>',
    );
    expect(unsent).toMatch(/onPress=\{\(\) => void load\(\)\}[^>]*> Try again <\/Button>/);
  });

  it('the times, keys and retention line are the muted ink; a not-confirmed message amber; refusals red', () => {
    expect(unsent).toContain(
      '<Mono size={11} color={c.ink3}> {rejectedWhen(row.createdAt, now)} </Mono>',
    );
    expect(unsent).toContain(
      '<Body size={13.5} color={c.warnText} style={{ marginTop: 4 }}> {row.lastError} </Body>',
    );
    expect(unsent).toContain(
      '<Body size={13.5} color={c.critText} style={{ marginTop: 4 }}> {row.lastError} </Body>',
    );
    expect(unsent).toContain(
      '<Mono size={10} tracking={0.1} color={c.ink3} style={{ marginTop: 6 }}> {row.idempotencyKey.slice(0, 8).toUpperCase()} </Mono>',
    );
    expect(unsent).toContain(
      '{`THESE RECORDS ARE KEPT FOR ${REJECTED_RETENTION_DAYS} DAYS, THEN REMOVED AUTOMATICALLY`}',
    );
  });

  it('Discard and Clear this list are named buttons in 44pt frames, in the per-mode red', () => {
    const sf = treeOf(UNSENT_WORK);
    const touch = elementsIn(sf).filter((n) => TOUCHABLE_TAG.test(tagOf(n.el, sf)));
    const discard = touch.find(
      (n) => attrText(n.el, 'onPress', sf) === '() => confirmDiscard(row)',
    )!;
    const clear = touch.find((n) => attrText(n.el, 'onPress', sf) === 'confirmClear')!;
    expect(attrText(discard.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(discard.el, 'accessibilityLabel', sf)).toBe(
      '`Discard ${pendingActionLabel(row.kind)} queued by another account`',
    );
    expect(attrText(clear.el, 'accessibilityRole', sf)).toBe('button');
    expect(textOf(clear.el, sf)).toBe('Clear this list');
    expect(styleBlock(UNSENT_WORK, 'discard')).toMatch(/minHeight: MIN_TAP,/);
    expect(styleBlock(UNSENT_WORK, 'clear')).toMatch(/minHeight: MIN_TAP,/);
    expect(unsent).toContain('const MIN_TAP = 44;');
    expect(unsent).toContain(
      '<Body size={14} color={c.critText} style={{ fontFamily: FONT.display }}> Discard </Body>',
    );
    expect(unsent).toContain(
      '<Body size={14.5} color={c.critText} style={{ fontFamily: FONT.display }}> Clear this list </Body>',
    );
  });

  it('keeps the three groups apart, every confirmation and no per-row retry', () => {
    for (const words of [
      '<Eyebrow>SETTINGS · OFFLINE WORK</Eyebrow>',
      'Unsent <Em>work.</Em>',
      '{`QUEUED BY ANOTHER ACCOUNT · ${held.length}`}',
      '{`NOT CONFIRMED · ${unconfirmedRows.length}`}',
      '{`NEVER SENT · ${neverSentRows.length}`}',
      "'Clear this list?'",
      "'Discard this change?'",
      'Nothing was left unsent.',
      'Checking…',
      'Queued by another account. It sends when that account signs in on this device.',
    ]) {
      expect(unsent).toContain(words);
    }
    expect(unsent).not.toMatch(/\bRetry\b|retry\(/);
  });
});

// ── Admin ────────────────────────────────────────────────────────────────

const ADMIN_INDEX = 'app/(drawer)/admin/index.tsx';
const ADMIN_USERS = 'app/(drawer)/admin/users.tsx';

/**
 * The six read-only admin lists: each one's failed-read words, the eyebrow it
 * shows without a count, and its Restricted words (kept as they were).
 */
const ADMIN_LISTS = [
  {
    file: 'app/(drawer)/admin/audit.tsx',
    noun: 'EVENTS',
    neutral: 'ADMIN · AUDIT LOG',
    title: 'Could not load audit events.',
    empty: 'No audit events yet.',
    restricted: 'Requires audit log access.',
  },
  {
    file: 'app/(drawer)/admin/bins.tsx',
    noun: 'BINS',
    neutral: 'ADMIN · BINS',
    title: 'Could not load bins.',
    empty: 'No bins yet.',
    restricted: 'Admin only.',
  },
  {
    file: 'app/(drawer)/admin/charters.tsx',
    noun: 'CHARTERS',
    neutral: 'ADMIN · CHARTERS',
    title: 'Could not load charters.',
    empty: 'No charters yet.',
    restricted: 'Admin only.',
  },
  {
    file: 'app/(drawer)/admin/uom-conversions.tsx',
    noun: 'CONVERSIONS',
    neutral: 'ADMIN · UOM',
    title: 'Could not load conversions.',
    empty: 'No conversions yet.',
    restricted: 'Admin only.',
  },
  {
    file: 'app/(drawer)/admin/vendor-mappings.tsx',
    noun: 'MAPPINGS',
    neutral: 'ADMIN · VENDOR MAPPINGS',
    title: 'Could not load mappings.',
    empty: 'No mappings yet.',
    restricted: 'Admin only.',
  },
  {
    file: 'app/(drawer)/admin/warehouses.tsx',
    noun: 'WAREHOUSES',
    neutral: 'ADMIN · WAREHOUSES',
    title: 'Could not load warehouses.',
    empty: 'No warehouses yet.',
    restricted: 'Admin only.',
  },
];

const ADMIN_FILES = [ADMIN_INDEX, ADMIN_USERS, ...ADMIN_LISTS.map((l) => l.file)];

/** The DataListScreen that shows the list (the one given `data={rows}`). */
function listScreen(file: string): { sf: ts.SourceFile; el: JsxNode } {
  const sf = treeOf(file);
  const screens = elementsIn(sf).filter(
    (n) => tagOf(n.el, sf) === 'DataListScreen' && attrText(n.el, 'data', sf) === 'rows',
  );
  expect(screens, `${file}: one list screen`).toHaveLength(1);
  return { sf, el: screens[0]!.el };
}

describe('Admin lists: a failed read is said, never "No X yet." (D25)', () => {
  it.each(ADMIN_LISTS)('$file passes the failed state with its own words', (list) => {
    const { sf, el } = listScreen(list.file);
    const failed = (attrText(el, 'failed', sf) ?? '').replace(/\s+/g, ' ');
    expect(failed).toContain(`title: '${list.title}'`);
    expect(failed).toContain("body: 'Check your connection and pull down to try again.'");
    // The empty words are only for a read that answered.
    expect(attrText(el, 'emptyTitle', sf)).toBe(list.empty);
    // The eyebrow quotes no count it did not read: run the screen's own
    // expression over each state.
    const eyebrow = attrText(el, 'eyebrow', sf)!;
    const failedFlag = list.file.endsWith('warehouses.tsx') ? 'list' : true;
    expect(runCondition(eyebrow, { failed: failedFlag, rows: [] })).toBe(list.neutral);
    expect(runCondition(eyebrow, { failed: failedFlag, rows: [{}, {}] })).toBe(
      `ADMIN · 2 ${list.noun}`,
    );
    expect(
      runCondition(eyebrow, {
        failed: list.file.endsWith('warehouses.tsx') ? null : false,
        rows: [],
      }),
    ).toBe(`ADMIN · 0 ${list.noun}`);
  });

  it.each(ADMIN_LISTS)(
    '$file: a failed read keeps the rows it had and sets the flag; a good one clears it',
    (list) => {
      const body = codeOnly(sourceOf(list.file));
      const load = body.slice(
        body.indexOf('const load = React.useCallback('),
        body.indexOf('React.useEffect('),
      );
      // The failure path returns before any setRows: rows from an earlier read
      // stay on screen, under the reload note.
      const failurePath =
        /if \((!read \|\| read\.error|whResp\.error)\) \{([\s\S]*?)return;\s*\}/.exec(load);
      expect(failurePath, list.file).not.toBeNull();
      expect(failurePath![2]).toMatch(/setFailed\((true|'list')\);/);
      expect(failurePath![2]).not.toContain('setRows(');
      // A thrown read is a failure too, never a spinner that turns forever.
      expect(load).toMatch(/\} catch \{\s*(read = null;|setFailed\('list'\);)/);
      expect(load).toMatch(
        /setFailed\((false|chartersFailed && whRows\.length > 0 \? 'charters' : null)\);/,
      );
    },
  );

  it('the warehouses say when their charters could not be loaded, rather than show none', () => {
    const wh = flatCode('app/(drawer)/admin/warehouses.tsx');
    expect(wh).toContain('let chartersFailed = Boolean(joinResp.error);');
    expect(wh).toContain(
      "console.warn('[admin/warehouses] charter fetch failed:', chErr.message); chartersFailed = true;",
    );
    expect(wh).toContain(
      "reloadNote: failed === 'charters' ? 'Could not load the charters. Pull down to try again.' : 'Could not refresh. Showing the last list.',",
    );
  });

  it.each(ADMIN_LISTS)('$file keeps its Restricted state, its title and its read', (list) => {
    const src = flatCode(list.file);
    expect(src).toContain('title="Restricted" italic="access."');
    expect(src).toContain(`emptyTitle="${list.restricted}"`);
    expect(src).toMatch(/\.limit\(200\)|\.order\('name', \{ ascending: true \}\)/);
  });

  it('the audit log keeps its wider gate: admins, or anyone with Activity logs, or while permissions load', () => {
    expect(flatCode('app/(drawer)/admin/audit.tsx')).toContain(
      "const canView = isAdmin || perms === undefined || perms.has('activity_logs:read');",
    );
  });
});

describe('Admin screens: the per-mode palette', () => {
  it.each(ADMIN_FILES)(
    '%s gives no word a faint ink and uses no fixed colour for a word or fill',
    (file) => {
      expect(themeImports(file)).not.toContain('ACCENT');
      // The one faint word left is the vendor mapping's arrow glyph (pinned
      // below as the only ink4 in that file).
      const faint = wordColours(file).filter((x) => /\bc\.ink[45]\b/.test(x));
      expect(faint).toEqual(file.endsWith('vendor-mappings.tsx') ? ['c.ink4'] : []);
      expect(codeOnly(sourceOf(file))).not.toMatch(/'#[0-9a-f]{3,8}'/i);
    },
  );

  // What ink4 may still draw here: glyphs (the mail glyph, the edit chevron)
  // and the text arrow between a vendor number and its SKU; ink5 only the
  // role sheet's grabber, which is decoration.
  it('the faint inks are left only on glyphs and decoration', () => {
    expect(tokenSites(ADMIN_USERS, 'ink4')).toEqual(['ChevronRight.color', 'Mail.color']);
    expect(tokenSites(ADMIN_USERS, 'ink5')).toEqual(['View.backgroundColor']);
    expect(tokenSites('app/(drawer)/admin/vendor-mappings.tsx', 'ink4')).toEqual(['Body.color']);
    expect(flatCode('app/(drawer)/admin/vendor-mappings.tsx')).toContain(
      '<Body size={12} color={c.ink4}> → </Body>',
    );
    for (const file of ADMIN_FILES.filter(
      (f) => f !== ADMIN_USERS && !f.endsWith('vendor-mappings.tsx'),
    )) {
      expect(tokenSites(file, 'ink4'), file).toEqual([]);
    }
  });

  it.each(MODES)('%s: the code lines, meta and descriptions read at AA on the card', (_m, p) => {
    for (const t of [p.ink, p.ink2, p.ink3])
      expect(contrast(t, p.card)).toBeGreaterThanOrEqual(AA_TEXT);
    // The role and category rows: words on the chosen row's recessed fill.
    for (const t of [p.ink, p.ink3]) expect(contrast(t, p.sunk)).toBeGreaterThanOrEqual(AA_TEXT);
    // A chosen row's ink edge, and the clear box's ink4 edge on the card.
    expect(contrast(p.ink, p.sunk)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrast(p.ink4, p.card)).toBeGreaterThanOrEqual(AA_UI);
    // The category read's failure on the sheet's card.
    expect(contrast(p.critText, p.card)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('Admin overview', () => {
  const index = flatCode(ADMIN_INDEX);

  it('each destination is a named button; its description a sentence in the muted body face', () => {
    expect(index).toContain(
      '<Pressable onPress={() => router.push(l.href as never)} accessibilityRole="button"',
    );
    expect(index).toContain(
      '<Body size={13} muted style={{ marginTop: 2 }}> {link.description} </Body>',
    );
  });

  it('keeps every link, the module filter and the Restricted state; Reconciliation stays gone', () => {
    for (const href of [
      '/admin/charters',
      '/admin/warehouses',
      '/admin/bins',
      '/admin/users',
      '/admin/vendor-mappings',
      '/admin/uom-conversions',
      '/cycle-counts',
      '/admin/audit',
    ]) {
      expect(index).toContain(`href: '${href}'`);
    }
    expect(index).toContain("module: 'cycle_counts' }");
    expect(index).toContain('LINKS.filter((l) => !l.module || enabledModules.has(l.module))');
    expect(index).toContain('title="Restricted" italic="access."');
    expect(index).toContain('emptyTitle="Admin only."');
    expect(index).toContain('eyebrow="ADMIN OVERVIEW" title="System" italic="settings."');
    expect(index).not.toContain('reconciliation');
  });
});

describe('Admin · Users', () => {
  const users = flatCode(ADMIN_USERS);

  it("a failed member read is the list's failed state, the empty words only for a read that answered", () => {
    expect(users).toContain(
      "failed={ loadFailed ? { title: 'Could not load users.', body: 'Check your connection and pull down to try again.', } : null }",
    );
    expect(users).toContain('emptyTitle="No users yet."');
    expect(users).toContain("loadFailed ? 'ADMIN · USERS'");
  });

  // The email link sits inside the card's Pressable, which iOS makes one
  // VoiceOver element: offered as an action instead. Run the screen's own
  // action list over each card.
  it("a member's email link is reachable with VoiceOver as an action on the card; the picker opens as before", () => {
    const { sf, fn } = functionNamed(ADMIN_USERS, 'UserCard');
    const card = elementsIn(fn).find((n) => TOUCHABLE_TAG.test(tagOf(n.el, sf)))!;
    expect(attrText(card.el, 'onPress', sf)).toBe('canEdit ? onPress : undefined');
    expect(attrText(card.el, 'disabled', sf)).toBe('!canEdit');
    expect(attrText(card.el, 'accessibilityRole', sf)).toBe("canEdit ? 'button' : undefined");
    expect(attrText(card.el, 'accessibilityActions', sf)).toBe('userCardActions(canEdit, email)');
    const actions = functionNamed(ADMIN_USERS, 'userCardActions');
    const js = ts.transpileModule(actions.fn.getText(actions.sf), {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const run = new Function(`${js}; return userCardActions;`)() as (
      canEdit: boolean,
      email: string | null,
    ) => { name: string; label?: string }[] | undefined;
    expect(run(true, 'a@b.co')).toEqual([
      { name: 'activate' },
      { name: 'email', label: 'Email a@b.co' },
    ]);
    expect(run(false, 'a@b.co')).toEqual([{ name: 'email', label: 'Email a@b.co' }]);
    expect(run(true, null)).toEqual([{ name: 'activate' }]);
    expect(run(false, null)).toBeUndefined();
    expect(users).toContain(
      "if (e.nativeEvent.actionName === 'email') openEmail(); else if (e.nativeEvent.actionName === 'activate' && canEdit) onPress();",
    );
    expect(users).toContain(
      'if (email) Linking.openURL(`mailto:${email}`).catch(() => undefined);',
    );
    expect(users).toContain("const canEdit = canChangeRoles && user.role !== 'owner' && !isSelf;");
  });

  it('the role picker is a standard sheet: VoiceOver kept inside, a "Close" scrim beside the card', () => {
    const { sf, fn } = functionNamed(ADMIN_USERS, 'RolePickerSheet');
    const els = elementsIn(fn);
    const container = els.find((n) => attrText(n.el, 'accessibilityViewIsModal', sf) === 'true')!;
    expect(container).toBeTruthy();
    expect(attrText(container.el, 'onAccessibilityEscape', sf)).toBe('onDismiss');
    const kids = els.filter((n) => n.ancestors[n.ancestors.length - 1] === container.el);
    expect(kids.map((k) => tagOf(k.el, sf))).toEqual(['Pressable', 'View']);
    const scrim = kids[0]!.el;
    expect(attrText(scrim, 'onPress', sf)).toBe('onDismiss');
    expect(attrText(scrim, 'onAccessibilityTap', sf)).toBe('onDismiss');
    expect(attrText(scrim, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(scrim, 'accessibilityLabel', sf)).toBe('Close');
    expect(attrText(scrim, 'style', sf)).toContain('StyleSheet.absoluteFill');
    expect(attrText(scrim, 'style', sf)).toContain(
      "mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'",
    );
    // Nothing between the container and the card's controls is a touchable.
    const card = kids[1]!.el;
    for (const n of els.filter(
      (x) => x.ancestors.includes(card) && TOUCHABLE_TAG.test(tagOf(x.el, sf)),
    )) {
      const above = n.ancestors.slice(n.ancestors.indexOf(card));
      expect(above.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toEqual([]);
    }
    expect(users).toContain('{ backgroundColor: c.card, borderColor: c.hair }, SHADOW.sheet,');
    expect(users).toContain('<View style={[pickerStyles.grabber, { backgroundColor: c.ink5 }]} />');
    expect(users).not.toContain("'#ccc'");
  });

  it('each role is a radio with its state and still applies on tap; owner is never offered', () => {
    expect(users).toContain(
      '<Pressable key={role} onPress={() => onSelect(role)} accessibilityRole="radio" accessibilityState={{ selected }}',
    );
    expect(users).toContain(
      "const ASSIGNABLE_ROLES = ['admin', 'manager', 'staff', 'viewer'] as const;",
    );
    expect(users).toContain(
      '<Body size={12.5} muted style={{ marginTop: 2 }}> {ROLE_DESCRIPTION[role]} </Body>',
    );
    expect(users).toContain(
      "borderColor: selected ? c.ink : c.hair2, backgroundColor: selected ? c.sunk : 'transparent',",
    );
  });

  it('each viewer category is a checkbox row with the shared box and its state; a failed read is said', () => {
    const { sf, fn } = functionNamed(ADMIN_USERS, 'RolePickerSheet');
    const marks = elementsIn(fn).filter((n) => tagOf(n.el, sf) === 'CheckboxMark');
    expect(marks).toHaveLength(1);
    expect(attrText(marks[0]!.el, 'checked', sf)).toBe('granted');
    const row = marks[0]!.ancestors.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf))).pop()!;
    expect(attrText(row, 'onPress', sf)).toBe('() => toggleCategory(cat.id)');
    expect(attrText(row, 'accessibilityRole', sf)).toBe('checkbox');
    expect(attrText(row, 'accessibilityState', sf)).toBe('{ checked: granted }');
    expect(attrText(row, 'accessibilityLabel', sf)).toBe('cat.name');
    expect(styleBlock(ADMIN_USERS, 'catRow')).toMatch(/minHeight: 44,/);
    // Either read failing is said, never "No categories yet." or clear boxes.
    expect(users).toContain(
      'if (catsResp.error || grantsResp.error) { setCatsFailed(true); setCatsLoading(false); return; }',
    );
    expect(users).toContain(
      ') : catsFailed ? ( <Body size={12.5} color={c.critText} accessibilityRole="alert" style={{ marginTop: 12 }} > Could not load the categories. Close this sheet and open it again. </Body> ) : categories.length === 0 ? (',
    );
    // The grant and revoke still paint first and revert on a refusal.
    expect(users).toContain("Alert.alert('Could not revoke access', error.message);");
    expect(users).toContain("Alert.alert('Could not grant access', error.message);");
  });

  it('Done is a named button in a 44pt frame', () => {
    expect(users).toMatch(
      /<Pressable onPress=\{onDismiss\} accessibilityRole="button" style=\{\(\{ pressed \}\) => \[pickerStyles\.cancel,/,
    );
    expect(styleBlock(ADMIN_USERS, 'cancel')).toMatch(/minWidth: 44,\s*minHeight: 44,/);
  });
});
