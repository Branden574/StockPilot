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
    expect(GROUP_COPY.skuNote).toBe('Records that share a SKU still show together automatically.');
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
