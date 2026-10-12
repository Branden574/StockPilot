import { describe, expect, it } from 'vitest';

import {
  GROUP_COPY,
  GROUPING_ERROR_TABLE,
  GROUPING_ERROR_WORDS,
  bookEditionCount,
  groupBodyForPlan,
  groupingPreviewKey,
  groupingSelectionFacts,
  mapGroupingError,
  parseGroupingBody,
  parseGroupingOutcome,
  parseGroupingPreview,
  planGrouping,
  planRemoval,
  removeBodyFor,
  suggestGroupName,
  toGroupingRpcRequest,
  type GroupingPreview,
} from './grouping-contract';

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const G = '99999999-9999-4999-8999-999999999999';
const H = '88888888-8888-4888-8888-888888888888';

const ids = { idempotencyKey: KEY, organizationId: ORG, actorUserId: ME };

describe('the group/remove/rename request body', () => {
  const group = (over: Record<string, unknown> = {}) => ({
    action: 'group',
    ...ids,
    itemIds: [A, B],
    target: { kind: 'new', name: 'Polo XXXL' },
    expectedGroups: { [A]: null, [B]: null },
    ...over,
  });

  it('accepts a new group and lower-cases ids, trims the name, defaults the decisions', () => {
    const p = parseGroupingBody(
      group({
        itemIds: [A.toUpperCase(), B],
        expectedGroups: { [A.toUpperCase()]: null, [B]: null },
        target: { kind: 'new', name: '  Polo XXXL ' },
      }),
    );
    expect(p.ok && p.body).toEqual({
      action: 'group',
      ...ids,
      itemIds: [A, B],
      target: { kind: 'new', name: 'Polo XXXL' },
      expectedGroups: { [A]: null, [B]: null },
      moveItemIds: [],
      acknowledgeProductFamily: false,
    });
  });

  it('refuses what the database refuses, naming the same field', () => {
    const field = (raw: unknown) => {
      const p = parseGroupingBody(raw);
      return p.ok ? 'ok' : p.refusal.field;
    };
    expect(field(group({ action: 'split_sku' }))).toBe('action');
    expect(field(group({ itemIds: [A, A] }))).toBe('item_ids'); // two rack rows of one record: send it once
    expect(field(group({ itemIds: [A], expectedGroups: { [A]: null } }))).toBe('item_ids'); // a new group needs two
    expect(
      field(
        group({
          itemIds: Array.from(
            { length: 101 },
            (_, i) => `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
          ),
        }),
      ),
    ).toBe('item_ids');
    expect(field(group({ target: { kind: 'new', name: '   ' } }))).toBe('name');
    expect(field(group({ target: { kind: 'new', name: 'x'.repeat(121) } }))).toBe('name');
    expect(field(group({ target: { kind: 'old' } }))).toBe('target');
    expect(field(group({ target: { kind: 'existing', groupId: G, expectedVersion: 0 } }))).toBe(
      'expected_version',
    );
    expect(field(group({ target: { kind: 'existing', groupId: G, expectedVersion: '1' } }))).toBe(
      'expected_version',
    );
    expect(field(group({ expectedGroups: { [A]: null } }))).toBe('expected_groups');
    expect(field(group({ expectedGroups: { [A]: 'nope', [B]: null } }))).toBe('expected_groups');
    expect(field(group({ moveItemIds: [C] }))).toBe('move_item_ids');
    expect(field(group({ acknowledgeProductFamily: 'yes' }))).toBe('acknowledge_product_family');
    expect(field(group({ extra: 1 }))).toBe('body');
    expect(field({ action: 'remove', ...ids, itemIds: [A], expectedGroups: { [A]: null } })).toBe(
      'expected_groups',
    );
    expect(field({ action: 'rename', ...ids, groupId: G, expectedVersion: 1, name: '' })).toBe(
      'name',
    );
    expect(
      field({ action: 'rename', ...ids, groupId: 'nope', expectedVersion: 1, name: 'X' }),
    ).toBe('group_id');
    expect(field(group({ idempotencyKey: 'nope' }))).toBe('idempotency_key');
  });

  it('builds the snake_case request apply_item_grouping reads', () => {
    const p = parseGroupingBody(
      group({
        target: { kind: 'existing', groupId: G, expectedVersion: 3 },
        moveItemIds: [B],
        expectedGroups: { [A]: null, [B]: H },
        acknowledgeProductFamily: true,
      }),
    );
    if (!p.ok) throw new Error('parse');
    expect(toGroupingRpcRequest(p.body, 'app')).toEqual({
      p_key: KEY,
      p_request: {
        action: 'group',
        organization_id: ORG,
        actor_user_id: ME,
        surface: 'app',
        item_ids: [A, B],
        target: { kind: 'existing', group_id: G, expected_version: 3 },
        expected_groups: { [A]: null, [B]: H },
        move_item_ids: [B],
        acknowledge_product_family: true,
      },
    });
    const r = parseGroupingBody({
      action: 'rename',
      ...ids,
      groupId: G,
      expectedVersion: 2,
      name: ' New ',
    });
    if (!r.ok) throw new Error('parse');
    expect(toGroupingRpcRequest(r.body, 'web').p_request).toEqual({
      action: 'rename',
      organization_id: ORG,
      actor_user_id: ME,
      surface: 'web',
      group_id: G,
      expected_version: 2,
      name: 'New',
    });
  });
});

describe('refusals for grouping (by hint, in words that never suggest a charter or rack change)', () => {
  it('maps every 0400 hint to its status and words', () => {
    const m = (hint: string, details?: string) =>
      mapGroupingError({ code: 'P0001', hint, message: 'x', details: details ?? null }, 'group');
    expect(m('group_not_found')).toMatchObject({
      status: 404,
      code: 'not_found',
      message: GROUPING_ERROR_WORDS.groupNotFound,
    });
    expect(m('group_changed')).toMatchObject({
      status: 409,
      message: GROUPING_ERROR_WORDS.groupChanged,
    });
    expect(m('membership_changed', JSON.stringify({ itemIds: [A] }))).toMatchObject({
      status: 409,
      itemIds: [A],
    });
    expect(m('membership_conflict')).toMatchObject({
      status: 409,
      message: GROUPING_ERROR_WORDS.membershipConflict,
    });
    expect(m('product_family_conflict')).toMatchObject({
      status: 409,
      message: GROUPING_ERROR_WORDS.familyConflict,
    });
    expect(m('mixed_item_types')).toMatchObject({
      status: 409,
      message: GROUPING_ERROR_WORDS.mixedTypes,
    });
    expect(m('group_too_large')).toMatchObject({
      status: 409,
      message: GROUPING_ERROR_WORDS.groupTooLarge,
    });
    expect(m('rename_not_permitted')).toMatchObject({
      status: 403,
      code: 'forbidden',
      message: GROUPING_ERROR_WORDS.renameNotPermitted,
    });
    expect(m('not_groupable', JSON.stringify({ reason: 'kit', itemIds: [A] })).message).toBe(
      GROUPING_ERROR_WORDS.groupKit,
    );
    expect(m('not_groupable', JSON.stringify({ reason: 'rental', itemIds: [A] })).message).toBe(
      GROUPING_ERROR_WORDS.groupRental,
    );
    expect(m('item_changed').message).toBe(GROUPING_ERROR_WORDS.groupItemChanged);
    // Ungroup keeps its own words.
    expect(
      mapGroupingError({ hint: 'not_groupable', details: JSON.stringify({ reason: 'kit' }) })
        .message,
    ).toBe(GROUPING_ERROR_WORDS.kit);
    expect(mapGroupingError({ hint: 'item_changed' }).message).toBe(
      GROUPING_ERROR_WORDS.itemChanged,
    );
  });

  it('no refusal word tells anyone to change a charter or a rack', () => {
    for (const entry of Object.values(GROUPING_ERROR_TABLE)) {
      expect(entry.message.toLowerCase()).not.toMatch(/change (the )?(charter|rack)/);
    }
    for (const w of Object.values(GROUPING_ERROR_WORDS)) {
      expect(w.toLowerCase()).not.toMatch(/change (the )?(charter|rack)/);
    }
  });
});

describe('the answer', () => {
  it('reads applied, no-op and replay answers', () => {
    expect(
      parseGroupingOutcome({
        action: 'group',
        outcome: 'applied',
        group: { id: G, name: 'Polo', version: 1, item_type: 'product', closed: false },
        changes: [{ item_id: A, from_group_id: null, to_group_id: G }],
        created: true,
        replay: false,
      }),
    ).toEqual({
      action: 'group',
      outcome: 'applied',
      replay: false,
      created: true,
      group: { id: G, name: 'Polo', version: 1, itemType: 'product', closed: false },
      changes: [{ itemId: A, fromGroupId: null, toGroupId: G }],
    });
    expect(
      parseGroupingOutcome({
        action: 'remove',
        outcome: 'noop',
        group: null,
        changes: [],
        created: false,
        replay: true,
      }),
    ).toMatchObject({
      outcome: 'noop',
      replay: true,
      group: null,
    });
    expect(parseGroupingOutcome({ items: [] })).toBeNull();
  });

  it('carries no closed group ids (security review SEC-2): which groups closed depends on records the caller may not see', () => {
    // apply_item_grouping no longer answers closed_group_ids: whether a group
    // closed tells a member whether hidden records were left in it. The
    // audit rows keep group_closed for those who may read the log.
    const o = parseGroupingOutcome({
      action: 'remove',
      outcome: 'applied',
      group: null,
      changes: [{ item_id: A, from_group_id: G, to_group_id: null }],
      created: false,
      replay: false,
    });
    expect(o).not.toBeNull();
    expect(Object.keys(o!).sort()).toEqual([
      'action',
      'changes',
      'created',
      'group',
      'outcome',
      'replay',
    ]);
    // An answer that still carries the field (an older stored outcome) reads
    // the same, without it.
    expect(
      parseGroupingOutcome({
        action: 'remove',
        outcome: 'applied',
        group: null,
        changes: [],
        closed_group_ids: [H],
        created: false,
        replay: true,
      }),
    ).not.toHaveProperty('closedGroupIds');
  });
});

const record = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'Polo XXXL',
  sku: `SKU-${id.slice(0, 4)}`,
  barcode: null,
  isbn_fields: { isbn: null, isbn13: null, isbn10: null },
  item_type: 'product',
  is_bundle: false,
  is_rental: false,
  product_group_id: null,
  product_group_name: null,
  variant_size: null,
  charter_id: null,
  warehouse_id: 'wh',
  bin_location: '15-A',
  quantity_on_hand: 2,
  created_at: '2026-01-01T00:00:00Z',
  display_group: null,
  writable: true,
  ...over,
});

const preview = (records: unknown[], over: Record<string, unknown> = {}): GroupingPreview => {
  const p = parseGroupingPreview({
    records,
    unavailable_count: 0,
    same_sku_siblings: [],
    candidate_groups: [],
    target_group: null,
    ...over,
  });
  if (!p) throw new Error('preview');
  return p;
};

describe('the review plan', () => {
  it('a plain new group of two records can be saved; Cancel needs nothing', () => {
    const plan = planGrouping(
      [A, B],
      preview([record(A), record(B)]),
      { kind: 'new', name: 'Polo XXXL' },
      {},
    );
    expect(plan.send.map((r) => r.id)).toEqual([A, B]);
    expect(plan.canSave).toBe(true);
    expect(plan.noop).toBeNull();
    const body = groupBodyForPlan(plan, { kind: 'new', name: 'Polo XXXL' }, {}, ids);
    expect(body).toEqual({
      action: 'group',
      ...ids,
      itemIds: [A, B],
      target: { kind: 'new', name: 'Polo XXXL' },
      expectedGroups: { [A]: null, [B]: null },
      moveItemIds: [],
      acknowledgeProductFamily: false,
    });
    expect(parseGroupingBody(body).ok).toBe(true);
  });

  it('a record in another group blocks Save until that record is explicitly moved', () => {
    const recs = [record(A, { display_group: { id: H, name: 'Old', version: 4 } }), record(B)];
    const blocked = planGrouping([A, B], preview(recs), { kind: 'new', name: 'New' }, {});
    expect(blocked.conflicts.otherGroup.map((r) => r.id)).toEqual([A]);
    expect(blocked.canSave).toBe(false);
    expect(blocked.blockedReason).toBe(GROUP_COPY.blocked.otherGroup);
    const moved = planGrouping(
      [A, B],
      preview(recs),
      { kind: 'new', name: 'New' },
      { moveIds: new Set([A]) },
    );
    expect(moved.canSave).toBe(true);
    const body = groupBodyForPlan(
      moved,
      { kind: 'new', name: 'New' },
      { moveIds: new Set([A]) },
      ids,
    );
    expect(body.moveItemIds).toEqual([A]);
    expect(body.expectedGroups).toEqual({ [A]: H, [B]: null });
  });

  it('a product-family member needs the acknowledgement; its family is never changed', () => {
    const recs = [
      record(A, { product_group_id: 'fam', product_group_name: 'Limits Tee', variant_size: 'XS' }),
      record(B),
    ];
    const plan = planGrouping([A, B], preview(recs), { kind: 'new', name: 'Tees' }, {});
    expect(plan.conflicts.family.map((r) => r.id)).toEqual([A]);
    expect(plan.canSave).toBe(false);
    const ok = planGrouping(
      [A, B],
      preview(recs),
      { kind: 'new', name: 'Tees' },
      { acknowledgeFamily: true },
    );
    expect(ok.canSave).toBe(true);
    expect(
      groupBodyForPlan(ok, { kind: 'new', name: 'Tees' }, { acknowledgeFamily: true }, ids)
        .acknowledgeProductFamily,
    ).toBe(true);
  });

  it('kits, rentals and records the caller cannot edit are left out with a reason; mixed types block', () => {
    const recs = [
      record(A, { is_bundle: true }),
      record(B, { is_rental: true }),
      record(C, { writable: false }),
    ];
    const plan = planGrouping(
      [A, B, C],
      preview(recs, { unavailable_count: 1 }),
      { kind: 'new', name: 'X' },
      {},
    );
    expect(plan.leftOut).toEqual([
      { id: A, reason: 'kit' },
      { id: B, reason: 'rental' },
      { id: C, reason: 'not_writable' },
    ]);
    expect(plan.unavailableCount).toBe(1);
    expect(plan.canSave).toBe(false);
    const mixed = planGrouping(
      [A, B],
      preview([record(A), record(B, { item_type: 'book' })]),
      { kind: 'new', name: 'X' },
      {},
    );
    expect(mixed.canSave).toBe(false);
    expect(mixed.blockedReason).toBe(GROUPING_ERROR_WORDS.mixedTypes);
  });

  it('a repeat of a completed grouping is a no-op the dialog says, not a second group', () => {
    const recs = [
      record(A, { display_group: { id: G, name: 'Polo', version: 1 } }),
      record(B, { display_group: { id: G, name: 'Polo', version: 1 } }),
    ];
    const plan = planGrouping([A, B], preview(recs), { kind: 'new', name: 'Polo' }, {});
    expect(plan.noop).toEqual({ groupId: G, name: 'Polo' });
    const existing = planGrouping([A, B], preview(recs), { kind: 'existing', groupId: G }, {});
    expect(existing.noop).toEqual({ groupId: G, name: 'Polo' });
  });

  it('adding to an existing group sends its version and needs only one record', () => {
    const p = preview([record(A)], {
      target_group: {
        id: G,
        name: 'Polo',
        version: 5,
        item_type: 'product',
        members: [{ id: B, name: 'Polo', sku: 'S', quantity_on_hand: 3 }],
      },
    });
    const plan = planGrouping([A], p, { kind: 'existing', groupId: G }, {});
    expect(plan.canSave).toBe(true);
    const body = groupBodyForPlan(plan, { kind: 'existing', groupId: G }, {}, ids);
    expect(body.target).toEqual({ kind: 'existing', groupId: G, expectedVersion: 5 });
    expect(plan.previewHeader).toBe(GROUP_COPY.previewHeader('Polo', 2, 5));
  });

  // People review P1: Add to group (a Same SKU chip) reviews [record] with
  // the target G, and the preview's same-SKU siblings include G's own
  // records: they are already in the group, so they never "stay outside
  // this group", and are never offered as "Add them to the selection".
  it('same-SKU records already in the target are not siblings that stay outside it (P1)', () => {
    const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const p = preview([record(D, { sku: 'X' })], {
      same_sku_siblings: [
        { id: A, name: 'Limits Tee', sku: 'X', item_type: 'product', display_group_id: G },
        { id: B, name: 'Limits Tee', sku: 'X', item_type: 'product', display_group_id: G },
        { id: E, name: 'Limits Tee', sku: 'X', item_type: 'product', display_group_id: null },
      ],
      target_group: {
        id: G,
        name: 'Limits Tee',
        version: 2,
        item_type: 'product',
        members: [
          { id: A, name: 'Limits Tee', sku: 'X', quantity_on_hand: 4 },
          { id: B, name: 'Limits Tee', sku: 'X', quantity_on_hand: 5 },
        ],
      },
    });
    const plan = planGrouping([D], p, { kind: 'existing', groupId: G }, {});
    expect(plan.conflicts.sameSkuSiblings.map((s) => s.id)).toEqual([E]);
    // A new group: every unselected same-SKU record stays outside it, those
    // in another group (G) included.
    const fresh = planGrouping([D], p, { kind: 'new', name: 'Tees' }, {});
    expect(fresh.conflicts.sameSkuSiblings.map((s) => s.id)).toEqual([A, B, E]);
    // A selected record is never its own sibling, even on an answer read for
    // a smaller selection.
    const more = planGrouping([D, E], p, { kind: 'new', name: 'Tees' }, {});
    expect(more.conflicts.sameSkuSiblings.map((s) => s.id)).toEqual([A, B]);
  });

  // P6 and P8: Save counts the records that JOIN, a selected record already
  // in the target says so, and the target's other records are listed.
  it('counts only the records that join an existing group, marks those already in it, and lists its other records (P6, P8)', () => {
    const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const p = preview(
      [record(A, { display_group: { id: G, name: 'Tees', version: 3 } }), record(D)],
      {
        target_group: {
          id: G,
          name: 'Tees',
          version: 3,
          item_type: 'product',
          members: [
            { id: A, name: 'Tee S', sku: 'T-S', quantity_on_hand: 2 },
            { id: B, name: 'Tee M', sku: 'T-M', quantity_on_hand: 2 },
            { id: C, name: 'Tee L', sku: 'T-L', quantity_on_hand: 3 },
          ],
        },
      },
    );
    const plan = planGrouping([A, D], p, { kind: 'existing', groupId: G }, {});
    expect(plan.send.map((r) => r.id)).toEqual([A, D]);
    // (?. so a plan without these fields fails on the values, not on a throw)
    expect(plan.joining?.map((r) => r.id)).toEqual([D]);
    expect(plan.alreadyInTarget?.map((r) => r.id)).toEqual([A]);
    expect(plan.targetMembers?.map((m) => m.id)).toEqual([B, C]);
    expect(GROUP_COPY.confirmExisting(plan.joining?.length ?? -1, 'Tees')).toBe(
      'Add 1 record to Tees',
    );
    expect(plan.previewHeader).toBe(GROUP_COPY.previewHeader('Tees', 4, 9));
    // A new group: nothing is "already in" it, every sent record joins.
    const fresh = planGrouping([A, D], p, { kind: 'new', name: 'X' }, { moveIds: new Set([A]) });
    expect(fresh.joining.map((r) => r.id)).toEqual([A, D]);
    expect(fresh.alreadyInTarget).toEqual([]);
    expect(fresh.targetMembers).toEqual([]);
  });

  // P10: the words promise "move it, or leave it out"; leaving it out is a
  // choice in the review, not a trip back to the list.
  it('a record in another group can be left out instead of moved: it is not sent and stays where it is (P10)', () => {
    const recs = [
      record(A, { display_group: { id: H, name: 'Old', version: 4 } }),
      record(B),
      record(C),
    ];
    const blocked = planGrouping([A, B, C], preview(recs), { kind: 'new', name: 'New' }, {});
    expect(blocked.blockedReason).toBe(
      'Decide for each record already in another group: move it, or leave it out.',
    );
    const left = planGrouping(
      [A, B, C],
      preview(recs),
      { kind: 'new', name: 'New' },
      { leaveOutIds: new Set([A]) },
    );
    expect(left.send.map((r) => r.id)).toEqual([B, C]);
    expect(left.leftOut).toEqual([{ id: A, reason: 'chosen' }]);
    expect(left.conflicts.otherGroup).toEqual([]);
    expect(left.canSave).toBe(true);
    const body = groupBodyForPlan(
      left,
      { kind: 'new', name: 'New' },
      { leaveOutIds: new Set([A]) },
      ids,
    );
    expect(body.itemIds).toEqual([B, C]);
    expect(body.moveItemIds).toEqual([]);
    expect(body.expectedGroups).toEqual({ [B]: null, [C]: null });
    // Leaving out a record that is in no other group changes nothing.
    const plain = planGrouping(
      [B, C],
      preview(recs),
      { kind: 'new', name: 'New' },
      { leaveOutIds: new Set([B]) },
    );
    expect(plain.send.map((r) => r.id)).toEqual([B, C]);
  });

  it('the preview header sums on hand once per record', () => {
    const plan = planGrouping(
      [A, B],
      preview([record(A, { quantity_on_hand: 3 }), record(B, { quantity_on_hand: 4 })]),
      { kind: 'new', name: 'Polo' },
      {},
    );
    expect(plan.previewHeader).toBe('Polo · 2 records · 7 on hand');
  });
});

describe('remove', () => {
  // People review P9: Remove from group dropped records silently and never
  // said the group closes; the plan now says which records leave, which are
  // left out and why, and what stays in each group (as far as the person
  // can see: a hidden record is never counted or named).
  it('plans a removal: what leaves, what is left out and why, and what stays in each group (P9)', () => {
    const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const p = preview(
      [
        record(A, { display_group: { id: G, name: 'Pads', version: 2 } }),
        record(B, { display_group: { id: G, name: 'Pads', version: 2 } }),
        record(C, { display_group: { id: H, name: 'Desks', version: 1 }, writable: false }),
        record(D),
      ],
      {
        unavailable_count: 1,
        candidate_groups: [
          {
            id: G,
            name: 'Pads',
            version: 2,
            item_type: 'product',
            member_count: 2,
            holds_selected: true,
          },
          {
            id: H,
            name: 'Desks',
            version: 1,
            item_type: 'product',
            member_count: 5,
            holds_selected: true,
          },
        ],
      },
    );
    const plan = planRemoval([A, B, C, D], p);
    expect(plan.remove.map((r) => r.id)).toEqual([A, B]);
    expect(plan.leftOut).toEqual([
      { id: C, reason: 'not_writable' },
      { id: D, reason: 'not_in_group' },
    ]);
    expect(plan.unavailableCount).toBe(1);
    // Pads loses both records the person can see: it closes (unless a
    // record hidden from them is in it, which the words allow for).
    expect(plan.groups).toEqual([{ id: G, name: 'Pads', removing: 2, staying: 0 }]);
    expect(GROUP_COPY.removeLast('Pads')).toBe(
      'This removes the last records in Pads that you can see. A group with no records left closes.',
    );
    // One of three readable records leaves: two stay, and the dialog says so.
    const some = planRemoval(
      [A],
      preview([record(A, { display_group: { id: G, name: 'Pads', version: 2 } })], {
        candidate_groups: [
          {
            id: G,
            name: 'Pads',
            version: 2,
            item_type: 'product',
            member_count: 3,
            holds_selected: true,
          },
        ],
      }),
    );
    expect(some.groups).toEqual([{ id: G, name: 'Pads', removing: 1, staying: 2 }]);
    expect(GROUP_COPY.removeStays(2, 'Pads')).toBe('2 other records you can see stay in Pads.');
    // A group the preview did not count says nothing about what stays.
    const unknown = planRemoval(
      [A],
      preview([record(A, { display_group: { id: G, name: 'Pads', version: 2 } })]),
    );
    expect(unknown.groups).toEqual([{ id: G, name: 'Pads', removing: 1, staying: null }]);
  });

  it('names the group each record is in, as the screen saw it', () => {
    const body = removeBodyFor(
      [
        { id: A, displayGroupId: G },
        { id: B, displayGroupId: G },
      ],
      ids,
    );
    expect(body).toEqual({
      action: 'remove',
      ...ids,
      itemIds: [A, B],
      expectedGroups: { [A]: G, [B]: G },
    });
    expect(parseGroupingBody(body).ok).toBe(true);
  });
});

describe('suggestions (a suggestion only: never a link on a name)', () => {
  it('Items: the shared base name without the size', () => {
    expect(
      suggestGroupName([{ name: 'Limits Tee - XS' }, { name: 'Limits Tee - S' }], 'items'),
    ).toBe('Limits Tee');
    expect(suggestGroupName([{ name: 'Polo XXXL' }, { name: 'Polo XXXL' }], 'items')).toBe(
      'Polo XXXL',
    );
  });
  it('Books: the shared title, no size parsing, no edition claim', () => {
    expect(
      suggestGroupName([{ name: 'Earth Science - S' }, { name: 'Earth Science - S' }], 'books'),
    ).toBe('Earth Science - S');
    expect(
      suggestGroupName(
        [{ name: 'Earth Science Grade 6' }, { name: 'Earth Science Grade 7' }],
        'books',
      ),
    ).toBe('Earth Science Grade');
  });
  it('falls back when nothing is shared', () => {
    expect(suggestGroupName([{ name: 'Cap' }, { name: 'Desk' }], 'items')).toBe('Cap');
    expect(suggestGroupName([], 'items')).toBe(GROUP_COPY.defaultName);
  });
});

describe('book editions', () => {
  it('equal titles are not one edition: counts distinct ISBNs (10 and 13 forms are one edition)', () => {
    expect(
      bookEditionCount([
        { barcode: '9780306406157', isbnFields: null },
        { barcode: '0306406152', isbnFields: null },
      ]),
    ).toEqual({ editions: 1, unknown: 0 });
    expect(
      bookEditionCount([
        { barcode: '9780306406157', isbnFields: null },
        { barcode: null, isbnFields: { isbn13: '9781861972712' } },
        { barcode: null, isbnFields: null },
      ]),
    ).toEqual({ editions: 2, unknown: 1 });
  });
});

describe('the bulk bar facts (from loaded rows only)', () => {
  // People review P3: a selection kept across pages (or after a search was
  // cleared) holds ids no loaded row describes; they are of the view's type,
  // never "product" on Books.
  it("types a selected record that is not loaded as the view's own type (P3)", () => {
    const rows = [{ id: C, item_type: 'book', display_group_id: null }];
    expect(groupingSelectionFacts([A, B, C], rows, 'book')).toEqual({
      count: 3,
      mixedTypes: false,
      canGroup: true,
      groupedIds: [],
    });
    // Items keeps its default.
    expect(groupingSelectionFacts([A, B, C], [{ id: C, item_type: 'product' }]).canGroup).toBe(
      true,
    );
  });

  it('counts distinct records, refuses mixed types, and lists the grouped ones', () => {
    const rows = [
      { id: A, item_type: 'product', display_group_id: G },
      { id: A, item_type: 'product', display_group_id: G },
      { id: B, item_type: 'product', display_group_id: null },
    ];
    expect(groupingSelectionFacts([A, B], rows)).toEqual({
      count: 2,
      mixedTypes: false,
      canGroup: true,
      groupedIds: [A],
    });
    expect(groupingSelectionFacts([A], rows).canGroup).toBe(false);
    expect(
      groupingSelectionFacts(
        [A, B],
        [
          { id: A, item_type: 'product' },
          { id: B, item_type: 'book' },
        ],
      ),
    ).toMatchObject({ mixedTypes: true, canGroup: false });
  });
});

describe('the words', () => {
  it("says the brief's sentence verbatim", () => {
    expect(GROUP_COPY.intro).toBe(
      'Grouping organizes these records together. It does not combine stock, change ownership, or move items.',
    );
    expect(GROUP_COPY.bulkAction).toBe('Group selected');
  });

  // People review P2: say where automatic same-SKU grouping still applies
  // (display-units.test.ts pins the behaviour these words describe).
  it('says where automatic same-SKU grouping still applies (P2)', () => {
    expect(GROUP_COPY.skuNote).toBe(
      'Records in a group show under its header. Records in no group that share a SKU still show together automatically, and one that shares a SKU with records in a group is marked Same SKU as records in that group, with Add to group.',
    );
    expect(GROUP_COPY.removeIntro).toBe(
      "Removing records from a group doesn't delete them or change their SKU, stock, charter or rack. Out of the group, a record shows together automatically with records in no group that share its SKU.",
    );
    expect(GROUP_COPY.skuNote).not.toMatch(/^Records that share a SKU still show together/);
  });

  // People review P5: one rule on both platforms: "N matching" whenever a
  // search, a filter or a stock view narrows the list.
  it('counts a header as matching whenever the list is narrowed (P5)', () => {
    expect(GROUP_COPY.headerCount(3, false)).toBe('3 records');
    expect(GROUP_COPY.headerCount(1, false)).toBe('1 record');
    expect(GROUP_COPY.headerCount(2, true)).toBe('2 matching');
  });

  // People review P7: the phone's select bar says "Group" (it fits at large
  // Dynamic Type); the words name it as the phone shows it.
  it("names the phone's select-bar control as it reads (P7)", () => {
    expect(GROUP_COPY.bulkActionShort).toBe('Group');
  });
});

describe('what a review answer is for', () => {
  it('keys on the organization, the distinct sorted ids and the target, so a stale answer is recognized', () => {
    expect(groupingPreviewKey(ORG, [B, A, A], null)).toBe(groupingPreviewKey(ORG, [A, B], null));
    expect(groupingPreviewKey(ORG, [A, B], G)).not.toBe(groupingPreviewKey(ORG, [A, B], null));
    expect(groupingPreviewKey(ORG, [A.toUpperCase()], null)).toBe(
      groupingPreviewKey(ORG, [A], null),
    );
  });
  it("the preview carries a record's stored rack keys for the rack line", () => {
    const p = parseGroupingPreview({
      records: [record(A, { custom_fields: { book_rack: '37', book_rack_section: 'B' } })],
    });
    expect(p?.records[0]?.customFields).toEqual({ book_rack: '37', book_rack_section: 'B' });
    expect(parseGroupingPreview({ records: [record(B)] })?.records[0]?.customFields).toBeNull();
  });
});
