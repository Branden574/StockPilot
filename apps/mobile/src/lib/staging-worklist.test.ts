import { describe, expect, it } from 'vitest';

import {
  canPlaceStagingRow,
  isStagingStale,
  parseStagingWorklist,
  STAGING_EMPTY,
  STAGING_NO_WAREHOUSE_REASON,
  STAGING_STALE_LABEL,
  STAGING_STALE_THRESHOLD_DAYS,
  STAGING_TYPE_OPTIONS,
  stagingAgeLabel,
  stagingCountLabel,
  stagingPlaceDisabledReason,
  stagingReceivedLabel,
  stagingRowKey,
  stagingSourceKindLabel,
  stagingSourceLabel,
  stagingWarehouseLabel,
  stagingWarehouseNameMap,
  stagingWorklistPath,
} from './staging-worklist';

/**
 * The native Staging screen's whole testable surface.
 *
 * The binding requirement is PARITY: for the same row, the phone must print
 * the same words the web staging table prints. So most assertions below are
 * written against apps/web/src/components/inventory/staging-table.tsx —
 * SourceCell, AgeBadge, the received cell, the warehouse cell and the
 * staged/unplaced badge — and the received-date test uses the browser's own
 * Intl implementation as the ORACLE, because Hermes has no
 * Intl.RelativeTimeFormat and the phone has to reproduce its output by hand.
 *
 * (This file previously covered a provenance union that has since been
 * reverted; those cases are gone because the code they described is gone, not
 * because the behaviour stopped mattering. The parity cases replacing them are
 * strictly stricter — they pin exact rendered strings.)
 */

const NOW = new Date('2026-07-22T12:00:00.000Z');

function wireRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: '11111111-1111-4111-8111-111111111111',
    name: 'Blue Widget',
    sku: 'BW-001',
    itemType: 'non-book',
    warehouseId: '22222222-2222-4222-8222-222222222222',
    sourceLocationId: '33333333-3333-4333-8333-333333333333',
    sourceKind: 'staging',
    quantity: 10,
    sourceReceiptId: '44444444-4444-4444-8444-444444444444',
    sourcePoNumber: 'CVW-002201',
    receiptNumber: 'RCV-1042',
    receivedAt: '2026-07-20T12:00:00.000Z',
    ageDays: 2,
    ...overrides,
  };
}

// The web helper, copied verbatim from apps/web/src/lib/utils.ts, used as the
// oracle for stagingReceivedLabel(). If web's wording ever changes, these
// assertions change with it — which is exactly the coupling we want.
function webFormatRelative(date: string, now: Date) {
  const d = new Date(date);
  const diff = (d.getTime() - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 60 * 60 * 24 * 365],
    ['month', 60 * 60 * 24 * 30],
    ['week', 60 * 60 * 24 * 7],
    ['day', 60 * 60 * 24],
    ['hour', 60 * 60],
    ['minute', 60],
    ['second', 1],
  ];
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs || unit === 'second') {
      return rtf.format(Math.round(diff / secs), unit);
    }
  }
  return '';
}

describe('stagingWorklistPath', () => {
  it('sends no type param for the All filter', () => {
    // ?type=all would fail the route's zod enum and 400 the whole screen.
    expect(stagingWorklistPath('all')).toBe('/api/v1/inventory/staging');
  });
  it('mirrors the web page ?type= values exactly', () => {
    expect(stagingWorklistPath('book')).toBe('/api/v1/inventory/staging?type=book');
    expect(stagingWorklistPath('non-book')).toBe(
      '/api/v1/inventory/staging?type=non-book',
    );
  });

  // The web page narrows the worklist to the active-warehouse cookie
  // (getActiveWarehouseFilter). Mobile has no cookie, so the picked warehouse
  // has to travel as a query param — otherwise a user who has selected
  // "Warehouse B" in the drawer switcher sees Warehouse A's staged stock on the
  // phone and not in the browser, and the two surfaces disagree about the row
  // set for the same person at the same moment.
  it('narrows to the active warehouse, on its own and alongside the type filter', () => {
    expect(stagingWorklistPath('all', 'w-1')).toBe(
      '/api/v1/inventory/staging?warehouseId=w-1',
    );
    expect(stagingWorklistPath('book', 'w-1')).toBe(
      '/api/v1/inventory/staging?type=book&warehouseId=w-1',
    );
  });

  it('treats "all warehouses" as no param at all', () => {
    // The switcher's "All warehouses" is null, and the route's zod schema wants
    // a UUID — sending an empty warehouseId would 400 the whole screen rather
    // than widen it.
    expect(stagingWorklistPath('all', null)).toBe('/api/v1/inventory/staging');
    expect(stagingWorklistPath('book', undefined)).toBe(
      '/api/v1/inventory/staging?type=book',
    );
    expect(stagingWorklistPath('book', '   ')).toBe('/api/v1/inventory/staging?type=book');
  });
  it('offers the same three buckets, labelled like the web toolbar', () => {
    expect(STAGING_TYPE_OPTIONS.map((o) => o.value)).toEqual([
      'all',
      'book',
      'non-book',
    ]);
    expect(STAGING_TYPE_OPTIONS.map((o) => o.label)).toEqual([
      'All',
      'Books',
      'Items',
    ]);
  });
});

describe('age + staleness match the web table', () => {
  it('uses the same 7-day threshold, strictly greater-than', () => {
    expect(STAGING_STALE_THRESHOLD_DAYS).toBe(7);
    expect(isStagingStale(7)).toBe(false);
    expect(isStagingStale(8)).toBe(true);
  });
  it('renders the web AgeBadge strings, em dash included', () => {
    expect(isStagingStale(null)).toBe(false);
    // Web's AgeBadge returns "—" for a null age, NOT an empty cell: a blank
    // would read as zero days, a different (and false) claim.
    expect(stagingAgeLabel(null)).toBe(STAGING_EMPTY);
    expect(stagingAgeLabel(0)).toBe('0d');
    expect(stagingAgeLabel(12)).toBe('12d');
    expect(STAGING_STALE_LABEL).toBe('Stale');
  });
});

describe('source cell parity with the web SourceCell', () => {
  it('joins PO and receipt with a spaced slash', () => {
    expect(stagingSourceLabel('CVW-002201', 'RCV-1042')).toBe('CVW-002201 / RCV-1042');
  });
  it('shows whichever identifier exists on its own', () => {
    expect(stagingSourceLabel('CVW-002201', null)).toBe('CVW-002201');
    expect(stagingSourceLabel(null, 'RCV-1042')).toBe('RCV-1042');
  });
  it('shows the em dash when the row has no PO source at all', () => {
    // This is the non-PO row: manual add, transfer into staging, unplaced
    // stock. Web prints "—" and so must the phone — no locally invented
    // sentence about where it might have come from.
    expect(stagingSourceLabel(null, null)).toBe(STAGING_EMPTY);
  });
  it('labels the bucket badge with web\'s capitalised sourceKind', () => {
    // Web renders the raw value under CSS `capitalize`.
    expect(stagingSourceKindLabel('staging')).toBe('Staging');
    expect(stagingSourceKindLabel('unplaced')).toBe('Unplaced');
  });
});

describe('received cell parity with the web formatRelative', () => {
  const offsets: [string, number][] = [
    ['3 seconds', 3_000],
    ['45 seconds', 45_000],
    ['1 minute', 60_000],
    ['5 minutes', 5 * 60_000],
    ['1 hour', 60 * 60_000],
    ['5 hours', 5 * 60 * 60_000],
    ['1 day', 24 * 60 * 60_000],
    ['2 days', 2 * 24 * 60 * 60_000],
    ['6 days', 6 * 24 * 60 * 60_000],
    ['1 week', 7 * 24 * 60 * 60_000],
    ['3 weeks', 21 * 24 * 60 * 60_000],
    ['1 month', 30 * 24 * 60 * 60_000],
    ['5 months', 150 * 24 * 60 * 60_000],
    ['1 year', 365 * 24 * 60 * 60_000],
    ['3 years', 3 * 365 * 24 * 60 * 60_000],
  ];

  it.each(offsets)('says exactly what the browser says, %s ago', (_label, ms) => {
    const when = new Date(NOW.getTime() - ms).toISOString();
    expect(stagingReceivedLabel(when, NOW)).toBe(webFormatRelative(when, NOW));
  });

  it('keeps the "yesterday" / "last week" wording Intl substitutes', () => {
    // The reason this cannot be a naive "Nd ago" formatter: numeric:'auto'
    // swaps in words for ±1, and the browser shows those words.
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString();
    const lastWeek = new Date(NOW.getTime() - 7 * 24 * 60 * 60_000).toISOString();
    expect(stagingReceivedLabel(yesterday, NOW)).toBe('yesterday');
    expect(stagingReceivedLabel(lastWeek, NOW)).toBe('last week');
    expect(stagingReceivedLabel(NOW.toISOString(), NOW)).toBe('now');
  });

  it('shows the em dash for a row with no received date', () => {
    expect(stagingReceivedLabel(null, NOW)).toBe(STAGING_EMPTY);
    expect(stagingReceivedLabel('not-a-date', NOW)).toBe(STAGING_EMPTY);
  });
});

describe('warehouse cell parity', () => {
  const names = { 'wh-1': 'Main Warehouse' };
  it('prefers the resolved name', () => {
    expect(stagingWarehouseLabel('wh-1', names)).toBe('Main Warehouse');
  });
  it('falls back to the same truncated id web shows for an unknown warehouse', () => {
    expect(stagingWarehouseLabel('22222222-2222-4222-8222-222222222222', names)).toBe(
      '22222222…',
    );
  });
  it('shows the em dash when the holding has no warehouse', () => {
    expect(stagingWarehouseLabel(null, names)).toBe(STAGING_EMPTY);
  });

  it('builds the name map from the SAME population web builds it from', () => {
    // Web's WarehousesService.listNames() selects status = 'active' only, so a
    // staged row in an INACTIVE warehouse falls through to the truncated UUID
    // in the browser. The phone's drawer switcher list is wider (it drops only
    // archived), and feeding that here printed a NAME on the phone for the very
    // same row — two surfaces describing one row differently.
    const map = stagingWarehouseNameMap([
      { id: 'wh-active', name: 'Main Warehouse', status: 'active' },
      { id: 'wh-inactive', name: 'Old Annex', status: 'inactive' },
      { id: 'wh-archived', name: 'Closed Depot', status: 'archived' },
      { id: 'wh-unknown', name: 'Mystery', status: null },
    ]);
    expect(map).toEqual({ 'wh-active': 'Main Warehouse' });
    // …and therefore the cell reads exactly as the browser's does.
    expect(stagingWarehouseLabel('wh-active', map)).toBe('Main Warehouse');
    expect(stagingWarehouseLabel('wh-inactive', map)).toBe('wh-inact…');
  });
});

describe('row identity + place gating', () => {
  it('keys on the composite — one item can hold BOTH staging and unplaced', () => {
    const a = { itemId: 'i1', sourceLocationId: 'staging-loc' };
    const b = { itemId: 'i1', sourceLocationId: 'unplaced-loc' };
    expect(stagingRowKey(a)).not.toBe(stagingRowKey(b));
    expect(stagingRowKey(a)).toBe('i1::staging-loc');
  });
  it('hides Place without the permission, and for a holding with no warehouse', () => {
    expect(canPlaceStagingRow({ warehouseId: 'w1' }, true)).toBe(true);
    expect(canPlaceStagingRow({ warehouseId: 'w1' }, false)).toBe(false);
    // No warehouse → no warehouse to scope destination racks to.
    expect(canPlaceStagingRow({ warehouseId: null }, true)).toBe(false);
  });
  it('gives the un-placeable row the same reason web puts on its disabled button', () => {
    // Web renders a DISABLED Place carrying "No warehouse — cannot place";
    // mobile rendered no control at all, which reads as "this row is different
    // somehow" rather than "this row cannot be placed, and here is why".
    expect(stagingPlaceDisabledReason({ warehouseId: null }, true)).toBe(
      STAGING_NO_WAREHOUSE_REASON,
    );
    expect(STAGING_NO_WAREHOUSE_REASON).toBe('No warehouse — cannot place');
    // A placeable row has nothing to explain…
    expect(stagingPlaceDisabledReason({ warehouseId: 'w1' }, true)).toBeNull();
    // …and without the permission web renders no Actions column at all, so the
    // phone must not invent a disabled button either.
    expect(stagingPlaceDisabledReason({ warehouseId: null }, false)).toBeNull();
  });
  it('pluralises the count like the web toolbar', () => {
    expect(stagingCountLabel(0)).toBe('0 items');
    expect(stagingCountLabel(1)).toBe('1 item');
    expect(stagingCountLabel(12)).toBe('12 items');
  });
});

describe('parseStagingWorklist', () => {
  it('parses a normal payload field for field', () => {
    const out = parseStagingWorklist({ rows: [wireRow()], canPlace: true });
    expect(out.canPlace).toBe(true);
    expect(out.rows).toHaveLength(1);
    const row = out.rows[0]!;
    expect(row.sourcePoNumber).toBe('CVW-002201');
    expect(row.receiptNumber).toBe('RCV-1042');
    expect(row.quantity).toBe(10);
    expect(row.ageDays).toBe(2);
    expect(row.receivedAt).toBe('2026-07-20T12:00:00.000Z');
  });

  it('keeps a non-PO row rather than dropping it, with null source fields', () => {
    const out = parseStagingWorklist({
      rows: [
        wireRow({
          sourceKind: 'unplaced',
          sourceReceiptId: null,
          sourcePoNumber: null,
          receiptNumber: null,
          receivedAt: null,
          ageDays: null,
        }),
      ],
      canPlace: true,
    });
    expect(out.rows).toHaveLength(1);
    const row = out.rows[0]!;
    expect(stagingSourceLabel(row.sourcePoNumber, row.receiptNumber)).toBe(STAGING_EMPTY);
    expect(stagingReceivedLabel(row.receivedAt, NOW)).toBe(STAGING_EMPTY);
    expect(stagingAgeLabel(row.ageDays)).toBe(STAGING_EMPTY);
  });

  it('defaults sourceKind to staging and drops only rows with no identity', () => {
    const out = parseStagingWorklist({
      rows: [
        wireRow({ sourceKind: 'unplaced' }),
        wireRow({ sourceKind: 'bogus' }),
        wireRow({ itemId: null }),
        wireRow({ sourceLocationId: undefined }),
        'not-an-object',
      ],
      canPlace: true,
    });
    expect(out.rows.map((r) => r.sourceKind)).toEqual(['unplaced', 'staging']);
  });

  it('never trusts canPlace loosely — only a literal true unlocks Place', () => {
    expect(parseStagingWorklist({ rows: [], canPlace: 'yes' }).canPlace).toBe(false);
    expect(parseStagingWorklist({ rows: [] }).canPlace).toBe(false);
  });

  it('fails soft on a garbage body instead of throwing the screen away', () => {
    expect(parseStagingWorklist(null)).toEqual({ rows: [], canPlace: false });
    expect(parseStagingWorklist('boom')).toEqual({ rows: [], canPlace: false });
    expect(parseStagingWorklist({ rows: 'nope' })).toEqual({ rows: [], canPlace: false });
  });
});
