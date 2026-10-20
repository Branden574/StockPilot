import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  attrText,
  parseTsx,
  readSource,
  tagOf,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
// vi.mock below is hoisted above every import by vitest.
import {
  groupSelectedReviewKey,
  readGroupSelectedParams,
  type GroupSelectedParams,
} from './display-groups';
import {
  readUngroupSelectedParams,
  ungroupSelectedReviewKey,
  type UngroupSelectedParams,
} from './ungroup-selected';

vi.mock('./api', () => ({
  api: () => Promise.reject(new Error('no request leaves this test')),
  ApiError: class extends Error {},
}));

/**
 * THE GROUP AND UNGROUP REVIEWS START FRESH FOR ANOTHER SELECTION (redesign
 * Stage 6, F8).
 *
 * expo-router REUSES a screen when a link to it arrives while it is on top,
 * swapping only the params (app/maintenance/new.tsx met it first). The Group
 * review held the records it first opened with in its own state, so opening
 * group-selected?ids=...&view=books after the items link said BOOKS · GROUP
 * over the items link's Pencils #2 HB and Glue Sticks. The Ungroup review
 * re-read its records, but a refused Save's error stayed over the new ones.
 *
 * Each screen's route now reads its params and mounts the review under a key
 * of the selection: another selection is a new review with nothing carried
 * over, and the same selection keeps the review and the person's edits.
 *
 * The mobile suite has no React Native renderer, so the screens are read with
 * the TypeScript parser, and the key expression is compiled from the
 * screen's own source and run, as items-books-selection-structure.test.ts
 * reads its screens.
 */

const MOBILE_ROOT = path.resolve(__dirname, '../..');

// The records of the F8 walk: the items link, then the books link.
const PENCILS = 'aaaaaaaa-0000-4000-8000-000000000001'; // Pencils #2 HB
const GLUE = 'aaaaaaaa-0000-4000-8000-000000000002'; // Glue Sticks
const ATLAS = 'bbbbbbbb-0000-4000-8000-000000000001';
const READER = 'bbbbbbbb-0000-4000-8000-000000000002';
const GROUP_A = 'cccccccc-0000-4000-8000-000000000001';
const GROUP_B = 'cccccccc-0000-4000-8000-000000000002';

const groupKey = (p: Parameters<typeof readGroupSelectedParams>[0]) =>
  groupSelectedReviewKey(readGroupSelectedParams(p));
const ungroupKey = (p: Parameters<typeof readUngroupSelectedParams>[0]) =>
  ungroupSelectedReviewKey(readUngroupSelectedParams(p));

describe('groupSelectedReviewKey: which Group review the route asks for', () => {
  const items = { ids: `${PENCILS},${GLUE}`, view: 'items' };
  const books = { ids: `${ATLAS},${READER}`, view: 'books' };

  // Mutation caught: a key of the view alone, or of nothing.
  it('the items link and then the books link are two reviews', () => {
    expect(groupKey(items)).not.toBe(groupKey(books));
  });

  // Mutation caught: any part of the selection left out of the key.
  it('other records, another list or another target group is another review', () => {
    const base = groupKey(items);
    expect(groupKey({ ...items, view: 'books' })).not.toBe(base);
    expect(groupKey({ ...items, ids: `${PENCILS},${READER}` })).not.toBe(base);
    expect(groupKey({ ...items, ids: `${PENCILS},${GLUE},${ATLAS}` })).not.toBe(base);
    expect(groupKey({ ...items, ids: PENCILS })).not.toBe(base);
    expect(groupKey({ ...items, groupId: GROUP_A })).not.toBe(base);
    expect(groupKey({ ...items, groupId: GROUP_A })).not.toBe(
      groupKey({ ...items, groupId: GROUP_B }),
    );
  });

  // Never lose what the person chose or typed for the SAME selection.
  // Mutation caught: the key read from the raw params, or the ids unsorted.
  it('the same selection is the same review, in any order, any case, with repeats or spaces', () => {
    const base = groupKey({ ...items, groupId: GROUP_A });
    expect(groupKey({ ...items, groupId: GROUP_A })).toBe(base);
    expect(groupKey({ ids: `${GLUE},${PENCILS}`, view: 'items', groupId: GROUP_A })).toBe(base);
    expect(
      groupKey({
        ids: `${GLUE.toUpperCase()}, ${PENCILS},${GLUE}`,
        view: 'items',
        groupId: GROUP_A.toUpperCase(),
      }),
    ).toBe(base);
    expect(groupKey({ ...items, groupId: '' })).toBe(groupKey(items));
  });

  it('a link that is not a selection is one review of its own, never a selection', () => {
    expect(groupSelectedReviewKey(null)).toBe('invalid');
    expect(groupKey({ ids: 'not-an-id', view: 'items' })).toBe('invalid');
    expect(groupKey(items)).not.toBe('invalid');
  });
});

describe('ungroupSelectedReviewKey: which Ungroup review the route asks for', () => {
  const items = { ids: `${PENCILS},${GLUE}`, view: 'items', under: 'gs' };
  const books = { ids: `${ATLAS},${READER}`, view: 'books', under: 'ss' };

  it('the items link and then the books link are two reviews', () => {
    expect(ungroupKey(items)).not.toBe(ungroupKey(books));
  });

  // Mutation caught: the grouping each record is shown under left out (it
  // decides what the record leaves, so it is another review).
  it('other records, another list or another grouping a record is shown under is another review', () => {
    const base = ungroupKey(items);
    expect(ungroupKey({ ...items, view: 'books' })).not.toBe(base);
    expect(ungroupKey({ ...items, ids: `${PENCILS},${READER}` })).not.toBe(base);
    expect(ungroupKey({ ...items, ids: PENCILS, under: 'g' })).not.toBe(base);
    expect(ungroupKey({ ...items, under: 'ss' })).not.toBe(base);
    expect(ungroupKey({ ...items, under: 'g-' })).not.toBe(base);
  });

  it('the same selection is the same review, in any order and any case', () => {
    const base = ungroupKey(items);
    expect(ungroupKey({ ...items })).toBe(base);
    // Each record keeps its own letter when the order changes.
    expect(ungroupKey({ ids: `${GLUE},${PENCILS}`, view: 'items', under: 'sg' })).toBe(base);
    expect(
      ungroupKey({ ids: `${PENCILS.toUpperCase()},${GLUE}`, view: 'items', under: 'gs' }),
    ).toBe(base);
  });

  it('a link that is not a selection is one review of its own, never a selection', () => {
    expect(ungroupSelectedReviewKey(null)).toBe('invalid');
    expect(ungroupKey({ ...items, under: 'g' })).toBe('invalid');
    expect(ungroupKey(items)).not.toBe('invalid');
  });
});

// ── The screens ────────────────────────────────────────────────────────────

/** Runs a source expression in a context of its free names. */
function run(expression: string, context: Record<string, unknown>): unknown {
  const js = ts.transpileModule(`(${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext(context);
}

/** The file's `export default function`. */
function defaultExport(sf: ts.SourceFile): ts.FunctionDeclaration {
  const found = sf.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) &&
      !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      !!s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword),
  );
  if (!found) throw new Error(`${sf.fileName} has no export default function`);
  return found;
}

/** A top-level `function name`. */
function functionNamed(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
}

/** Every hook call inside a node (`useX(` or `React.useX(`), as spelled, its
 *  text on one line. */
function hookCalls(node: ts.Node, sf: ts.SourceFile): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (/^(?:React\.)?use[A-Z]\w*$/.test(callee))
        out.push({ name: callee, text: n.getText(sf).replace(/\s+/g, ' ') });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The JSX a function returns (its last top-level return). */
function returnedJsx(fn: ts.FunctionDeclaration): JsxNode {
  const returns = fn.body?.statements.filter(ts.isReturnStatement) ?? [];
  let e: ts.Expression | undefined = returns[returns.length - 1]?.expression;
  while (e && ts.isParenthesizedExpression(e)) e = e.expression;
  if (!e || !(ts.isJsxSelfClosingElement(e) || ts.isJsxElement(e)))
    throw new Error(`${fn.name?.text} does not return JSX`);
  return e;
}

const SCREENS = [
  {
    name: 'Group',
    file: 'app/group-selected.tsx',
    route: 'GroupSelectedScreen',
    review: 'GroupSelectedReview',
    params: 'readGroupSelectedParams({ ids: idsParam, view: viewParam, groupId: groupParam })',
    keyName: 'groupSelectedReviewKey',
    key: (p: unknown) => groupSelectedReviewKey(p as GroupSelectedParams | null),
    read: (p: Record<string, string>) => readGroupSelectedParams(p),
    // The state that held the first records, and the rest of the review's
    // (each call's start, on one line).
    state: [
      'React.useState<string[]>(params?.itemIds ?? [])',
      "React.useState<'new' | 'existing'>(params?.groupId ? 'existing' : 'new')",
      "React.useState('')",
      'React.useState<string | null>(params?.groupId ?? null)',
      'React.useState<ReadonlyMap<string, GroupRecordChoice>>(',
      'React.useState(false)',
      "React.useState<'ready' | 'saving' | 'done'>('ready')",
      'React.useState<GroupingOutcome | null>(null)',
      'React.useState<{ message: string; stale: boolean } | null>(',
      'React.useRef<PendingGroupingBody | null>(null)',
    ],
    items: { ids: `${PENCILS},${GLUE}`, view: 'items' },
    books: { ids: `${ATLAS},${READER}`, view: 'books' },
    sameItems: { ids: `${GLUE},${PENCILS}`, view: 'items' },
  },
  {
    name: 'Ungroup',
    file: 'app/ungroup-selected.tsx',
    route: 'UngroupSelectedScreen',
    review: 'UngroupSelectedReview',
    params: 'readUngroupSelectedParams({ ids: idsParam, view: viewParam, under: underParam })',
    keyName: 'ungroupSelectedReviewKey',
    key: (p: unknown) => ungroupSelectedReviewKey(p as UngroupSelectedParams | null),
    read: (p: Record<string, string>) => readUngroupSelectedParams(p),
    state: [
      'React.useState<Record<string, string>>({})',
      "React.useState<'ready' | 'saving' | 'done'>('ready')",
      'React.useState<UngroupSelectedOutcome | null>(null)',
      'React.useState<{ message: string; stale: boolean } | null>(',
      'React.useState<UngroupSelectedBody | null>(null)',
      'React.useRef<{ json: string; body: UngroupSelectedBody } | null>(null)',
    ],
    items: { ids: `${PENCILS},${GLUE}`, view: 'items', under: 'gs' },
    books: { ids: `${ATLAS},${READER}`, view: 'books', under: 'ss' },
    sameItems: { ids: `${GLUE},${PENCILS}`, view: 'items', under: 'sg' },
  },
] as const;

describe.each(SCREENS)('$name review: the route mounts the review under its key', (s) => {
  const sf = parseTsx(readSource(path.join(MOBILE_ROOT, s.file)), s.file);
  const route = defaultExport(sf);
  const review = functionNamed(sf, s.review);

  it('the route reads its params and renders only the review, keyed by the selection', () => {
    expect(route.name?.text).toBe(s.route);
    // No state, ref or effect above the key: it reads the params, nothing else.
    expect(hookCalls(route, sf).map((h) => h.name)).toEqual([
      'useLocalSearchParams',
      'React.useMemo',
    ]);
    expect(route.getText(sf)).toContain(s.params);
    const el = returnedJsx(route);
    expect(tagOf(el, sf)).toBe(s.review);
    expect(attrText(el, 'key', sf)).toBe(`${s.keyName}(params)`);
    expect(attrText(el, 'params', sf)).toBe('params');
  });

  // Mutation caught: the review's state moved back above the key (into the
  // route), where a reused screen keeps it for the next selection.
  it('every piece of the review state lives under the key', () => {
    expect(review, `function ${s.review} in ${s.file}`).toBeDefined();
    const inReview = hookCalls(review!, sf);
    for (const state of s.state) {
      expect(
        inReview.some((h) => h.text.startsWith(state)),
        state,
      ).toBe(true);
    }
    expect(inReview.filter((h) => h.name === 'React.useEffect').length).toBeGreaterThan(0);
    // Every hook of the file is the route's two or the review's own.
    const all = hookCalls(sf, sf).length;
    expect(all).toBe(inReview.length + 2);
    // The review is the only element the route renders, and nothing else
    // renders the review.
    const reviews: JsxNode[] = [];
    walkJsx(sf, (el) => {
      if (tagOf(el, sf) === s.review) reviews.push(el);
    });
    expect(reviews).toHaveLength(1);
  });

  // The F8 walk, through the screen's own key: the items link, then the
  // books link, mount two reviews; the same selection again keeps the one.
  it("runs the screen's key: another link mounts a fresh review, the same selection keeps it", () => {
    const keyOf = (link: Record<string, string>) =>
      run(attrText(returnedJsx(route), 'key', sf)!, {
        [s.keyName]: s.key,
        params: s.read(link),
      });
    const first = keyOf(s.items);
    expect(typeof first).toBe('string');
    expect(keyOf(s.books)).not.toBe(first);
    expect(keyOf({ ...s.items, view: 'books' })).not.toBe(first);
    expect(keyOf({ ...s.items })).toBe(first);
    expect(keyOf(s.sameItems)).toBe(first);
  });
});
