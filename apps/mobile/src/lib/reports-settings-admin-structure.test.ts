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
