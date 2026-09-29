import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assessOrderReadiness,
  orderReadinessPhase,
  type OrderReadinessAssessment,
  type OrderReadinessFacts,
  type ReadinessItemFacts,
  type ReadinessLineAssessment,
  type ReadinessVisibleItemFacts,
} from './readiness';
import {
  describeStagingItemFilter,
  lineNeedsPutAway,
  linePutAwayUnits,
  parseStagingItemFilter,
  PUT_AWAY_LINE_LABEL,
  PUT_AWAY_NEEDS_TRANSFER_COPY,
  putAwayLineAccessibilityLabel,
  putAwayLineOffer,
  putAwayStripLabel,
  putAwayStripOffer,
  putAwayTargets,
  STAGING_FILTER_BACK_LABEL,
  STAGING_FILTER_EMPTY_COPY,
  STAGING_FILTER_MAX_ITEMS,
  STAGING_FILTER_SHOW_ALL_LABEL,
  STAGING_FILTER_UNPLACED_NOTE,
  stagingFilterInvalidCopy,
  stagingPutAwayHref,
  stagingPutAwayParams,
} from './put-away';

// ── Builders (the shapes order_readiness_facts returns) ─────────────────────

const WH = 'wh-home';
const NOW = '2026-09-28T12:00:00.000Z';
const ORDER = '0f0f0f0f-0000-4000-8000-000000000001';

function item(itemId: string, over: Partial<ReadinessVisibleItemFacts> = {}): ReadinessVisibleItemFacts {
  const here = { rack: 0, site: 0, unplaced: 0, staging: 0, ...over.here };
  const elsewhere = { pickable: 0, staging: 0, ...over.elsewhere };
  const onHand =
    over.onHand ?? here.rack + here.site + here.unplaced + here.staging + elsewhere.pickable + elsewhere.staging;
  return {
    itemId,
    visible: true,
    name: `Item ${itemId}`,
    sku: `SKU-${itemId}`,
    supplierId: null,
    itemWarehouseId: WH,
    deleted: false,
    archived: false,
    isBundle: false,
    heldOwn: 0,
    heldOtherOrders: 0,
    heldRentals: 0,
    stagingSources: [],
    stagingHiddenQty: 0,
    pendingOthers: null,
    committedOtherShortfall: 0,
    inbound: null,
    drafts: null,
    ...over,
    here,
    elsewhere,
    onHand,
  };
}

interface LineSpec {
  id: string;
  item: string;
  requested: number;
  fulfilled?: number;
}

function assess(opts: {
  status?: string;
  lines: LineSpec[];
  items: ReadinessItemFacts[];
  linesCapped?: boolean;
}): OrderReadinessAssessment {
  const status = opts.status ?? 'pending_approval';
  const facts: OrderReadinessFacts = {
    v: 1,
    observedAt: NOW,
    phase: orderReadinessPhase(status),
    linesCapped: opts.linesCapped ?? false,
    order: {
      id: ORDER,
      orderNumber: 123,
      status,
      warehouseId: WH,
      neededBy: null,
      fulfillmentType: 'pickup',
      timeZone: 'America/Los_Angeles',
    },
    lines: opts.linesCapped
      ? []
      : opts.lines.map((l, i) => ({
          lineId: l.id,
          itemId: l.item,
          requested: l.requested,
          fulfilled: l.fulfilled ?? 0,
          picked: null,
          createdAt: new Date(Date.UTC(2026, 8, 1, 10, 0, i)).toISOString(),
        })),
    items: opts.linesCapped ? [] : opts.items,
  };
  return assessOrderReadiness(facts, { now: NOW });
}

function lineOf(a: OrderReadinessAssessment, id: string): ReadinessLineAssessment {
  if (a.phase !== 'to_pick') throw new Error(`expected to_pick, got ${a.phase}`);
  const l = a.lines.find((x) => x.lineId === id);
  if (!l) throw new Error(`no line ${id}`);
  return l;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

// ── Which lines qualify ─────────────────────────────────────────────────────

describe('which lines offer "Put away" (units in this warehouse\'s Staging, whatever the state)', () => {
  it('a needs-put-away line: 6 on the rack, 4 in Staging, 10 asked', () => {
    const a = assess({ lines: [{ id: 'L1', item: 'A', requested: 10 }], items: [item('A', { here: { rack: 6, site: 0, unplaced: 0, staging: 4 } })] });
    const l = lineOf(a, 'L1');
    expect(l.state).toBe('needs_put_away');
    expect(lineNeedsPutAway(l)).toBe(true);
    expect(linePutAwayUnits(l)).toBe(4);
  });

  it('a SHORT line with units in Staging still offers it (the worst state hides needs_put_away)', () => {
    // 10 asked, 3 on the rack, 4 in Staging: 3 ready, 4 to put away, 3 short.
    const a = assess({ lines: [{ id: 'L1', item: 'A', requested: 10 }], items: [item('A', { here: { rack: 3, site: 0, unplaced: 0, staging: 4 } })] });
    const l = lineOf(a, 'L1');
    expect(l.state).toBe('short');
    expect(l.units?.putAway).toBe(4);
    expect(lineNeedsPutAway(l)).toBe(true);
  });

  it('a ready line, an Unplaced-only line and a Site-only line do not (picking takes them as they are)', () => {
    const a = assess({
      lines: [
        { id: 'R', item: 'A', requested: 5 },
        { id: 'U', item: 'B', requested: 5 },
        { id: 'S', item: 'C', requested: 5 },
      ],
      items: [
        item('A', { here: { rack: 5, site: 0, unplaced: 0, staging: 0 } }),
        item('B', { here: { rack: 0, site: 0, unplaced: 5, staging: 0 } }),
        item('C', { here: { rack: 0, site: 5, unplaced: 0, staging: 0 } }),
      ],
    });
    for (const id of ['R', 'U', 'S']) expect(lineNeedsPutAway(lineOf(a, id)), id).toBe(false);
    expect(putAwayTargets(a)).toEqual({ itemIds: [], lineIds: [], units: 0 });
  });

  it('a hidden item, a deleted item, a moved item and a handed-over line never do', () => {
    const a = assess({
      status: 'backordered',
      lines: [
        { id: 'H', item: 'hidden', requested: 5 },
        { id: 'D', item: 'deleted', requested: 5 },
        { id: 'M', item: 'moved', requested: 5 },
        { id: 'O', item: 'over', requested: 5, fulfilled: 5 },
      ],
      items: [
        { itemId: 'hidden', visible: false },
        item('deleted', { deleted: true, here: { rack: 0, site: 0, unplaced: 0, staging: 5 } }),
        item('moved', { itemWarehouseId: 'wh-other', here: { rack: 0, site: 0, unplaced: 0, staging: 5 } }),
        item('over', { here: { rack: 0, site: 0, unplaced: 0, staging: 5 } }),
      ],
    });
    for (const id of ['H', 'D', 'M', 'O']) expect(lineNeedsPutAway(lineOf(a, id)), id).toBe(false);
    expect(putAwayTargets(a)?.itemIds).toEqual([]);
  });

  it("another warehouse's Staging is not put-away here (readiness does not count it)", () => {
    const a = assess({ lines: [{ id: 'L1', item: 'A', requested: 5 }], items: [item('A', { elsewhere: { pickable: 0, staging: 5 } })] });
    expect(lineNeedsPutAway(lineOf(a, 'L1'))).toBe(false);
  });

  it('duplicate-item lines name their item once, both lines, and the units once (never double)', () => {
    // 3 + 3 asked of A: 2 on the rack, 4 in Staging. Line 1 takes 2 ready + 1
    // put-away; line 2 takes the other 3 put-away. B has 5 in Staging.
    const a = assess({
      lines: [
        { id: 'L1', item: 'A', requested: 3 },
        { id: 'L2', item: 'B', requested: 5 },
        { id: 'L3', item: 'A', requested: 3 },
      ],
      items: [
        item('A', { here: { rack: 2, site: 0, unplaced: 0, staging: 4 } }),
        item('B', { here: { rack: 0, site: 0, unplaced: 0, staging: 5 } }),
      ],
    });
    expect(linePutAwayUnits(lineOf(a, 'L1'))).toBe(1);
    expect(linePutAwayUnits(lineOf(a, 'L3'))).toBe(3);
    expect(putAwayTargets(a)).toEqual({ itemIds: ['A', 'B'], lineIds: ['L1', 'L2', 'L3'], units: 9 });
  });

  it('claims nothing past the line cap or outside the to_pick phase', () => {
    expect(putAwayTargets(assess({ lines: [], items: [], linesCapped: true }))).toBeNull();
    expect(putAwayTargets(assess({ status: 'picking_complete', lines: [{ id: 'L1', item: 'A', requested: 1 }], items: [] }))).toBeNull();
    expect(putAwayTargets(null)).toBeNull();
  });
});

// ── The offers and their words ──────────────────────────────────────────────

describe('put-away offers (stock:transfer, the Place action\'s own permission)', () => {
  const a = assess({
    lines: [
      { id: 'L1', item: 'A', requested: 10 },
      { id: 'L2', item: 'B', requested: 5 },
      { id: 'L3', item: 'C', requested: 5 },
    ],
    items: [
      item('A', { name: 'Maus I', here: { rack: 6, site: 0, unplaced: 0, staging: 4 } }),
      item('B', { here: { rack: 0, site: 0, unplaced: 0, staging: 5 } }),
      item('C', { here: { rack: 5, site: 0, unplaced: 0, staging: 0 } }),
    ],
  });

  it('the strip links "Put away 2 items" for someone who can transfer stock', () => {
    expect(putAwayStripOffer(putAwayTargets(a), true)).toEqual({ kind: 'link', label: 'Put away 2 items', itemIds: ['A', 'B'] });
    expect(putAwayStripLabel(1)).toBe('Put away 1 item');
  });

  it('everyone else sees the permission sentence, never a link that bounces', () => {
    expect(putAwayStripOffer(putAwayTargets(a), false)).toEqual({ kind: 'needs_permission', message: PUT_AWAY_NEEDS_TRANSFER_COPY });
    expect(putAwayLineOffer(lineOf(a, 'L1'), false)).toEqual({ kind: 'needs_permission', message: PUT_AWAY_NEEDS_TRANSFER_COPY });
    expect(PUT_AWAY_NEEDS_TRANSFER_COPY).toBe('Putting stock away needs the Transfer stock permission.');
  });

  it('a line links its own item only; a line with nothing to put away offers nothing', () => {
    expect(putAwayLineOffer(lineOf(a, 'L1'), true)).toEqual({ kind: 'link', label: PUT_AWAY_LINE_LABEL, itemIds: ['A'] });
    expect(putAwayLineOffer(lineOf(a, 'L3'), true)).toEqual({ kind: 'none' });
    expect(putAwayLineOffer(lineOf(a, 'L3'), false)).toEqual({ kind: 'none' });
    expect(putAwayStripOffer({ itemIds: [], lineIds: [], units: 0 }, true)).toEqual({ kind: 'none' });
    expect(putAwayStripOffer(null, true)).toEqual({ kind: 'none' });
  });

  it('speaks the line action: "Put away 4 of Maus I from Staging"', () => {
    expect(putAwayLineAccessibilityLabel(lineOf(a, 'L1'))).toBe('Put away 4 of Maus I from Staging');
  });
});

// ── The filter: links in, filter out ────────────────────────────────────────

describe('parseStagingItemFilter (web ?item / ?order, phone itemIds / orderId)', () => {
  const A = uuid(1);
  const B = uuid(2);

  it('no item param is no filter (an order alone is not one)', () => {
    expect(parseStagingItemFilter({})).toEqual({ state: 'none' });
    expect(parseStagingItemFilter({ order: ORDER })).toEqual({ state: 'none' });
    expect(parseStagingItemFilter({ item: [] })).toEqual({ state: 'none' });
  });

  it('reads a single ?item, a repeated ?item and a comma list the same, deduped, lower case', () => {
    const want = { state: 'ok', filter: { itemIds: [A, B], orderId: ORDER } };
    expect(parseStagingItemFilter({ item: [A, B], order: ORDER })).toEqual(want);
    expect(parseStagingItemFilter({ item: `${A},${B}`, order: ORDER })).toEqual(want);
    expect(parseStagingItemFilter({ item: [A.toUpperCase(), ` ${B} `, A], order: ORDER.toUpperCase() })).toEqual(want);
    expect(parseStagingItemFilter({ item: A })).toEqual({ state: 'ok', filter: { itemIds: [A], orderId: null } });
  });

  it('refuses a value that is not a uuid (it would fail the whole read) and an empty one', () => {
    expect(parseStagingItemFilter({ item: [A, 'nope'] })).toEqual({ state: 'invalid', reason: 'bad_id' });
    expect(parseStagingItemFilter({ item: '' })).toEqual({ state: 'invalid', reason: 'bad_id' });
    expect(parseStagingItemFilter({ item: `${A},,${B}` })).toEqual({ state: 'invalid', reason: 'bad_id' });
  });

  it('takes 200 items and refuses 201 (never a silently shorter list)', () => {
    const ids = Array.from({ length: STAGING_FILTER_MAX_ITEMS + 1 }, (_, i) => uuid(i + 1));
    const two = parseStagingItemFilter({ item: ids.slice(0, 200) });
    expect(two.state === 'ok' && two.filter.itemIds.length).toBe(200);
    expect(parseStagingItemFilter({ item: ids })).toEqual({ state: 'invalid', reason: 'too_many' });
    // 201 values that dedupe to 200 are 200 items.
    expect(parseStagingItemFilter({ item: [...ids.slice(0, 200), ids[0]!] }).state).toBe('ok');
  });

  it('an order that is not a uuid names no order', () => {
    expect(parseStagingItemFilter({ item: A, order: 'SO-000123' })).toEqual({ state: 'ok', filter: { itemIds: [A], orderId: null } });
  });

  it('the web link and the phone params both read back to the same filter', () => {
    const filter = { orderId: ORDER, itemIds: [A, B] };
    const href = stagingPutAwayHref(filter);
    expect(href).toBe(`/dashboard/inventory/staging?order=${ORDER}&item=${A}&item=${B}`);
    const q = new URL(href, 'https://x.test').searchParams;
    expect(parseStagingItemFilter({ item: q.getAll('item'), order: q.get('order') })).toEqual({ state: 'ok', filter });
    const params = stagingPutAwayParams(filter);
    expect(params).toEqual({ itemIds: `${A},${B}`, orderId: ORDER });
    expect(parseStagingItemFilter({ item: params.itemIds, order: params.orderId })).toEqual({ state: 'ok', filter });
    expect(stagingPutAwayParams({ orderId: null, itemIds: [A] })).toEqual({ itemIds: A });
  });

  it('builds its links by hand: React Native has no working URLSearchParams', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'put-away.ts'), 'utf8');
    expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/URLSearchParams|new URL\(/);
  });
});

// ── The chip ────────────────────────────────────────────────────────────────

describe('the filtered Staging chip (web and phone alike)', () => {
  it('"Showing items from SO-000123 · Show all · Back to the order", and the Unplaced note', () => {
    const chip = describeStagingItemFilter({ orderNumber: 'SO-000123', hasOrder: true, itemCount: 3 });
    expect([chip.headline, chip.showAllLabel, chip.backLabel].join(' · ')).toBe(
      'Showing items from SO-000123 · Show all · Back to the order',
    );
    expect(chip.note).toBe(STAGING_FILTER_UNPLACED_NOTE);
    expect(chip.note).toMatch(/^Only stock in Staging stops a pick\./);
  });

  it('an order whose number could not be read, and a link with no order', () => {
    expect(describeStagingItemFilter({ orderNumber: null, hasOrder: true, itemCount: 3 })).toMatchObject({
      headline: 'Showing items from an order',
      backLabel: STAGING_FILTER_BACK_LABEL,
    });
    expect(describeStagingItemFilter({ orderNumber: null, hasOrder: false, itemCount: 1 })).toMatchObject({
      headline: 'Showing only 1 item',
      showAllLabel: STAGING_FILTER_SHOW_ALL_LABEL,
      backLabel: null,
    });
  });

  it('says why a link was not used', () => {
    expect(stagingFilterInvalidCopy('too_many')).toBe('This link names more than 200 items, so every item is shown.');
    expect(stagingFilterInvalidCopy('bad_id')).toBe("This link's item list couldn't be read, so every item is shown.");
  });
});

describe('honest words (put-away)', () => {
  const a = assess({ lines: [{ id: 'L1', item: 'A', requested: 10 }], items: [item('A', { here: { rack: 6, site: 0, unplaced: 0, staging: 4 } })] });
  const all = [
    PUT_AWAY_LINE_LABEL,
    PUT_AWAY_NEEDS_TRANSFER_COPY,
    putAwayStripLabel(1),
    putAwayStripLabel(3),
    putAwayLineAccessibilityLabel(lineOf(a, 'L1')),
    STAGING_FILTER_UNPLACED_NOTE,
    STAGING_FILTER_EMPTY_COPY,
    stagingFilterInvalidCopy('bad_id'),
    stagingFilterInvalidCopy('too_many'),
    ...Object.values(describeStagingItemFilter({ orderNumber: 'SO-000001', hasOrder: true, itemCount: 2 })),
    ...Object.values(describeStagingItemFilter({ orderNumber: null, hasOrder: false, itemCount: 2 })),
  ].filter((s): s is string => typeof s === 'string');

  it('never "book" for a quantity, never a percentage, never "verified" or "guaranteed"', () => {
    expect(all.filter((s) => /\bbooks?\b|%|verif|guarantee/i.test(s))).toEqual([]);
  });
});
