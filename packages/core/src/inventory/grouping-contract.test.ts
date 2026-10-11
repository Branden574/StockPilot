import { describe, expect, it } from 'vitest';

import {
  GROUPING_ERROR_TABLE,
  GROUPING_ERROR_WORDS,
  GROUPING_MAX_ITEMS,
  SPLIT_SKU_SHAPE,
  UNGROUP_COPY,
  groupingErrorKey,
  mapGroupingError,
  parseSplitSkuBody,
  parseSplitSkuOutcome,
  planSkuSplit,
  sharedSkuBannerCopy,
  sharedSkuItemIds,
  sharedSkuNoteCopy,
  splitSkuBodyForPlan,
  toSplitSkuRpcRequest,
  type SplitCandidate,
} from './grouping-contract';

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const body = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: KEY,
  organizationId: ORG,
  actorUserId: ME,
  itemIds: [A],
  expectedSkus: { [A]: 'SP-PAIR' },
  ...over,
});

describe('the split_sku request body', () => {
  it('accepts the owner-case body and normalises ids to lower case', () => {
    const parsed = parseSplitSkuBody(
      body({ itemIds: [A.toUpperCase()], expectedSkus: { [A.toUpperCase()]: 'SP-PAIR' } }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.body.itemIds).toEqual([A]);
    expect(parsed.body.expectedSkus).toEqual({ [A]: 'SP-PAIR' });
    expect(parsed.body.anchorItemIds).toEqual([]);
  });

  // The SQL shape check (0399 _item_grouping_split_request) refuses exactly
  // these, naming the same field (pgTAP R8): the app refuses them first.
  it.each([
    ['empty', { itemIds: [], expectedSkus: {} }, 'item_ids'],
    [
      'too many',
      {
        itemIds: Array.from(
          { length: 101 },
          (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        ),
        expectedSkus: {},
      },
      'item_ids',
    ],
    ['a duplicate, case aside', { itemIds: [A, A.toUpperCase()] }, 'item_ids'],
    ['not a uuid', { itemIds: ['nope'], expectedSkus: { nope: 'X' } }, 'item_ids'],
    [
      'an expected SKU missing',
      { itemIds: [A, B], expectedSkus: { [A]: 'SP-PAIR' } },
      'expected_skus',
    ],
    ['a blank expected SKU', { expectedSkus: { [A]: '   ' } }, 'expected_skus'],
    [
      'an extra expected SKU',
      { expectedSkus: { [A]: 'SP-PAIR', [B]: 'SP-PAIR' } },
      'expected_skus',
    ],
    ['a numeric expected SKU', { expectedSkus: { [A]: 7 } }, 'expected_skus'],
    ['a 256-character SKU', { expectedSkus: { [A]: 'X'.repeat(256) } }, 'expected_skus'],
    ['an anchor not selected', { anchorItemIds: [B] }, 'anchor_item_ids'],
    [
      'two anchors on one SKU',
      { itemIds: [A, B], expectedSkus: { [A]: 'S', [B]: 'S' }, anchorItemIds: [A, B] },
      'anchor_item_ids',
    ],
    ['a missing key', { idempotencyKey: undefined }, 'idempotency_key'],
    ['an unknown field', { surface: 'web' }, 'body'],
  ])('refuses %s, naming the field', (_label, over, field) => {
    const parsed = parseSplitSkuBody(body(over as Record<string, unknown>));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.field).toBe(field);
    expect(parsed.refusal.message).toBe(GROUPING_ERROR_WORDS.invalid);
  });

  it('builds the snake_case request the database function reads, with the surface', () => {
    const parsed = parseSplitSkuBody(
      body({ itemIds: [B, A], expectedSkus: { [A]: 'S', [B]: 'S' }, anchorItemIds: [B] }),
    );
    if (!parsed.ok) throw new Error('refused');
    expect(toSplitSkuRpcRequest(parsed.body, 'app')).toEqual({
      p_key: KEY,
      p_request: {
        action: 'split_sku',
        organization_id: ORG,
        actor_user_id: ME,
        surface: 'app',
        item_ids: [B, A],
        expected_skus: { [A]: 'S', [B]: 'S' },
        anchor_item_ids: [B],
      },
    });
    expect(GROUPING_MAX_ITEMS).toBe(100);
  });
});

describe('the grouping error map', () => {
  it.each(Object.entries(GROUPING_ERROR_TABLE))('maps hint %s to its entry', (hint, entry) => {
    const mapped = mapGroupingError({ code: 'P0001', hint, message: 'anything' });
    expect(mapped.reason).toBe(hint);
    expect(mapped.code).toBe(entry.code);
    expect(mapped.status).toBe(entry.status);
    expect(mapped.message).toBe(entry.message);
  });

  it('pins the design 3.4 HTTP mapping', () => {
    const status = (hint: string) => mapGroupingError({ hint }).status;
    expect(status('unauthenticated')).toBe(401);
    for (const h of ['permission', 'item_not_writable', 'not_member', 'actor_mismatch'])
      expect(status(h)).toBe(403);
    expect(status('item_not_found')).toBe(404);
    for (const h of [
      'idempotency_conflict',
      'item_changed',
      'not_shared',
      'family_member_sku',
      'not_groupable',
      'sku_siblings_changed',
    ]) {
      expect(status(h)).toBe(409);
    }
    for (const h of ['grouping_invalid', 'idempotency_key_required', 'idempotency_key_invalid'])
      expect(status(h)).toBe(400);
    expect(status('busy')).toBe(503);
    expect(mapGroupingError({ code: '55P03' })).toMatchObject({
      reason: 'busy',
      status: 503,
      retryable: true,
    });
    expect(mapGroupingError({ code: '57014' })).toMatchObject({ reason: 'busy', retryable: true });
  });

  it('maps by hint, never by message text; an unknown answer is internal', () => {
    expect(groupingErrorKey({ code: 'P0001', message: 'not_shared' })).toBeNull();
    expect(mapGroupingError({ code: 'P0001', message: 'not_shared' })).toMatchObject({
      reason: 'internal_error',
      status: 500,
    });
    expect(mapGroupingError({ code: '55P03', hint: 'item_changed' }).reason).toBe('item_changed');
  });

  it('reads the item ids a refusal names, and words a kit refusal from its reason', () => {
    const mapped = mapGroupingError({
      code: 'P0001',
      hint: 'not_groupable',
      details: JSON.stringify({ reason: 'kit', itemIds: [A] }),
    });
    expect(mapped.itemIds).toEqual([A]);
    expect(mapped.message).toBe(GROUPING_ERROR_WORDS.kit);
    expect(
      mapGroupingError({ hint: 'item_not_found', details: '{"itemIds":["x"]}' }).itemIds,
    ).toEqual(['x']);
    expect(mapGroupingError({ hint: 'grouping_invalid', details: 'item_ids' }).field).toBe(
      'item_ids',
    );
  });

  it('never advises changing the charter or the rack', () => {
    for (const words of Object.values(GROUPING_ERROR_WORDS)) {
      expect(words).not.toMatch(/charter|rack/i);
    }
  });
});

describe('the outcome', () => {
  it('reads the answer the function gives', () => {
    const out = parseSplitSkuOutcome({
      action: 'split_sku',
      replay: true,
      items: [
        { id: A, before_sku: 'S', after_sku: 'SP-ABCDE-1234567', kept: false, anchor_item_id: B },
        { id: B, before_sku: 'S', after_sku: 'S', kept: true, anchor_item_id: B },
      ],
    });
    expect(out).toEqual({
      replay: true,
      items: [
        { id: A, beforeSku: 'S', afterSku: 'SP-ABCDE-1234567', kept: false, anchorItemId: B },
        { id: B, beforeSku: 'S', afterSku: 'S', kept: true, anchorItemId: B },
      ],
    });
    expect(parseSplitSkuOutcome({ items: 'nope' })).toBeNull();
    expect(SPLIT_SKU_SHAPE.test('SP-ABCDE-1234567')).toBe(true);
  });
});

describe('which selected records share a SKU (the bulk bar, from loaded rows)', () => {
  const rows = [
    { id: A, sku: 'S' },
    { id: B, sku: 'S' },
    { id: C, sku: 'ALONE' },
    { id: D, sku: '  ' },
  ];
  it('offers only records another loaded record shares a SKU with; blank SKUs never', () => {
    expect(sharedSkuItemIds([A, C, D], rows)).toEqual([A]);
    expect(sharedSkuItemIds([C], rows)).toEqual([]);
  });
  it('compares the raw SKU (case and spaces matter, as the grouping does)', () => {
    expect(
      sharedSkuItemIds(
        [A],
        [
          { id: A, sku: 'S' },
          { id: B, sku: 's' },
        ],
      ),
    ).toEqual([]);
    expect(
      sharedSkuItemIds(
        [A],
        [
          { id: A, sku: 'S' },
          { id: B, sku: 'S ' },
        ],
      ),
    ).toEqual([]);
  });
  it('counts one record once however many rack rows it has, and uses the full-set counts when known', () => {
    expect(
      sharedSkuItemIds(
        [A],
        [
          { id: A, sku: 'S' },
          { id: A, sku: 'S' },
        ],
      ),
    ).toEqual([]);
    expect(sharedSkuItemIds([A], [{ id: A, sku: 'S' }], new Map([['S', 2]]))).toEqual([A]);
  });
});

describe('planning a split for the review dialog', () => {
  const rec = (id: string, sku: string, extra: Partial<SplitCandidate> = {}): SplitCandidate => ({
    id,
    sku,
    name: 'Mouse pad',
    isBundle: false,
    inFamily: false,
    ...extra,
  });

  it('the owner case: one of two selected, it gets a new SKU and the other keeps it', () => {
    const plan = planSkuSplit([B], [rec(A, 'S'), rec(B, 'S')]);
    expect(plan.leftOut).toEqual([]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({ sku: 'S', allSelected: false, defaultAnchorId: null });
    expect(plan.groups[0]!.selected.map((r) => r.id)).toEqual([B]);
    expect(plan.groups[0]!.others.map((r) => r.id)).toEqual([A]);
    expect(plan.splitIds).toEqual([B]);
  });

  it('every record selected: the first in the server order (oldest) is the default anchor', () => {
    const plan = planSkuSplit([B, A], [rec(A, 'S'), rec(B, 'S')]);
    expect(plan.groups[0]).toMatchObject({ allSelected: true, defaultAnchorId: A });
    const sent = splitSkuBodyForPlan(
      plan,
      { [plan.groups[0]!.sku]: B },
      { idempotencyKey: KEY, organizationId: ORG, actorUserId: ME },
    );
    expect(sent.anchorItemIds).toEqual([B]);
    expect(sent.itemIds).toEqual([A, B]);
    expect(sent.expectedSkus).toEqual({ [A]: 'S', [B]: 'S' });
  });

  it('sends the default anchor when none was chosen, so the database never decides unseen', () => {
    const plan = planSkuSplit([A, B], [rec(A, 'S'), rec(B, 'S')]);
    const sent = splitSkuBodyForPlan(
      plan,
      {},
      { idempotencyKey: KEY, organizationId: ORG, actorUserId: ME },
    );
    expect(sent.anchorItemIds).toEqual([A]);
  });

  it('leaves out, with a reason, what the database would refuse', () => {
    const plan = planSkuSplit(
      [A, C, D, B],
      [
        rec(A, 'ALONE'),
        rec(B, 'KIT', { isBundle: true }),
        rec('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'KIT'),
        rec(C, 'FAM', { inFamily: true }),
        rec('ffffffff-ffff-4fff-8fff-ffffffffffff', 'FAM'),
      ],
    );
    expect(plan.leftOut).toEqual([
      { id: A, reason: 'not_shared' },
      { id: C, reason: 'family' },
      { id: D, reason: 'not_found' },
      { id: B, reason: 'kit' },
    ]);
    expect(plan.splitIds).toEqual([]);
    expect(plan.groups).toEqual([]);
  });
});

describe('the words', () => {
  it("says what Ungroup does and what it does not change, in the design's words", () => {
    expect(UNGROUP_COPY.intro).toBe(
      'Ungroup gives each selected record its own new SKU. Only the selected records change. Stock, charter, rack, barcode/ISBN and history stay as they are.',
    );
    expect(UNGROUP_COPY.offline).toMatch(/connection/i);
  });

  it('says plainly how many other records share the SKU and that editing changes them all', () => {
    // Fix round 1, P4: every field the edit fans out is named (the variant
    // details and the product family too, SHARED_ITEM_FIELDS).
    expect(sharedSkuBannerCopy(1)).toBe(
      'This SKU is also used by 1 other record you can see. Saving the name, SKU, cost, price, description, category, barcode, reorder levels, item type, size and other variant details, or product family changes every record with this SKU. To change only this record, use Make this its own item on the item page.',
    );
    expect(sharedSkuBannerCopy(3)).toMatch(
      /^This SKU is also used by 3 other records you can see\./,
    );
    expect(sharedSkuBannerCopy(0)).toBeNull();
  });

  // Fix round 1, P4: a kit or a family member cannot be made its own item, so
  // the banner says why its SKU stays instead of pointing to the action.
  it('tells a kit or a product-family member why its SKU stays, instead of pointing to Make this its own item', () => {
    const kit = sharedSkuBannerCopy(1, 'kit')!;
    expect(kit.endsWith(GROUPING_ERROR_WORDS.kit)).toBe(true);
    expect(kit).not.toContain(UNGROUP_COPY.makeOwnItem);
    const family = sharedSkuBannerCopy(2, 'family')!;
    expect(family.endsWith(GROUPING_ERROR_WORDS.family)).toBe(true);
    expect(family).not.toContain(UNGROUP_COPY.makeOwnItem);
    expect(sharedSkuBannerCopy(0, 'kit')).toBeNull();
  });

  it("the item screens' note names the shared fields the edit form names", () => {
    expect(sharedSkuNoteCopy(1, 'SP-PAIR')).toBe(
      'SKU SP-PAIR is also used by 1 other record you can see. Editing the name, SKU, cost, price, description, category, barcode, reorder levels, item type or size changes all of them.',
    );
    expect(sharedSkuNoteCopy(0, 'SP-PAIR')).toBeNull();
  });
});
