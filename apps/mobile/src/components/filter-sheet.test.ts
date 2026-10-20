import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  TOUCHABLE_TAG,
  attrText,
  hasContent,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from '../lib/__fixtures__/jsx-touch-audit';
import { palette } from '../lib/theme';
import { AA_TEXT, AA_UI, contrast } from './ui/__fixtures__/contrast';

/**
 * THE ITEMS AND BOOKS FILTER SHEET, READ AS SOURCE (redesign package P5.5).
 *
 * One sheet serves both tabs: STOCK (five views), SORT (five orders),
 * CATEGORY, LOCATION and CHARTER (with "Generic (any charter)"), CLEAR ALL and
 * Apply, plus the filter button beside each search box and the active-filter
 * pill under it. The restyle kept every option, word and state change; these
 * pin them, and what it fixed (CONFLICTS D29 and the sheet pattern of
 * sheet-a11y-structure.test.ts):
 *
 *  - the filter button had no name (an icon and a number);
 *  - the option rows had no role or state, so VoiceOver read a name and
 *    nothing about whether it was chosen, and their marks' edges were the
 *    hairline, under the 3:1 a mark needs;
 *  - the scrim was an unnamed element, and VoiceOver could leave the sheet;
 *  - CLEAR ALL was not a button, its words in the faint ink4, its target
 *    about 30pt; the option rows were 42.5pt; the pill about 30pt;
 *  - on a small phone the sheet could grow past the top of the screen.
 *
 * Read with the TypeScript parser (no React Native renderer in this suite),
 * with the sheet's pure helpers compiled from its own source and run.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const FILE = 'src/components/filter-sheet.tsx';
const src = readSource(path.join(MOBILE_ROOT, FILE));
const sf = parseTsx(src, FILE);

function codeOnly(text: string): string {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
const code = codeOnly(src);

/** Top-level functions and consts of the sheet, compiled and run. */
function sheetHelpers(names: string[]): Record<string, (...args: unknown[]) => unknown> {
  const parts = sf.statements
    .filter((st) => {
      if (ts.isFunctionDeclaration(st)) return !!st.name && names.includes(st.name.text);
      return false;
    })
    // The functions are exported; the context only needs their bodies.
    .map((st) => st.getText(sf).replace(/^export\s+/, ''));
  expect(parts, names.join(', ')).toHaveLength(names.length);
  const js = ts.transpileModule(`${parts.join('\n')}\n({ ${names.join(', ')} });`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext({}) as Record<string, (...args: unknown[]) => unknown>;
}

function functionNamed(name: string): ts.FunctionDeclaration {
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
  if (!fn) throw new Error(`${name} is not declared in ${FILE}`);
  return fn;
}

/** Every element inside one function, with its ancestors (outermost first). */
function nodesIn(name: string): { el: JsxNode; ancestors: JsxNode[] }[] {
  const out: { el: JsxNode; ancestors: JsxNode[] }[] = [];
  walkJsx(functionNamed(name), (el, ancestors) => out.push({ el, ancestors: [...ancestors] }));
  return out;
}

function jsxChildren(el: JsxNode): JsxNode[] {
  if (!ts.isJsxElement(el)) return [];
  return el.children.filter(
    (ch): ch is ts.JsxElement | ts.JsxSelfClosingElement =>
      ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch),
  );
}

/** The words an element shows: its JSX text, children joined. */
function textOf(el: ts.Node): string {
  const parts: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) parts.push(n.getText(sf).trim());
    ts.forEachChild(n, visit);
  };
  visit(el);
  return parts.filter(Boolean).join(' ');
}

/** A `name: {...}` block of one of the sheet's StyleSheets. */
function styleBlock(name: string): string {
  return new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(src)?.[1] ?? '';
}

/** Everything a person can read in the sheet: JSX text and string literals. */
function wordsOfFile(): string[] {
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

const MODES = ['light', 'dark'] as const;

describe('every option, word and state change is kept', () => {
  it('STOCK, SORT, CATEGORY, LOCATION, CHARTER, CLEAR ALL and Apply, word for word', () => {
    const words = wordsOfFile();
    for (const w of [
      'FILTERS',
      'CLEAR ALL',
      'STOCK',
      'SORT',
      'All items',
      'Low + critical',
      'Out of stock',
      'Archived',
      'Expected (awaiting first receipt)',
      'Recently updated',
      'Name (A → Z)',
      'Name (Z → A)',
      'On hand (high → low)',
      'On hand (low → high)',
      'CATEGORY · ',
      'LOCATION · ',
      'CHARTER · ',
      'ANY',
      'Generic (any charter)',
      'Apply',
      'Generic',
      'Expected',
    ]) {
      expect(words, w).toContain(w);
    }
  });

  it('each STOCK choice sets its status, each SORT choice its order, and CLEAR ALL the empty state', () => {
    for (const s of ['all', 'low', 'out', 'archived', 'expected']) {
      expect(code).toContain(`active={state.status === '${s}'}`);
      expect(code).toContain(`onPress={() => onChange({ ...state, status: '${s}' })}`);
    }
    expect(code).toContain('onPress={() => onChange({ ...state, sort: k })}');
    expect(code).toContain('onPress={() => onChange(EMPTY_FILTER_STATE)}');
    for (const list of ['categoryIds', 'locationIds', 'charterIds']) {
      expect(code).toContain(`onChange({ ...state, ${list}: toggleIn(state.${list}, opt.id) })`);
    }
    // Apply and the scrim close the sheet; nothing else changed its contract.
    expect(code).toMatch(/<Button block onPress=\{onDismiss\}/);
    expect(code).toContain('onRequestClose={onDismiss}');
  });

  it('the pure helpers still count and name what they did', () => {
    const { activeFilterCount, filterButtonLabel } = sheetHelpers([
      'activeFilterCount',
      'filterButtonLabel',
    ]);
    const empty = {
      status: 'all',
      sort: 'updated_desc',
      categoryIds: [],
      locationIds: [],
      charterIds: [],
    };
    expect(activeFilterCount!(empty)).toBe(0);
    expect(
      activeFilterCount!({
        status: 'low',
        sort: 'name_asc',
        categoryIds: ['a', 'b'],
        locationIds: ['l'],
        charterIds: ['__generic__'],
      }),
    ).toBe(6);
    // D29: the filter button's spoken name, with the count it shows.
    expect(filterButtonLabel!(0)).toBe('Filters');
    expect(filterButtonLabel!(1)).toBe('Filters, 1 active');
    expect(filterButtonLabel!(6)).toBe('Filters, 6 active');
  });
});

describe('VoiceOver: the sheet keeps VoiceOver in, and every row says what it is', () => {
  const nodes = nodesIn('FilterSheet');
  const container = nodes.find((n) => attrText(n.el, 'accessibilityViewIsModal', sf) === 'true');

  it('the container keeps VoiceOver inside the sheet, and the escape scrub closes it', () => {
    expect(container).toBeDefined();
    expect(tagOf(container!.el, sf)).toBe('View');
    expect(attrText(container!.el, 'onAccessibilityEscape', sf)).toBe('onDismiss');
    expect(attrText(container!.el, 'style', sf)).toBe('styles.container');
    expect(styleBlock('container')).toMatch(/flex: 1,\s*justifyContent: 'flex-end',/);
  });

  it('the scrim is a childless "Close" button behind the card, closing on a tap and a VoiceOver double-tap', () => {
    const [scrim, card, ...rest] = jsxChildren(container!.el);
    expect(rest).toEqual([]);
    expect(tagOf(scrim!, sf)).toBe('Pressable');
    expect(hasContent(scrim!)).toBe(false);
    expect(attrText(scrim!, 'onPress', sf)).toBe('onDismiss');
    expect(attrText(scrim!, 'onAccessibilityTap', sf)).toBe('onDismiss');
    expect(attrText(scrim!, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(scrim!, 'accessibilityLabel', sf)).toBe('Close');
    const style = attrText(scrim!, 'style', sf) ?? '';
    expect(style).toContain('StyleSheet.absoluteFill');
    expect(style).toContain("mode === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(14,15,13,0.35)'");
    // The card is a plain View (never a touchable that would fold the sheet
    // into one element or steal the list's scroll).
    expect(tagOf(card!, sf)).toBe('View');
    for (const prop of ['onPress', 'accessible', 'onStartShouldSetResponder']) {
      expect(attrText(card!, prop, sf)).toBeUndefined();
    }
  });

  it('the title is a heading; CLEAR ALL is a button in a 44pt frame', () => {
    const title = nodes.find((n) => textOf(n.el) === 'FILTERS' && tagOf(n.el, sf) === 'Mono');
    expect(title && attrText(title.el, 'accessibilityRole', sf)).toBe('header');
    const clear = nodes.find(
      (n) => tagOf(n.el, sf) === 'Pressable' && textOf(n.el) === 'CLEAR ALL',
    );
    expect(clear).toBeDefined();
    expect(attrText(clear!.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(clear!.el, 'hitSlop', sf)).toBeUndefined();
    expect(styleBlock('clearAll')).toMatch(/minHeight: 44,\s*minWidth: 44,/);
  });

  it('a STOCK or SORT row is a radio with its checked state; its section a radio group', () => {
    const radio = nodesIn('RadioRow').find((n) => tagOf(n.el, sf) === 'Pressable');
    expect(attrText(radio!.el, 'accessibilityRole', sf)).toBe('radio');
    expect(attrText(radio!.el, 'accessibilityState', sf)).toBe('{ checked: active }');
    expect(code).toMatch(/<Section label="STOCK" choice="radio">/);
    expect(code).toMatch(/<Section label="SORT" choice="radio">/);
    expect(code).toContain("accessibilityRole={choice === 'radio' ? 'radiogroup' : undefined}");
    expect(code).toContain('<Eyebrow accessibilityRole="header">{label}</Eyebrow>');
  });

  it('a CATEGORY, LOCATION or CHARTER row is the checkbox: the shared mark inside, the role and state on the row', () => {
    const rows = nodesIn('CheckRow');
    const press = rows.find((n) => tagOf(n.el, sf) === 'Pressable')!;
    expect(attrText(press.el, 'accessibilityRole', sf)).toBe('checkbox');
    expect(attrText(press.el, 'accessibilityState', sf)).toBe('{ checked: active }');
    const mark = rows.find((n) => tagOf(n.el, sf) === 'CheckboxMark');
    expect(mark && attrText(mark.el, 'checked', sf)).toBe('active');
    expect(mark!.ancestors).toContain(press.el);
    // The hand-drawn box is gone.
    expect(code).not.toContain('optStyles.checkbox');
    expect(code).toContain("import { CheckboxMark } from '@/components/ui/checkbox';");
    for (const sect of ['CATEGORY', 'LOCATION', 'CHARTER']) {
      expect(code).toMatch(new RegExp(`label=\\{\`${sect} · [^\`]*\`\\} choice="check"`));
    }
  });

  it('every control in the card is its own element with a role', () => {
    const card = jsxChildren(container!.el)[1]!;
    const inCard = nodes.filter(
      (n) => n.ancestors.includes(card) && TOUCHABLE_TAG.test(tagOf(n.el, sf)),
    );
    expect(inCard.length).toBeGreaterThan(0);
    for (const n of inCard) {
      // No touchable sits inside another one in the card.
      const above = n.ancestors.slice(n.ancestors.indexOf(card) + 1);
      expect(above.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toEqual([]);
      expect(attrText(n.el, 'accessibilityRole', sf)).toBeDefined();
    }
  });
});

describe('targets and the sheet height', () => {
  it('each option row is at least 44pt tall (it was 42.5pt)', () => {
    expect(styleBlock('row')).toMatch(/minHeight: 44,/);
  });

  it('the sheet stops at 90% of the screen, and its list gives way (ScrollView shrinks by default)', () => {
    expect(styleBlock('sheet')).toMatch(/maxHeight: '90%',/);
    expect(code).toContain('style={{ maxHeight: 520 }}');
    // The list may not opt out of shrinking, or the header would go off screen.
    expect(code).not.toMatch(/flexShrink: 0/);
  });

  it('the active-filter pill is a 44pt button that says what a tap does', () => {
    const fn = nodesIn('ActiveFilterPill');
    const press = fn.find((n) => tagOf(n.el, sf) === 'Pressable')!;
    expect(attrText(press.el, 'onPress', sf)).toBe('onClear');
    expect(attrText(press.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(press.el, 'accessibilityHint', sf)).toBe('Clears all filters');
    expect(/\n {2}row: \{[^}]*\}/.exec(src.slice(src.indexOf('const pillStyles')))?.[0]).toMatch(
      /minHeight: 44,/,
    );
  });

  it('the filter button is a named button; its 32pt chip keeps the 6pt slop that makes 44pt in the search box', () => {
    const fn = nodesIn('FilterButton');
    const press = fn.find((n) => tagOf(n.el, sf) === 'Pressable')!;
    expect(attrText(press.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(press.el, 'accessibilityLabel', sf)).toBe('filterButtonLabel(count)');
    expect(attrText(press.el, 'hitSlop', sf)).toBe('6');
    expect(styleBlock('btn')).toMatch(/minHeight: 32,/);
  });
});

describe('the look, measured in both modes', () => {
  it('no hard-coded colour for words, fills or borders, and no mode-independent accent', () => {
    // The scrim and the grabber are the app's shared per-mode overlays.
    const hex = [...code.matchAll(/#[0-9a-f]{3,8}\b/gi)];
    expect(hex).toEqual([]);
    expect(code).not.toMatch(/\bACCENT\b/);
    expect(code).not.toMatch(/c\.ink5|c\.paper2/);
  });

  it('informational words are muted ink or stronger: CLEAR ALL, the pill, its X', () => {
    expect(code).toMatch(/<Mono size=\{11\.5\} tracking=\{0\.06\} color=\{c\.ink3\}>\s*CLEAR ALL/);
    expect(code).toMatch(/color: c\.ink3,\s*\}\}\s*>\s*\{parts\.join\(' · '\)\}/);
    expect(code).toContain('<X size={12} color={c.ink3} strokeWidth={1.6} />');
    for (const mode of MODES) {
      const c = palette(mode);
      expect(contrast(c.ink3, c.card), mode).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(c.ink, c.card), mode).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("a clear radio's ring is the checkbox's ink4 edge, 3:1 or more on the card; a chosen one is ink", () => {
    expect(code).toContain(
      'style={[optStyles.dot, { borderColor: active ? c.ink : c.ink4, backgroundColor: c.card }]}',
    );
    expect(styleBlock('dot')).toMatch(/width: 22,\s*height: 22,/);
    for (const mode of MODES) {
      const c = palette(mode);
      expect(contrast(c.ink4, c.card), mode).toBeGreaterThanOrEqual(AA_UI);
      expect(contrast(c.hair, c.card), `${mode}: the old hairline ring`).toBeLessThan(AA_UI);
      expect(contrast(c.ink, c.card), mode).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  it("the filter button and the pill take the stronger border (a control's edge), never the hairline", () => {
    expect(code).toContain('borderColor: isActive ? c.ink : c.hair2,');
    expect(code).toContain(
      '{ borderColor: c.hair2, backgroundColor: c.card, opacity: pressed ? 0.8 : 1 }',
    );
  });
});
