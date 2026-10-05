import { describe, expect, it } from 'vitest';

import {
  choiceFromKey,
  choiceKey,
  choiceToDecision,
  damagedHint,
  inboundStateLabel,
  isChoiceOffered,
  liveChoice,
  parseRestockOptions,
  preselectedChoice,
  processLabelFor,
  restockOptionRows,
  type RestockOptionsLine,
  type RestockSource,
} from './restock-view';

const R31 = '00000000-0000-4000-8000-000000000031';
const R32 = '00000000-0000-4000-8000-000000000032';
const R33 = '00000000-0000-4000-8000-000000000033';

function src(id: string, name: string, remaining: number, valid = true, reason: string | null = null): RestockSource {
  return { locationId: id, name, kind: 'rack', type: 'shelf', drawn: remaining, restored: 0, remaining, valid, reason };
}

function line(over: Partial<RestockOptionsLine>): RestockOptionsLine {
  return {
    returnLineId: 'line-1',
    itemId: 'item-1',
    quantity: 1,
    disposition: 'restock',
    applied: false,
    plan: null,
    case: 'single_source',
    notRecordedReason: null,
    sources: [src(R31, '31-C', 1)],
    offerOriginal: true,
    offerSourceIds: [],
    preselect: 'original',
    ...over,
  };
}

describe('restock option rows (C1 to C4)', () => {
  it('C1: one recorded rack, preselected, Staging one tap away', () => {
    const l = line({});
    const rows = restockOptionRows(l);
    expect(rows.map((r) => [r.key, r.label, r.enabled])).toEqual([
      ['original', 'Return to original rack: 31-C', true],
      ['staging', 'Leave in Staging', true],
    ]);
    expect(preselectedChoice(l)).toEqual({ disposition: 'restock', target: 'original', locationId: null });
  });

  it('C2: several racks, the full remainder, legs through the shared holdings formatter', () => {
    const l = line({ case: 'full_remainder', quantity: 3, sources: [src(R32, '32-A', 2), src(R31, '31-C', 1)] });
    expect(restockOptionRows(l)[0]!.label).toBe('Return to original racks: 31-C ×1 · 32-A ×2');
    expect(processLabelFor(l, { disposition: 'restock', target: 'original', locationId: null }).button).toBe(
      'Return to 31-C ×1 · 32-A ×2',
    );
  });

  it('C3: partial: each actual source with "up to N", only those with room enabled, Staging preselected', () => {
    const l = line({
      case: 'partial',
      quantity: 2,
      offerOriginal: false,
      preselect: 'staging',
      sources: [src(R31, '31-C', 1), src(R32, '32-A', 3), src(R33, '33-B', 4, false, 'archived')],
      offerSourceIds: [R32],
    });
    const rows = restockOptionRows(l);
    expect(rows.map((r) => [r.key, r.help, r.enabled])).toEqual([
      [`source:${R31}`, 'up to 1', false],
      [`source:${R32}`, 'up to 3', true],
      [`source:${R33}`, 'up to 4', false],
      ['staging', null, true],
    ]);
    expect(rows[0]!.disabledReason).toBe('Room for 1 here; this return is 2.');
    expect(rows[2]!.disabledReason).toBe('Original rack is no longer available. (archived)');
    expect(preselectedChoice(l)).toEqual({ disposition: 'restock', target: 'staging', locationId: null });
    expect(isChoiceOffered(l, { disposition: 'restock', target: 'source', locationId: R32 })).toBe(true);
    expect(isChoiceOffered(l, { disposition: 'restock', target: 'source', locationId: R31 })).toBe(false);
    expect(isChoiceOffered(l, { disposition: 'restock', target: 'original', locationId: null })).toBe(false);
  });

  it('C4: not recorded: the explanation as a disabled row, Staging only', () => {
    const l = line({ case: 'not_recorded', notRecordedReason: 'no_draw', sources: [], offerOriginal: false, preselect: 'staging' });
    const rows = restockOptionRows(l);
    expect(rows[0]).toMatchObject({
      enabled: false,
      label: 'Original rack unavailable. The original pick location was not recorded for this historical order.',
    });
    expect(preselectedChoice(l).target).toBe('staging');
  });

  it.each([
    ['archived', '(archived)'],
    ['moved_warehouse', '(moved to another warehouse)'],
    ['warehouse_inactive', '(its warehouse is closed)'],
    ['not_a_placement', '(no longer a rack)'],
    ['item_deleted', '(the item was deleted)'],
  ])('a rack that failed revalidation (%s) is shown disabled with its reason', (reason, words) => {
    const l = line({ sources: [src(R31, '31-C', 1, false, reason)], offerOriginal: false, preselect: 'staging' });
    const row = restockOptionRows(l)[0]!;
    expect(row.enabled).toBe(false);
    expect(row.disabledReason).toBe(`Original rack is no longer available. ${words}`);
  });
});

describe('preselection and choices', () => {
  it('opens with the live plan while it is still offered, else Staging', () => {
    const planned = line({ plan: { disposition: 'restock', target: 'original', locationId: null, basis: 'single_source', seq: 4 } });
    expect(preselectedChoice(planned).target).toBe('original');
    const gone = line({ ...planned, offerOriginal: false });
    expect(preselectedChoice(gone)).toEqual({ disposition: 'restock', target: 'staging', locationId: null });
    const scrapPlan = line({ plan: { disposition: 'scrap', target: null, locationId: null, basis: null, seq: 2 } });
    expect(preselectedChoice(scrapPlan)).toEqual({ disposition: 'scrap', target: null, locationId: null });
  });

  it('a scrap line has no destination row key, and its decision carries no restock', () => {
    expect(choiceKey({ disposition: 'scrap', target: null, locationId: null })).toBeNull();
    expect(choiceToDecision('l', { disposition: 'scrap', target: 'original', locationId: null })).toEqual({
      returnLineId: 'l',
      disposition: 'scrap',
    });
  });

  it('round-trips keys and builds the RPC decision', () => {
    expect(choiceFromKey('restock', `source:${R32}`)).toEqual({ disposition: 'restock', target: 'source', locationId: R32 });
    expect(choiceFromKey('restock', 'original')).toEqual({ disposition: 'restock', target: 'original', locationId: null });
    expect(choiceFromKey('restock', null).target).toBe('staging');
    expect(choiceToDecision('l', { disposition: 'restock', target: 'source', locationId: R32 })).toEqual({
      returnLineId: 'l',
      disposition: 'restock',
      restock: { target: 'source', locationId: R32 },
    });
    expect(choiceToDecision('l', { disposition: 'restock', target: 'staging', locationId: null })).toEqual({
      returnLineId: 'l',
      disposition: 'restock',
      restock: { target: 'staging' },
    });
  });

  it('never preselects scrap from the reason Damaged; it only adds "Inspect before choosing."', () => {
    expect(damagedHint('damaged')).toBe('Inspect before choosing.');
    expect(damagedHint('other')).toBeNull();
    expect(preselectedChoice(line({})).disposition).toBe('restock');
  });
});

describe('the SQL answer is read defensively', () => {
  it('coerces numbers, drops unknown cases and keeps strings only', () => {
    const o = parseRestockOptions({
      returnId: 'r',
      status: 'approved',
      planSeq: '7',
      lines: [
        {
          returnLineId: 'l',
          itemId: 'i',
          quantity: '2',
          disposition: 'scrap',
          applied: false,
          plan: null,
          case: 'mystery',
          sources: [{ locationId: R31, name: '31-C', remaining: '1', valid: true }],
          offerOriginal: 'yes',
          offerSourceIds: [R31, 5],
          preselect: 'original',
        },
      ],
    });
    expect(o.planSeq).toBe(7);
    expect(o.lines[0]).toMatchObject({ quantity: 2, disposition: 'scrap', case: null, offerOriginal: false, offerSourceIds: [R31] });
    expect(o.lines[0]!.sources[0]!.remaining).toBe(1);
    expect(parseRestockOptions(null)).toEqual({ returnId: '', status: '', planSeq: 0, lines: [] });
  });
});

describe('inbound state per line', () => {
  it('Waiting, Received, Returned to a rack (or racks), In Staging, Scrapped', () => {
    expect(inboundStateLabel({ returnStatus: 'approved', applied: false, disposition: 'restock' })).toBe('Waiting');
    expect(inboundStateLabel({ returnStatus: 'received', applied: false, disposition: 'restock' })).toBe('Received');
    expect(
      inboundStateLabel({ returnStatus: 'closed', applied: true, disposition: 'restock', legs: [{ locationName: '31-C', quantity: 1, rack: true }] }),
    ).toBe('Returned to 31-C');
    expect(
      inboundStateLabel({
        returnStatus: 'closed',
        applied: true,
        disposition: 'restock',
        legs: [
          { locationName: '32-A', quantity: 2, rack: true },
          { locationName: '31-C', quantity: 1, rack: true },
        ],
      }),
    ).toBe('Returned to 31-C ×1 · 32-A ×2');
    expect(inboundStateLabel({ returnStatus: 'closed', applied: true, disposition: 'restock', legs: [] })).toBe('In Staging');
    expect(inboundStateLabel({ returnStatus: 'closed', applied: true, disposition: 'scrap' })).toBe('Scrapped');
  });
});

describe('liveChoice', () => {
  it('reads the live plan, else the legacy default (restock lands in Staging)', () => {
    expect(liveChoice(line({ plan: { disposition: 'restock', target: 'source', locationId: R32, basis: 'manager_choice', seq: 3 } }))).toEqual({
      disposition: 'restock',
      target: 'source',
      locationId: R32,
    });
    expect(liveChoice(line({ plan: null }))).toEqual({ disposition: 'restock', target: 'staging', locationId: null });
    expect(liveChoice(line({ plan: null, disposition: 'scrap' }))).toEqual({ disposition: 'scrap', target: null, locationId: null });
  });
});
