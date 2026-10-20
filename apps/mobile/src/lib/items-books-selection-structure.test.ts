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
 * THE ITEMS AND BOOKS TABS AND THEIR GROUP / UNGROUP REVIEWS, READ AS SOURCE
 * (redesign package P5.5; the owner: "make sure our check boxes and grouping
 * and ungrouping works in the redeisgn as well please").
 *
 * The Items tab (app/(drawer)/(tabs)/inventory.tsx), the Books tab
 * (app/(drawer)/(tabs)/books.tsx), the Group selected review
 * (app/group-selected.tsx) and the Ungroup review (app/ungroup-selected.tsx)
 * took the redesign's look on the per-mode palette. The look is all that
 * moved. These pin what had to survive it, and what the package fixed:
 *
 *  - select mode: a row is the checkbox, announced with its state (D29); the
 *    shared CheckboxMark draws the box; group headers never take a pick;
 *  - one selection store for both tabs and the count picker, each pick
 *    keeping what its record would leave on Ungroup as it was when ticked;
 *  - Add to group for an editor outside select mode, on the row and as the
 *    VoiceOver action; the lists re-read after a save on a review;
 *  - the select bar on both tabs, and the list's end kept clear of it;
 *  - the reviews' eyebrows, strict params, online checks, words, the family
 *    acknowledgement on the shared Checkbox, and their pinned footer;
 *  - the performance shape (memo rows, FlatList tuning, one scale read);
 *  - the colours, measured in both modes.
 *
 * The mobile suite has no React Native renderer, so the screens are read with
 * the TypeScript parser, and the expressions that decide behaviour are
 * compiled from the repository's own source (never from input) and run, the
 * way scanner-structure.test.ts and header-chip-a11y.test.ts read theirs.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');
const ITEMS = 'app/(drawer)/(tabs)/inventory.tsx';
const BOOKS = 'app/(drawer)/(tabs)/books.tsx';
const GROUP = 'app/group-selected.tsx';
const UNGROUP = 'app/ungroup-selected.tsx';
const BAR = 'src/components/count-select-bar.tsx';

const LIGHT = palette('light');
const DARK = palette('dark');
const MODES: [string, Palette][] = [
  ['light', LIGHT],
  ['dark', DARK],
];

const sourceOf = (file: string) => readSource(path.join(MOBILE_ROOT, file));
const treeOf = (file: string) => parseTsx(sourceOf(file), file);

/** Source with comments stripped, so a comment can never satisfy a pin. */
function codeOnly(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** A component declared as `function Name` or `const Name = React.memo(function Name`. */
function componentNamed(sf: ts.SourceFile, name: string): ts.FunctionLikeDeclaration {
  let found: ts.FunctionLikeDeclaration | null = null;
  const visit = (n: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) &&
      n.name?.text === name &&
      n.body
    ) {
      found ??= n;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) throw new Error(`${name} is not declared in ${sf.fileName}`);
  return found;
}

type Found = { el: JsxNode; ancestors: JsxNode[] };

/** Every element inside a node, with its JSX ancestors (outermost first). */
function nodesIn(root: ts.Node): Found[] {
  const out: Found[] = [];
  walkJsx(root, (el, ancestors) => out.push({ el, ancestors: [...ancestors] }));
  return out;
}

/** The innermost touchable around an element. */
function hostOf(f: Found, sf: ts.SourceFile): JsxNode | undefined {
  return [...f.ancestors].reverse().find((a) => TOUCHABLE_TAG.test(tagOf(a, sf)));
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

/**
 * The conditions a JSX element renders under, read from the screen: every
 * `cond ? <el> : ...`, `cond ? ... : <el>` and `cond && <el>` between it and
 * the component's return, joined with && (scanner-structure.test.ts's rule).
 */
function renderCondition(sf: ts.SourceFile, el: JsxNode): string {
  const parts: string[] = [];
  let node: ts.Node = el;
  while (node.parent && !ts.isReturnStatement(node.parent) && !ts.isSourceFile(node.parent)) {
    const p: ts.Node = node.parent;
    if (ts.isConditionalExpression(p)) {
      if (node === p.whenTrue) parts.push(`(${p.condition.getText(sf)})`);
      else if (node === p.whenFalse) parts.push(`!(${p.condition.getText(sf)})`);
    } else if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      node === p.right
    ) {
      parts.push(`(${p.left.getText(sf)})`);
    }
    node = p;
  }
  return parts.length ? parts.join(' && ') : 'true';
}

/** Runs a source expression in a context of its free names. */
function run(expression: string, context: Record<string, unknown>): unknown {
  const js = ts.transpileModule(`(${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext(context);
}

/** The arrow inside `const name = React.useCallback(arrow, deps)` of a file. */
function callbackArrow(sf: ts.SourceFile, name: string): string {
  let text: string | null = null;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer &&
      ts.isCallExpression(n.initializer) &&
      n.initializer.expression.getText(sf) === 'React.useCallback'
    ) {
      text = n.initializer.arguments[0]!.getText(sf);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(text, `${name} = React.useCallback(...) in ${sf.fileName}`).not.toBeNull();
  return text!;
}

/** A `name: {...}` block of one of a file's StyleSheets (2-space indent). */
function styleBlock(src: string, name: string): string {
  return new RegExp(`\\n {2}${name}: \\{([^}]*)\\}`).exec(src)?.[1] ?? '';
}

// ── The two tabs ──────────────────────────────────────────────────────────

/** The row component of each tab that takes a pick, its record's name, and
 *  the press handler outside select mode. */
const TABS = [
  {
    name: 'Items',
    file: ITEMS,
    row: 'ItemRow',
    rec: 'item',
    open: 'onItemPress',
    view: 'items',
    type: 'product',
  },
  {
    name: 'Books',
    file: BOOKS,
    row: 'BookCard',
    rec: 'book',
    open: 'onBookPress',
    view: 'books',
    type: 'book',
  },
] as const;

/** The header components, which expand and never take a pick. */
const HEADERS: [string, string][] = [
  [ITEMS, 'GroupHeaderRow'],
  [ITEMS, 'SkuGroupHeaderRow'],
  [BOOKS, 'BookGroupHeaderCard'],
];

describe.each(TABS)('$name tab: in select mode a row is the checkbox (D29)', (t) => {
  const sf = treeOf(t.file);
  const code = codeOnly(sourceOf(t.file));
  const row = componentNamed(sf, t.row);
  const marks = nodesIn(sf).filter((n) => tagOf(n.el, sf) === 'CheckboxMark');

  it('one CheckboxMark, in the row, checked from the per-row subscription', () => {
    expect(marks).toHaveLength(1);
    expect(nodesIn(row).some((n) => n.el === marks[0]!.el)).toBe(true);
    expect(attrText(marks[0]!.el, 'checked', sf)).toBe('picked');
    expect(code).toContain(`const picked = useIsPicked(${t.rec}.id);`);
    // Never the standalone Checkbox (it would nest a control in the row).
    expect(nodesIn(sf).filter((n) => tagOf(n.el, sf) === 'Checkbox')).toEqual([]);
    // The hand-drawn circles are gone.
    expect(code).not.toMatch(/\bCheckCircle2\b|\bCircle\b/);
    expect(code).toContain("import { CheckboxMark } from '@/components/ui/checkbox';");
  });

  it('the row that holds it is announced as a checkbox with its checked state, and as a button outside select mode', () => {
    const host = hostOf(marks[0]!, sf)!;
    expect(tagOf(host, sf)).toBe('Pressable');
    const role = attrText(host, 'accessibilityRole', sf)!;
    const state = attrText(host, 'accessibilityState', sf)!;
    expect(role).toBe("selectMode ? 'checkbox' : 'button'");
    expect(state).toBe('selectMode ? { checked: picked } : undefined');
    // Run them: what VoiceOver is told in each case.
    for (const picked of [true, false]) {
      expect(run(role, { selectMode: true, picked })).toBe('checkbox');
      expect(run(state, { selectMode: true, picked })).toEqual({ checked: picked });
      expect(run(role, { selectMode: false, picked })).toBe('button');
      expect(run(state, { selectMode: false, picked })).toBeUndefined();
    }
  });

  it('the box shows only in select mode, and a tap or a double tap goes through the same handler as before', () => {
    expect(run(renderCondition(sf, marks[0]!.el), { selectMode: true })).toBe(true);
    expect(run(renderCondition(sf, marks[0]!.el), { selectMode: false })).toBe(false);
    const host = hostOf(marks[0]!, sf)!;
    const press = `() => (selectMode ? onToggleSelect(${t.rec}) : ${t.open}(${t.rec}.id))`;
    expect(attrText(host, 'onPress', sf)).toBe(press);
    expect(attrText(host, 'accessibilityActions', sf)).toBe(
      'groupRowAccessibilityActions(!!(addToGroupId && onAddToGroup))',
    );
    const action = attrText(host, 'onAccessibilityAction', sf)!.replace(/\s+/g, ' ');
    expect(action).toContain(
      `runGroupRowAccessibilityAction(e.nativeEvent.actionName, { activate: ${press},`,
    );
    expect(action).toContain(
      `addToGroup: () => { if (addToGroupId && onAddToGroup) onAddToGroup(${t.rec}.id, addToGroupId); }`,
    );
    // The row carries no name of its own: VoiceOver reads its words.
    expect(attrText(host, 'accessibilityLabel', sf)).toBeUndefined();
  });

  it('only the row takes a pick: the select handler goes to it alone', () => {
    const takers = nodesIn(sf)
      .filter((n) => attrText(n.el, 'onToggleSelect', sf) !== undefined)
      .map((n) => tagOf(n.el, sf));
    expect(takers).toEqual([t.row]);
  });
});

describe('group headers expand and never take a pick (expand them to tick their records)', () => {
  it.each(HEADERS)('%s %s', (file, name) => {
    const sf = treeOf(file);
    const fn = componentNamed(sf, name);
    const text = codeOnly(fn.getText(sf));
    for (const never of [
      'CheckboxMark',
      'useIsPicked',
      'countSelection',
      'onToggleSelect',
      "'checkbox'",
    ]) {
      expect(text, never).not.toContain(never);
    }
    const press = nodesIn(fn).find((n) => tagOf(n.el, sf) === 'Pressable')!;
    expect(attrText(press.el, 'onPress', sf)).toBe('onToggle');
    expect(attrText(press.el, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(press.el, 'accessibilityLabel', sf)).toMatch(
      /^`\$\{expanded \? 'Collapse' : 'Expand'\} /,
    );
  });
});

describe.each(TABS)(
  '$name tab: one selection store, each pick keeping its facts from tick time',
  (t) => {
    const sf = treeOf(t.file);
    const code = codeOnly(sourceOf(t.file));

    it('ticks into the shared store a pick with what the record would leave on Ungroup, as the list knew it then', () => {
      const fn = run(callbackArrow(sf, 'onToggleSelect'), {}) as unknown;
      expect(typeof fn).toBe('function');
      // The callback closes over the store and the facts: run it in a context
      // that supplies them.
      const picks = new Map<string, Record<string, unknown>>();
      const store = {
        toggle(p: Record<string, unknown>) {
          if (picks.has(p.id as string)) picks.delete(p.id as string);
          else picks.set(p.id as string, p);
        },
      };
      type Facts = {
        displayGroupId: string | null;
        familyId: string | null;
        sharesSku: boolean;
        shownUnder: string | null;
      };
      const factsAtTick: Facts = {
        displayGroupId: 'g1',
        familyId: null,
        sharesSku: true,
        shownUnder: 'group',
      };
      let ungroupFacts = new Map<string, Facts>([['r1', factsAtTick]]);
      const toggle = (rec: Record<string, unknown>) =>
        (
          run(callbackArrow(sf, 'onToggleSelect'), { countSelection: store, ungroupFacts }) as (
            r: unknown,
          ) => void
        )(rec);
      toggle({ id: 'r1', sku: 'SKU-1', name: 'Record one', extra: 'not kept' });
      expect(picks.get('r1')).toEqual({
        id: 'r1',
        sku: 'SKU-1',
        name: 'Record one',
        itemType: t.type,
        grouping: factsAtTick,
      });
      // The list re-reads and its facts change; the pick keeps the facts it
      // was ticked with (the bar's Ungroup offer reads those).
      ungroupFacts = new Map([
        ['r1', { displayGroupId: null, familyId: null, sharesSku: false, shownUnder: null }],
      ]);
      expect(picks.get('r1')!.grouping).toBe(factsAtTick);
      // A second tap takes it out again.
      toggle({ id: 'r1', sku: 'SKU-1', name: 'Record one' });
      expect(picks.has('r1')).toBe(false);
    });

    it('the facts come from the grouped rows the screen shows, and the store is the shared one', () => {
      expect(code).toContain(
        "import { countSelection, useIsPicked } from '@/lib/use-count-selection';",
      );
      if (t.file === ITEMS) {
        expect(code).toContain(
          'const ungroupFacts = React.useMemo(() => ungroupFactsByItem(groupedItems), [groupedItems]);',
        );
      } else {
        expect(code).toMatch(
          /const ungroupFacts = React\.useMemo\(\s*\(\) => ungroupFactsByItem\(groupedBookRows, \{ enableSizeRuns: false \}\),\s*\[groupedBookRows\],\s*\);/,
        );
      }
    });

    it('picks survive Done, page flips, filter changes and the other tab: the tab never clears or removes them', () => {
      expect(code).not.toMatch(/countSelection\.(clear|remove|add)\(/);
      // The select chip toggles the mode and nothing else.
      expect(code).toContain('onPress={() => setSelectMode((v) => !v)}');
    });
  },
);

describe.each(TABS)('$name tab: Add to group, the select bar, and the re-reads', (t) => {
  const sf = treeOf(t.file);
  const src = sourceOf(t.file);
  const code = codeOnly(src);

  it('Add to group is offered to an editor, outside select mode, and opens the review on that group for that record', () => {
    expect(code).toContain(
      "const canEditItems = showWriteCtaForRole(role, permissions, 'items:update');",
    );
    expect(code).toContain(
      'addToGroupId={canEditItems && !selectMode ? (row.addToGroupId ?? null) : null}',
    );
    expect(code).toContain(
      `router.push(groupSelectedHref({ itemIds: [itemId], view: '${t.view}', groupId }));`,
    );
  });

  it('its pill is a named button in a real 44pt frame (the slop never reached past its chip line)', () => {
    const adds = nodesIn(sf).filter(
      (n) =>
        tagOf(n.el, sf) === 'Pressable' &&
        (attrText(n.el, 'onPress', sf) ?? '').startsWith('() => onAddToGroup('),
    );
    expect(adds).toHaveLength(1);
    const add = adds[0]!.el;
    expect(attrText(add, 'accessibilityRole', sf)).toBe('button');
    expect(attrText(add, 'accessibilityLabel', sf)).toBe(
      `\`\${GROUP_COPY.addToGroup}: \${${t.rec}.name}\``,
    );
    expect(attrText(add, 'hitSlop', sf)).toBeUndefined();
    expect(attrText(add, 'style', sf)).toContain('addToGroupFrame');
    expect(styleBlock(src, 'addToGroupFrame')).toMatch(/minHeight: 44,/);
    expect(code).toContain('{ borderColor: c.hair2 }');
  });

  it('the bar shows in select mode and reports its height; the list ends clear of it', () => {
    expect(code).toMatch(
      /<CountSelectBar\s+visible=\{selectMode\}\s+bottomInset=\{tabBarHeight\}\s+onHeight=\{setSelectBarHeight\}\s*\/>/,
    );
    const padding = /paddingBottom: (tabBarHeight \+ 24[^,\n]*),/.exec(code)?.[1];
    expect(padding).toBe('tabBarHeight + 24 + (selectMode ? selectBarHeight : 0)');
    // Where the bar sits, from its own source: bottomInset + 12 from the foot.
    const bar = codeOnly(sourceOf(BAR));
    const barBottom = /bottom: (bottomInset \+ \d+),/.exec(bar)?.[1];
    expect(barBottom).toBe('bottomInset + 12');
    for (const tabBarHeight of [49, 83]) {
      for (const height of [68, 120, 200]) {
        const listEnd = run(padding!, {
          tabBarHeight,
          selectMode: true,
          selectBarHeight: height,
        }) as number;
        const barTop = (run(barBottom!, { bottomInset: tabBarHeight }) as number) + height;
        // 12pt of air between the pager and the bar (it was covered by
        // height - 12, about 45pt of a 57pt bar).
        expect(listEnd - barTop).toBe(12);
      }
      // Outside select mode the list's end is exactly what it was.
      expect(run(padding!, { tabBarHeight, selectMode: false, selectBarHeight: 120 })).toBe(
        tabBarHeight + 24,
      );
    }
  });

  it('re-reads memberships after a Group save, and rows after an Ungroup save', () => {
    expect(code).toMatch(
      /onDisplayGroupsChanged\(\(\) => \{\s*void readDisplayGroups\(supabase as never, orgId\)/,
    );
    expect(code).toMatch(/return onRecordsUngrouped\(\(\) => void load\(/);
  });

  it('expansions reset on a search, filter, warehouse or page change', () => {
    const reset =
      /React\.useEffect\(\(\) => \{\s*setPage\(1\);([\s\S]*?)\}, \[q, filter, activeWarehouseId\]\);/.exec(
        code,
      )?.[1] ?? '';
    const flip =
      /const onPageChange = React\.useCallback\(\(p: number\) => \{([\s\S]*?)\n {2}\}, \[\]\);/.exec(
        code,
      )?.[1] ?? '';
    const sets =
      t.file === ITEMS
        ? [
            'setExpandedGroups(new Set())',
            'setExpandedSkuGroups(new Set())',
            'setExpandedExplicitGroups(new Set())',
          ]
        : ['setExpandedSkuGroups(new Set())', 'setExpandedExplicitGroups(new Set())'];
    for (const s of sets) {
      expect(reset, s).toContain(s);
      expect(flip, s).toContain(s);
    }
  });
});

describe.each(TABS)('$name tab: the performance shape is kept', (t) => {
  const sf = treeOf(t.file);
  const code = codeOnly(sourceOf(t.file));

  it('memo rows; FlatList tuning; a module-scope key extractor', () => {
    const memo =
      t.file === ITEMS
        ? ['GroupHeaderRow', 'SkuGroupHeaderRow', 'ItemRow']
        : ['BookCard', 'BookGroupHeaderCard'];
    for (const m of memo) expect(code).toContain(`const ${m} = React.memo(function ${m}(`);
    for (const prop of [
      'initialNumToRender={12}',
      'maxToRenderPerBatch={8}',
      'windowSize={9}',
      "removeClippedSubviews={Platform.OS === 'android'}",
    ]) {
      expect(code).toContain(prop);
    }
    expect(code).toMatch(
      /^const (keyExtractor|groupedKeyExtractor) = \(r: \w+\): string => r\.key;$/m,
    );
  });

  it('the text size is read once per screen and handed to the rows, never subscribed per row', () => {
    const rows =
      t.file === ITEMS
        ? ['GroupHeaderRow', 'SkuGroupHeaderRow', 'ItemRow']
        : ['BookCard', 'BookGroupHeaderCard'];
    for (const r of rows) {
      expect(componentNamed(sf, r).getText(sf), r).not.toContain('useWindowDimensions');
    }
  });
});

describe('both tabs keep every word, label and tour target', () => {
  it('Items: the header, toolbar, notices, empty states and the tour sample', () => {
    const words = wordsOf(ITEMS);
    for (const w of [
      'Back',
      'Open menu',
      'Done selecting',
      'Select items',
      'New item',
      'INVENTORY · ITEMS',
      'Items',
      'Search SKU, name, or scan…',
      'Open scanner',
      'Could not load items: ',
      '. Pull to retry — if the app was just updated, the server may still be catching up.',
      'Items did not load.',
      'Pull down to try again.',
      'No items match.',
      'Adjust filters or add items from the web app.',
      'Acer Chromebook 511',
      'SAMPLE-001 · example item',
      'SAMPLE',
      'Example only — it disappears when the tour ends. Your real items will appear here.',
      ' items. Search or filter to narrow — grouped totals below cover only the loaded rows.',
      'Collapse',
      'Expand',
    ]) {
      expect(words, w).toContain(w);
    }
  });

  it('Books: the header, toolbar, notices and empty states', () => {
    const words = wordsOf(BOOKS);
    for (const w of [
      'Back',
      'Open menu',
      'Done selecting',
      'Select books',
      'New book',
      'INVENTORY · PLACEMENTS',
      'Book',
      'catalog.',
      'Search title, ISBN, SKU…',
      'Open scanner',
      'Could not load books: ',
      '. Pull to retry.',
      "Rack locations did not load, so a book's rack label may be out of date. Pull down to try again.",
      'Books did not load.',
      'Pull down to try again.',
      'No books match.',
      'Scan a book on the Scan tab to add one, or import from the web.',
      ' · Grade ',
      ' placements. Search or filter to narrow — grouped totals below cover only the loaded rows.',
    ]) {
      expect(words, w).toContain(w);
    }
  });

  it('the search fields are named with their own placeholder words only while they hold text, and Open scanner is a named button in a 44pt frame on both tabs (D29: Books had none)', () => {
    for (const [file, placeholder] of [
      [ITEMS, 'Search SKU, name, or scan…'],
      [BOOKS, 'Search title, ISBN, SKU…'],
    ] as const) {
      const sf = treeOf(file);
      const src = sourceOf(file);
      const input = nodesIn(sf).find((n) => tagOf(n.el, sf) === 'TextInput')!;
      expect(attrText(input.el, 'placeholder', sf)).toBe(placeholder);
      expect(attrText(input.el, 'value', sf), file).toBe('q');
      // iOS already reads an empty field's placeholder, so a name there too
      // would say the same words twice; once text is typed, the placeholder
      // is gone and the name says what the field is.
      const label = attrText(input.el, 'accessibilityLabel', sf)!;
      expect(label, file).toBe(`q.length > 0 ? '${placeholder}' : undefined`);
      expect(run(label, { q: '' }), file).toBeUndefined();
      expect(run(label, { q: 'abc' }), file).toBe(placeholder);
      const scan = nodesIn(sf).find(
        (n) =>
          tagOf(n.el, sf) === 'Pressable' &&
          attrText(n.el, 'onPress', sf) === "() => router.push('/scan')",
      )!;
      expect(attrText(scan.el, 'accessibilityRole', sf), file).toBe('button');
      expect(attrText(scan.el, 'accessibilityLabel', sf), file).toBe('Open scanner');
      expect(attrText(scan.el, 'hitSlop', sf), file).toBeUndefined();
      expect(attrText(scan.el, 'style', sf), file).toContain('styles.scanFrame');
      expect(styleBlock(src, 'scanFrame'), file).toMatch(/minWidth: 44,\s*minHeight: 44,/);
    }
  });

  it("Items' tour targets stay on the search box, the New item chip and the first row", () => {
    const code = codeOnly(sourceOf(ITEMS));
    expect(code).toContain("const searchTargetRef = useTourTarget('inventory-search');");
    expect(code).toMatch(/<View\s+ref=\{searchTargetRef\}\s+collapsable=\{false\}/);
    expect(code).toContain("const addTargetRef = useTourTarget('inventory-add');");
    expect(code).toMatch(
      /<View ref=\{addTargetRef\} collapsable=\{false\}>\s*<IconChip\s+icon=\{Plus\}/,
    );
    expect(code.match(/useTourTarget\('inventory-first-row'\)/g)).toHaveLength(2);
    expect(code).toContain('<MobileTour tour={MOBILE_INVENTORY_TOUR} />');
  });

  it('no emoji in either tab', () => {
    for (const file of [ITEMS, BOOKS, GROUP, UNGROUP]) {
      expect(sourceOf(file), file).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe('the look on both tabs, measured in both modes', () => {
  it('per-mode palette only: no mode-independent accent, no hard-coded colour, no faint ink, no paper2', () => {
    for (const file of [ITEMS, BOOKS]) {
      const code = codeOnly(sourceOf(file));
      expect(code, file).not.toMatch(/\bACCENT\b/);
      expect(code, file).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(code, file).not.toMatch(/c\.ink4|c\.ink5|c\.paper2/);
      // The decorative pips by row position are gone.
      expect(code, file).not.toMatch(/\bpip=/);
      // Error and notice lines: the warning words of the palette.
      expect(code.match(/color=\{c\.warnText\}/g)?.length, file).toBe(file === ITEMS ? 1 : 2);
    }
  });

  it('a picked row takes the accent wash; a header the recessed fill; chevrons the muted ink', () => {
    const items = codeOnly(sourceOf(ITEMS));
    const books = codeOnly(sourceOf(BOOKS));
    expect(items).toContain('backgroundColor: picked ? c.accentWash : c.card,');
    expect(books).toContain(
      '<Card padding={14} style={picked ? { backgroundColor: c.accentWash } : undefined}>',
    );
    expect(items.match(/backgroundColor: c\.sunk,/g)).toHaveLength(2);
    expect(books).toContain('<Card padding={14} style={{ backgroundColor: c.sunk }}>');
    expect(items.match(/<ChevronRight\s+size=\{18\}\s+color=\{c\.ink3\}/g)).toHaveLength(2);
    expect(books.match(/<ChevronRight\s+size=\{18\}\s+color=\{c\.ink3\}/g)).toHaveLength(1);
  });

  it.each(MODES)(
    '%s: every word on a picked row, a header and a card reads at AA; marks at 3:1',
    (_mode, c) => {
      for (const fill of [c.card, c.accentWash, c.sunk]) {
        expect(contrast(c.ink, fill)).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrast(c.ink3, fill)).toBeGreaterThanOrEqual(AA_TEXT);
      }
      // The chevron on the recessed header fill (ink4 there is under 3:1 in
      // light mode, which is why it is ink3).
      expect(contrast(c.ink3, c.sunk)).toBeGreaterThanOrEqual(AA_UI);
      // The warning lines on the page.
      expect(contrast(c.warnText, c.paper)).toBeGreaterThanOrEqual(AA_TEXT);
      // A ticked box (ink) on a picked row's wash.
      expect(contrast(c.ink, c.accentWash)).toBeGreaterThanOrEqual(AA_UI);
      // A clear box's ink4 edge only ever sits on the card: the wash comes
      // with `picked` and so does the tick (checked={picked}), and on the wash
      // ink4 would be under 3:1.
      expect(contrast(c.ink4, c.card)).toBeGreaterThanOrEqual(AA_UI);
      expect(contrast(c.ink4, c.accentWash)).toBeLessThan(AA_UI);
    },
  );

  it('quantities are mono with tabular numerals, on rows and headers alike', () => {
    for (const file of [ITEMS, BOOKS]) {
      const src = sourceOf(file);
      const code = codeOnly(src);
      const style = file === ITEMS ? 'rowStyles.quantity' : 'styles.quantity';
      expect(
        code.match(
          new RegExp(
            `<Mono size=\\{15\\} color=\\{c\\.ink\\} style=\\{${style.replace('.', '\\.')}\\}>`,
            'g',
          ),
        )?.length,
        file,
      ).toBe(file === ITEMS ? 4 : 2);
      expect(styleBlock(src, 'quantity'), file).toMatch(/fontVariant: \['tabular-nums'\],/);
    }
  });

  it('the search box takes the shared input look: the stronger border, muted icon and placeholder', () => {
    for (const file of [ITEMS, BOOKS]) {
      const code = codeOnly(sourceOf(file));
      expect(code, file).toMatch(
        /\[styles\.searchBox, \{ backgroundColor: c\.card, borderColor: c\.hair2 \}\]/,
      );
      expect(code, file).toContain('<Search size={16} color={c.ink3} strokeWidth={1.4} />');
      expect(code, file).toContain('placeholderTextColor={c.ink3}');
    }
  });
});

// ── The two reviews ───────────────────────────────────────────────────────

const REVIEWS = [
  {
    name: 'Group',
    file: GROUP,
    eyebrow: "view === 'books' ? 'BOOKS · GROUP' : 'ITEMS · GROUP'",
    params: 'readGroupSelectedParams({ ids: idsParam, view: viewParam, groupId: groupParam })',
    offline: 'GROUP_COPY.offline',
    // The guard on a preview's answer: the newest look at the records.
    current: 'mine === seq.current',
  },
  {
    name: 'Ungroup',
    file: UNGROUP,
    eyebrow: "view === 'books' ? 'BOOKS · UNGROUP' : 'ITEMS · UNGROUP'",
    params: 'readUngroupSelectedParams({ ids: idsParam, view: viewParam, under: underParam })',
    offline: 'UNGROUP_COPY.selectedOffline',
    // ...and, since the F8 review, a review still mounted (the load effect's
    // cleanup clears live; grouping-reviews-route-reuse.test.ts runs it).
    current: 'live && mine === seq.current',
  },
] as const;

/** The core words a review reads, by key, sorted. */
function copyKeys(file: string, table: 'GROUP_COPY' | 'UNGROUP_COPY'): string[] {
  const code = codeOnly(sourceOf(file));
  return [
    ...new Set([...code.matchAll(new RegExp(`\\b${table}\\.(\\w+)`, 'g'))].map((m) => m[1]!)),
  ].sort();
}

describe.each(REVIEWS)('$name review', (r) => {
  const sf = treeOf(r.file);
  const code = codeOnly(sourceOf(r.file));

  it('keeps its eyebrows ITEMS / BOOKS, the view coming from the strictly read params', () => {
    expect(code).toContain(`<Eyebrow>{${r.eyebrow}}</Eyebrow>`);
    expect(run(r.eyebrow, { view: 'items' })).toBe(
      r.name === 'Group' ? 'ITEMS · GROUP' : 'ITEMS · UNGROUP',
    );
    expect(run(r.eyebrow, { view: 'books' })).toBe(
      r.name === 'Group' ? 'BOOKS · GROUP' : 'BOOKS · UNGROUP',
    );
    expect(code).toContain(r.params);
    expect(code).toContain("const view = params?.view ?? 'items';");
    // Params that are not a selection it can review say so, and nothing else.
    expect(code).toMatch(
      /\{!params \? \(\s*<Body muted size=\{13\.5\}>\s*\{GROUPING_ERROR_WORDS\.invalid\}/,
    );
  });

  it('checks for a connection before the preview, says so offline, and never queues', () => {
    const current = r.current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(code).toMatch(
      new RegExp(
        `if \\(!\\(await isOnline\\(\\)\\)\\) \\{\\s*if \\(${current}\\) setLoadState\\(\\{ kind: 'offline' \\}\\);\\s*return;\\s*\\}`,
      ),
    );
    expect(code).toContain(`loadState.kind === 'offline' ? ${r.offline} : loadState.message`);
    expect(code).not.toMatch(/enqueue\(/);
  });

  it('keeps its plain words: loading, Try again, Review again, Done, Back', () => {
    const words = wordsOf(r.file);
    for (const w of ['Loading the records…', 'Try again', 'Review again', 'Done', 'Back']) {
      expect(words, w).toContain(w);
    }
  });

  it('reserves what its pinned footer really takes, and marks the footer with a hairline', () => {
    expect(code).toContain('paddingBottom: footerReservation(footerHeight, 170),');
    expect(code).toContain('onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}');
    expect(code).toContain(
      'style={[styles.footer, { backgroundColor: c.paper, borderTopColor: c.hair }]}',
    );
    expect(styleBlock(sourceOf(r.file), 'footer')).toMatch(/borderTopWidth: 1,/);
  });

  it('every record line is the muted ink; the faint ink4 only draws a clear radio ring', () => {
    expect(code).toMatch(
      /<Mono size=\{11\.5\} color=\{c\.ink3\} tracking=\{0\.02\}>\s*\{reviewRecordDetail\(r, view\)\}/,
    );
    const faint = faintInkOwners(sf);
    expect(faint.length).toBeGreaterThan(0);
    expect([...new Set(faint)]).toEqual(['Circle']);
    expect(code).not.toMatch(/\bACCENT\b|#[0-9a-f]{3,8}\b|c\.ink5|c\.paper2/i);
    for (const [, c] of MODES) {
      expect(contrast(c.ink3, c.card)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(contrast(c.ink3, c.paper)).toBeGreaterThanOrEqual(AA_TEXT);
      // The clear radio ring sits on the record card.
      expect(contrast(c.ink4, c.card)).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  it('every radio is announced with its checked state and is off while saving', () => {
    const radios = nodesIn(sf).filter((n) => attrText(n.el, 'accessibilityRole', sf) === 'radio');
    expect(radios.length).toBe(r.name === 'Group' ? 4 : 1);
    for (const n of radios) {
      expect(tagOf(n.el, sf)).toBe('Pressable');
      expect(attrText(n.el, 'accessibilityState', sf)).toMatch(
        /^\{ checked: .+, disabled: busy \}$/,
      );
      expect(attrText(n.el, 'disabled', sf)).toBe('busy');
    }
  });

  it('every small button (Try again, Add them to the selection) is a 44pt target, not the 36pt small size', () => {
    const small = nodesIn(sf).filter(
      (n) => tagOf(n.el, sf) === 'Button' && attrText(n.el, 'size', sf) === 'sm',
    );
    expect(small.length).toBe(r.name === 'Group' ? 2 : 1);
    for (const n of small) expect(attrText(n.el, 'style', sf)).toBe('styles.smallButton');
    expect(styleBlock(sourceOf(r.file), 'smallButton')).toMatch(/minHeight: 44,/);
  });
});

/** The tag of the element whose attribute reads each `c.ink4` in a file
 *  (`<Circle color={c.ink4}>` gives 'Circle'); '(not in JSX)' elsewhere. */
function faintInkOwners(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'c' &&
      n.name.text === 'ink4'
    ) {
      let p: ts.Node | undefined = n.parent;
      while (p && !ts.isJsxAttribute(p)) p = p.parent;
      const owner = p?.parent?.parent;
      out.push(
        owner && (ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner))
          ? owner.tagName.getText(sf)
          : '(not in JSX)',
      );
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('Group review: the words, the family acknowledgement and the save', () => {
  const sf = treeOf(GROUP);
  const code = codeOnly(sourceOf(GROUP));

  it("reads every one of core's GROUP_COPY words it read before", () => {
    // The two radios of a record in another group are named with core's
    // moveOneFor and leaveOutOneFor words (R2-5), now put together once per
    // review by groupChoiceRadioNamesById, which the screen calls for them
    // (redesign Stage 6, GROUP-REVIEW-RADIO-NAMES): the words it reads are
    // the screen's own, and it reads no others.
    expect(code).toContain('groupChoiceRadioNamesById(');
    const lib = 'src/lib/display-groups.ts';
    const namer = ts
      .createSourceFile(lib, sourceOf(lib), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      .statements.find(
        (s): s is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(s) && s.name?.text === 'groupChoiceRadioNamesById',
      );
    expect(namer, `function groupChoiceRadioNamesById in ${lib}`).toBeDefined();
    const namerKeys = [
      ...new Set(
        [...codeOnly(namer!.getText()).matchAll(/\bGROUP_COPY\.(\w+)/g)].map((m) => m[1]!),
      ),
    ].sort();
    expect(namerKeys).toEqual(['leaveOutOneFor', 'moveOneFor']);
    expect([...new Set([...copyKeys(GROUP, 'GROUP_COPY'), ...namerKeys])].sort()).toEqual(
      [
        'acknowledgeFamily',
        'addSiblings',
        'alreadyInTarget',
        'cancel',
        'confirmExisting',
        'confirmNew',
        'done',
        'editions',
        'editionsUnknown',
        'family',
        'headerRecords',
        'intro',
        'leaveOutOne',
        'leaveOutOneFor',
        'leftOutReason',
        'moreTargetMembers',
        'moveOne',
        'moveOneFor',
        'nameLabel',
        'noCandidates',
        'noop',
        'noopConfirm',
        'offline',
        'otherGroup',
        'previewLabel',
        'sameSku',
        'skuNote',
        'targetExisting',
        'targetMembers',
        'targetNew',
        'title',
        'unavailable',
      ].sort(),
    );
    expect(wordsOf(GROUP)).toContain('Where they go');
  });

  it('the family acknowledgement is the shared Checkbox, with the same toggle, state and words, and no touchable around it', () => {
    const boxes = nodesIn(sf).filter((n) => tagOf(n.el, sf) === 'Checkbox');
    expect(boxes).toHaveLength(1);
    const box = boxes[0]!;
    expect(attrText(box.el, 'checked', sf)).toBe('ackFamily');
    expect(attrText(box.el, 'onChange', sf)).toBe('() => setAckFamily((v) => !v)');
    expect(attrText(box.el, 'disabled', sf)).toBe('busy');
    expect(attrText(box.el, 'label', sf)).toBe('GROUP_COPY.acknowledgeFamily');
    expect(box.ancestors.filter((a) => TOUCHABLE_TAG.test(tagOf(a, sf)))).toEqual([]);
    // Shown exactly when the plan names product-family records (inside the
    // review's ready branch, whose own conditions follow).
    expect(renderCondition(sf, box.el)).toMatch(
      /^\(\(plan\?\.conflicts\.family\.length \?\? 0\) > 0\) && !\(loadState\.kind === 'offline'/,
    );
    // The old hand-drawn row is gone: no Pressable plays checkbox here now.
    expect(
      nodesIn(sf).filter((n) => attrText(n.el, 'accessibilityRole', sf) === 'checkbox'),
    ).toEqual([]);
    expect(code).not.toMatch(/\bCheckCircle2\b/);
    expect(code).toContain("import { Checkbox } from '@/components/ui/checkbox';");
  });

  it('the group name is the shared Field, named, capped at the input ceiling, off while saving', () => {
    const field = nodesIn(sf).find((n) => tagOf(n.el, sf) === 'Field')!;
    expect(attrText(field.el, 'label', sf)).toBe('GROUP_COPY.nameLabel');
    expect(attrText(field.el, 'accessibilityLabel', sf)).toBe('GROUP_COPY.nameLabel');
    expect(attrText(field.el, 'value', sf)).toBe('nameValue');
    expect(attrText(field.el, 'maxLength', sf)).toBe('GROUP_NAME_MAX_LENGTH');
    expect(attrText(field.el, 'editable', sf)).toBe('!busy');
    expect(attrText(field.el, 'maxFontSizeMultiplier', sf)).toBe('capTo(16, TYPE_CEILING.input)');
    expect(renderCondition(sf, field.el)).toMatch(
      /^\(mode === 'new'\) && !\(loadState\.kind === 'offline'/,
    );
  });

  it('a save re-reads the lists and the grouped records leave the shared selection on close', () => {
    expect(code).toContain("if (o.outcome === 'applied') notifyDisplayGroupsChanged();");
    expect(code).toMatch(
      /if \(outcome\?\.outcome === 'applied'\) \{\s*for \(const id of itemIds\) countSelection\.remove\(id\);\s*\}/,
    );
    expect(code).toContain('pending.current = keyedGroupingBody(');
  });

  it('the preview header is drawn as the list will draw it: the recessed fill', () => {
    expect(code).toContain(
      '[styles.previewHeader, { backgroundColor: c.sunk, borderColor: c.hair }]',
    );
    for (const label of ['Where they go', '{GROUP_COPY.previewLabel}']) {
      expect(code).toMatch(
        new RegExp(
          `<Mono size=\\{11\\} tracking=\\{0\\.14\\} upper color=\\{c\\.ink3\\} accessibilityRole="header">\\s*${label.replace(/[{}.]/g, '\\$&')}`,
        ),
      );
    }
  });
});

describe('Ungroup review: the words and the save', () => {
  const code = codeOnly(sourceOf(UNGROUP));

  it("reads every one of core's UNGROUP_COPY and GROUP_COPY words it read before", () => {
    expect(copyKeys(UNGROUP, 'UNGROUP_COPY')).toEqual(
      [
        'anchorLegend',
        'barcodeNote',
        'confirm',
        'familyNameNote',
        'familyNote',
        'familySkuNote',
        'familySkuWith',
        'keepsSku',
        'othersKeep',
        'selectedIntro',
        'selectedNothing',
        'selectedOffline',
        'selectedTitle',
      ].sort(),
    );
    expect(copyKeys(UNGROUP, 'GROUP_COPY')).toEqual(
      ['cancel', 'removeLast', 'removeStays', 'reviewReady', 'unavailable'].sort(),
    );
  });

  it('a save that may have changed something re-reads the lists, and the changed records leave the selection on close', () => {
    expect(code).toMatch(
      /if \(ungroupListMayBeStale\(o\)\) \{\s*notifyRecordsUngrouped\(\);\s*notifyDisplayGroupsChanged\(\);\s*\}/,
    );
    expect(code).toMatch(
      /for \(const p of outcome\.parts\) for \(const id of p\.changedItemIds\) countSelection\.remove\(id\);/,
    );
    // Keeps SKU X: a radio named for its record and for what tells it apart
    // from the SKU's other records, with the outcome beside it as its value
    // (redesign Stage 6, F9; ungroup-keeps-sku-radio.test.ts runs both). The
    // names are worked out once per plan (F9 review), not in each radio.
    const sf = treeOf(UNGROUP);
    const radio = nodesIn(sf).find((n) => attrText(n.el, 'accessibilityRole', sf) === 'radio')!;
    expect(attrText(radio.el, 'accessibilityLabel', sf)).toBe('radioNames.get(rec.id)');
    expect(code).toMatch(
      /const radioNames = React\.useMemo\([\s\S]*?keepsSkuRadioLabels\([\s\S]*?\[plan, view\],?\s*\);/,
    );
    expect(attrText(radio.el, 'accessibilityValue', sf)).toBe('{ text: ungroupOutcomeWords(o) }');
  });
});
