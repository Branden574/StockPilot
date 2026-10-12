import { describe, expect, it } from 'vitest';

import { composeDisplayList, shownUnderByRecord } from './display-units';
import {
  GROUPING_ERROR_WORDS,
  UNGROUP_COPY,
  chooseUngroupKind,
  keyedUngroupSelectedBody,
  parseUngroupSelectedBody,
  parseUngroupSelectedOutcome,
  planUngroupSelected,
  ungroupableItemIds,
  ungroupChangeCount,
  ungroupOutcomeWords,
  ungroupRecordOutcome,
  ungroupResultLines,
  ungroupSelectedBodyForPlan,
  type SplitCandidate,
  type UngroupKind,
  type UngroupSelectedRecord,
} from './grouping-contract';

// Ungroup anything (owner 2026-10-12, verbatim: "im supposed to be able to
// check box whatever item and then group or ungroup it that was the point.").

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const K1 = '33333333-3333-4333-8333-333333333333';
const K2 = '44444444-4444-4444-8444-444444444444';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const G = '99999999-9999-4999-8999-999999999999';
const FAM = '77777777-7777-4777-8777-777777777777';

function rec(n: number, over: Partial<UngroupSelectedRecord> = {}): UngroupSelectedRecord {
  return {
    id: id(n),
    name: `Record ${n}`,
    sku: `SKU-${n}`,
    isBundle: false,
    writable: true,
    displayGroup: null,
    productGroupId: null,
    productGroupName: null,
    ...over,
  };
}

function cand(n: number, sku: string, over: Partial<SplitCandidate> = {}): SplitCandidate {
  return { id: id(n), sku, name: `Record ${n}`, isBundle: false, inFamily: false, ...over };
}

const inG = { id: G, name: 'Tees', version: 3 };

describe('chooseUngroupKind: the grouping a record leaves', () => {
  it('is the one it is shown under when it has it', () => {
    const all = new Set<UngroupKind>(['group', 'sku', 'family']);
    expect(chooseUngroupKind(all, 'family')).toBe('family');
    expect(chooseUngroupKind(all, 'sku')).toBe('sku');
    expect(chooseUngroupKind(all, 'group')).toBe('group');
  });

  it("falls back to the list's precedence (group, SKU, family) when shown under none it has", () => {
    expect(chooseUngroupKind(new Set<UngroupKind>(['family', 'sku', 'group']), null)).toBe('group');
    expect(chooseUngroupKind(new Set<UngroupKind>(['family', 'sku']), undefined)).toBe('sku');
    expect(chooseUngroupKind(new Set<UngroupKind>(['family']), 'group')).toBe('family');
    expect(chooseUngroupKind(new Set<UngroupKind>(), 'sku')).toBeNull();
  });
});

describe('planUngroupSelected: what happens to each ticked record', () => {
  it("the owner's case: the eight sizes of a T-shirt, each its own SKU in one size family, all leave the family", () => {
    const sizes = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
      rec(n, { productGroupId: FAM, productGroupName: 'Limits Tee' }),
    );
    const plan = planUngroupSelected(
      sizes.map((r) => r.id),
      { records: sizes, unavailableCount: 0 },
      sizes.map((r) => cand(Number(r.id.slice(-2)), r.sku, { inFamily: true })),
      {
        canUnlinkFamilies: true,
        shownUnder: new Map(sizes.map((r) => [r.id, 'family' as const])),
      },
    );
    expect(plan.leaveFamily.map((r) => r.id)).toEqual(sizes.map((r) => r.id));
    expect(plan.leftOut).toEqual([]);
    expect(ungroupChangeCount(plan, {})).toBe(8);
    const o = ungroupRecordOutcome(plan, sizes[0]!.id, {})!;
    expect(ungroupOutcomeWords(o)).toBe('Leaves the Limits Tee size family');
  });

  it('a record that shares its SKU gets its own SKU; one in a display group leaves it', () => {
    const a = rec(1, { sku: 'PAIR' });
    const g = rec(2, { displayGroup: inG });
    const plan = planUngroupSelected(
      [a.id, g.id],
      { records: [a, g], unavailableCount: 0 },
      [cand(1, 'PAIR'), cand(9, 'PAIR'), cand(2, 'SKU-2')],
      { canUnlinkFamilies: false },
    );
    expect(plan.split.splitIds).toEqual([a.id]);
    expect(plan.leaveGroup.map((r) => r.id)).toEqual([g.id]);
    expect(ungroupOutcomeWords(ungroupRecordOutcome(plan, a.id, {})!)).toBe(
      UNGROUP_COPY.getsOwnSku,
    );
    expect(ungroupOutcomeWords(ungroupRecordOutcome(plan, g.id, {})!)).toBe('Leaves group Tees');
    expect(ungroupChangeCount(plan, {})).toBe(2);
  });

  it('counts only the records that change: with every record of a SKU ticked, one keeps it', () => {
    const a = rec(1, { sku: 'PAIR' });
    const b = rec(2, { sku: 'PAIR' });
    const plan = planUngroupSelected(
      [a.id, b.id],
      { records: [a, b], unavailableCount: 0 },
      [cand(1, 'PAIR'), cand(2, 'PAIR')],
      { canUnlinkFamilies: false },
    );
    expect(plan.split.splitIds).toEqual([a.id, b.id]);
    expect(ungroupChangeCount(plan, {})).toBe(1);
    // The oldest keeps it by default; the person may choose the other.
    expect(ungroupOutcomeWords(ungroupRecordOutcome(plan, a.id, {})!)).toBe(
      UNGROUP_COPY.keepsSku('PAIR'),
    );
    expect(ungroupOutcomeWords(ungroupRecordOutcome(plan, b.id, { PAIR: b.id })!)).toBe(
      UNGROUP_COPY.keepsSku('PAIR'),
    );
    expect(ungroupOutcomeWords(ungroupRecordOutcome(plan, a.id, { PAIR: b.id })!)).toBe(
      UNGROUP_COPY.getsOwnSku,
    );
    expect(ungroupChangeCount(plan, { PAIR: b.id })).toBe(1);
  });

  it('a record in more than one grouping leaves the one it is shown under', () => {
    // In display group G AND in a size family: under the family's run, it
    // leaves the family; under the group's header, it leaves the group.
    const r = rec(1, { displayGroup: inG, productGroupId: FAM, productGroupName: 'Tee' });
    const plan = (shown: UngroupKind | null) =>
      planUngroupSelected([r.id], { records: [r], unavailableCount: 0 }, [cand(1, 'SKU-1')], {
        canUnlinkFamilies: true,
        shownUnder: shown ? new Map([[r.id, shown]]) : null,
      });
    expect(plan('family').leaveFamily.map((x) => x.id)).toEqual([r.id]);
    expect(plan('family').leaveGroup).toEqual([]);
    expect(plan('group').leaveGroup.map((x) => x.id)).toEqual([r.id]);
    // Shown under nothing here (another page, a lone search hit): the list's
    // precedence, a group before a family.
    expect(plan(null).leaveGroup.map((x) => x.id)).toEqual([r.id]);
    // In group G and sharing its SKU, shown under the SKU's header: it gets
    // its own SKU and stays in G.
    const s = rec(2, { sku: 'PAIR', displayGroup: inG });
    const p2 = planUngroupSelected(
      [s.id],
      { records: [s], unavailableCount: 0 },
      [cand(2, 'PAIR'), cand(3, 'PAIR')],
      { canUnlinkFamilies: false, shownUnder: new Map([[s.id, 'sku' as const]]) },
    );
    expect(p2.split.splitIds).toEqual([s.id]);
    expect(p2.leaveGroup).toEqual([]);
  });

  it('a mixed selection: one of each kind, and every left-out record with its reason', () => {
    const split = rec(1, { sku: 'PAIR' });
    const group = rec(2, { displayGroup: inG });
    const family = rec(3, { productGroupId: FAM, productGroupName: 'Tee' });
    const kit = rec(4, { isBundle: true, displayGroup: inG });
    const nothing = rec(5);
    const locked = rec(6, { displayGroup: inG, writable: false });
    const famSku = rec(7, { sku: 'PAIR', productGroupId: FAM, productGroupName: 'Tee' });
    const records = [split, group, family, kit, nothing, locked, famSku];
    const ticked = records.map((r) => r.id);
    const plan = planUngroupSelected(
      [...ticked, id(50)],
      { records, unavailableCount: 1 },
      [cand(1, 'PAIR'), cand(7, 'PAIR', { inFamily: true }), cand(8, 'PAIR')],
      { canUnlinkFamilies: true },
    );
    expect(plan.split.splitIds).toEqual([split.id]);
    expect(plan.leaveGroup.map((r) => r.id)).toEqual([group.id]);
    expect(plan.leaveFamily.map((r) => r.id)).toEqual([family.id]);
    expect(plan.leftOut).toEqual([
      { id: kit.id, reason: 'kit' },
      { id: nothing.id, reason: 'nothing' },
      { id: locked.id, reason: 'not_writable' },
      // Shares its SKU and is in a family: the SKU header wins on the list,
      // and the database refuses that split, so it is left out (not unlinked).
      { id: famSku.id, reason: 'family_sku' },
    ]);
    expect(plan.unavailableCount).toBe(1);
    expect(ungroupChangeCount(plan, {})).toBe(3);
    expect(ungroupOutcomeWords(ungroupRecordOutcome(plan, kit.id, {})!)).toBe(
      `Left out: ${UNGROUP_COPY.selectedLeftOutReason.kit}`,
    );
  });

  it('never plans a split for a family member, even when the SKU read missed its family (two reads)', () => {
    const famSku = rec(7, { sku: 'PAIR', productGroupId: FAM, productGroupName: 'Tee' });
    const plan = planUngroupSelected(
      [famSku.id],
      { records: [famSku], unavailableCount: 0 },
      [cand(7, 'PAIR'), cand(8, 'PAIR')],
      { canUnlinkFamilies: true, shownUnder: new Map([[famSku.id, 'sku' as const]]) },
    );
    expect(plan.split.splitIds).toEqual([]);
    expect(plan.leftOut).toEqual([{ id: famSku.id, reason: 'family_sku' }]);
  });

  it('a size family needs permission to manage sports products: without it the record is left out', () => {
    const family = rec(3, { productGroupId: FAM });
    const plan = planUngroupSelected(
      [family.id],
      { records: [family], unavailableCount: 0 },
      [cand(3, 'SKU-3', { inFamily: true })],
      { canUnlinkFamilies: false, shownUnder: new Map([[family.id, 'family' as const]]) },
    );
    expect(plan.leaveFamily).toEqual([]);
    expect(plan.leftOut).toEqual([{ id: family.id, reason: 'family_permission' }]);
    expect(ungroupChangeCount(plan, {})).toBe(0);
  });

  it('names how many records the person can see stay in a group that loses records', () => {
    const a = rec(1, { displayGroup: inG });
    const b = rec(2, { displayGroup: inG });
    const plan = planUngroupSelected(
      [a.id, b.id],
      {
        records: [a, b],
        unavailableCount: 0,
        candidateGroups: [
          {
            id: G,
            name: 'Tees',
            version: 3,
            itemType: 'product',
            memberCount: 5,
            holdsSelected: true,
          },
        ],
      },
      [],
      { canUnlinkFamilies: false },
    );
    expect(plan.groups).toEqual([{ id: G, name: 'Tees', removing: 2, staying: 3 }]);
  });
});

describe('ungroupableItemIds: the bulk bar offers Ungroup', () => {
  const rows = [
    { id: id(1), sku: 'PAIR' },
    { id: id(2), sku: 'PAIR' },
    { id: id(3), sku: 'SOLO', display_group_id: G },
    { id: id(4), sku: 'T-S', group_id: FAM },
    { id: id(5), sku: 'LONE' },
    { id: id(6), sku: 'KIT', display_group_id: G, is_bundle: true },
  ];
  const all = rows.map((r) => r.id);

  it('for any ticked record with something to leave, per kind and permission', () => {
    expect(ungroupableItemIds(all, rows, { canEditItems: true, canUnlinkFamilies: true })).toEqual([
      id(1),
      id(2),
      id(3),
      id(4),
    ]);
    // A family needs the sports permission too; nothing at all without items:update.
    expect(ungroupableItemIds(all, rows, { canEditItems: true, canUnlinkFamilies: false })).toEqual(
      [id(1), id(2), id(3)],
    );
    expect(ungroupableItemIds(all, rows, { canEditItems: false, canUnlinkFamilies: true })).toEqual(
      [],
    );
    // Only family members ticked by someone who may not unlink: no button.
    expect(
      ungroupableItemIds([id(4)], rows, { canEditItems: true, canUnlinkFamilies: false }),
    ).toEqual([]);
  });

  it('judges a record on the grouping it is shown under', () => {
    const both = [{ id: id(7), sku: 'X', display_group_id: G, group_id: FAM }];
    const shownFamily = new Map([[id(7), 'family' as const]]);
    expect(
      ungroupableItemIds([id(7)], both, {
        canEditItems: true,
        canUnlinkFamilies: false,
        shownUnder: shownFamily,
      }),
    ).toEqual([]);
    expect(
      ungroupableItemIds([id(7)], both, { canEditItems: true, canUnlinkFamilies: false }),
    ).toEqual([id(7)]);
  });
});

describe('the Ungroup request', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    organizationId: ORG,
    actorUserId: ME,
    remove: { idempotencyKey: K1, itemIds: [id(1)], expectedGroups: { [id(1)]: G } },
    split: {
      idempotencyKey: K2,
      itemIds: [id(2)],
      expectedSkus: { [id(2)]: 'PAIR' },
      anchorItemIds: [],
    },
    unlink: { itemIds: [id(3)], expectedFamilies: { [id(3)]: FAM } },
    ...over,
  });

  it('accepts a mixed body with each step checked by its own rules', () => {
    const p = parseUngroupSelectedBody(body());
    expect(p.ok && p.body).toEqual({
      organizationId: ORG,
      actorUserId: ME,
      remove: { idempotencyKey: K1, itemIds: [id(1)], expectedGroups: { [id(1)]: G } },
      split: {
        idempotencyKey: K2,
        itemIds: [id(2)],
        expectedSkus: { [id(2)]: 'PAIR' },
        anchorItemIds: [],
      },
      unlink: { itemIds: [id(3)], expectedFamilies: { [id(3)]: FAM } },
    });
    expect(parseUngroupSelectedBody(body({ remove: null, split: null })).ok).toBe(true);
  });

  it('refuses a body with no step, a record in two steps, more than 100 records, or a stray key', () => {
    const field = (raw: unknown) => {
      const p = parseUngroupSelectedBody(raw);
      return p.ok ? null : p.refusal.field;
    };
    expect(field(body({ remove: null, split: null, unlink: null }))).toBe('body');
    expect(field(body({ unlink: { itemIds: [id(1)], expectedFamilies: { [id(1)]: FAM } } }))).toBe(
      'item_ids',
    );
    const many = Array.from({ length: 101 }, (_, i) => id(100 + i));
    expect(
      field(
        body({
          remove: null,
          split: null,
          unlink: {
            itemIds: many,
            expectedFamilies: Object.fromEntries(many.map((x) => [x, FAM])),
          },
        }),
      ),
    ).toBe('unlink');
    expect(field(body({ extra: 1 }))).toBe('body');
    expect(field(body({ unlink: { itemIds: [id(3)], expectedFamilies: {} } }))).toBe('unlink');
    expect(
      field(body({ remove: { idempotencyKey: 'x', itemIds: [id(1)], expectedGroups: {} } })),
    ).toBe('remove');
    expect(field(body({ split: { ...body().split, anchorItemIds: [id(9)] } }))).toBe('split');
    expect(field(body({ actorUserId: 'me' }))).toBe('actor_user_id');
    const p = parseUngroupSelectedBody(body({ remove: null, split: null, unlink: null }));
    expect(!p.ok && p.refusal.message).toBe(GROUPING_ERROR_WORDS.invalid);
  });

  it('a Save keeps both keys for a retry of the same plan and mints new ones when it changes', () => {
    const a = rec(1, { sku: 'PAIR' });
    const b = rec(2, { displayGroup: inG });
    const f = rec(3, { productGroupId: FAM });
    const plan = planUngroupSelected(
      [a.id, b.id, f.id],
      { records: [a, b, f], unavailableCount: 0 },
      [cand(1, 'PAIR'), cand(9, 'PAIR')],
      { canUnlinkFamilies: true },
    );
    const draft = ungroupSelectedBodyForPlan(
      plan,
      {},
      {
        organizationId: ORG,
        actorUserId: ME,
        removeKey: 'pending',
        splitKey: 'pending',
      },
    );
    expect(draft.remove).toMatchObject({ itemIds: [b.id], expectedGroups: { [b.id]: G } });
    expect(draft.split).toMatchObject({
      itemIds: [a.id],
      expectedSkus: { [a.id]: 'PAIR' },
      anchorItemIds: [],
    });
    expect(draft.unlink).toEqual({ itemIds: [f.id], expectedFamilies: { [f.id]: FAM } });
    let n = 0;
    const mint = () => `00000000-0000-4000-8000-00000000000${++n}`;
    const first = keyedUngroupSelectedBody(null, draft, mint);
    expect(first.body.remove?.idempotencyKey).not.toBe(first.body.split?.idempotencyKey);
    expect(parseUngroupSelectedBody(first.body).ok).toBe(true);
    expect(keyedUngroupSelectedBody(first, draft, mint)).toBe(first);
    const changed = keyedUngroupSelectedBody(first, { ...draft, unlink: null }, mint);
    expect(changed.body.split?.idempotencyKey).not.toBe(first.body.split?.idempotencyKey);
  });
});

describe('the Ungroup answer', () => {
  it('says what applied, what was refused and what was not tried, counting changed records', () => {
    const raw = {
      complete: false,
      parts: [
        {
          kind: 'remove',
          status: 'applied',
          changedItemIds: [id(1), id(2)],
          notChangedItemIds: [],
          message: null,
          reason: null,
          retryable: false,
        },
        {
          kind: 'split',
          status: 'refused',
          changedItemIds: [],
          notChangedItemIds: [id(3)],
          message: GROUPING_ERROR_WORDS.itemChanged,
          reason: 'item_changed',
          retryable: false,
        },
        {
          kind: 'unlink',
          status: 'not_attempted',
          changedItemIds: [],
          notChangedItemIds: [id(4), id(5)],
          message: null,
          reason: null,
          retryable: false,
        },
      ],
    };
    const o = parseUngroupSelectedOutcome(raw)!;
    expect(o.complete).toBe(false);
    expect(ungroupResultLines(o)).toEqual({
      done: [UNGROUP_COPY.leftGroups(2)],
      notDone: [
        UNGROUP_COPY.partNotDone(
          UNGROUP_COPY.partWhat('split', 1),
          GROUPING_ERROR_WORDS.itemChanged,
        ),
        UNGROUP_COPY.partNotTried(UNGROUP_COPY.partWhat('unlink', 2)),
      ],
    });
    expect(UNGROUP_COPY.leftGroups(2)).toBe('2 records left their group.');
    expect(UNGROUP_COPY.partWhat('unlink', 2)).toBe('2 records leaving their size family');
  });

  it('a step that applied in part names both halves', () => {
    const o = parseUngroupSelectedOutcome({
      complete: false,
      parts: [
        {
          kind: 'unlink',
          status: 'partial',
          changedItemIds: [id(1)],
          notChangedItemIds: [id(2)],
          message: GROUPING_ERROR_WORDS.notWritable,
          reason: 'forbidden',
          retryable: false,
        },
      ],
    })!;
    expect(ungroupResultLines(o)).toEqual({
      done: [UNGROUP_COPY.leftFamilies(1)],
      notDone: [
        UNGROUP_COPY.partNotDone(
          UNGROUP_COPY.partWhat('unlink', 1),
          GROUPING_ERROR_WORDS.notWritable,
        ),
      ],
    });
  });

  it('refuses an answer that is not one', () => {
    expect(parseUngroupSelectedOutcome(null)).toBeNull();
    expect(parseUngroupSelectedOutcome({ parts: [{ kind: 'merge' }] })).toBeNull();
    expect(
      parseUngroupSelectedOutcome({
        parts: [{ kind: 'split', status: 'applied', changedItemIds: [1], notChangedItemIds: [] }],
      }),
    ).toBeNull();
  });
});

describe('shownUnderByRecord: the header each record appears beneath', () => {
  interface Row {
    id: string;
    sku: string;
    name: string;
    dg: string | null;
    fam: string | null;
  }
  const row = (n: number, over: Partial<Row> = {}): Row => ({
    id: id(n),
    sku: `S-${n}`,
    name: `Plain ${n}`,
    dg: null,
    fam: null,
    ...over,
  });
  const compose = (rows: Row[]) =>
    composeDisplayList(rows, {
      itemIdOf: (r) => r.id,
      skuOf: (r) => r.sku,
      displayGroupOf: (r) => r.dg,
      runMetaOf: (r) => ({ name: r.name, quantity: 1, groupId: r.fam, variantSize: null }),
      expanded: { explicit: new Set(), skus: new Set(), runs: new Set() },
    });

  it('names the group, SKU and size-family headers, and nothing for a plain row or a name-only run', () => {
    const rows = [
      row(1, { dg: G }),
      row(2, { dg: G }),
      row(3, { sku: 'PAIR' }),
      row(4, { sku: 'PAIR' }),
      row(5, { fam: FAM, name: 'Tee - S' }),
      row(6, { fam: FAM, name: 'Tee - M' }),
      row(7, { name: 'Hoodie - S' }),
      row(8, { name: 'Hoodie - M' }),
      row(9),
    ];
    const m = shownUnderByRecord(compose(rows), (r) => r.id);
    expect(m.get(id(1))).toBe('group');
    expect(m.get(id(2))).toBe('group');
    expect(m.get(id(3))).toBe('sku');
    expect(m.get(id(5))).toBe('family');
    expect(m.get(id(6))).toBe('family');
    expect(m.has(id(7))).toBe(false);
    expect(m.has(id(9))).toBe(false);
  });

  it('follows the list: a family member in a group that forms here is under the group', () => {
    const rows = [
      row(1, { dg: G, fam: FAM, name: 'Tee - S' }),
      row(2, { dg: G }),
      row(3, { fam: FAM, name: 'Tee - M' }),
    ];
    const m = shownUnderByRecord(compose(rows), (r) => r.id);
    expect(m.get(id(1))).toBe('group');
    // Its family's other size stands alone here (one member left for a run).
    expect(m.has(id(3))).toBe(false);
  });
});
