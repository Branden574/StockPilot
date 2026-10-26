import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  GROUP_COPY,
  GROUPING_MAX_ITEMS,
  groupingDecisionsFor,
  planGrouping,
  type GroupRecordChoice,
} from '@stockpilot/core';

import {
  attrText,
  parseTsx,
  readSource,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
// vi.mock below is hoisted above every import by vitest.
import {
  groupChoiceRadioNamesById,
  type PhoneGroupingRecord,
  type PhoneGroupingReview,
} from './display-groups';

vi.mock('./api', () => ({
  api: () => Promise.reject(new Error('no request leaves this test')),
  ApiError: class extends Error {},
}));

/** How many record lines were built (core groupingRecordLine, counted below). */
const lineBuilds = vi.hoisted(() => ({ count: 0 }));
vi.mock('@stockpilot/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stockpilot/core')>();
  return {
    ...actual,
    groupingRecordLine: (...args: Parameters<typeof actual.groupingRecordLine>) => {
      lineBuilds.count += 1;
      return actual.groupingRecordLine(...args);
    },
  };
});

/**
 * THE GROUP REVIEW'S "MOVE IT INTO THIS GROUP" AND "LEAVE IT OUT" RADIOS, AS
 * VOICEOVER HEARS THEM (redesign Stage 6, GROUP-REVIEW-RADIO-NAMES).
 *
 * A record already in another group gets two radios, named for its record
 * (recheck R2-5): "Move it into this group: Wireless Mouse" and "Leave it out:
 * Wireless Mouse". Two records with one name that were both in another group
 * were two pairs of radios with one name, and VoiceOver could not tell them
 * apart.
 *
 * The web fixed its Group review first (groupChoiceRadioNames in apps/web
 * grouping-radio-names.ts). The phone names its radios with the same rule and
 * the same words: a record is compared only with the other records here that
 * carry the two radios and whose names a screen reader says the same way
 * (letter case, runs of spaces and how an accented letter is stored make no
 * difference), in the order listed. A name no other such record has keeps
 * core's words. Otherwise the name goes on with the parts of the record's
 * line that those records do not all share, in the line's own words, and
 * ends with "record N of M" when two still read the same. These cases and
 * their expected words are the web's own.
 *
 * The phone works out every record's two names in one pass that builds each
 * record's line once, and the screen works them out once per review and
 * target, not on every tap.
 */

const M1 = 'dddddddd-0000-4000-8000-000000000001';
const M2 = 'dddddddd-0000-4000-8000-000000000002';
const M3 = 'dddddddd-0000-4000-8000-000000000003';
const OTHER = 'dddddddd-0000-4000-8000-000000000009';
/** The group the records are already in, and another one. */
const H = 'hhhhhhhh-0000-4000-8000-000000000001';
const G2 = 'hhhhhhhh-0000-4000-8000-000000000002';

const rec = (over: Partial<PhoneGroupingRecord>): PhoneGroupingRecord => ({
  id: M1,
  name: 'Wireless Mouse',
  sku: 'WM-1',
  barcode: null,
  isbnFields: null,
  itemType: 'product',
  isBundle: false,
  isRental: false,
  productGroupId: null,
  productGroupName: null,
  variantSize: null,
  charterId: null,
  warehouseId: null,
  binLocation: null,
  customFields: null,
  quantityOnHand: 4,
  createdAt: null,
  displayGroup: null,
  writable: true,
  charterName: null,
  warehouseName: 'Main',
  placementLabel: null,
  imageUrl: null,
  ...over,
});

const inH = { displayGroup: { id: H, name: 'Old shirts', version: 3 } };
const inG2 = { displayGroup: { id: G2, name: 'Desk', version: 1 } };

/** Every record's two radio names, each of them a record with the radios. */
const names = (rows: PhoneGroupingRecord[], view: 'items' | 'books' = 'items') => {
  const byId = groupChoiceRadioNamesById(
    rows.map((r) => r.id),
    rows,
    view,
  );
  return rows.map((r) => {
    const both = byId.get(r.id);
    if (both === undefined) throw new Error(`the radios of ${r.id} have no names`);
    return both;
  });
};

describe("groupChoiceRadioNamesById: the Group review radios are named apart, by the web's rule", () => {
  it("a record whose name is its own keeps core's words alone (R2-5)", () => {
    const rows = [
      rec({ id: M1, ...inH, name: 'Polo S', sku: 'P-S', placementLabel: 'A-1' }),
      rec({ id: M2, ...inH, name: 'Polo M', sku: 'P-M', placementLabel: 'B-2' }),
    ];
    expect(names(rows)).toEqual([
      { move: GROUP_COPY.moveOneFor('Polo S'), leave: GROUP_COPY.leaveOutOneFor('Polo S') },
      { move: GROUP_COPY.moveOneFor('Polo M'), leave: GROUP_COPY.leaveOutOneFor('Polo M') },
    ]);
  });

  // Mutation caught: the names back to core's words alone, so the three pairs
  // of Wireless Mouse radios read the same.
  it('three Wireless Mouse records on three racks: each pair is named with its rack; another name is not compared', () => {
    const rows = [
      rec({ id: M1, ...inH, placementLabel: 'A-1' }),
      rec({ id: OTHER, ...inH, name: 'Keyboard', sku: 'KB-1', warehouseName: 'Annex' }),
      rec({ id: M2, ...inH, placementLabel: 'B-2' }),
      rec({ id: M3, ...inH, placementLabel: 'C-3' }),
    ];
    expect(names(rows)).toEqual([
      {
        move: 'Move it into this group: Wireless Mouse, A-1',
        leave: 'Leave it out: Wireless Mouse, A-1',
      },
      { move: 'Move it into this group: Keyboard', leave: 'Leave it out: Keyboard' },
      {
        move: 'Move it into this group: Wireless Mouse, B-2',
        leave: 'Leave it out: Wireless Mouse, B-2',
      },
      {
        move: 'Move it into this group: Wireless Mouse, C-3',
        leave: 'Leave it out: Wireless Mouse, C-3',
      },
    ]);
  });

  // A screen reader says names that differ only in letter case, spacing or
  // how an accent is stored the same way, so they are one name here. Each
  // radio still says its record's own name. Mutation caught: the names
  // compared letter for letter, so each pair keeps core's words alone and
  // the three pairs sound alike.
  it('names a screen reader says the same way are one name: case, spacing and accents as stored', () => {
    const rows = [
      rec({ id: M1, ...inH, name: 'Wireless Mouse', placementLabel: 'A-1' }),
      rec({ id: M2, ...inH, name: 'Wireless mouse', placementLabel: 'B-2' }),
      rec({ id: OTHER, ...inH, name: 'Keyboard', sku: 'KB-1', placementLabel: 'A-1' }),
      rec({ id: M3, ...inH, name: 'Wireless  Mouse', placementLabel: 'C-3' }),
    ];
    expect(names(rows)).toEqual([
      {
        move: 'Move it into this group: Wireless Mouse, A-1',
        leave: 'Leave it out: Wireless Mouse, A-1',
      },
      {
        move: 'Move it into this group: Wireless mouse, B-2',
        leave: 'Leave it out: Wireless mouse, B-2',
      },
      // A name no other record here is said as keeps core's words (R2-5).
      { move: GROUP_COPY.moveOneFor('Keyboard'), leave: GROUP_COPY.leaveOutOneFor('Keyboard') },
      {
        move: 'Move it into this group: Wireless  Mouse, C-3',
        leave: 'Leave it out: Wireless  Mouse, C-3',
      },
    ]);
    // One accented letter stored as one character, and as a letter and its
    // accent: they look and sound the same.
    const mugs = [
      rec({ id: M1, ...inH, name: 'Caf\u00e9 Mug', placementLabel: 'A-1' }),
      rec({ id: M2, ...inH, name: 'Cafe\u0301 Mug', placementLabel: 'B-2' }),
    ];
    expect(names(mugs).map((n) => n.move)).toEqual([
      'Move it into this group: Caf\u00e9 Mug, A-1',
      'Move it into this group: Cafe\u0301 Mug, B-2',
    ]);
  });

  // Mutation caught: a name with no position, so two records whose every
  // word reads the same are two pairs of radios with one name again.
  it('two identical records end with where they are listed among the records with these radios', () => {
    expect(names([rec({ id: M2, ...inH }), rec({ id: M1, ...inH })])).toEqual([
      {
        move: 'Move it into this group: Wireless Mouse, record 1 of 2',
        leave: 'Leave it out: Wireless Mouse, record 1 of 2',
      },
      {
        move: 'Move it into this group: Wireless Mouse, record 2 of 2',
        leave: 'Leave it out: Wireless Mouse, record 2 of 2',
      },
    ]);
    // Only the records that still read the same are numbered, by where they
    // are listed among the records with one name.
    expect(
      names([
        rec({ id: M1, ...inH, placementLabel: 'A-1' }),
        rec({ id: M2, ...inH, placementLabel: 'B-2' }),
        rec({ id: M3, ...inH, placementLabel: 'A-1' }),
      ]).map((n) => n.leave),
    ).toEqual([
      'Leave it out: Wireless Mouse, A-1, record 1 of 3',
      'Leave it out: Wireless Mouse, B-2',
      'Leave it out: Wireless Mouse, A-1, record 3 of 3',
    ]);
  });

  it("says the SKU, an ISBN or a size when it is what differs, in the line's words", () => {
    expect(
      names([
        rec({ id: M1, ...inH, sku: 'WM-1' }),
        rec({ id: M2, ...inH, sku: 'WM-2', quantityOnHand: 0 }),
      ]).map((n) => n.move),
    ).toEqual([
      'Move it into this group: Wireless Mouse, SKU WM-1, 4 on hand',
      'Move it into this group: Wireless Mouse, SKU WM-2, 0 on hand',
    ]);
    const editions = [
      rec({ id: M1, ...inH, itemType: 'book', name: 'Atlas', barcode: '9780134685991' }),
      rec({ id: M2, ...inH, itemType: 'book', name: 'Atlas', barcode: '9780321125217' }),
    ];
    expect(names(editions, 'books').map((n) => n.leave)).toEqual([
      'Leave it out: Atlas, ISBN 9780134685991',
      'Leave it out: Atlas, ISBN 9780321125217',
    ]);
    expect(
      names([
        rec({ id: M1, ...inH, variantSize: 'S' }),
        rec({ id: M2, ...inH, variantSize: 'M' }),
      ]).map((n) => n.move),
    ).toEqual([
      'Move it into this group: Wireless Mouse, Size S',
      'Move it into this group: Wireless Mouse, Size M',
    ]);
  });

  // The records with the radios are compared with each other, never with
  // the review's other records; and the position is where the record is
  // listed among them.
  it('names only the records with the radios, in the order they are listed', () => {
    const rows = [
      rec({ id: OTHER, ...inH, name: 'Keyboard', sku: 'KB-1', warehouseName: 'Annex' }),
      rec({ id: M1, ...inH }),
      // In no group: no radios, so neither named nor counted.
      rec({ id: M3 }),
      rec({ id: M2, ...inH }),
    ];
    const byId = groupChoiceRadioNamesById([M2, OTHER, M1], rows, 'items');
    expect([...byId.keys()]).toEqual([M2, OTHER, M1]);
    expect(byId.get(M2)?.move).toBe('Move it into this group: Wireless Mouse, record 1 of 2');
    expect(byId.get(M1)?.move).toBe('Move it into this group: Wireless Mouse, record 2 of 2');
    expect(byId.get(OTHER)?.move).toBe(GROUP_COPY.moveOneFor('Keyboard'));
    expect(byId.has(M3)).toBe(false);
  });

  // Naming one record at a time, as the web does, builds every same-named
  // record's line again for each record. Mutation caught: the names worked
  // out one record at a time, or a line built more than once per record.
  it("names every record's two radios in one pass, building each record's line once", () => {
    const many = Array.from({ length: GROUPING_MAX_ITEMS }, (_, i) =>
      rec({
        id: `dddddddd-0000-4000-8000-${String(100 + i).padStart(12, '0')}`,
        ...inH,
        placementLabel: `R-${i + 1}`,
      }),
    );
    lineBuilds.count = 0;
    const byId = groupChoiceRadioNamesById(
      many.map((r) => r.id),
      many,
      'items',
    );
    expect(lineBuilds.count).toBe(GROUPING_MAX_ITEMS);
    expect(byId.size).toBe(GROUPING_MAX_ITEMS);
    expect(new Set([...byId.values()].map((n) => n.move)).size).toBe(GROUPING_MAX_ITEMS);
    expect(byId.get(many[41]!.id)).toEqual({
      move: 'Move it into this group: Wireless Mouse, R-42',
      leave: 'Leave it out: Wireless Mouse, R-42',
    });
  });
});

// ── The screen, run ────────────────────────────────────────────────────────

const GROUP = 'app/group-selected.tsx';
const sf = parseTsx(readSource(path.resolve(__dirname, '../..', GROUP)), GROUP);

/** Runs a source expression in a context of its free names. */
function run(expression: string, context: Record<string, unknown>): unknown {
  const js = ts.transpileModule(`(${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new vm.Script(js).runInNewContext(context);
}

/** The initializer of the screen's `const name = ...`. */
function initializerOf(name: string): string {
  let text: string | null = null;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer
    )
      text ??= n.initializer.getText(sf);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (text === null) throw new Error(`const ${name} is not in ${GROUP}`);
  return text;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ');

/** The radiogroup of a record already in another group, and its radios. */
function choiceGroup(): { group: JsxNode; radios: JsxNode[] } {
  const groups: JsxNode[] = [];
  walkJsx(sf, (el) => {
    if (attrText(el, 'accessibilityRole', sf) === 'radiogroup') groups.push(el);
  });
  expect(groups).toHaveLength(1);
  const radios: JsxNode[] = [];
  walkJsx(groups[0]!, (el) => {
    if (attrText(el, 'accessibilityRole', sf) === 'radio') radios.push(el);
  });
  return { group: groups[0]!, radios };
}

/** The condition the radiogroup renders under (`cond ? <View ...> : null`). */
function conditionOf(el: JsxNode): string {
  let n: ts.Node = el;
  while (ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  if (!ts.isConditionalExpression(p) || p.whenTrue !== n)
    throw new Error('the radiogroup is not the true branch of a condition');
  return p.condition.getText(sf);
}

/** The `[...] as const` list the radios are mapped from, and the parameter
 *  each entry is read into. */
function radioList(radio: JsxNode): { list: string; param: string } {
  let n: ts.Node = radio;
  while (!ts.isArrowFunction(n)) n = n.parent;
  const call = n.parent;
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== 'map'
  )
    throw new Error('the radios are not mapped from a list');
  let list: ts.Expression = call.expression.expression;
  while (ts.isParenthesizedExpression(list) || ts.isAsExpression(list)) list = list.expression;
  return { list: list.getText(sf), param: n.parameters[0]!.getText(sf) };
}

type UseMemo = (make: () => unknown, deps: readonly unknown[]) => unknown;
type ChoiceNames = Map<string, { move: string; leave: string }>;

/** React's useMemo for one mounted review: it remembers its last deps and
 *  works a value out again only when one of them changes. */
function mountedMemo(): { useMemo: UseMemo; made: () => number } {
  let last: { deps: readonly unknown[]; value: unknown } | null = null;
  let made = 0;
  return {
    useMemo: (make, deps) => {
      if (
        last &&
        last.deps.length === deps.length &&
        last.deps.every((d, i) => Object.is(d, deps[i]))
      )
        return last.value;
      made += 1;
      last = { deps, value: make() };
      return last.value;
    },
    made: () => made,
  };
}

const passThrough: { useMemo: UseMemo } = { useMemo: (make) => make() };

interface ReviewState {
  review: PhoneGroupingReview;
  itemIds: string[];
  mode?: 'new' | 'existing';
  groupId?: string | null;
  nameValue?: string;
  choices?: ReadonlyMap<string, GroupRecordChoice>;
  view?: 'items' | 'books';
}

/**
 * One render of the review, from the screen's own expressions: the target,
 * the decisions and core's plan, the records it lists, the rows that carry
 * the two radios and their names (worked out by `memo`, the review's
 * useMemo).
 */
function render(s: ReviewState, memo: { useMemo: UseMemo } = passThrough) {
  const mode = s.mode ?? 'new';
  const groupId = s.groupId ?? null;
  const nameValue = s.nameValue ?? '';
  const view = s.view ?? 'items';
  const review = s.review;
  const targetGroupId = run(initializerOf('targetGroupId'), { mode, groupId });
  const target = run(initializerOf('target'), { mode, nameValue, groupId });
  const decisions = run(initializerOf('decisions'), {
    React: passThrough,
    groupingDecisionsFor,
    choices: s.choices ?? new Map(),
    review,
    ackFamily: false,
  }) as { moveIds: Set<string>; leaveOutIds: Set<string> };
  const plan = run(initializerOf('plan'), {
    React: passThrough,
    planGrouping,
    review,
    itemIds: s.itemIds,
    target,
    decisions,
    mode,
    nameValue,
    groupId,
  }) as ReturnType<typeof planGrouping>;
  const reviewById = run(initializerOf('reviewById'), { review });
  const records = run(initializerOf('records'), { plan, reviewById }) as PhoneGroupingRecord[];
  const leftOutReason = run(initializerOf('leftOutReason'), { plan }) as Map<string, string>;
  const otherGroupOf = run(initializerOf('otherGroupOf'), { targetGroupId }) as (
    r: PhoneGroupingRecord,
  ) => { id: string; name: string } | null;
  const choiceIds = run(initializerOf('choiceIds'), {
    plan,
    records,
    leftOutReason,
    otherGroupOf,
  });
  const choiceNames = run(initializerOf('choiceNames'), {
    React: memo,
    groupChoiceRadioNamesById,
    choiceIds,
    review,
    view,
  }) as ChoiceNames;
  return { plan, decisions, records, leftOutReason, otherGroupOf, choiceIds, choiceNames };
}

/** One radio as VoiceOver is told it, and the words it shows. */
interface HeardRadio {
  role: string | undefined;
  name: string;
  state: { checked: boolean; disabled: boolean };
  words: string;
}

/**
 * What VoiceOver is told for each listed record's radios, from the screen's
 * own expressions: the radiogroup's condition, the list the two radios are
 * mapped from, and each radio's role, name and state (no hint or value).
 */
function spoken(s: ReviewState): { id: string; radios: HeardRadio[] }[] {
  const { group, radios } = choiceGroup();
  const [radio] = radios;
  const condition = conditionOf(group);
  const { list } = radioList(radio!);
  const r0 = render(s);
  return r0.records.map((r) => {
    const names = r0.choiceNames.get(r.id);
    const other = r0.otherGroupOf(r);
    if (!run(condition, { names, other })) return { id: r.id, radios: [] };
    const entries = run(list, {
      moving: r0.decisions.moveIds.has(r.id),
      leaving: r0.decisions.leaveOutIds.has(r.id),
      GROUP_COPY,
      names,
    }) as [string, boolean, string, string][];
    return {
      id: r.id,
      radios: entries.map(([choice, on, label, a11yLabel]): HeardRadio => {
        const scope = { choice, on, label, a11yLabel, busy: false };
        return {
          role: attrText(radio!, 'accessibilityRole', sf),
          name: run(attrText(radio!, 'accessibilityLabel', sf)!, scope) as string,
          state: run(attrText(radio!, 'accessibilityState', sf)!, scope) as HeardRadio['state'],
          words: label,
        };
      }),
    };
  });
}

const reviewOf = (records: PhoneGroupingRecord[]): PhoneGroupingReview => ({
  records,
  unavailableCount: 0,
  sameSkuSiblings: [],
  candidateGroups: [
    { id: G2, name: 'Desk', version: 1, itemType: 'product', memberCount: 1, holdsSelected: true },
  ],
  targetGroup: null,
  previewKey: 'preview',
});

const radioPair = (move: string, leave: string, checked: 'move' | 'leave' | null = null) => [
  {
    role: 'radio',
    name: move,
    state: { checked: checked === 'move', disabled: false },
    words: GROUP_COPY.moveOne,
  },
  {
    role: 'radio',
    name: leave,
    state: { checked: checked === 'leave', disabled: false },
    words: GROUP_COPY.leaveOutOne,
  },
];

describe('the Group review radios, run from the screen over core plan', () => {
  it('there is one pair of radios per record, with their role, checked state and words as before', () => {
    const { group, radios } = choiceGroup();
    expect(radios).toHaveLength(1);
    const radio = radios[0]!;
    expect(attrText(radio, 'accessibilityState', sf)).toBe('{ checked: on, disabled: busy }');
    expect(attrText(radio, 'disabled', sf)).toBe('busy');
    expect(attrText(radio, 'onPress', sf)).toBe('() => choose(r.id, choice, other.id)');
    // Nothing is heard beside the name: no hint, no value.
    expect(attrText(radio, 'accessibilityHint', sf)).toBeUndefined();
    expect(attrText(radio, 'accessibilityValue', sf)).toBeUndefined();
    // The group's header is the words on screen, as before.
    expect(group.getText(sf)).toContain('{GROUP_COPY.otherGroup(other.name)}');
    expect(radio.getText(sf)).toMatch(/\{label\}\s*<\/Body>/);
  });

  // Each radio's name was core's words for its record, worked out by the
  // radio (GROUP_COPY.moveOneFor(r.name)). Mutation caught: a radio names
  // itself again, or the names are worked out on every render.
  it("both radios read their names from the review's names, worked out once per review", () => {
    const { radios } = choiceGroup();
    const radio = radios[0]!;
    const { list, param } = radioList(radio);
    expect(param).toBe('[choice, on, label, a11yLabel]');
    expect(oneLine(list)).toBe(
      "[ ['move', moving, GROUP_COPY.moveOne, names.move], ['leave', leaving, GROUP_COPY.leaveOutOne, names.leave], ]",
    );
    expect(attrText(radio, 'accessibilityLabel', sf)).toBe('a11yLabel');
    expect(initializerOf('names')).toBe('choiceNames.get(r.id)');
    // Only a record with its names carries the radios.
    expect(conditionOf(choiceGroup().group)).toBe('names && other');
    // Worked out by the review's memo, from what the names depend on.
    expect(oneLine(initializerOf('choiceNames'))).toBe(
      "React.useMemo( () => groupChoiceRadioNamesById(choiceIds ? choiceIds.split(',') : [], review?.records ?? [], view), [choiceIds, review, view], )",
    );
    expect(oneLine(sf.getFullText())).not.toMatch(/GROUP_COPY\.(?:moveOneFor|leaveOutOneFor)\(/);
  });

  // The walk: three Wireless Mouse records on racks A-1, B-2 and C-3 and a
  // Keyboard, every one already in the group Old shirts, grouped into a new
  // group. Mutation caught: the names back to core's words alone (three
  // pairs of radios with one name).
  it('three Wireless Mouse records on three racks next to a Keyboard: each pair is named with its rack', () => {
    const KB = OTHER;
    const review = reviewOf([
      rec({ id: M1, ...inH, placementLabel: 'A-1' }),
      rec({ id: M2, ...inH, placementLabel: 'B-2' }),
      rec({ id: M3, ...inH, placementLabel: 'C-3' }),
      rec({ id: KB, ...inH, name: 'Keyboard', sku: 'KB-1', placementLabel: 'A-1' }),
    ]);
    const heard = spoken({ review, itemIds: [M1, M2, M3, KB] });
    expect(heard).toEqual([
      {
        id: M1,
        radios: radioPair(
          'Move it into this group: Wireless Mouse, A-1',
          'Leave it out: Wireless Mouse, A-1',
        ),
      },
      {
        id: M2,
        radios: radioPair(
          'Move it into this group: Wireless Mouse, B-2',
          'Leave it out: Wireless Mouse, B-2',
        ),
      },
      {
        id: M3,
        radios: radioPair(
          'Move it into this group: Wireless Mouse, C-3',
          'Leave it out: Wireless Mouse, C-3',
        ),
      },
      // Its name is its own: core's words, as before (R2-5).
      {
        id: KB,
        radios: radioPair(GROUP_COPY.moveOneFor('Keyboard'), GROUP_COPY.leaveOutOneFor('Keyboard')),
      },
    ]);
    // A choice moves the check, and every name stays the same.
    const chosen = spoken({
      review,
      itemIds: [M1, M2, M3, KB],
      choices: new Map([
        [M2, { choice: 'leave', fromGroupId: H }],
        [M3, { choice: 'move', fromGroupId: H }],
      ]),
    });
    expect(chosen.map((h) => h.radios.map((r) => r.name))).toEqual(
      heard.map((h) => h.radios.map((r) => r.name)),
    );
    expect(chosen.map((h) => h.radios.map((r) => r.state.checked))).toEqual([
      [false, false],
      [false, true],
      [true, false],
      [false, false],
    ]);
  });

  it('two identical records in another group end with record 1 of 2 and record 2 of 2, in the order listed', () => {
    const D = OTHER;
    const mouse = { placementLabel: 'A-1' };
    const review = reviewOf([
      rec({ id: M1, ...mouse, ...inH }),
      rec({ id: M2, ...mouse, ...inH }),
      // The same name and line, in no group: no radios, so not counted.
      rec({ id: D, ...mouse }),
    ]);
    expect(spoken({ review, itemIds: [M2, D, M1] })).toEqual([
      {
        id: M2,
        radios: radioPair(
          'Move it into this group: Wireless Mouse, record 1 of 2',
          'Leave it out: Wireless Mouse, record 1 of 2',
        ),
      },
      { id: D, radios: [] },
      {
        id: M1,
        radios: radioPair(
          'Move it into this group: Wireless Mouse, record 2 of 2',
          'Leave it out: Wireless Mouse, record 2 of 2',
        ),
      },
    ]);
  });

  it('names that differ only in letter case or spacing: each pair says its own name and its rack', () => {
    const review = reviewOf([
      rec({ id: M1, ...inH, name: 'Wireless Mouse', placementLabel: 'A-1' }),
      rec({ id: M2, ...inH, name: 'Wireless mouse', placementLabel: 'B-2' }),
      rec({ id: M3, ...inH, name: 'Wireless  Mouse', placementLabel: 'C-3' }),
    ]);
    expect(
      spoken({ review, itemIds: [M1, M2, M3] }).map((h) => h.radios.map((r) => r.name)),
    ).toEqual([
      ['Move it into this group: Wireless Mouse, A-1', 'Leave it out: Wireless Mouse, A-1'],
      ['Move it into this group: Wireless mouse, B-2', 'Leave it out: Wireless mouse, B-2'],
      ['Move it into this group: Wireless  Mouse, C-3', 'Leave it out: Wireless  Mouse, C-3'],
    ]);
  });

  // The rows with the radios are the web's: a record in another group than
  // the target, sent or chosen to be left out. A kit, a rental or a record
  // the person cannot edit carries none, and is not counted; a record in the
  // target carries none either.
  it('a record left out for another reason, or in the target group, has no radios and is not counted', () => {
    const review = reviewOf([
      rec({ id: M1, ...inH }),
      rec({ id: M2, ...inH, isRental: true }),
      rec({ id: M3, ...inH }),
      rec({ id: OTHER, ...inG2 }),
    ]);
    const heard = spoken({
      review,
      itemIds: [M1, M2, M3, OTHER],
      mode: 'existing',
      groupId: G2,
      choices: new Map([[M3, { choice: 'leave', fromGroupId: H }]]),
    });
    expect(heard).toEqual([
      {
        id: M1,
        radios: radioPair(
          'Move it into this group: Wireless Mouse, record 1 of 2',
          'Leave it out: Wireless Mouse, record 1 of 2',
        ),
      },
      { id: M2, radios: [] },
      {
        id: M3,
        radios: radioPair(
          'Move it into this group: Wireless Mouse, record 2 of 2',
          'Leave it out: Wireless Mouse, record 2 of 2',
          'leave',
        ),
      },
      { id: OTHER, radios: [] },
    ]);
  });

  // The plan changes with every choice and every letter of a new group's
  // name, and the names do not: they are worked out once per review and
  // target. Mutation caught: the memo keyed on the plan (the names worked out
  // again on every tap), or on nothing that changes with the target.
  it('a choice or a typed name keeps the names; another target works them out again', () => {
    const review = reviewOf([
      rec({ id: M1, ...inH, placementLabel: 'A-1' }),
      rec({ id: M2, ...inH, placementLabel: 'B-2' }),
      rec({ id: OTHER, ...inG2, name: 'Keyboard', sku: 'KB-1' }),
    ]);
    const itemIds = [M1, M2, OTHER];
    const mounted = mountedMemo();
    const first = render({ review, itemIds }, mounted);
    const tapped = render(
      { review, itemIds, choices: new Map([[M1, { choice: 'leave', fromGroupId: H }]]) },
      mounted,
    );
    const typed = render(
      {
        review,
        itemIds,
        nameValue: 'Mice',
        choices: new Map([[M1, { choice: 'leave', fromGroupId: H }]]),
      },
      mounted,
    );
    expect(tapped.plan).not.toBe(first.plan);
    expect(typed.plan).not.toBe(tapped.plan);
    expect(mounted.made()).toBe(1);
    expect(tapped.choiceNames).toBe(first.choiceNames);
    expect(typed.choiceNames).toBe(first.choiceNames);
    expect([...first.choiceNames.keys()]).toEqual([M1, M2, OTHER]);
    // Into the Keyboard's group: its row has no radios now, so the names are
    // worked out again, for the two mice.
    const existing = render({ review, itemIds, mode: 'existing', groupId: G2 }, mounted);
    expect(mounted.made()).toBe(2);
    expect([...existing.choiceNames.entries()]).toEqual([
      [
        M1,
        {
          move: 'Move it into this group: Wireless Mouse, A-1',
          leave: 'Leave it out: Wireless Mouse, A-1',
        },
      ],
      [
        M2,
        {
          move: 'Move it into this group: Wireless Mouse, B-2',
          leave: 'Leave it out: Wireless Mouse, B-2',
        },
      ],
    ]);
  });
});
