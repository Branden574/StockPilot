import * as path from 'node:path';
import * as vm from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  planUngroupSelected,
  UNGROUP_COPY,
  ungroupAnchorFor,
  ungroupOutcomeWords,
  ungroupRecordOutcome,
  type UngroupKind,
} from '@stockpilot/core';

import {
  attrText,
  parseTsx,
  readSource,
  walkJsx,
  type JsxNode,
} from './__fixtures__/jsx-touch-audit';
import type { PhoneGroupingRecord } from './display-groups';
// vi.mock below is hoisted above every import by vitest.
import { keepsSkuRadioLabel, type PhoneUngroupReview } from './ungroup-selected';

vi.mock('./api', () => ({
  api: () => Promise.reject(new Error('no request leaves this test')),
  ApiError: class extends Error {},
}));

/**
 * THE UNGROUP REVIEW'S "KEEPS THE SKU" RADIOS, AS VOICEOVER HEARS THEM
 * (redesign Stage 6, F9).
 *
 * When every record of a SKU the person can see is ticked, each row carries
 * a radio for the one that keeps the SKU. Each radio was named "Keeps SKU
 * <sku>: <name>" and nothing more: with three Wireless Mouse records the
 * three radios read the same, and the outcome beside each ("Gets its own
 * SKU" on the records that will change) was never heard, since a named
 * Pressable is read by its name, not its words.
 *
 * Each radio's name now goes on with what tells its record apart from the
 * SKU's other records, in the words the record's line shows (its rack or
 * placement, warehouse, charter or on hand), and the outcome is its value.
 * VoiceOver: "Keeps SKU WM-1: Wireless Mouse, B-2, 4 on hand, radio button,
 * unchecked, Gets its own SKU". The role and the checked state are kept.
 */

const M1 = 'dddddddd-0000-4000-8000-000000000001';
const M2 = 'dddddddd-0000-4000-8000-000000000002';
const M3 = 'dddddddd-0000-4000-8000-000000000003';
const OTHER = 'dddddddd-0000-4000-8000-000000000009';

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

const keeps = UNGROUP_COPY.keepsSku('WM-1');

/** Every radio's name for these records, all of them the SKU's radios. */
const names = (records: PhoneGroupingRecord[], view: 'items' | 'books' = 'items') =>
  records.map((r) => keepsSkuRadioLabel(keeps, r, records, records, view));

describe('keepsSkuRadioLabel: each radio is named for what tells its record apart', () => {
  it('three Wireless Mouse records on three racks are three radios, each named with its rack', () => {
    const mice = [
      rec({ id: M1, placementLabel: 'A-1' }),
      rec({ id: M2, placementLabel: 'B-2' }),
      rec({ id: M3, placementLabel: 'C-3' }),
    ];
    expect(names(mice)).toEqual([
      'Keeps SKU WM-1: Wireless Mouse, A-1',
      'Keeps SKU WM-1: Wireless Mouse, B-2',
      'Keeps SKU WM-1: Wireless Mouse, C-3',
    ]);
  });

  // The words are the line's own (reviewRecordDetail), and only the parts
  // not on every one of the SKU's lines are said.
  it('says what differs, in the words of the record line: warehouse, charter, on hand, no rack', () => {
    expect(
      names([rec({ id: M1, warehouseName: 'Main' }), rec({ id: M2, warehouseName: 'Annex' })]),
    ).toEqual(['Keeps SKU WM-1: Wireless Mouse, Main', 'Keeps SKU WM-1: Wireless Mouse, Annex']);
    expect(
      names([
        rec({ id: M1, charterId: 'ch-1', charterName: 'North Charter' }),
        rec({ id: M2, charterId: null }),
      ]),
    ).toEqual([
      'Keeps SKU WM-1: Wireless Mouse, North Charter',
      'Keeps SKU WM-1: Wireless Mouse, No charter',
    ]);
    expect(names([rec({ id: M1, quantityOnHand: 4 }), rec({ id: M2, quantityOnHand: 0 })])).toEqual(
      ['Keeps SKU WM-1: Wireless Mouse, 4 on hand', 'Keeps SKU WM-1: Wireless Mouse, 0 on hand'],
    );
    expect(
      names([
        rec({ id: M1, placementLabel: 'A-1', quantityOnHand: 4 }),
        rec({ id: M2, placementLabel: null, quantityOnHand: 4 }),
        rec({ id: M3, placementLabel: 'C-3', quantityOnHand: 0 }),
      ]),
    ).toEqual([
      'Keeps SKU WM-1: Wireless Mouse, A-1, 4 on hand',
      'Keeps SKU WM-1: Wireless Mouse, No rack, 4 on hand',
      'Keeps SKU WM-1: Wireless Mouse, C-3, 0 on hand',
    ]);
  });

  it("another name tells a record apart by itself, and a book's ISBN or an item's size is said when it differs", () => {
    expect(
      names([
        rec({ id: M1, name: 'Wireless Mouse' }),
        rec({ id: M2, name: 'Wireless Mouse (black)' }),
      ]),
    ).toEqual(['Keeps SKU WM-1: Wireless Mouse', 'Keeps SKU WM-1: Wireless Mouse (black)']);
    expect(
      names([rec({ id: M1, variantSize: 'S' }), rec({ id: M2, variantSize: 'M' })], 'items'),
    ).toEqual(['Keeps SKU WM-1: Wireless Mouse, Size S', 'Keeps SKU WM-1: Wireless Mouse, Size M']);
    const editions = [
      rec({ id: M1, itemType: 'book', name: 'Atlas', barcode: '9780134685991' }),
      rec({ id: M2, itemType: 'book', name: 'Atlas', barcode: '9780321125217' }),
    ];
    expect(names(editions, 'books')).toEqual([
      'Keeps SKU WM-1: Atlas, ISBN 9780134685991',
      'Keeps SKU WM-1: Atlas, ISBN 9780321125217',
    ]);
  });

  // Mutation caught: a name with no position, so two records whose every
  // word reads the same are two radios with one name again.
  it('records whose names and lines read the same are told apart by where they are listed', () => {
    const twins = [
      rec({ id: M1, placementLabel: 'A-1' }),
      rec({ id: M2, placementLabel: 'B-2' }),
      rec({ id: M3, placementLabel: 'A-1' }),
    ];
    expect(names(twins)).toEqual([
      'Keeps SKU WM-1: Wireless Mouse, A-1, record 1 of 3',
      'Keeps SKU WM-1: Wireless Mouse, B-2',
      'Keeps SKU WM-1: Wireless Mouse, A-1, record 3 of 3',
    ]);
    const same = [rec({ id: M1 }), rec({ id: M2 })];
    expect(names(same)).toEqual([
      'Keeps SKU WM-1: Wireless Mouse, record 1 of 2',
      'Keeps SKU WM-1: Wireless Mouse, record 2 of 2',
    ]);
  });

  // The SKU's radios are compared with each other, never with the review's
  // other rows; and the position is where the record is listed.
  it("compares only the SKU's records with a radio, in the order the review lists them", () => {
    const rows = [
      rec({ id: OTHER, name: 'Keyboard', sku: 'KB-1', warehouseName: 'Annex' }),
      rec({ id: M2 }),
      rec({ id: M1 }),
    ];
    const skuRecords = [{ id: M1 }, { id: M2 }];
    expect(keepsSkuRadioLabel(keeps, rows[2]!, rows, skuRecords, 'items')).toBe(
      'Keeps SKU WM-1: Wireless Mouse, record 2 of 2',
    );
    expect(keepsSkuRadioLabel(keeps, rows[1]!, rows, skuRecords, 'items')).toBe(
      'Keeps SKU WM-1: Wireless Mouse, record 1 of 2',
    );
  });

  it("starts as before, with core's choice and the record's name, and never says the outcome", () => {
    for (const name of names([rec({ id: M1, placementLabel: 'A-1' }), rec({ id: M2 })])) {
      expect(name.startsWith(`${UNGROUP_COPY.keepsSku('WM-1')}: Wireless Mouse`)).toBe(true);
      expect(name).not.toContain(UNGROUP_COPY.getsOwnSku);
      // The SKU is said once, by the choice; the shared line parts are not.
      expect(name.match(/WM-1/g)).toHaveLength(1);
      expect(name).not.toContain('Main');
    }
  });
});

// ── The screen, run ────────────────────────────────────────────────────────

const UNGROUP = 'app/ungroup-selected.tsx';
const sf = parseTsx(readSource(path.resolve(__dirname, '../..', UNGROUP)), UNGROUP);

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
  if (text === null) throw new Error(`const ${name} is not in ${UNGROUP}`);
  return text;
}

const radios: JsxNode[] = [];
walkJsx(sf, (el) => {
  if (attrText(el, 'accessibilityRole', sf) === 'radio') radios.push(el);
});

type Candidate = PhoneUngroupReview['candidates'][number];
const candidateOf = (r: PhoneGroupingRecord): Candidate => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  isBundle: false,
  inFamily: false,
  barcode: r.barcode,
  placementLabel: r.placementLabel,
  warehouseName: r.warehouseName,
  quantityOnHand: r.quantityOnHand,
});

/**
 * What VoiceOver is told for each row's radio, from the screen's own
 * expressions over core's plan: every Wireless Mouse ticked, shown under the
 * SKU they share. The candidates come in the server order (oldest first), the
 * rows in the order ticked.
 */
function spoken(
  ticked: PhoneGroupingRecord[],
  serverOrder: PhoneGroupingRecord[],
  anchorBySku: Record<string, string>,
) {
  const shownUnder = new Map<string, UngroupKind>(ticked.map((r) => [r.id, 'sku']));
  const plan = planUngroupSelected(
    ticked.map((r) => r.id),
    { records: ticked, unavailableCount: 0 },
    serverOrder.map(candidateOf),
    { canUnlinkFamilies: true, shownUnder },
  );
  const [radio] = radios;
  const label = attrText(radio!, 'accessibilityLabel', sf)!;
  const value = attrText(radio!, 'accessibilityValue', sf);
  const state = attrText(radio!, 'accessibilityState', sf)!;
  return plan.records.map((r) => {
    const o = ungroupRecordOutcome(plan, r.id, anchorBySku);
    const group = run(initializerOf('group'), { o, plan, rec: r }) as
      (typeof plan.split.groups)[number] | undefined;
    const checked = run(initializerOf('keeps'), {
      group,
      rec: r,
      anchorBySku,
      ungroupAnchorFor,
    }) as boolean;
    expect(group?.allSelected, r.id).toBe(true);
    return {
      id: r.id,
      role: attrText(radio!, 'accessibilityRole', sf),
      name: run(label, { keepsSkuRadioLabel, UNGROUP_COPY, group, r, plan, view: 'items' }),
      value: value === undefined ? undefined : run(value, { ungroupOutcomeWords, o }),
      state: run(state, { keeps: checked, busy: false }),
    };
  });
}

describe('the Ungroup review radios, run from the screen over core plan', () => {
  it('there is one radio, the keeps-the-SKU choice, with its role and checked state', () => {
    expect(radios).toHaveLength(1);
    expect(attrText(radios[0]!, 'accessibilityState', sf)).toBe(
      '{ checked: keeps, disabled: busy }',
    );
  });

  // The F9 walk: three Wireless Mouse records sharing SKU WM-1, every one
  // ticked. Mutation caught: the name back to "Keeps SKU X: <name>" (three
  // names the same), or the value dropped (the outcome never heard).
  it('three Wireless Mouse radios have three names, and each says its outcome as its value', () => {
    const mice = [
      rec({ id: M1, placementLabel: 'A-1' }),
      rec({ id: M2, placementLabel: 'B-2' }),
      rec({ id: M3, placementLabel: 'C-3', quantityOnHand: 0 }),
    ];
    const heard = spoken([mice[1]!, mice[0]!, mice[2]!], mice, {});
    expect(new Set(heard.map((h) => h.name)).size).toBe(3);
    expect(heard).toEqual([
      {
        id: M2,
        role: 'radio',
        name: 'Keeps SKU WM-1: Wireless Mouse, B-2, 4 on hand',
        value: { text: UNGROUP_COPY.getsOwnSku },
        state: { checked: false, disabled: false },
      },
      {
        id: M1,
        role: 'radio',
        // The oldest keeps the SKU unless another is chosen.
        name: 'Keeps SKU WM-1: Wireless Mouse, A-1, 4 on hand',
        value: { text: UNGROUP_COPY.keepsSku('WM-1') },
        state: { checked: true, disabled: false },
      },
      {
        id: M3,
        role: 'radio',
        name: 'Keeps SKU WM-1: Wireless Mouse, C-3, 0 on hand',
        value: { text: UNGROUP_COPY.getsOwnSku },
        state: { checked: false, disabled: false },
      },
    ]);
  });

  it('choosing another record moves the outcome and the check, and every name stays the same', () => {
    const mice = [
      rec({ id: M1, placementLabel: 'A-1' }),
      rec({ id: M2, placementLabel: 'B-2' }),
      rec({ id: M3, placementLabel: 'C-3' }),
    ];
    const before = spoken(mice, mice, {});
    const after = spoken(mice, mice, { 'WM-1': M3 });
    expect(after.map((h) => h.name)).toEqual(before.map((h) => h.name));
    expect(after.map((h) => [h.id, h.value, h.state])).toEqual([
      [M1, { text: UNGROUP_COPY.getsOwnSku }, { checked: false, disabled: false }],
      [M2, { text: UNGROUP_COPY.getsOwnSku }, { checked: false, disabled: false }],
      [M3, { text: UNGROUP_COPY.keepsSku('WM-1') }, { checked: true, disabled: false }],
    ]);
  });

  it('records that read the same in every word are named by where the review lists them', () => {
    const same = [rec({ id: M1 }), rec({ id: M2 }), rec({ id: M3 })];
    const heard = spoken([same[2]!, same[0]!, same[1]!], same, {});
    expect(heard.map((h) => [h.id, h.name])).toEqual([
      [M3, 'Keeps SKU WM-1: Wireless Mouse, record 1 of 3'],
      [M1, 'Keeps SKU WM-1: Wireless Mouse, record 2 of 3'],
      [M2, 'Keeps SKU WM-1: Wireless Mouse, record 3 of 3'],
    ]);
  });
});
