import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  GROUP_COPY,
  GROUPING_ERROR_WORDS,
  GROUPING_MAX_ITEMS,
  UNGROUP_COPY,
} from '@stockpilot/core';

import {
  TOUCHABLE_TAG,
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from '../lib/__fixtures__/jsx-touch-audit';
// vi.mock below is hoisted above every import by vitest: the two libs reach
// the network client, which imports native modules.
import { groupSelectedHref, phoneGroupingCheck } from '../lib/display-groups';
import { palette } from '../lib/theme';
import { phoneUngroupCheck, ungroupSelectedHref } from '../lib/ungroup-selected';
import { AA_TEXT, contrast } from './ui/__fixtures__/contrast';

vi.mock('../lib/api', () => ({ api: vi.fn(), ApiError: class extends Error {} }));

/**
 * THE PHONE SELECT BAR, READ AS SOURCE (redesign package P5.5; the owner:
 * "make sure our check boxes and grouping and ungrouping works in the
 * redeisgn as well please").
 *
 * The bar floats over the Items and Books tabs in select mode and reads the
 * one selection store both tabs and the count picker share. It took the
 * reference's select-bar look (DESIGN-SPEC 6.21). What had to survive it, and
 * is pinned here: Group and Ungroup check for a connection before anything
 * else and refuse what the review could only refuse (Group: 2 to 100 distinct
 * records of one type; Ungroup: at most 100), each with core's own words; the
 * gates (items:update, and for a size family sports:manage with the sports
 * module); every pick's id reaching the review; Review opening the count;
 * Clear. Plus what the restyle fixed: every action a real 44pt frame with a
 * button role, the bar's height reported so a list keeps its pager clear.
 *
 * The mobile suite has no React Native renderer, so the bar's own functions
 * are compiled from the repository's source (never from input) and run over
 * fakes, the way scanner-structure.test.ts runs the Scan tab's helpers.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const BAR = 'src/components/count-select-bar.tsx';
const src = readSource(path.join(MOBILE_ROOT, BAR));
const sf = parseTsx(src, BAR);

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(text: string): string {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** A function declared anywhere in the bar (top level or inside the
 *  component), compiled to run in a context that supplies what it closes
 *  over. */
function barFunction(name: string, context: Record<string, unknown>) {
  let text: string | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) text = n.getText(sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(text, `function ${name} in ${BAR}`).not.toBeNull();
  const js = ts.transpileModule(`${text}\n${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext(context) as () => Promise<void>;
}

/** The touchable that holds the given words (its JSX text). */
function touchableWithText(words: string): JsxNode {
  const hits: JsxNode[] = [];
  walkJsx(sf, (el, ancestors) => {
    if (!ts.isJsxElement(el)) return;
    const text = el.children
      .filter(ts.isJsxText)
      .map((t) => t.getText(sf).trim())
      .join('');
    const expr = el.children
      .filter(ts.isJsxExpression)
      .map((x) => x.getText(sf))
      .join('');
    if (text !== words && expr !== `{${words}}`) return;
    const host = [...ancestors].reverse().find((a) => TOUCHABLE_TAG.test(tagOf(a, sf)));
    if (host) hits.push(host);
  });
  expect(hits, `one touchable around ${words}`).toHaveLength(1);
  return hits[0]!;
}

/** A `name: {...}` block of the bar's StyleSheet. */
function styleBlock(name: string): string {
  return new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(src)?.[1] ?? '';
}

const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid(n),
  sku: `SKU-${n}`,
  name: `Item ${n}`,
  itemType: 'product',
  ...over,
});

/** Runs openGroup or openUngroup as the bar does, over these picks. */
async function tap(name: 'openGroup' | 'openUngroup', picks: unknown[], online: boolean) {
  const alerts: [string, string][] = [];
  const pushes: unknown[] = [];
  const run = barFunction(name, {
    picks,
    isOnline: async () => online,
    Alert: { alert: (title: string, body: string) => alerts.push([title, body]) },
    router: { push: (href: unknown) => pushes.push(href) },
    GROUP_COPY,
    UNGROUP_COPY,
    phoneGroupingCheck,
    groupSelectedHref,
    phoneUngroupCheck,
    ungroupSelectedHref,
  });
  await run();
  return { alerts, pushes };
}

describe('Group: a connection first, then 2 to 100 distinct records of one type', () => {
  it('offline: the Group alert with the offline words, and no review opens', async () => {
    const r = await tap('openGroup', [item(1), item(2)], false);
    expect(r.alerts).toEqual([[GROUP_COPY.bulkAction, GROUP_COPY.offline]]);
    expect(r.pushes).toEqual([]);
  });

  it('the connection is checked first: offline, even a selection Group would refuse hears the offline words', async () => {
    for (const picks of [
      [item(1)],
      [item(1), item(2, { itemType: 'book' })],
      Array.from({ length: GROUPING_MAX_ITEMS + 1 }, (_, i) => item(i + 1)),
    ]) {
      const r = await tap('openGroup', picks, false);
      expect(r.alerts).toEqual([[GROUP_COPY.bulkAction, GROUP_COPY.offline]]);
      expect(r.pushes).toEqual([]);
    }
  });

  it('one record: refused with core words', async () => {
    const r = await tap('openGroup', [item(1)], true);
    expect(r.alerts).toEqual([[GROUP_COPY.bulkAction, GROUP_COPY.blocked.tooFew]]);
    expect(r.pushes).toEqual([]);
  });

  it('an item and a book together: refused with core words', async () => {
    const r = await tap('openGroup', [item(1), item(2, { itemType: 'book' })], true);
    expect(r.alerts).toEqual([[GROUP_COPY.bulkAction, GROUPING_ERROR_WORDS.mixedTypes]]);
    expect(r.pushes).toEqual([]);
  });

  it('101 records: refused before the review opens', async () => {
    const picks = Array.from({ length: GROUPING_MAX_ITEMS + 1 }, (_, i) => item(i + 1));
    const r = await tap('openGroup', picks, true);
    expect(r.alerts).toEqual([[GROUP_COPY.bulkAction, GROUPING_ERROR_WORDS.groupTooMany]]);
    expect(r.pushes).toEqual([]);
  });

  it('2 and 100 records open the review with every id (books: the Books reading)', async () => {
    const two = await tap('openGroup', [item(1), item(2)], true);
    expect(two.alerts).toEqual([]);
    expect(two.pushes).toEqual([
      { pathname: '/group-selected', params: { ids: `${uuid(1)},${uuid(2)}`, view: 'items' } },
    ]);
    const hundred = Array.from({ length: GROUPING_MAX_ITEMS }, (_, i) =>
      item(i + 1, { itemType: 'book' }),
    );
    const r = await tap('openGroup', hundred, true);
    expect(r.alerts).toEqual([]);
    const pushed = r.pushes[0] as { params: { ids: string; view: string } };
    expect(pushed.params.view).toBe('books');
    expect(pushed.params.ids.split(',')).toEqual(hundred.map((p) => p.id));
  });

  it('a pick ticked twice still counts once (distinct records)', async () => {
    const r = await tap('openGroup', [item(1), item(1)], true);
    expect(r.alerts).toEqual([[GROUP_COPY.bulkAction, GROUP_COPY.blocked.tooFew]]);
  });
});

describe('Ungroup: a connection first, then at most 100, with where each record is shown', () => {
  const g = (shownUnder: string | null) => ({
    displayGroupId: shownUnder === 'group' ? 'grp' : null,
    familyId: shownUnder === 'family' ? 'fam' : null,
    sharesSku: shownUnder === 'sku',
    shownUnder,
  });

  it('offline: the Ungroup alert with its offline words, and no review opens', async () => {
    const r = await tap('openUngroup', [item(1, { grouping: g('group') })], false);
    expect(r.alerts).toEqual([[UNGROUP_COPY.bulkAction, UNGROUP_COPY.selectedOffline]]);
    expect(r.pushes).toEqual([]);
  });

  it('101 records: refused before the review opens', async () => {
    const picks = Array.from({ length: GROUPING_MAX_ITEMS + 1 }, (_, i) =>
      item(i + 1, { grouping: g('sku') }),
    );
    const r = await tap('openUngroup', picks, true);
    expect(r.alerts).toEqual([[UNGROUP_COPY.bulkAction, GROUPING_ERROR_WORDS.tooMany]]);
    expect(r.pushes).toEqual([]);
    // The connection is checked first: offline, 101 hears the offline words.
    const offline = await tap('openUngroup', picks, false);
    expect(offline.alerts).toEqual([[UNGROUP_COPY.bulkAction, UNGROUP_COPY.selectedOffline]]);
  });

  it('100 records open the review', async () => {
    const picks = Array.from({ length: GROUPING_MAX_ITEMS }, (_, i) =>
      item(i + 1, { grouping: g('group') }),
    );
    const r = await tap('openUngroup', picks, true);
    expect(r.alerts).toEqual([]);
    expect(r.pushes).toHaveLength(1);
  });

  it('opens the review with every id and one "under" letter per id, from the facts kept at tick time', async () => {
    const picks = [
      item(1, { grouping: g('group') }),
      item(2, { grouping: g('sku') }),
      item(3, { grouping: g('family') }),
      item(4, { grouping: g(null) }),
      item(5),
    ];
    const r = await tap('openUngroup', picks, true);
    expect(r.alerts).toEqual([]);
    expect(r.pushes).toEqual([
      {
        pathname: '/ungroup-selected',
        params: { ids: picks.map((p) => p.id).join(','), view: 'items', under: 'gsf--' },
      },
    ]);
  });
});

describe('the gates and the actions, as the bar draws them', () => {
  const code = codeOnly(src);

  // The rules themselves (items:update; sports:manage with the sports module)
  // live in countSelectOffers since B42, and count-select-offers.test.ts runs
  // them.
  it('Group is offered to someone who can edit items; Ungroup by core rule, families with sports:manage and the module', () => {
    expect(code).toContain(
      'const offers = countSelectOffers({ role, permissions, enabledModules });',
    );
    expect(code).toContain('const canGroup = offers.group;');
    expect(code).toMatch(
      /const canUngroup = phoneUngroupOffer\(picks, \{\s*editItems: offers\.group,\s*unlinkFamilies: offers\.unlinkFamilies,\s*\}\);/,
    );
    expect(code).toMatch(/\{canGroup \? \(\s*<Pressable\s+onPress=\{\(\) => void openGroup\(\)\}/);
    expect(code).toMatch(
      /\{canUngroup \? \(\s*<Pressable\s+onPress=\{\(\) => void openUngroup\(\)\}/,
    );
  });

  it('hidden outside select mode; Clear empties the shared store; Review opens a new count', () => {
    expect(code).toContain('if (!visible) return null;');
    expect(code).toContain('onPress={() => countSelection.clear()}');
    expect(code).toMatch(
      /onPress=\{\(\) => \{\s*if \(count === 0\) return;\s*router\.push\('\/cycle-count\/new'\);\s*\}\}/,
    );
  });

  it('every action is a button, off at 0 picks, in a real 44pt frame; Group and Ungroup keep their spoken names', () => {
    const actions: [string, string | undefined, string][] = [
      ['Clear', undefined, 'styles.textAction'],
      ['GROUP_COPY.bulkActionShort', 'GROUP_COPY.bulkAction', 'styles.textAction'],
      ['UNGROUP_COPY.bulkAction', 'UNGROUP_COPY.bulkAction', 'styles.textAction'],
    ];
    for (const [words, name, style] of actions) {
      const t = touchableWithText(words);
      expect(attrText(t, 'accessibilityRole', sf), words).toBe('button');
      expect(attrText(t, 'accessibilityLabel', sf), words).toBe(name);
      expect(attrText(t, 'disabled', sf), words).toBe('count === 0');
      expect(attrText(t, 'style', sf), words).toBe(style);
      expect(attrText(t, 'hitSlop', sf), words).toBe('GROUP_HIT_SLOP');
    }
    const review = touchableWithText('Review');
    expect(attrText(review, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(review, 'disabled', sf)).toBe('count === 0');
    expect(styleBlock('textAction')).toMatch(/minHeight: 44,/);
    expect(styleBlock('reviewBtn')).toMatch(/minHeight: 44,/);
    expect(styleBlock('reviewBtn')).toMatch(/borderRadius: 10,/);
    // P11's slop, kept: it still widens each action by 8pt a side.
    expect(code).toMatch(/GROUP_HIT_SLOP = \{ top: 14, bottom: 14, left: 8, right: 8 \}/);
    // Never the old height-only frame of the words alone.
    expect(code).not.toContain('hitSlop={8}');
  });

  it('keeps every word: the count, Clear, Group, Ungroup and Review', () => {
    expect(code).toMatch(/\{count\} selected\s*<\/Mono>/);
    expect(code).toMatch(/>\s*Clear\s*</);
    expect(code).toContain('{GROUP_COPY.bulkActionShort}');
    expect(code).toContain('{UNGROUP_COPY.bulkAction}');
    expect(code).toMatch(/>\s*Review\s*</);
    expect(GROUP_COPY.bulkActionShort).toBe('Group');
    expect(GROUP_COPY.bulkAction).toBe('Group selected');
  });

  it('reports its height from its own layout, so a list can keep its pager clear of it', () => {
    expect(code).toContain(
      'onLayout={onHeight ? (e) => onHeight(e.nativeEvent.layout.height) : undefined}',
    );
    expect(code).toContain(
      '{ bottom: bottomInset + 12, backgroundColor: c.card, borderColor: c.hair2 }',
    );
  });
});

describe('the look: the reference select bar, in both modes', () => {
  const code = codeOnly(src);

  it('the card surface with the stronger border, radius 14, and a theme shadow (no hard-coded colour)', () => {
    expect(styleBlock('wrap')).toMatch(/borderRadius: 14,/);
    expect(code).toContain('SHADOW.fab');
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(code).not.toMatch(/\bACCENT\b/);
  });

  it('the words read at AA on the bar in both modes; the faint ink only marks an action that is off', () => {
    for (const mode of ['light', 'dark'] as const) {
      const c = palette(mode);
      // The count and Group / Ungroup (ink), Clear (ink3), Review (paper on ink).
      expect(contrast(c.ink, c.card), mode).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(c.ink3, c.card), mode).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(c.paper, c.ink), mode).toBeGreaterThanOrEqual(AA_TEXT);
    }
    // ink4 appears only behind `count === 0 ?`, the disabled look.
    const faint = [...code.matchAll(/c\.ink4/g)].map((m) => code.slice(m.index! - 20, m.index));
    expect(faint.length).toBe(3);
    for (const before of faint) expect(before).toContain('count === 0 ?');
  });
});
