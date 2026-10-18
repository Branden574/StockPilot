import * as path from 'node:path';
import * as vm from 'node:vm';

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
 * THE BUNDLE SCREENS, READ AS SOURCE (redesign package P5.9b).
 *
 * Bundles (app/bundles/index.tsx) and a bundle (app/bundles/[id].tsx) were
 * drawn from the light-only legacy `theme` alias, so they stayed light in
 * dark mode, with system fonts, "Menlo", and text glyphs for icons. They now
 * draw from the per-mode palette with the shared primitives. These pin what
 * had to survive it (every word, the Back and Refresh buttons, the distribute
 * gate, preview, confirm and queue path, which bundle-distribute-wiring and
 * header-chip-a11y pin as behaviour) and the defects fixed on the way:
 *
 *   - a bundle this phone does not hold spun for good with no Back on screen;
 *     it now says so (its own bundleScreenState is run below);
 *   - Refresh stayed busy for good when the cache read threw (no finally);
 *   - the empty words promise "Pull-to-refresh" and there was no pull;
 *   - the warehouse choices and the bundle rows had no button role, and
 *     Distribute hid its words behind the spinner while it sent.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const LIST = 'app/bundles/index.tsx';
const DETAIL = 'app/bundles/[id].tsx';
const FILES = [LIST, DETAIL];

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

/** The words an element shows: its JSX text, children joined. */
function textOf(el: JsxNode, sf: ts.SourceFile): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.getText(sf).trim());
    ts.forEachChild(n, visit);
  };
  visit(el);
  return parts.filter(Boolean).join(' ');
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

/** A top-level function of a screen, compiled from its own source and run. */
function screenFunction(file: string, name: string): (...args: unknown[]) => unknown {
  const sf = treeOf(file);
  const fn = sf.statements.find(
    (st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === name,
  );
  expect(fn, `${name} in ${file}`).toBeDefined();
  const js = ts.transpileModule(`${fn!.getText(sf)}\n${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext({}) as (...args: unknown[]) => unknown;
}

describe('off the light-only legacy theme, onto the per-mode palette', () => {
  // Mutation caught: the legacy alias imported again, a fixed colour (the
  // old '#fff' words, the amber rgba wash), system "Menlo", or a 700 weight.
  it.each(FILES)('%s', (file) => {
    const code = codeOnly(sourceOf(file));
    expect(code).toContain("import { useTheme } from '@/lib/use-theme';");
    expect(code).not.toMatch(/import \{[^}]*\b(theme|radius)\b[^}]*\} from '@\/lib\/theme'/);
    expect(code).not.toMatch(/\btheme\./);
    expect(code).not.toMatch(/\bACCENT\b/);
    expect(code).not.toMatch(/['"`]#[0-9a-f]{3,8}['"`]/i);
    expect(code).not.toMatch(/rgba?\(/);
    expect(code).not.toContain('Menlo');
    expect(code).not.toMatch(/fontWeight: '7/);
    expect(code).not.toMatch(/\bc\.(paper2|ink5)\b/);
  });

  // The warning-sign, rotating-arrow and chevron glyphs became icons; the
  // words beside them stay.
  it.each(FILES)('%s: icons, not text glyphs', (file) => {
    const code = codeOnly(sourceOf(file));
    for (const glyph of ['⚠', '⟳', '›']) expect(code).not.toContain(glyph);
  });

  it('every colour given to words or glyphs is a text token of the palette', () => {
    const TEXT_TOKENS = new Set(['ink', 'ink3', 'ink4', 'paper', 'warnText']);
    for (const file of FILES) {
      for (const m of codeOnly(sourceOf(file)).matchAll(/\bcolor(?:=\{|: )[^},]*/g)) {
        for (const t of m[0].matchAll(/\bc\.(\w+)/g)) {
          expect(TEXT_TOKENS.has(t[1]!), `${file}: ${m[0]}`).toBe(true);
        }
      }
    }
    // The faint ink4 only on the row chevron.
    expect(flatCode(LIST)).toContain('<ChevronRight size={16} color={c.ink4} strokeWidth={1.5} />');
    expect((codeOnly(sourceOf(LIST)).match(/c\.ink4/g) ?? []).length).toBe(1);
    expect(codeOnly(sourceOf(DETAIL))).not.toMatch(/c\.ink4/);
  });
});

describe('Bundles', () => {
  const code = flatCode(LIST);

  it('every word stays', () => {
    const words = wordsOf(LIST);
    for (const w of [
      '← Back',
      'Back',
      'Bundles',
      'Refresh',
      'No bundles synced yet. Pull-to-refresh or check back after the next sync.',
      ' pre-assembled',
      'Virtual recipe',
    ]) {
      expect(words, w).toContain(w);
    }
  });

  // Mutation caught: the word swapped for the spinner again (the old '⟳'),
  // or the busy state dropped.
  it('Refresh keeps its word beside a spinner while it syncs, and says it is busy', () => {
    const { sf, els } = elements(LIST, (el, s) => attrText(el, 'onPress', s) === 'refresh');
    expect(els).toHaveLength(1);
    const btn = els[0]!;
    expect(attrText(btn, 'accessibilityLabel', sf)).toBe('Refresh');
    expect(attrText(btn, 'accessibilityState', sf)).toBe('{ busy: refreshing }');
    expect(textOf(btn, sf)).toBe('Refresh');
    expect(code).toContain(
      '{refreshing ? ( <ActivityIndicator size="small" color={c.ink} /> ) : ( <RefreshCw size={14} color={c.ink} strokeWidth={1.75} /> )} <Text style={[styles.refreshLabel, { color: c.ink }]}>Refresh</Text>',
    );
    expect(styleBlock(LIST, 'refreshBtn')).toMatch(/minHeight: 44,/);
  });

  // Mutation caught: the old refresh() with no finally (a cache read that
  // threw left Refresh busy for good).
  it('a refresh ends when it ends, whatever happened', () => {
    expect(code).toContain(
      'async function refresh() { setRefreshing(true); try { await syncNow(); await load(); } finally { setRefreshing(false); } }',
    );
  });

  // Mutation caught: the ScrollView without its RefreshControl (the empty
  // words promised a pull that did nothing), or two spinners for one pull.
  it('a pull refreshes, as the empty words promise, with one spinner', () => {
    expect(code).toContain(
      'refreshControl={ <RefreshControl refreshing={pulling} onRefresh={() => void pull()} tintColor={c.ink} /> }',
    );
    expect(code).toContain(
      'async function pull() { setPulling(true); try { await refresh(); } finally { setPulling(false); } }',
    );
    expect(code).toContain('{refreshing && !pulling && rows.length === 0 ? (');
    expect(code).toContain('{rows.length === 0 && !refreshing ? (');
  });

  it('a row is a button that opens its bundle, on the reference card', () => {
    const { sf, els } = elements(
      LIST,
      (el, s) => attrText(el, 'onPress', s) === '() => router.push(`/bundles/${b.id}`)',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(els[0]!, 'accessibilityHint', sf)).toBe('Opens the bundle');
    expect(code).toContain(
      "{b.preassemblyEnabled ? `${b.phantomQty} pre-assembled` : 'Virtual recipe'}",
    );
    expect(code).toContain(
      '<Mono size={11.5} color={c.ink3} style={{ marginTop: 3 }}> {b.sku} </Mono>',
    );
    // The list still reads the offline cache, never the network.
    expect(code).toContain('const list = await listBundles();');
  });
});

describe('a bundle', () => {
  const code = flatCode(DETAIL);

  // Mutation caught: any branch of the rule changed (a missing bundle shown
  // as the endless spinner again).
  it('its own bundleScreenState: the spinner only while the cache is read', () => {
    const state = screenFunction(DETAIL, 'bundleScreenState');
    const bundle = { id: 'b1' };
    expect(state(null, false)).toBe('loading');
    expect(state(null, true)).toBe('missing');
    expect(state(bundle, false)).toBe('ready');
    expect(state(bundle, true)).toBe('ready');
  });

  // Mutation caught: `looked` set only on success (a cache read that throws
  // spins for good), or a missing id never counted as looked.
  it('the cache read always ends as looked, and no id is a bundle this phone cannot hold', () => {
    expect(code).toMatch(
      /\} catch \(e\) \{ console\.warn\('\[bundle\] cache read failed:', e instanceof Error \? e\.message : e\); \} finally \{ setLooked\(true\); \}/,
    );
    expect(code).toContain('const state = bundleScreenState(bundle, looked || !id);');
    expect(code).toContain(
      '{state === \'missing\' ? ( <View style={styles.body}> <Card padding={16}> <Body size={14.5} accessibilityRole="alert"> This bundle is not on this phone. Go back to Bundles and tap Refresh, or check back after the next sync. </Body>',
    );
  });

  // Every state draws the one Back (header-chip-a11y counts one "← Back" in
  // this file and pins its role, name and 44pt frame).
  it('every state has the way back on screen', () => {
    expect((code.match(/<BackLink onPress=\{\(\) => router\.back\(\)\} \/>/g) ?? []).length).toBe(
      2,
    );
    const { sf, els } = elements(
      DETAIL,
      (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)) && textOf(el, s) === '← Back',
    );
    expect(els).toHaveLength(1);
    expect(attrText(els[0]!, 'style', sf)).toBe('styles.backBtn');
  });

  // Mutation caught: Distribute back on a bespoke Pressable with no role, a
  // variant other than the ink primary, or its words hidden while it sends.
  it('Distribute is the ink button that commits the work, with its words beside the spinner', () => {
    const { sf, els } = elements(DETAIL, (el, s) => tagOf(el, s) === 'Button');
    expect(els).toHaveLength(1);
    const btn = els[0]!;
    expect(attrText(btn, 'variant', sf)).toBeUndefined(); // the default, primary (ink)
    expect(attrText(btn, 'onPress', sf)).toBe('distribute');
    expect(attrText(btn, 'disabled', sf)).toBe('busy || !warehouseId');
    expect(attrText(btn, 'leading', sf)).toBe(
      'busy ? <ActivityIndicator color={c.paper} /> : undefined',
    );
    expect(btn.getText(sf)).toContain(
      "{preview?.hasShortage ? 'Distribute with shortage' : 'Distribute'}",
    );
    expect(
      elements(
        DETAIL,
        (el, s) => TOUCHABLE_TAG.test(tagOf(el, s)) && attrText(el, 'onPress', s) === 'distribute',
      ).els,
    ).toHaveLength(0);
  });

  it('a warehouse choice is a 44pt button that says its name and whether it is chosen', () => {
    const { sf, els } = elements(
      DETAIL,
      (el, s) => attrText(el, 'onPress', s) === '() => setWarehouseId(w.id)',
    );
    expect(els).toHaveLength(1);
    const chip = els[0]!;
    expect(attrText(chip, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(chip, 'accessibilityLabel', sf)).toBe('w.name');
    expect(attrText(chip, 'accessibilityState', sf)).toBe('{ selected: active }');
    expect(styleBlock(DETAIL, 'whBtn')).toMatch(/minHeight: 44,/);
    expect(code).toContain(
      'styles.whBtn, { borderColor: active ? c.ink : c.hair2, backgroundColor: active ? c.ink : c.sunk, opacity: pressed ? 0.85 : 1, },',
    );
    expect(code).toContain(
      '<Text style={[styles.whLabel, { color: active ? c.paper : c.ink }]}> {w.name} </Text>',
    );
  });

  it('Quantity is the shared text box, named, its typed words uncapped as before', () => {
    const { sf, els } = elements(DETAIL, (el, s) => tagOf(el, s) === 'Field');
    expect(els).toHaveLength(1);
    const f = els[0]!;
    expect(attrText(f, 'label', sf)).toBe('Quantity');
    expect(attrText(f, 'accessibilityLabel', sf)).toBe('Quantity');
    expect(attrText(f, 'keyboardType', sf)).toBe('numeric');
    expect(attrText(f, 'value', sf)).toBe('qty');
    expect(attrText(f, 'onChangeText', sf)).toBe('setQty');
    expect(attrText(f, 'maxFontSizeMultiplier', sf)).toBe('0');
  });

  it('the preview keeps its words; a shortage is the warning wash with the warning icon', () => {
    expect(code).toContain(
      "{preview.fromPhantom} kit{preview.fromPhantom === 1 ? '' : 's'} from pre-assembled stock",
    );
    expect(code).toContain(
      "{preview.fromComponents} kit{preview.fromComponents === 1 ? '' : 's'} from individual components",
    );
    expect(code).toContain(
      "<TriangleAlert size={14} color={c.warnText} strokeWidth={2} /> <Body size={13} color={c.warnText} style={styles.shortText}> {preview.totalShortageUnits} unit {preview.totalShortageUnits === 1 ? '' : 's'} short </Body>",
    );
    expect(code).toContain(
      'preview.hasShortage ? { backgroundColor: c.warnWash, borderColor: c.warnWash } : { backgroundColor: c.sunk, borderColor: c.hair },',
    );
  });

  it('every word stays', () => {
    const words = wordsOf(DETAIL);
    for (const w of [
      '← Back',
      'Back',
      'Pre-assembled kits',
      'Components',
      '(deleted)',
      '—',
      'opt',
      'Distribute',
      'Quantity',
      'Warehouse',
      'Distribute with shortage',
      'Invalid quantity',
      'Enter a positive number.',
      'Distribute with shortage?',
      'Cancel',
      'Distributed',
      'OK',
      'Could not distribute',
      'Queued',
      'Mobile distribute',
      'Mobile distribute (offline)',
    ]) {
      expect(words, w).toContain(w);
    }
    expect(code).toContain('×{comp.quantity}');
    expect(code).toContain('{comp.isOptional ? <Pill dot={false}>opt</Pill> : null}');
  });
});

/**
 * WCAG contrast of every word and mark the two screens draw, in both modes
 * (AA: 4.5:1 for words, 3:1 for glyphs and marks).
 */
describe('contrast, both modes', () => {
  const WORDS: [keyof Palette, keyof Palette, string][] = [
    ['ink', 'paper', 'the titles, Back and Refresh'],
    ['ink3', 'paper', 'the empty words, the bundle SKU'],
    ['ink', 'card', 'names, quantities, the preview lines'],
    ['ink3', 'card', 'SKUs, labels, the row meta, the opt tag'],
    ['ink', 'sunk', 'an idle warehouse choice, the preview lines'],
    ['paper', 'ink', 'the chosen warehouse, Distribute'],
    ['ink', 'warnWash', 'the preview lines in a shortage'],
    ['warnText', 'warnWash', 'the shortage line'],
  ];
  const MARKS: [keyof Palette, keyof Palette, string][] = [
    ['ink', 'paper', 'the refresh glyph and spinner'],
    ['ink4', 'card', 'the row chevron'],
    ['warnText', 'warnWash', 'the shortage glyph'],
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
