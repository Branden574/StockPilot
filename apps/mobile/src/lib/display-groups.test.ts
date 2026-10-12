import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUP_COPY, GROUPING_ERROR_WORDS, groupingPreviewKey } from '@stockpilot/core';

import { CONNECTION_FAILURE_COPY } from './connection-copy';
// vi.mock below is hoisted above every import by vitest.
import {
  ADD_TO_GROUP_ACTION,
  attachDisplayGroups,
  describeGroupingError,
  listIsNarrowed,
  groupSelectedHref,
  keyedGroupingBody,
  notifyDisplayGroupsChanged,
  onDisplayGroupsChanged,
  phoneGroupingCheck,
  postGrouping,
  previewGrouping,
  readDisplayGroups,
  readGroupSelectedParams,
  readItemDisplayGroup,
  reviewAnnouncement,
  reviewIdsForRetry,
  reviewRecordDetail,
  groupRowAccessibilityActions,
  runGroupRowAccessibilityAction,
  type PhoneGroupingRecord,
} from './display-groups';

const { api, FakeApiError } = vi.hoisted(() => ({
  api: vi.fn(),
  FakeApiError: class FakeApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public code?: string,
      public details?: unknown,
    ) {
      super(message);
    }
  },
}));
vi.mock('./api', () => ({
  api: (...a: unknown[]) => api(...a),
  ApiError: FakeApiError,
}));

/**
 * Group selected on the phone (migration 0400): ONLINE ONLY (never queued),
 * over POST /api/v1/items/grouping/preview and POST /api/v1/items/grouping,
 * the web's own service. The lists read memberships next to their rows,
 * under the member's own RLS. The words come from core.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const G = '99999999-9999-4999-8999-999999999999';
const KEY = '33333333-3333-4333-8333-333333333333';

beforeEach(() => api.mockReset());

describe('readDisplayGroups (the lists)', () => {
  /** A recording fake of the query builder; `pages` answers each range. */
  function fake(pages: { data: unknown[] | null; error: { message: string } | null }[]) {
    const calls: [string, unknown][] = [];
    let page = 0;
    const builder = {
      select: (c: string) => (calls.push(['select', c]), builder),
      eq: (c: string, v: unknown) => (calls.push(['eq', [c, v]]), builder),
      order: (c: string, o: unknown) => (calls.push(['order', [c, o]]), builder),
      range: (from: number, to: number) => {
        calls.push(['range', [from, to]]);
        return Promise.resolve(pages[page++] ?? { data: [], error: null });
      },
      limit: (n: number) => {
        calls.push(['limit', n]);
        return Promise.resolve(pages[page++] ?? { data: [], error: null });
      },
    };
    const client = { from: (t: string) => (calls.push(['from', t]), builder) };
    return { client, calls };
  }

  it("reads the organization's memberships with each group's name, as the member (RLS), naming the one key", async () => {
    const { client, calls } = fake([
      {
        data: [
          { item_id: A, group_id: G, item_display_groups: { id: G, name: 'Polos', version: 2 } },
        ],
        error: null,
      },
    ]);
    const map = await readDisplayGroups(client as never, ORG);
    expect(map.get(A)).toEqual({ id: G, name: 'Polos', version: 2 });
    expect(calls).toContainEqual(['from', 'item_display_group_members']);
    expect(calls).toContainEqual(['eq', ['organization_id', ORG]]);
    // A stable order, so a membership is on exactly one page.
    expect(calls).toContainEqual(['order', ['item_id', { ascending: true }]]);
    expect(String(calls.find((c) => c[0] === 'select')![1])).toContain(
      'item_display_groups!item_display_group_members_group_fk(id, name, version)',
    );
  });

  it('pages past the 1000-row cap, so a large organization is never cut short', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({
      item_id: `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      group_id: G,
      item_display_groups: { id: G, name: 'Big', version: 1 },
    }));
    const { client, calls } = fake([
      { data: full, error: null },
      { data: [{ item_id: B, group_id: G, item_display_groups: null }], error: null },
    ]);
    const map = await readDisplayGroups(client as never, ORG);
    expect(map.size).toBe(1001);
    expect(calls.filter((c) => c[0] === 'range')).toEqual([
      ['range', [0, 999]],
      ['range', [1000, 1999]],
    ]);
    // A group whose name could not be read keeps its id (the header says "Group").
    expect(map.get(B)).toEqual({ id: G, name: null, version: null });
  });

  it('a failed read groups nothing (rows render as before), never fails the list', async () => {
    const { client } = fake([{ data: null, error: { message: 'boom' } }]);
    const map = await readDisplayGroups(client as never, ORG);
    expect(map.size).toBe(0);
  });

  it("the item screen reads its own record's group, or null", async () => {
    const hit = fake([
      {
        data: [
          { item_id: A, group_id: G, item_display_groups: { id: G, name: 'Polos', version: 3 } },
        ],
        error: null,
      },
    ]);
    expect(await readItemDisplayGroup(hit.client as never, ORG, A)).toEqual({
      id: G,
      name: 'Polos',
      version: 3,
    });
    expect(hit.calls).toContainEqual(['eq', ['item_id', A]]);
    expect(
      await readItemDisplayGroup(fake([{ data: [], error: null }]).client as never, ORG, A),
    ).toBeNull();
    expect(
      await readItemDisplayGroup(
        fake([{ data: null, error: { message: 'x' } }]).client as never,
        ORG,
        A,
      ),
    ).toBeNull();
  });

  it("attaches each record's group to its row", () => {
    const rows = attachDisplayGroups(
      [{ id: A }, { id: B }],
      new Map([[A, { id: G, name: 'Polos', version: 2 }]]),
    );
    expect(rows).toEqual([
      { id: A, display_group_id: G, display_group_name: 'Polos', display_group_version: 2 },
      { id: B, display_group_id: null, display_group_name: null, display_group_version: null },
    ]);
  });

  it('a Save tells every list to re-read memberships, and an unsubscribed list hears nothing', () => {
    const heard: string[] = [];
    const off = onDisplayGroupsChanged(() => heard.push('items'));
    const off2 = onDisplayGroupsChanged(() => heard.push('books'));
    notifyDisplayGroupsChanged();
    off();
    notifyDisplayGroupsChanged();
    off2();
    expect(heard).toEqual(['items', 'books', 'books']);
  });
});

describe('phoneGroupingCheck (the select bar)', () => {
  it('needs two distinct records of one type', () => {
    expect(phoneGroupingCheck([{ id: A, itemType: 'product' }])).toEqual({
      ok: false,
      message: GROUP_COPY.blocked.tooFew,
    });
    expect(
      phoneGroupingCheck([
        { id: A, itemType: 'product' },
        { id: B, itemType: 'book' },
      ]),
    ).toEqual({
      ok: false,
      message: GROUPING_ERROR_WORDS.mixedTypes,
    });
    expect(
      phoneGroupingCheck([
        { id: A, itemType: 'book' },
        { id: B, itemType: 'book' },
      ]),
    ).toEqual({ ok: true, view: 'books' });
    expect(
      phoneGroupingCheck([
        { id: A, itemType: 'product' },
        { id: B, itemType: 'product' },
      ]),
    ).toEqual({
      ok: true,
      view: 'items',
    });
    // The same record twice is one record.
    expect(
      phoneGroupingCheck([
        { id: A, itemType: 'product' },
        { id: A, itemType: 'product' },
      ]),
    ).toEqual({
      ok: false,
      message: GROUP_COPY.blocked.tooFew,
    });
    const many = Array.from({ length: 101 }, (_, i) => ({ id: `id-${i}`, itemType: 'product' }));
    expect(phoneGroupingCheck(many)).toEqual({
      ok: false,
      message: GROUPING_ERROR_WORDS.groupTooMany,
    });
  });
});

describe('the review screen route', () => {
  it('carries the distinct ids, the view and the group to add to', () => {
    expect(groupSelectedHref({ itemIds: [A, B, A], view: 'items' })).toEqual({
      pathname: '/group-selected',
      params: { ids: `${A},${B}`, view: 'items' },
    });
    expect(groupSelectedHref({ itemIds: [A], view: 'books', groupId: G }).params).toEqual({
      ids: A,
      view: 'books',
      groupId: G,
    });
  });

  it('reads them back, and refuses what is not a reviewable selection', () => {
    expect(readGroupSelectedParams({ ids: `${A},${B}`, view: 'items' })).toEqual({
      itemIds: [A, B],
      view: 'items',
      groupId: null,
    });
    expect(readGroupSelectedParams({ ids: A, view: 'books', groupId: G })).toEqual({
      itemIds: [A],
      view: 'books',
      groupId: G,
    });
    expect(readGroupSelectedParams({ ids: '', view: 'items' })).toBeNull();
    expect(readGroupSelectedParams({ ids: 'not-an-id', view: 'items' })).toBeNull();
    expect(readGroupSelectedParams({ ids: A, view: 'kits' })).toBeNull();
    expect(readGroupSelectedParams({ ids: A, view: 'items', groupId: 'x' })).toBeNull();
  });
});

// Recheck R2-4: a review that covers more records than one request takes
// can only fail again, so Try again reviews the records the screen opened
// with (the select bar and the route cap those at 100).
describe('reviewIdsForRetry (R2-4)', () => {
  const ids = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );

  it('keeps the records under review when one request takes them', () => {
    const current = ids(100);
    expect(reviewIdsForRetry(current, [A, B])).toBe(current);
  });

  it('falls back to the records the screen opened with when there are more than 100', () => {
    expect(reviewIdsForRetry(ids(101), [A, B])).toEqual([A, B]);
  });
});

describe('previewGrouping and postGrouping', () => {
  it('asks the preview route for the ids and the target, as the signed-in account in its organization', async () => {
    api.mockResolvedValueOnce({
      organizationId: ORG,
      actorUserId: ME,
      review: { records: [], previewKey: groupingPreviewKey(ORG, [A, B], G) },
    });
    const r = await previewGrouping({
      itemIds: [A, B],
      groupId: G,
      organizationId: ORG,
      actorUserId: ME,
    });
    expect(api).toHaveBeenCalledWith('/api/v1/items/grouping/preview', {
      method: 'POST',
      body: { itemIds: [A, B], groupId: G },
      orgId: ORG,
      asUserId: ME,
    });
    expect(r.identity).toEqual({ organizationId: ORG, actorUserId: ME });
  });

  it('refuses an answer from another organization, for another account, or for another selection', async () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    api.mockResolvedValueOnce({
      organizationId: OTHER,
      actorUserId: ME,
      review: { records: [], previewKey: groupingPreviewKey(OTHER, [A], null) },
    });
    await expect(
      previewGrouping({ itemIds: [A], groupId: null, organizationId: ORG, actorUserId: ME }),
    ).rejects.toThrow('another organization');
    api.mockResolvedValueOnce({
      organizationId: ORG,
      actorUserId: OTHER,
      review: { records: [], previewKey: groupingPreviewKey(ORG, [A], null) },
    });
    await expect(
      previewGrouping({ itemIds: [A], groupId: null, organizationId: ORG, actorUserId: ME }),
    ).rejects.toThrow(GROUPING_ERROR_WORDS.actorMismatch);
    api.mockResolvedValueOnce({
      organizationId: ORG,
      actorUserId: ME,
      review: { records: [], previewKey: groupingPreviewKey(ORG, [A, B], null) },
    });
    await expect(
      previewGrouping({ itemIds: [A], groupId: null, organizationId: ORG, actorUserId: ME }),
    ).rejects.toThrow();
  });

  it('keeps the key of an unchanged body for a retry, and mints a new one for a changed body', () => {
    let n = 0;
    const mint = () => `key-${++n}`;
    const draft = {
      action: 'remove' as const,
      idempotencyKey: 'pending',
      organizationId: ORG,
      actorUserId: ME,
      itemIds: [A],
      expectedGroups: { [A]: G },
    };
    const first = keyedGroupingBody(null, draft, mint);
    expect(first.body.idempotencyKey).toBe('key-1');
    expect(keyedGroupingBody(first, { ...draft }, mint).body.idempotencyKey).toBe('key-1');
    expect(
      keyedGroupingBody(first, { ...draft, itemIds: [B], expectedGroups: { [B]: G } }, mint).body
        .idempotencyKey,
    ).toBe('key-2');
  });

  it('posts the body as is (the same body and key on a retry) and reads the outcome', async () => {
    const body = {
      action: 'group' as const,
      idempotencyKey: KEY,
      organizationId: ORG,
      actorUserId: ME,
      itemIds: [A, B],
      target: { kind: 'new' as const, name: 'Polos' },
      expectedGroups: { [A]: null, [B]: null },
      moveItemIds: [],
      acknowledgeProductFamily: false,
    };
    // No closedGroupIds (security review SEC-2): the answer no longer says
    // which groups closed.
    const outcome = {
      action: 'group',
      outcome: 'applied',
      replay: false,
      created: true,
      group: { id: G, name: 'Polos', version: 1, itemType: 'product', closed: false },
      changes: [],
    };
    api.mockResolvedValueOnce({ organizationId: ORG, result: outcome });
    expect(await postGrouping(body)).toEqual(outcome);
    expect(api).toHaveBeenCalledWith('/api/v1/items/grouping', {
      method: 'POST',
      body,
      orgId: ORG,
      asUserId: ME,
    });

    // An answer for another organization, or one that is not an outcome, is
    // refused rather than reported as done.
    api.mockResolvedValueOnce({
      organizationId: '44444444-4444-4444-8444-444444444444',
      result: outcome,
    });
    await expect(postGrouping(body)).rejects.toThrow('another organization');
    api.mockResolvedValueOnce({ organizationId: ORG, result: { ...outcome, outcome: 'maybe' } });
    await expect(postGrouping(body)).rejects.toThrow();
  });
});

describe('describeGroupingError', () => {
  it('words refusals from the server or core, and says which may be sent again', () => {
    expect(
      describeGroupingError(
        new FakeApiError(GROUPING_ERROR_WORDS.busy, 503, 'conflict', { reason: 'busy' }),
      ),
    ).toEqual({
      message: GROUPING_ERROR_WORDS.busy,
      retrySame: true,
    });
    expect(
      describeGroupingError(
        new FakeApiError('membership_conflict', 409, 'conflict', { reason: 'membership_conflict' }),
      ),
    ).toEqual({ message: GROUPING_ERROR_WORDS.membershipConflict, retrySame: false });
    expect(describeGroupingError(new FakeApiError('x', 500, 'internal_error'))).toEqual({
      message: GROUPING_ERROR_WORDS.internal,
      retrySame: false,
    });
    expect(describeGroupingError(new FakeApiError('x', 429, 'rate_limited'))).toEqual({
      message: GROUPING_ERROR_WORDS.rateLimited,
      retrySame: true,
    });
    expect(describeGroupingError(new FakeApiError('x', 401, 'unauthenticated'))).toEqual({
      message: GROUPING_ERROR_WORDS.unauthenticated,
      retrySame: false,
    });
    // No answer at all (offline mid-save): the same body may be sent again,
    // and the network layer's own text is never shown.
    expect(describeGroupingError(new TypeError('Network request failed'))).toEqual({
      message: CONNECTION_FAILURE_COPY,
      retrySame: true,
    });
  });
});

describe('reviewRecordDetail', () => {
  const rec = (over: Partial<PhoneGroupingRecord>): PhoneGroupingRecord => ({
    id: A,
    name: 'Polo',
    sku: 'POLO-1',
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
    warehouseName: null,
    placementLabel: null,
    imageUrl: null,
    ...over,
  });

  it('names what tells the records apart, as the web review does', () => {
    expect(
      reviewRecordDetail(
        rec({
          variantSize: 'XL',
          charterName: 'North',
          placementLabel: 'Rack 3-A',
          warehouseName: 'DC4',
        }),
        'items',
      ),
    ).toBe('SKU POLO-1 · Size XL · North · Rack 3-A · DC4 · 4 on hand');
    expect(reviewRecordDetail(rec({}), 'items')).toBe(
      'SKU POLO-1 · No charter · No rack · 4 on hand',
    );
  });

  // Recheck R2-6: "No charter" only for a record with no charter; a charter
  // whose name could not be read is left out (core's one record line).
  it('says No charter only for a record with no charter (R2-6)', () => {
    expect(reviewRecordDetail(rec({ charterId: 'ch-1', charterName: null }), 'items')).toBe(
      'SKU POLO-1 · No rack · 4 on hand',
    );
  });

  it("shows a book's ISBN (its edition), and never a size", () => {
    expect(
      reviewRecordDetail(
        rec({ itemType: 'book', barcode: '9780134685991', variantSize: 'M' }),
        'books',
      ),
    ).toBe('SKU POLO-1 · ISBN 9780134685991 · No charter · No rack · 4 on hand');
  });
});

// People review P4: a Pressable nested in the row's Pressable is not its own
// element for VoiceOver (RN's Pressable is accessible), so the row itself
// carries "Add to group" as an action; 'activate' keeps a double tap doing
// what a tap on the row does.
describe('the row accessibility actions (P4)', () => {
  it('offers Add to group as an action on the row only when the row offers it', () => {
    expect(groupRowAccessibilityActions(true)).toEqual([
      { name: 'activate' },
      { name: ADD_TO_GROUP_ACTION, label: GROUP_COPY.addToGroup },
    ]);
    expect(groupRowAccessibilityActions(false)).toBeUndefined();
  });

  it('runs the action asked for, and nothing for an unknown one', () => {
    const on = { activate: vi.fn(), addToGroup: vi.fn() };
    runGroupRowAccessibilityAction(ADD_TO_GROUP_ACTION, on);
    expect(on.addToGroup).toHaveBeenCalledTimes(1);
    expect(on.activate).not.toHaveBeenCalled();
    runGroupRowAccessibilityAction('activate', on);
    expect(on.activate).toHaveBeenCalledTimes(1);
    runGroupRowAccessibilityAction('magicTap', on);
    expect(on.activate).toHaveBeenCalledTimes(1);
    expect(on.addToGroup).toHaveBeenCalledTimes(1);
  });
});

// People review P11: iOS ignores accessibilityLiveRegion, so the review
// announces its loading outcome itself.
describe('reviewAnnouncement (P11)', () => {
  it('announces a review that loaded, failed or found no connection, once per change', () => {
    const ready = { kind: 'ready' as const, records: 2 };
    expect(reviewAnnouncement({ kind: 'loading' }, ready)).toBe(GROUP_COPY.reviewReady(2));
    expect(reviewAnnouncement(ready, ready)).toBeNull();
    expect(reviewAnnouncement({ kind: 'loading' }, { kind: 'failed', message: 'No luck.' })).toBe(
      'No luck.',
    );
    expect(reviewAnnouncement({ kind: 'loading' }, { kind: 'offline' })).toBe(GROUP_COPY.offline);
    expect(reviewAnnouncement(ready, { kind: 'loading' })).toBeNull();
  });
});

// People review P5: one rule with the web, "N matching" whenever a search
// or a filter narrows the list (a sort does not).
describe('listIsNarrowed (P5)', () => {
  const none = { status: 'all', categoryIds: [], locationIds: [], charterIds: [] };
  it('is true for a search, a stock view or any filter, and false for a sort alone', () => {
    expect(listIsNarrowed('', none)).toBe(false);
    expect(listIsNarrowed('   ', none)).toBe(false);
    expect(listIsNarrowed('tee', none)).toBe(true);
    expect(listIsNarrowed('', { ...none, status: 'low' })).toBe(true);
    expect(listIsNarrowed('', { ...none, categoryIds: ['c'] })).toBe(true);
    expect(listIsNarrowed('', { ...none, locationIds: ['l'] })).toBe(true);
    expect(listIsNarrowed('', { ...none, charterIds: ['h'] })).toBe(true);
  });
});

describe('screen pins', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

  it('the select bar offers Group, gated by the edit permission, online only', () => {
    const bar = read('../components/count-select-bar.tsx');
    expect(bar).toContain('GROUP_COPY.bulkAction');
    // P7: the label the phone shows is core's word, the one What's New names.
    expect(bar).toContain('{GROUP_COPY.bulkActionShort}');
    expect(bar).toContain("'items:update'");
    expect(bar).toContain('phoneGroupingCheck');
    expect(bar).toContain('isOnline');
    expect(bar).toContain('GROUP_COPY.offline');
  });

  it("the review screen says the brief's sentence, and never queues", () => {
    const screen = read('../../app/group-selected.tsx');
    expect(screen).toContain('GROUP_COPY.intro');
    expect(screen).toContain('GROUP_COPY.skuNote');
    expect(screen).toContain('previewGrouping');
    expect(screen).toContain('postGrouping');
    // One key per body, kept for a retry of that body (keyedGroupingBody).
    expect(screen).toContain('keyedGroupingBody(');
    expect(screen).not.toMatch(/enqueue\(/);
    // Dynamic Type: the record list grows; no line cap on a record's name.
    expect(screen).toContain('maxFontSizeMultiplier');
  });

  // People review P1, P6, P8 and P10, on the phone's review as on the web
  // (the decisions are core planGrouping's; the screen renders them).
  it('the review counts only the records that join, lists the target group, and lets a record in another group be left out', () => {
    const screen = read('../../app/group-selected.tsx');
    // P6: Save counts plan.joining, never every sent record; a repeat says OK.
    expect(screen).toContain('GROUP_COPY.confirmExisting(plan.joining.length');
    expect(screen).not.toContain('GROUP_COPY.confirmExisting(sendCount');
    expect(screen).toContain('GROUP_COPY.noopConfirm');
    expect(screen).toContain('GROUP_COPY.alreadyInTarget');
    // P8: the existing group's other records.
    expect(screen).toContain('plan.targetMembers');
    expect(screen).toContain('GROUP_COPY.targetMembers(');
    // P10: move it, or leave it out.
    expect(screen).toContain('GROUP_COPY.leaveOutOne');
    expect(screen).toMatch(/leaveOutIds/);
    // P1: only siblings outside the group are offered (core filters them).
    expect(screen).toContain('plan?.conflicts.sameSkuSiblings');
  });

  // Recheck R2-1: a "Move it into this group" or "Leave it out" choice is kept
  // with the group the record was in when it was made (core
  // choicesForReview, tested in core). A new review that finds the record in
  // another group drops it, so Save stays off until the member decides again;
  // the plan's decisions come only from the choices that hold.
  it('the review keeps each choice with its group and drops it when a new review finds the record elsewhere (R2-1)', () => {
    const screen = read('../../app/group-selected.tsx');
    expect(screen).toContain('groupingDecisionsFor(');
    expect(screen).toContain('fromGroupId');
    // No bare id sets that outlive the review they were chosen in.
    expect(screen).not.toMatch(/useState<Set<string>>/);
    // Pruned the moment a review arrives, not only when a radio is pressed.
    expect(screen).toMatch(/setChoices\(\(cur\) => choicesForReview\(cur, r\.review\.records\)\)/);
  });

  // Recheck R2-5: each record's choice is named for its record with core's
  // words, the same names the web's radios carry.
  it("each record's Move it and Leave it out choice is named for its record with core's words (R2-5)", () => {
    const screen = read('../../app/group-selected.tsx');
    expect(screen).toContain('GROUP_COPY.moveOneFor(r.name)');
    expect(screen).toContain('GROUP_COPY.leaveOutOneFor(r.name)');
  });

  // Recheck R2-4: "Add them to the selection" stays within one request's 100
  // records (core's plan says why it is off), and Try again after a failed
  // review never resends a request that can only fail again.
  it('Add them to the selection stays within 100 records, and Try again falls back to the records the screen opened with (R2-4)', () => {
    const screen = read('../../app/group-selected.tsx');
    expect(screen).toContain('plan?.addSiblingsBlockedReason');
    expect(screen).toMatch(/disabled=\{busy \|\| !!plan\?\.addSiblingsBlockedReason\}/);
    expect(screen).toContain('reviewIdsForRetry(cur, params?.itemIds ?? [])');
  });

  it("the item screen names the record's group and offers Remove from group to an editor, online only", () => {
    const item = read('../../app/item/[id].tsx');
    expect(item).toContain('GROUP_COPY.itemPageInGroup');
    expect(item).toContain('GROUP_COPY.removeAction');
    expect(item).toContain('removeBodyFor');
  });

  it('both lists put Add to group on the row as an accessibility action (P4)', () => {
    for (const p of [
      '../../app/(drawer)/(tabs)/inventory.tsx',
      '../../app/(drawer)/(tabs)/books.tsx',
    ]) {
      const src = read(p);
      expect(src).toContain('accessibilityActions={groupRowAccessibilityActions(');
      expect(src).toContain('runGroupRowAccessibilityAction(e.nativeEvent.actionName');
    }
  });

  it('the review announces its load and its blocked reason on iOS, and the select bar Group is a 44pt target (P11)', () => {
    const screen = read('../../app/group-selected.tsx');
    expect(screen).toContain('reviewAnnouncement(');
    expect(screen).toMatch(/announce\(plan\.blockedReason\)|announce\(blocked\)/);
    const bar = read('../components/count-select-bar.tsx');
    expect(bar).toContain('hitSlop={GROUP_HIT_SLOP}');
    // 12.5pt text sits on a line of about 16pt; 14pt above and below make 44.
    expect(bar).toMatch(/GROUP_HIT_SLOP = \{ top: 14, bottom: 14, left: 8, right: 8 \}/);
  });

  it('both lists read memberships and render the explicit header', () => {
    for (const p of [
      '../../app/(drawer)/(tabs)/inventory.tsx',
      '../../app/(drawer)/(tabs)/books.tsx',
    ]) {
      const src = read(p);
      expect(src).toContain('readDisplayGroups');
      expect(src).toContain("'explicit-header'");
      expect(src).toContain('expandedExplicitGroups');
      // P5: "N matching" under a search or a filter, as on the web.
      expect(src).toContain('GROUP_COPY.headerCount(row.recordCount, narrowed)');
      expect(src).toContain('listIsNarrowed(');
    }
  });
});
