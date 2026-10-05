import { describe, expect, it } from 'vitest';

import type { OrderCatalogAnswer } from '@stockpilot/core';

import {
  PHOTO_REFRESH_MS,
  catalogIsStale,
  catalogItems,
  clockLabel,
  earmarkLabel,
  initialShipFrom,
  matchRequesters,
  photosNeedRefresh,
  quantityFromField,
  requesterRowValue,
  siteAddressLines,
  siteLabel,
} from './setup';

const W = [
  { id: 'w-a', name: 'Annex' },
  { id: 'w-b', name: 'DC4' },
  { id: 'w-c', name: 'East' },
];

describe('Ship from when the storefront opens (plan decision 3)', () => {
  it('a locked cart’s warehouse first', () => {
    expect(initialShipFrom({ warehouses: W, lockedWarehouseIds: ['w-c'], lastUsedId: 'w-b', activeWarehouseId: 'w-a' })).toBe('w-c');
  });
  it('a locked cart’s warehouse even when no longer listed (its send must still be settled)', () => {
    expect(initialShipFrom({ warehouses: W, lockedWarehouseIds: ['w-gone'], lastUsedId: 'w-b', activeWarehouseId: null })).toBe('w-gone');
  });
  it('then the last used for ordering on this phone', () => {
    expect(initialShipFrom({ warehouses: W, lockedWarehouseIds: [], lastUsedId: 'w-b', activeWarehouseId: 'w-a' })).toBe('w-b');
  });
  it('then the workspace’s active warehouse, if it may be ordered from', () => {
    expect(initialShipFrom({ warehouses: W, lockedWarehouseIds: [], lastUsedId: 'w-gone', activeWarehouseId: 'w-c' })).toBe('w-c');
    expect(initialShipFrom({ warehouses: W, lockedWarehouseIds: [], lastUsedId: null, activeWarehouseId: 'w-hidden' })).toBe('w-a');
  });
  it('then the first by name; none when there is none', () => {
    expect(initialShipFrom({ warehouses: W, lockedWarehouseIds: [], lastUsedId: null, activeWarehouseId: null })).toBe('w-a');
    expect(initialShipFrom({ warehouses: [], lockedWarehouseIds: [], lastUsedId: null, activeWarehouseId: null })).toBeNull();
  });
});

describe('the catalog rows', () => {
  const answer = {
    items: [
      { id: 'i1', sku: 'S', name: 'Planner', categoryId: 'c1', charterId: 'ch', rackLabel: '1-A', quantityOnHand: 4, reservedQuantity: 1, reorderPoint: 2 },
      { id: 'i2', sku: 'T', name: 'Mug', categoryId: null, charterId: null, rackLabel: null, quantityOnHand: 0, reservedQuantity: 0, reorderPoint: 0 },
    ],
    aisles: [{ id: 'c1', name: 'Paper', itemCount: 1 }, { id: null, name: 'Uncategorized', itemCount: 1 }],
    charters: { ch: { name: 'North Campus', code: 'NC' } },
  } as unknown as OrderCatalogAnswer;

  it('names the category and the earmark, field by field', () => {
    const [a, b] = catalogItems(answer);
    expect(a).toEqual({
      id: 'i1',
      sku: 'S',
      name: 'Planner',
      quantityOnHand: 4,
      reservedQuantity: 1,
      categoryId: 'c1',
      categoryName: 'Paper',
      charterId: 'ch',
      charterName: 'North Campus',
      charterCode: 'NC',
      rackLabel: '1-A',
      reorderPoint: 2,
    });
    expect(b).toMatchObject({ categoryName: null, charterName: null });
    expect(earmarkLabel(a!)).toBe('NC');
    expect(earmarkLabel({ charterCode: null, charterName: 'North' })).toBe('North');
    expect(earmarkLabel(b!)).toBeNull();
  });
});

describe('sites and requesters', () => {
  it('an address prints its lines, and nothing for none', () => {
    expect(siteAddressLines({ line1: '1 Main St', line2: '', city: 'Fresno', region: 'CA', postalCode: '93701' })).toEqual([
      '1 Main St',
      'Fresno, CA 93701',
    ]);
    expect(siteAddressLines(null)).toEqual([]);
    expect(siteAddressLines({})).toEqual([]);
    expect(siteLabel({ name: 'North', code: 'N' })).toBe('North (N)');
    expect(siteLabel({ name: 'North', code: null })).toBe('North');
  });

  it('recent requesters: every word in the name or email', () => {
    const people = [
      { name: 'Maria Lopez', email: 'maria@example.org', lastOrderedAt: '', orders: 1, lastFulfillment: null, lastSiteId: null },
      { name: null, email: 'sam@school.org', lastOrderedAt: '', orders: 2, lastFulfillment: null, lastSiteId: null },
    ];
    expect(matchRequesters(people, 'maria').map((p) => p.email)).toEqual(['maria@example.org']);
    expect(matchRequesters(people, 'school sam').map((p) => p.email)).toEqual(['sam@school.org']);
    expect(matchRequesters(people, '  ')).toHaveLength(2);
  });

  it('the For row', () => {
    expect(requesterRowValue(null)).toBe('Myself');
    expect(requesterRowValue({ name: 'Maria', email: 'm@x.org' })).toBe('Maria · m@x.org');
    expect(requesterRowValue({ name: '', email: '' })).toBe('Myself');
  });
});

describe('freshness (never on a timer)', () => {
  it('the catalog is read again once older than its stale time', () => {
    expect(catalogIsStale(null, 1000)).toBe(true);
    expect(catalogIsStale(0, 59_999)).toBe(false);
    expect(catalogIsStale(0, 60_000)).toBe(true);
    expect(catalogIsStale(0, 10_000, 5)).toBe(true);
  });

  it('photos after 4 hours, near expiry, or after a failed image', () => {
    const signedAt = '2026-10-04T00:00:00.000Z';
    const expiresAt = '2026-11-03T00:00:00.000Z';
    const t0 = Date.parse(signedAt);
    expect(photosNeedRefresh(null, t0, false)).toBe(true);
    expect(photosNeedRefresh({ signedAt, expiresAt }, t0 + 1000, false)).toBe(false);
    expect(photosNeedRefresh({ signedAt, expiresAt }, t0 + 1000, true)).toBe(true);
    expect(photosNeedRefresh({ signedAt, expiresAt }, t0 + PHOTO_REFRESH_MS, false)).toBe(true);
    expect(photosNeedRefresh({ signedAt: 'x', expiresAt }, t0, false)).toBe(true);
  });

  it('"9:41 AM" on the phone’s clock', () => {
    const d = new Date(2026, 9, 4, 9, 41);
    expect(clockLabel(d.getTime())).toBe('9:41 AM');
    expect(clockLabel(new Date(2026, 9, 4, 0, 5).getTime())).toBe('12:05 AM');
    expect(clockLabel(new Date(2026, 9, 4, 13, 0).getTime())).toBe('1:00 PM');
  });
});

// PO-4 review: the quantity sheet opens with its text selected, so one
// backspace and Set quantity sent 0 and removed the line ("Removed X from
// your cart."). The web's quantity field keeps the quantity for a blank one
// (storefront-cards.tsx QtyField).
describe('the quantity sheet’s field (PO-4 review)', () => {
  it('blank keeps the quantity (nothing to set)', () => {
    expect(quantityFromField('', 10)).toBeNull();
  });
  it('0 removes the line; a number is clamped to what is available', () => {
    expect(quantityFromField('0', 10)).toBe(0);
    expect(quantityFromField('7', 10)).toBe(7);
    expect(quantityFromField('007', 10)).toBe(7);
    expect(quantityFromField('99', 10)).toBe(10);
  });
});
