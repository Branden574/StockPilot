import { describe, expect, it } from 'vitest';

import {
  HOLDINGS_ELSEWHERE_MAX_IDS,
  chunkHoldingsElsewhereIds,
  holdingsElsewhereTotal,
  itemElsewhereFrom,
  parseHoldingsElsewhereRows,
} from './holdings-elsewhere';

// The item_holdings_elsewhere contract (0371). The RPC returns, per item a
// scoped member can read, the totals outside their holdings scope. These tests
// pin how the answer is read, because the failure that matters is a SILENT
// one: a payload read as "nothing hidden" when it was not.

describe('parseHoldingsElsewhereRows', () => {
  it('reads the literal row shape, numeric strings included', () => {
    const map = parseHoldingsElsewhereRows([
      {
        item_id: 'i1',
        staged: '5',
        unplaced: 0,
        placed: 7,
        placed_location_ids: ['loc-b', 'loc-a'],
      },
    ]);
    expect(map.get('i1')).toEqual({
      staged: 5,
      unplaced: 0,
      placed: 7,
      placedLocationIds: ['loc-a', 'loc-b'],
    });
  });

  it('treats an empty or bodiless answer as nothing hidden', () => {
    expect(parseHoldingsElsewhereRows([]).size).toBe(0);
    expect(parseHoldingsElsewhereRows(null).size).toBe(0);
  });

  it('keeps an empty placed-location list when the hidden stock is all in Staging', () => {
    const map = parseHoldingsElsewhereRows([
      { item_id: 'i1', staged: 5, unplaced: 0, placed: 0, placed_location_ids: [] },
    ]);
    expect(map.get('i1')?.placedLocationIds).toEqual([]);
  });

  it('THROWS on a malformed payload, so a caller can never read it as "nothing hidden"', () => {
    expect(() => parseHoldingsElsewhereRows({ item_id: 'i1' })).toThrow();
    expect(() => parseHoldingsElsewhereRows([{ staged: 1, unplaced: 0, placed: 0 }])).toThrow();
    expect(() =>
      parseHoldingsElsewhereRows([{ item_id: 'i1', staged: 'x', unplaced: 0, placed: 0 }]),
    ).toThrow();
    expect(() => parseHoldingsElsewhereRows(['i1'])).toThrow();
  });

  it('sums a duplicate item rather than letting the later row overwrite the earlier', () => {
    const map = parseHoldingsElsewhereRows([
      { item_id: 'i1', staged: 1, unplaced: 2, placed: 3, placed_location_ids: ['a'] },
      { item_id: 'i1', staged: 1, unplaced: 0, placed: 4, placed_location_ids: ['b', 'a'] },
    ]);
    expect(map.get('i1')).toEqual({
      staged: 2,
      unplaced: 2,
      placed: 7,
      placedLocationIds: ['a', 'b'],
    });
  });
});

describe('holdingsElsewhereTotal', () => {
  it('adds all three buckets', () => {
    expect(
      holdingsElsewhereTotal({ staged: 5, unplaced: 1, placed: 7, placedLocationIds: ['a'] }),
    ).toBe(13);
  });
  it('is 0 for nothing', () => {
    expect(holdingsElsewhereTotal(null)).toBe(0);
    expect(holdingsElsewhereTotal(undefined)).toBe(0);
  });
});

describe('itemElsewhereFrom', () => {
  const byItem = new Map([
    ['i1', { staged: 5, unplaced: 0, placed: 7, placedLocationIds: ['a'] }],
    ['i0', { staged: 0, unplaced: 0, placed: 0, placedLocationIds: [] }],
  ]);

  it('reports the totals for an item with hidden stock', () => {
    expect(itemElsewhereFrom(byItem, 'i1')).toEqual({
      status: 'some',
      staged: 5,
      unplaced: 0,
      placed: 7,
      placedLocationIds: ['a'],
    });
  });

  it('reports none for an item with no row, or a row that sums to zero', () => {
    expect(itemElsewhereFrom(byItem, 'missing')).toEqual({ status: 'none' });
    expect(itemElsewhereFrom(byItem, 'i0')).toEqual({ status: 'none' });
  });

  it('reports UNAVAILABLE when the read failed, never none', () => {
    expect(itemElsewhereFrom(null, 'i1')).toEqual({ status: 'unavailable' });
  });
});

describe('chunkHoldingsElsewhereIds', () => {
  it('never puts more than the RPC bound in one call', () => {
    const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
    const chunks = chunkHoldingsElsewhereIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 1]);
    expect(HOLDINGS_ELSEWHERE_MAX_IDS).toBe(500);
  });

  it('drops duplicates and blanks', () => {
    expect(chunkHoldingsElsewhereIds(['a', 'a', '', null, undefined, 'b'])).toEqual([['a', 'b']]);
  });

  it('asks nothing for no ids', () => {
    expect(chunkHoldingsElsewhereIds([])).toEqual([]);
  });
});
