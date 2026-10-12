import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUPING_ERROR_WORDS, groupingPreviewKey, UNGROUP_COPY } from '@stockpilot/core';

import { ungroupFactsByItem, type GroupableItem } from './inventory-grouping';
// vi.mock below is hoisted above every import by vitest.
import {
  notifyRecordsUngrouped,
  onRecordsUngrouped,
  phoneUngroupCheck,
  phoneUngroupOffer,
  postUngroupSelected,
  previewUngroupSelected,
  readUngroupSelectedParams,
  ungroupSelectedHref,
} from './ungroup-selected';

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('./api', () => ({
  api: (...a: unknown[]) => api(...a),
  ApiError: class extends Error {},
}));

/**
 * Ungroup anything on the phone (owner 2026-10-12, verbatim: "im supposed to
 * be able to check box whatever item and then group or ungroup it that was
 * the point."): the select bar offers Ungroup by core's rule, the review
 * goes through POST /api/v1/items/ungroup-selected/preview and the Save
 * through POST /api/v1/items/ungroup-selected, the web's own service, online
 * only, under the record's organization and only the signed-in account.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const FAM = 'fam-1';

const facts = (
  over: Partial<NonNullable<Parameters<typeof phoneUngroupOffer>[0][number]['grouping']>> = {},
) => ({
  displayGroupId: null,
  familyId: null,
  sharesSku: false,
  shownUnder: null,
  ...over,
});

beforeEach(() => {
  api.mockReset();
});

describe('the select bar offers Ungroup', () => {
  const can = { editItems: true, unlinkFamilies: true };

  it("the owner's case: ticked sizes of a size family, to someone who may unlink one", () => {
    const sizes = [1, 2, 3].map((n) => ({
      id: id(n),
      grouping: facts({ familyId: FAM, shownUnder: 'family' }),
    }));
    expect(phoneUngroupOffer(sizes, can)).toBe(true);
    expect(phoneUngroupOffer(sizes, { editItems: true, unlinkFamilies: false })).toBe(false);
  });

  it('for a record in a display group or sharing its SKU, to someone who can edit items', () => {
    expect(phoneUngroupOffer([{ id: id(1), grouping: facts({ displayGroupId: 'g' }) }], can)).toBe(
      true,
    );
    expect(phoneUngroupOffer([{ id: id(1), grouping: facts({ sharesSku: true }) }], can)).toBe(
      true,
    );
    expect(
      phoneUngroupOffer([{ id: id(1), grouping: facts({ displayGroupId: 'g' }) }], {
        editItems: false,
        unlinkFamilies: true,
      }),
    ).toBe(false);
  });

  it('not for records with nothing to leave, or picks the list said nothing about', () => {
    expect(phoneUngroupOffer([{ id: id(1), grouping: facts() }], can)).toBe(false);
    expect(phoneUngroupOffer([{ id: id(1) }], can)).toBe(false);
  });

  it('judges a record on the grouping it is shown under', () => {
    const both = facts({ displayGroupId: 'g', familyId: FAM, shownUnder: 'family' });
    expect(
      phoneUngroupOffer([{ id: id(1), grouping: both }], {
        editItems: true,
        unlinkFamilies: false,
      }),
    ).toBe(false);
    expect(
      phoneUngroupOffer([{ id: id(1), grouping: { ...both, shownUnder: null } }], {
        editItems: true,
        unlinkFamilies: false,
      }),
    ).toBe(true);
  });

  it('refuses more than 100 records before the review opens, and reads books as books', () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ id: id(i), itemType: 'product' }));
    expect(phoneUngroupCheck(many)).toEqual({ ok: false, message: GROUPING_ERROR_WORDS.tooMany });
    expect(phoneUngroupCheck([{ id: id(1), itemType: 'book' }])).toEqual({
      ok: true,
      view: 'books',
    });
    expect(
      phoneUngroupCheck([
        { id: id(1), itemType: 'book' },
        { id: id(2), itemType: 'product' },
      ]),
    ).toEqual({ ok: true, view: 'items' });
  });
});

describe('the review route carries every pick and where each was shown', () => {
  it('round-trips the ids and the shown-under letters', () => {
    const href = ungroupSelectedHref({
      picks: [
        { id: id(1), grouping: facts({ shownUnder: 'family' }) },
        { id: id(2), grouping: facts({ shownUnder: 'group' }) },
        { id: id(3), grouping: facts({ shownUnder: 'sku' }) },
        { id: id(4) },
        { id: id(1), grouping: facts({ shownUnder: 'family' }) },
      ],
      view: 'items',
    });
    expect(href).toEqual({
      pathname: '/ungroup-selected',
      params: { ids: [1, 2, 3, 4].map(id).join(','), view: 'items', under: 'fgs-' },
    });
    const back = readUngroupSelectedParams(href.params);
    expect(back?.itemIds).toEqual([1, 2, 3, 4].map(id));
    expect(back?.view).toBe('items');
    expect([...(back?.shownUnder ?? [])]).toEqual([
      [id(1), 'family'],
      [id(2), 'group'],
      [id(3), 'sku'],
    ]);
  });

  it('refuses params it cannot review', () => {
    const ok = { ids: `${id(1)},${id(2)}`, view: 'items', under: 'g-' };
    expect(readUngroupSelectedParams(ok)).not.toBeNull();
    expect(readUngroupSelectedParams({ ...ok, under: 'g' })).toBeNull();
    expect(readUngroupSelectedParams({ ...ok, under: 'gx' })).toBeNull();
    expect(readUngroupSelectedParams({ ...ok, view: 'orders' })).toBeNull();
    expect(readUngroupSelectedParams({ ...ok, ids: `${id(1)},${id(1)}` })).toBeNull();
    expect(readUngroupSelectedParams({ ...ok, ids: 'nope,x' })).toBeNull();
  });
});

describe('the review and the Save go through the web service, online, as the signed-in account', () => {
  const answer = (over: Record<string, unknown> = {}) => ({
    organizationId: ORG,
    actorUserId: ME,
    review: {
      records: [{ id: id(1), name: 'Tee', displayGroup: null }],
      unavailableCount: 0,
      candidateGroups: [],
      previewKey: groupingPreviewKey(ORG, [id(1)], null),
    },
    candidates: [
      { id: id(1), sku: 'S', name: 'Tee', isBundle: false, inFamily: true, barcode: null },
    ],
    canUnlinkFamilies: true,
    previewKey: groupingPreviewKey(ORG, [id(1)], null),
    ...over,
  });

  it('reads the review under the organization and the account, and says whether families may be unlinked', async () => {
    api.mockResolvedValueOnce(answer());
    const r = await previewUngroupSelected({
      itemIds: [id(1)],
      organizationId: ORG,
      actorUserId: ME,
    });
    expect(api).toHaveBeenCalledWith('/api/v1/items/ungroup-selected/preview', {
      method: 'POST',
      body: { itemIds: [id(1)] },
      orgId: ORG,
      asUserId: ME,
    });
    expect(r.canUnlinkFamilies).toBe(true);
    expect(r.identity).toEqual({ organizationId: ORG, actorUserId: ME });
    expect(r.review.records.map((x) => x.id)).toEqual([id(1)]);
  });

  it('refuses a review for another organization, account or selection', async () => {
    api.mockResolvedValueOnce(answer({ organizationId: '55555555-5555-4555-8555-555555555555' }));
    await expect(
      previewUngroupSelected({ itemIds: [id(1)], organizationId: ORG, actorUserId: ME }),
    ).rejects.toThrow('another organization');
    api.mockResolvedValueOnce(answer({ actorUserId: '55555555-5555-4555-8555-555555555555' }));
    await expect(
      previewUngroupSelected({ itemIds: [id(1)], organizationId: ORG, actorUserId: ME }),
    ).rejects.toThrow(GROUPING_ERROR_WORDS.actorMismatch);
    api.mockResolvedValueOnce(answer());
    await expect(
      previewUngroupSelected({ itemIds: [id(2)], organizationId: ORG, actorUserId: ME }),
    ).rejects.toThrow('could not be read');
  });

  it('sends a Save under the body organization and account, and reads every step of the answer', async () => {
    const body = {
      organizationId: ORG,
      actorUserId: ME,
      remove: null,
      split: null,
      unlink: {
        itemIds: [id(1)],
        expectedFamilies: { [id(1)]: '77777777-7777-4777-8777-777777777777' },
      },
    };
    const result = {
      complete: true,
      parts: [
        {
          kind: 'unlink',
          status: 'applied',
          changedItemIds: [id(1)],
          notChangedItemIds: [],
          message: null,
          reason: null,
          retryable: false,
        },
      ],
    };
    api.mockResolvedValueOnce({ organizationId: ORG, result });
    expect(await postUngroupSelected(body)).toEqual(result);
    expect(api).toHaveBeenCalledWith('/api/v1/items/ungroup-selected', {
      method: 'POST',
      body,
      orgId: ORG,
      asUserId: ME,
    });
    api.mockResolvedValueOnce({ organizationId: '55555555-5555-4555-8555-555555555555', result });
    await expect(postUngroupSelected(body)).rejects.toThrow('another organization');
    api.mockResolvedValueOnce({ organizationId: ORG, result: { parts: 'x' } });
    await expect(postUngroupSelected(body)).rejects.toThrow('could not be read');
  });

  it('tells the lists to re-read their rows after an Ungroup', () => {
    const seen = vi.fn();
    const off = onRecordsUngrouped(seen);
    notifyRecordsUngrouped();
    off();
    notifyRecordsUngrouped();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('ungroupFactsByItem: what the list knows about each record for Ungroup', () => {
  const item = (o: Partial<GroupableItem> & { id: string }): GroupableItem => ({
    name: o.name ?? 'Item',
    sku: o.sku ?? o.id,
    quantity_on_hand: 1,
    reorder_point: 0,
    status: 'active',
    charter_id: null,
    primary_location_id: null,
    awaiting_first_receipt: false,
    ...o,
  });

  it('names the grouping each record is shown under, and whether its SKU is shared', () => {
    const m = ungroupFactsByItem([
      item({ id: 'g1', display_group_id: 'grp' }),
      item({ id: 'g2', display_group_id: 'grp' }),
      item({ id: 's1', sku: 'PAIR' }),
      item({ id: 's2', sku: 'PAIR' }),
      item({ id: 'f1', name: 'Tee - S', group_id: FAM }),
      item({ id: 'f2', name: 'Tee - M', group_id: FAM }),
      item({ id: 'x' }),
    ]);
    expect(m.get('g1')).toEqual({
      displayGroupId: 'grp',
      familyId: null,
      sharesSku: false,
      shownUnder: 'group',
    });
    expect(m.get('s1')).toMatchObject({ sharesSku: true, shownUnder: 'sku' });
    expect(m.get('f2')).toMatchObject({ familyId: FAM, shownUnder: 'family' });
    expect(m.get('x')).toEqual({
      displayGroupId: null,
      familyId: null,
      sharesSku: false,
      shownUnder: null,
    });
  });

  it('Books: no size runs', () => {
    const m = ungroupFactsByItem(
      [
        item({ id: 'f1', name: 'Tee - S', group_id: FAM }),
        item({ id: 'f2', name: 'Tee - M', group_id: FAM }),
      ],
      { enableSizeRuns: false },
    );
    expect(m.get('f1')?.shownUnder).toBeNull();
  });
});

describe('screen pins', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, p), 'utf8');

  it('the select bar offers Ungroup by core rule, with the sports gate for families, online only', () => {
    const bar = read('../components/count-select-bar.tsx');
    expect(bar).toContain('phoneUngroupOffer(picks');
    expect(bar).toContain(
      "showWriteCtaForRole(role, permissions, 'sports:manage') && enabledModules.has('sports')",
    );
    expect(bar).toContain('UNGROUP_COPY.selectedOffline');
    expect(bar).toContain('ungroupSelectedHref({ picks, view: check.view })');
    expect(bar).toContain('accessibilityLabel={UNGROUP_COPY.bulkAction}');
  });

  it('both lists keep what each ticked record would leave with its pick, and re-read rows after an Ungroup', () => {
    for (const p of [
      '../../app/(drawer)/(tabs)/inventory.tsx',
      '../../app/(drawer)/(tabs)/books.tsx',
    ]) {
      const src = read(p);
      expect(src).toContain('ungroupFactsByItem(');
      expect(src).toContain('grouping: ungroupFacts.get(');
      expect(src).toContain('onRecordsUngrouped(');
    }
  });

  it("the review screen says core's words for each record, counts the records that change, and never queues", () => {
    const screen = read('../../app/ungroup-selected.tsx');
    expect(screen).toContain('UNGROUP_COPY.selectedIntro');
    expect(screen).toContain('planUngroupSelected(');
    expect(screen).toContain('ungroupOutcomeWords(o)');
    expect(screen).toContain('UNGROUP_COPY.confirm(changing)');
    expect(screen).toContain('ungroupChangeCount(plan, anchorBySku)');
    expect(screen).toContain('UNGROUP_COPY.familyNote');
    // Test stage 2026-10-12 (PR #355, MEDIUM): sizes whose names end in a size
    // stay listed together by their name once out of the family; the review
    // and the result say so, by core's rule.
    expect(screen).toContain('familyStaysListedByName(plan.leaveFamily, view)');
    expect(screen).toContain(
      'familyStaysListedByNameAfter(outcome, (x) => reviewById.get(x)?.name, view)',
    );
    expect(screen.split('UNGROUP_COPY.familyNameNote').length - 1).toBe(2);
    expect(screen).toContain('keyedUngroupSelectedBody(');
    expect(screen).toContain('ungroupResultLines(');
    expect(screen).toContain('notifyRecordsUngrouped()');
    expect(screen).not.toMatch(/enqueue\(/);
    // Each "keeps the SKU" choice is a 44pt radio named for its record.
    expect(screen).toContain(
      'accessibilityLabel={`${UNGROUP_COPY.keepsSku(group.sku)}: ${r.name}`}',
    );
  });

  it('a step refused after an earlier one applied is said, with Try again for the same body or Review again', () => {
    const screen = read('../../app/ungroup-selected.tsx');
    expect(screen).toContain('lines.notDone');
    expect(screen).toContain('send(retryBody)');
    expect(screen).toContain('reviewAgain');
    // G2 reviews (2026-10-12): the lists re-read after any answer that may
    // have changed something (a lost answer, records already out), by core's
    // rule, not only when a record is counted as changed.
    expect(screen).toContain('if (ungroupListMayBeStale(o)) {');
    expect(screen).not.toContain('if (o.parts.some((p) => p.changedItemIds.length > 0)) {');
    // UNGROUP_COPY words exist for every left-out reason the plan names.
    expect(Object.keys(UNGROUP_COPY.selectedLeftOutReason).sort()).toEqual(
      ['family_permission', 'family_sku', 'kit', 'not_writable', 'nothing'].sort(),
    );
  });
});
