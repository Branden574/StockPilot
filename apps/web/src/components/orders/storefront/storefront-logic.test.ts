import { describe, expect, it } from 'vitest';

import { DELIVERY_REQUEST_EMAIL } from '@/lib/site';

import type { CatalogItem } from '../v2/types';

import {
  availabilityLabel,
  availableOf,
  buildClipboardText,
  buildDeliveryRequestDraft,
  buildMailtoUrl,
  buildOutlookComposeUrl,
  buildQtyMap,
  cartTotals,
  clampQty,
  DRAFT_URL_LIMIT,
  filterCatalog,
  formatSiteAddressLines,
  fullKitLines,
  glyphFor,
  isBrowsingAll,
  prepareDeliveryRequest,
  successRefLine,
  sortCatalog,
  statusOf,
  type ItemStatus,
} from './storefront-logic';

import type { DeliveryRequestInput } from './storefront-logic';

let seq = 0;
function makeItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  seq += 1;
  return {
    id: overrides.id ?? `item-${seq}`,
    sku: `SKU-${seq}`,
    name: `Item ${seq}`,
    warehouseId: 'wh-1',
    quantityOnHand: 10,
    reservedQuantity: 0,
    itemType: null,
    categoryId: null,
    categoryName: null,
    charterId: null,
    charterName: null,
    charterCode: null,
    rackLabel: null,
    imageUrl: null,
    lqip: null,
    price: null,
    reorderPoint: 0,
    ...overrides,
  };
}

describe('availableOf / statusOf', () => {
  it('subtracts reserved from on-hand and floors at 0', () => {
    expect(availableOf(makeItem({ quantityOnHand: 10, reservedQuantity: 3 }))).toBe(7);
    expect(availableOf(makeItem({ quantityOnHand: 2, reservedQuantity: 5 }))).toBe(0);
  });

  it('is ok when available exceeds the reorder point', () => {
    const it_ = makeItem({ quantityOnHand: 20, reservedQuantity: 0, reorderPoint: 5 });
    expect(statusOf(it_)).toBe('ok');
  });

  it('is low when available is at or below the reorder point (nonzero avail)', () => {
    expect(
      statusOf(makeItem({ quantityOnHand: 5, reservedQuantity: 0, reorderPoint: 5 })),
    ).toBe('low');
    expect(
      statusOf(makeItem({ quantityOnHand: 3, reservedQuantity: 0, reorderPoint: 5 })),
    ).toBe('low');
  });

  it('is out when nothing is available — including via reservations', () => {
    expect(statusOf(makeItem({ quantityOnHand: 0, reservedQuantity: 0 }))).toBe('out');
    // 4 on hand but all 4 reserved → out, not ok
    expect(
      statusOf(makeItem({ quantityOnHand: 4, reservedQuantity: 4, reorderPoint: 2 })),
    ).toBe('out');
  });

  it('reservations can flip ok → low', () => {
    // 10 on hand, reorder point 5: ok. Reserve 6 → 4 available → low.
    expect(
      statusOf(makeItem({ quantityOnHand: 10, reservedQuantity: 6, reorderPoint: 5 })),
    ).toBe('low');
  });

  it('a zero reorder point never reports low', () => {
    expect(
      statusOf(makeItem({ quantityOnHand: 1, reservedQuantity: 0, reorderPoint: 0 })),
    ).toBe('ok');
  });

  it('availabilityLabel matches the spec copy', () => {
    expect(availabilityLabel('ok', 107)).toBe('107 avail');
    expect(availabilityLabel('low', 8)).toBe('Low · 8 left');
    expect(availabilityLabel('out', 0)).toBe('Out of stock');
  });
});

describe('filterCatalog', () => {
  const planner = makeItem({
    id: 'planner',
    name: 'L4L Weekly Planner',
    sku: 'PLN-001',
    categoryId: 'cat-office',
    categoryName: 'Office',
    quantityOnHand: 50,
  });
  const poloW = makeItem({
    id: 'polo-w',
    name: "L4L Polo (Women's)",
    sku: 'POL-W',
    categoryId: 'cat-apparel',
    categoryName: 'Apparel',
    quantityOnHand: 3,
    reorderPoint: 5,
  });
  const mug = makeItem({
    id: 'mug',
    name: 'Camp Mug',
    sku: 'MUG-11',
    categoryId: 'cat-office',
    categoryName: 'Office',
    quantityOnHand: 0,
  });
  const loose = makeItem({
    id: 'loose',
    name: 'Loose Item',
    sku: 'LOOSE-1',
    categoryId: null,
    categoryName: null,
  });
  const all = [planner, poloW, mug, loose];
  const none = new Set<ItemStatus>();

  it('passes everything through with no filters', () => {
    expect(
      filterCatalog(all, { category: 'all', search: '', availability: none }),
    ).toHaveLength(4);
  });

  it('filters by category id and by the uncategorized bucket', () => {
    const office = filterCatalog(all, {
      category: 'cat-office',
      search: '',
      availability: none,
    });
    expect(office.map((i) => i.id)).toEqual(['planner', 'mug']);

    const uncat = filterCatalog(all, {
      category: 'uncategorized',
      search: '',
      availability: none,
    });
    expect(uncat.map((i) => i.id)).toEqual(['loose']);
  });

  it('searches across name, SKU, and category (case-insensitive)', () => {
    const byName = filterCatalog(all, {
      category: 'all',
      search: 'planner',
      availability: none,
    });
    expect(byName.map((i) => i.id)).toEqual(['planner']);

    const bySku = filterCatalog(all, {
      category: 'all',
      search: 'pol-w',
      availability: none,
    });
    expect(bySku.map((i) => i.id)).toEqual(['polo-w']);

    const byCategory = filterCatalog(all, {
      category: 'all',
      search: 'apparel',
      availability: none,
    });
    expect(byCategory.map((i) => i.id)).toEqual(['polo-w']);
  });

  it('requires every search token to match', () => {
    const hit = filterCatalog(all, {
      category: 'all',
      search: 'polo women',
      availability: none,
    });
    expect(hit.map((i) => i.id)).toEqual(['polo-w']);

    const miss = filterCatalog(all, {
      category: 'all',
      search: 'polo planner',
      availability: none,
    });
    expect(miss).toHaveLength(0);
  });

  it('filters by availability status set', () => {
    const outOnly = filterCatalog(all, {
      category: 'all',
      search: '',
      availability: new Set<ItemStatus>(['out']),
    });
    expect(outOnly.map((i) => i.id)).toEqual(['mug']);

    const lowOrOut = filterCatalog(all, {
      category: 'all',
      search: '',
      availability: new Set<ItemStatus>(['low', 'out']),
    });
    expect(lowOrOut.map((i) => i.id)).toEqual(['polo-w', 'mug']);
  });

  it('composes category + search + availability', () => {
    const composed = filterCatalog(all, {
      category: 'cat-office',
      search: 'mug',
      availability: new Set<ItemStatus>(['out']),
    });
    expect(composed.map((i) => i.id)).toEqual(['mug']);

    // Same search but availability excludes it → empty
    const excluded = filterCatalog(all, {
      category: 'cat-office',
      search: 'mug',
      availability: new Set<ItemStatus>(['ok']),
    });
    expect(excluded).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const before = all.slice();
    filterCatalog(all, { category: 'all', search: 'x', availability: none });
    expect(all).toEqual(before);
  });
});

describe('sortCatalog', () => {
  const a = makeItem({ id: 'a', name: 'Backpack', quantityOnHand: 5 });
  const b = makeItem({ id: 'b', name: 'Apron', quantityOnHand: 20, reservedQuantity: 2 });
  const c = makeItem({ id: 'c', name: 'Towel', quantityOnHand: 1 });
  const list = [a, b, c];

  it('featured keeps catalog order', () => {
    expect(sortCatalog(list, 'featured').map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('name-asc / name-desc sort alphabetically', () => {
    expect(sortCatalog(list, 'name-asc').map((i) => i.name)).toEqual([
      'Apron',
      'Backpack',
      'Towel',
    ]);
    expect(sortCatalog(list, 'name-desc').map((i) => i.name)).toEqual([
      'Towel',
      'Backpack',
      'Apron',
    ]);
  });

  it('stock-desc / stock-asc sort by AVAILABLE (reserved subtracted)', () => {
    // b has 20 on hand but 2 reserved → 18 available; still the most.
    expect(sortCatalog(list, 'stock-desc').map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(sortCatalog(list, 'stock-asc').map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('freq ranks by the frequency map, unordered items sink, ties stay stable', () => {
    const freq = new Map([
      ['c', 9],
      ['a', 2],
    ]);
    expect(sortCatalog(list, 'freq', freq).map((i) => i.id)).toEqual(['c', 'a', 'b']);
    // No map at all → order unchanged (all zero, stable sort)
    expect(sortCatalog(list, 'freq').map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const before = list.slice();
    sortCatalog(list, 'name-desc');
    expect(list).toEqual(before);
  });
});

describe('fullKitLines', () => {
  it('adds one of each in-stock item and skips out-of-stock ones', () => {
    const inStock = makeItem({ id: 'k1', quantityOnHand: 4 });
    const low = makeItem({ id: 'k2', quantityOnHand: 2, reorderPoint: 5 });
    const outHard = makeItem({ id: 'k3', quantityOnHand: 0 });
    const outReserved = makeItem({ id: 'k4', quantityOnHand: 3, reservedQuantity: 3 });

    const lines = fullKitLines([inStock, low, outHard, outReserved]);
    expect(lines).toEqual([
      { itemId: 'k1', quantity: 1 },
      { itemId: 'k2', quantity: 1 },
    ]);
  });

  it('returns an empty list when everything is out', () => {
    expect(fullKitLines([makeItem({ quantityOnHand: 0 })])).toEqual([]);
  });
});

describe('cartTotals / buildQtyMap', () => {
  it('sums line count and unit count', () => {
    const lines = [
      { itemId: 'a', quantity: 3 },
      { itemId: 'b', quantity: 4 },
    ];
    expect(cartTotals(lines)).toEqual({ lineCount: 2, unitCount: 7 });
    expect(cartTotals([])).toEqual({ lineCount: 0, unitCount: 0 });
  });

  it('buildQtyMap maps itemId → qty', () => {
    const map = buildQtyMap([
      { itemId: 'a', quantity: 3 },
      { itemId: 'b', quantity: 1 },
    ]);
    expect(map.get('a')).toBe(3);
    expect(map.get('b')).toBe(1);
    expect(map.get('zzz')).toBeUndefined();
  });
});

describe('clampQty', () => {
  it('floors fractional input and clamps to [0, available]', () => {
    expect(clampQty(5.7, 10)).toBe(5);
    expect(clampQty(99, 10)).toBe(10);
    expect(clampQty(-2, 10)).toBe(0);
    expect(clampQty(0, 10)).toBe(0);
    expect(clampQty(10, 10)).toBe(10);
  });

  it('treats non-finite input as 0 and tolerates non-positive available', () => {
    expect(clampQty(Number.NaN, 10)).toBe(0);
    expect(clampQty(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(clampQty(3, 0)).toBe(0);
    expect(clampQty(3, -4)).toBe(0);
  });
});

describe('misc helpers', () => {
  it('glyphFor strips the L4L prefix and takes two initials', () => {
    expect(glyphFor('L4L Water Bottle')).toBe('WB');
    expect(glyphFor('Planner')).toBe('P');
  });

  it('isBrowsingAll only when no category/search/availability filter', () => {
    const none = new Set<ItemStatus>();
    expect(isBrowsingAll({ category: 'all', search: '', availability: none })).toBe(true);
    expect(isBrowsingAll({ category: 'all', search: '  ', availability: none })).toBe(true);
    expect(isBrowsingAll({ category: 'c1', search: '', availability: none })).toBe(false);
    expect(isBrowsingAll({ category: 'all', search: 'x', availability: none })).toBe(false);
    expect(
      isBrowsingAll({
        category: 'all',
        search: '',
        availability: new Set<ItemStatus>(['ok']),
      }),
    ).toBe(false);
  });
});

describe('successRefLine', () => {
  it('prints the CANONICAL order number, zero-padded, exactly as every other surface does', () => {
    expect(successRefLine(49, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 7)).toBe(
      'SO-000049 · DC4 · 7 units',
    );
  });

  it('singularizes one unit', () => {
    expect(successRefLine(49, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 1)).toBe(
      'SO-000049 · DC4 · 1 unit',
    );
  });

  it('NEVER fabricates an SO- handle from the uuid when the number is missing', () => {
    // The old orderRef() produced "SO-B3F1C2D4", which looks canonical and is
    // not. When the number is genuinely unavailable we fall back to a handle
    // that is visibly NOT an SO number, so nobody searches for it.
    const line = successRefLine(null, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 7);
    expect(line).toBe('Order b3f1c2d4 · DC4 · 7 units');
    expect(line).not.toContain('SO-');
  });

  it('treats 0 as missing — order_number is a 1-based sequence', () => {
    expect(successRefLine(0, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 2)).toBe(
      'Order b3f1c2d4 · DC4 · 2 units',
    );
  });

  it('pads a large number without truncating it', () => {
    expect(successRefLine(1234567, 'b3f1c2d4-0000-0000-0000-000000000000', 'DC4', 1)).toBe(
      'SO-1234567 · DC4 · 1 unit',
    );
  });
});

describe('the fabricated order handle is gone', () => {
  it('storefront-logic.ts no longer exports orderRef', async () => {
    const mod = await import('./storefront-logic');
    expect('orderRef' in mod).toBe(false);
  });
});

describe('formatSiteAddressLines', () => {
  it('renders a full US address as street / city-region-postal / country', () => {
    expect(
      formatSiteAddressLines({
        line1: '1295 Shaw Ave',
        line2: null,
        city: 'Fresno',
        region: 'California',
        postalCode: '93612',
        country: 'United States',
      }),
    ).toEqual(['1295 Shaw Ave', 'Fresno, California 93612', 'United States']);
  });

  it('keeps line2 as its own line when present', () => {
    expect(
      formatSiteAddressLines({
        line1: '1295 Shaw Ave',
        line2: 'Suite 200',
        city: 'Fresno',
        region: 'California',
        postalCode: '93612',
        country: 'United States',
      }),
    ).toEqual(['1295 Shaw Ave', 'Suite 200', 'Fresno, California 93612', 'United States']);
  });

  it('returns NO lines at all for a null address — 4 of 16 sites have none', () => {
    expect(formatSiteAddressLines(null)).toEqual([]);
  });

  it('returns no lines for an all-blank address rather than blank lines', () => {
    expect(
      formatSiteAddressLines({ line1: '', line2: null, city: '  ', region: null, postalCode: '', country: null }),
    ).toEqual([]);
  });

  it('omits the city line entirely when city, region and postal are all missing', () => {
    expect(formatSiteAddressLines({ line1: '1295 Shaw Ave', country: 'United States' })).toEqual([
      '1295 Shaw Ave',
      'United States',
    ]);
  });

  it('reads `region`, never `state` — the jsonb key is region', () => {
    const lines = formatSiteAddressLines({
      line1: '1 Main St',
      city: 'Tulare',
      region: 'California',
      postalCode: '93274',
    } as never);
    expect(lines).toContain('Tulare, California 93274');
  });

  it('passes a typo through verbatim instead of guessing — KVA Tulare really says "Calfornia"', () => {
    // Data quality is the owner's to fix. Silently "correcting" a site address
    // in an outbound delivery instruction would be worse than reproducing it.
    expect(formatSiteAddressLines({ city: 'Fresno', region: 'Calfornia', postalCode: '93274' })).toEqual([
      'Fresno, Calfornia 93274',
    ]);
  });

  it('collapses newlines injected into an address field to a single space', () => {
    expect(formatSiteAddressLines({ line1: '1 Main St\nBcc: evil@evil.test' })).toEqual([
      '1 Main St Bcc: evil@evil.test',
    ]);
  });
});

/**
 * Fixture for the draft builder. Deliberately a DELIVERY order with every
 * optional field populated, so each test can strip exactly the one thing it is
 * about instead of building up from nothing.
 */
function makeDraftInput(overrides: Partial<DeliveryRequestInput> = {}): DeliveryRequestInput {
  const polo = makeItem({ id: 'i-1', sku: 'APP-POLO-W', name: "L4L Polo (Women's)" });
  const bottle = makeItem({ id: 'i-2', sku: 'GEN-BOTL', name: 'L4L Water Bottle' });
  return {
    orderId: 'b3f1c2d4-1111-2222-3333-444455556666',
    orderNumber: 49,
    orderUrlBase: 'https://app.stockpilotusa.com',
    fulfillmentType: 'delivery',
    warehouseName: 'DC4',
    destination: {
      id: 'ch-1',
      name: 'CVW Clovis',
      code: 'CVW-CLO',
      address: {
        line1: '1295 Shaw Ave',
        line2: null,
        city: 'Fresno',
        region: 'California',
        postalCode: '93612',
        country: 'United States',
      },
    },
    requestedFor: 'Branden Vincent-Walker',
    requesterEmail: 'branden@cvwest.org',
    neededByLocal: '2026-08-05T09:00',
    orgTimezone: 'America/Los_Angeles',
    notes: 'Please stage these by Friday.',
    lines: [
      { itemId: 'i-1', quantity: 5 },
      { itemId: 'i-2', quantity: 2 },
    ],
    itemMap: new Map([
      ['i-1', polo],
      ['i-2', bottle],
    ]),
    ...overrides,
  };
}

describe('buildDeliveryRequestDraft — recipients', () => {
  it('carries both recipients as explicit properties, read from the ONE constant', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    expect(draft.to).toBe(DELIVERY_REQUEST_EMAIL.to);
    expect(draft.cc).toBe(DELIVERY_REQUEST_EMAIL.cc);
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
  });

  it('never puts either recipient in the body — the CC is a real field, not prose', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    expect(draft.body).not.toContain('dc4@learn4life.org');
    expect(draft.body).not.toContain('arosas@cvwest.org');
  });

  it('accepts NO recipient argument — there is no parameter for a caller to poison', () => {
    // Passing hostile values through every user-controlled field must not move
    // the recipients. This is the security invariant in executable form.
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({
        notes: 'to=attacker@evil.test cc=attacker2@evil.test',
        requestedFor: 'attacker@evil.test',
        requesterEmail: 'attacker@evil.test',
        destination: {
          id: 'ch-x',
          name: 'attacker@evil.test',
          code: 'to=attacker@evil.test',
          address: { line1: 'cc: attacker@evil.test' },
        },
      }),
    );
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
  });
});

describe('buildDeliveryRequestDraft — subject', () => {
  it('is ONE format carrying the canonical order number and the destination', () => {
    expect(buildDeliveryRequestDraft(makeDraftInput()).subject).toBe(
      'Delivery Request — StockPilot Order SO-000049 — CVW Clovis',
    );
  });

  it('uses the SAME format for pickup, with the warehouse as the location', () => {
    // Brief section 10 wants one subject shape so Zendesk routing stays
    // uniform; the body's Fulfillment Method line carries the distinction.
    // A pickup-specific subject would be a second format and needs owner
    // sign-off (see the plan's open questions).
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({ fulfillmentType: 'pickup', destination: null }),
    );
    expect(draft.subject).toBe('Delivery Request — StockPilot Order SO-000049 — DC4');
  });

  it('falls back to the warehouse when a delivery order somehow has no site', () => {
    // R8: order_requests_delivery_target_chk is NOT VALID, so 5 of 41 prod
    // delivery rows have delivery_charter_id = NULL. New orders cannot reach
    // this state, but the builder must not print "undefined".
    const draft = buildDeliveryRequestDraft(makeDraftInput({ destination: null }));
    expect(draft.subject).toBe('Delivery Request — StockPilot Order SO-000049 — DC4');
    expect(draft.subject).not.toContain('undefined');
    expect(draft.subject).not.toContain('null');
  });

  it('degrades honestly when the order number is missing', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput({ orderNumber: null }));
    expect(draft.subject).toBe('Delivery Request — StockPilot Order b3f1c2d4 — CVW Clovis');
    expect(draft.subject).not.toContain('SO-');
  });

  it('is a single line — a newline in a subject is a header-injection shape', () => {
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({
        destination: { id: 'x', name: 'Clovis\nBcc: evil@evil.test', code: null, address: null },
      }),
    );
    expect(draft.subject).not.toContain('\n');
    expect(draft.subject).not.toContain('\r');
  });
});

describe('buildDeliveryRequestDraft — delivery body', () => {
  it('states the method, the origin, the destination and the needed-by date', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain('Fulfillment method: Delivery');
    expect(body).toContain('FROM (WAREHOUSE)\nDC4');
    expect(body).toContain('DELIVERY DESTINATION\nCVW Clovis (CVW-CLO)');
    expect(body).toContain('1295 Shaw Ave');
    expect(body).toContain('Fresno, California 93612');
  });

  it('renders needed-by in the ORG timezone with the zone named, never a raw ISO string', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain('NEEDED BY');
    expect(body).toContain('America/Los_Angeles');
    expect(body).not.toContain('2026-08-05T');
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('omits the NEEDED BY block entirely when none was given — 70 of 78 prod orders have none', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ neededByLocal: '' }));
    expect(body).not.toContain('NEEDED BY');
  });

  it('lists every line with name, SKU and quantity, and a counted heading', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain('ITEMS (2 lines, 7 units)');
    expect(body).toContain("1. L4L Polo (Women's) — APP-POLO-W — qty 5");
    expect(body).toContain('2. L4L Water Bottle — GEN-BOTL — qty 2');
  });

  it('singularizes one line and one unit', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({ lines: [{ itemId: 'i-1', quantity: 1 }] }),
    );
    expect(body).toContain('ITEMS (1 line, 1 unit)');
  });

  it('falls back to the item id when the catalog map has no entry', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({ lines: [{ itemId: 'ghost', quantity: 3 }], itemMap: new Map() }),
    );
    expect(body).toContain('1. ghost — qty 3');
  });

  it('falls back to the item id when the catalog item exists but has an empty name', () => {
    // item?.name ?? line.itemId only catches null/undefined — an empty
    // string survives the ?? and used to render "1.  — qty 3".
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({
        lines: [{ itemId: 'i-9', quantity: 3 }],
        itemMap: new Map([['i-9', makeItem({ id: 'i-9', name: '', sku: '' })]]),
      }),
    );
    expect(body).toContain('1. i-9 — qty 3');
    expect(body).not.toContain('1.  —');
  });

  it('handles zero lines without emitting an empty ITEMS block', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ lines: [] }));
    expect(body).not.toContain('ITEMS (');
    expect(body).toContain('No line items were recorded on this order.');
  });

  it('prints the order notes under an honest heading, not as "delivery instructions"', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain('ORDER NOTES\nPlease stage these by Friday.');
    expect(body).not.toContain('DELIVERY INSTRUCTIONS');
  });

  it('omits the notes block when there are none', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ notes: '   ' }));
    expect(body).not.toContain('ORDER NOTES');
  });

  it('includes an absolute, clickable order link', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain(
      'Order link: https://app.stockpilotusa.com/dashboard/orders/b3f1c2d4-1111-2222-3333-444455556666',
    );
  });

  it('omits the link rather than emitting a relative path when no base is configured', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ orderUrlBase: '' }));
    expect(body).not.toContain('Order link:');
    expect(body).not.toContain('/dashboard/orders/');
  });

  it('states the real status — a fresh internal order is pending approval, not approved', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain('Order status in StockPilot: Pending approval');
    for (const claim of ['approved', 'reserved', 'scheduled', 'ticket']) {
      expect(body.toLowerCase()).not.toContain(`is ${claim}`);
    }
  });

  it('closes with the non-claim footer', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).toContain(
      'Drafted in StockPilot. StockPilot did not send this message and has not created a ticket.',
    );
  });
});

describe('buildDeliveryRequestDraft — pickup body (owner decision: pickup gets the assistant)', () => {
  const pickup = () =>
    buildDeliveryRequestDraft(makeDraftInput({ fulfillmentType: 'pickup', destination: null }));

  it('states pickup as the method', () => {
    expect(pickup().body).toContain('Fulfillment method: Pickup / will-call');
  });

  it('names where to collect from and who is collecting', () => {
    const { body } = pickup();
    expect(body).toContain('PICKUP FROM\nDC4 will-call desk');
    expect(body).toContain('COLLECTED BY\nBranden Vincent-Walker (branden@cvwest.org)');
  });

  it('prints NO destination block and no empty or invented address', () => {
    const { body } = pickup();
    expect(body).not.toContain('DELIVERY DESTINATION');
    expect(body).not.toContain('1295 Shaw Ave');
    expect(body).not.toContain('Address:');
  });

  it('ignores a stray destination on a pickup order rather than printing it', () => {
    // fulfillment_type is the authority. A pickup order's charter is NULL by
    // CHECK constraint; if one ever arrives, printing it would invent a
    // destination the order does not have.
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ fulfillmentType: 'pickup' }));
    expect(body).not.toContain('DELIVERY DESTINATION');
    expect(body).not.toContain('CVW Clovis');
  });
});

describe('buildDeliveryRequestDraft — fields that DO NOT EXIST are omitted, never stubbed', () => {
  it('never prints a labelled-but-empty row for building, room, instructions or priority', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    for (const absent of [
      'Building',
      'Room',
      'Delivery instructions',
      'DELIVERY INSTRUCTIONS',
      'Priority',
      'PRIORITY',
      'Urgency',
      'Rush',
    ]) {
      expect(body).not.toContain(absent);
    }
  });

  it('never prints a site contact block — 0 of 16 charters have a name or email', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).not.toContain('Site contact');
    expect(body).not.toContain('CONTACT');
  });

  it('never prints a unit of measure or a per-line note', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).not.toContain('UOM');
    expect(body).not.toContain('Unit of measure');
    expect(body).not.toContain('Line note');
  });

  it('never prints cost, price or any staff-only figure', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    for (const leak of ['$', 'cost', 'Cost', 'price', 'Price', 'internal', 'Internal', 'Picker']) {
      expect(body).not.toContain(leak);
    }
  });

  it('omits the address lines for a site that has none, keeping the name and code', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({
        destination: { id: 'ch-2', name: 'KVA Tulare', code: 'KVA-TUL', address: null },
      }),
    );
    expect(body).toContain('DELIVERY DESTINATION\nKVA Tulare (KVA-TUL)');
    expect(body).not.toContain('Address');
  });

  it('prints a site with no code without an empty parenthesis', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({ destination: { id: 'ch-3', name: 'Mendota', code: null, address: null } }),
    );
    expect(body).toContain('DELIVERY DESTINATION\nMendota');
    expect(body).not.toContain('Mendota ()');
  });
});

describe('buildDeliveryRequestDraft — honest placeholders for empty-string inputs', () => {
  // toPlainTextLine('   ') === ''. Every one of these inputs used to produce a
  // labelled heading with nothing under it, and blocks.join('\n\n') then
  // turned that trailing newline into three in a row. The fix is an honest
  // placeholder string, never a blank line and never an invented value.

  it('uses an honest placeholder when the warehouse name is all whitespace, on a delivery order', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput({ warehouseName: '   ' }));
    expect(body).toContain('FROM (WAREHOUSE)\n(warehouse not recorded)');
    expect(body).not.toContain('FROM (WAREHOUSE)\n\n');
    expect(body).not.toContain('\n\n\n');
  });

  it('uses the same honest placeholder for the will-call desk on a pickup order', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({ warehouseName: '   ', fulfillmentType: 'pickup', destination: null }),
    );
    expect(body).toContain('PICKUP FROM\n(warehouse not recorded) will-call desk');
    expect(body).not.toContain('PICKUP FROM\n\n');
    expect(body).not.toContain('\n\n\n');
  });

  it('falls back to the same warehouse placeholder in the subject when neither the site nor the warehouse is usable', () => {
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({ warehouseName: '   ', destination: null }),
    );
    expect(draft.subject).toBe(
      'Delivery Request — StockPilot Order SO-000049 — (warehouse not recorded)',
    );
  });

  it('uses an honest placeholder when the requester is all whitespace and no email is known', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({
        fulfillmentType: 'pickup',
        destination: null,
        requestedFor: '   ',
        requesterEmail: null,
      }),
    );
    expect(body).toContain('Requested by: (requester not recorded)');
    expect(body).toContain('COLLECTED BY\n(requester not recorded)');
    expect(body).not.toContain('COLLECTED BY\n\n');
    expect(body).not.toContain('\n\n\n');
  });

  it('falls through to the honest destination fallback when the site name is all whitespace', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({
        destination: { id: 'ch-4', name: '   ', code: null, address: null },
      }),
    );
    expect(body).toContain(
      'DELIVERY DESTINATION\nNot recorded on this order. Please confirm the destination with the requester before delivering.',
    );
    expect(body).not.toContain('DELIVERY DESTINATION\n\n');
    expect(body).not.toContain('\n\n\n');
  });
});

describe('buildDeliveryRequestDraft — plain text and safety', () => {
  it('is plain text: no HTML, no markdown emphasis, no CRLF', () => {
    const { body } = buildDeliveryRequestDraft(makeDraftInput());
    expect(body).not.toMatch(/<[a-z/][^>]*>/i);
    expect(body).not.toContain('**');
    expect(body).not.toContain('\r');
  });

  it('collapses newlines inside user text so nothing can forge a header line', () => {
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({ notes: 'Line one\nBcc: evil@evil.test\nLine two' }),
    );
    expect(body).toContain('ORDER NOTES\nLine one Bcc: evil@evil.test Line two');
    expect(body).not.toContain('\nBcc:');
  });

  it('never emits three consecutive newlines', () => {
    expect(buildDeliveryRequestDraft(makeDraftInput()).body).not.toContain('\n\n\n');
  });

  it('sanitizes a newline embedded in the order id before it reaches the body', () => {
    // orderId and orderUrlBase are the only input strings that reach the body
    // unsanitized: a newline inside orderId used to survive into both
    // `Order: ${handle}` and `Order link: ${orderUrl}` verbatim.
    const { body } = buildDeliveryRequestDraft(
      makeDraftInput({
        orderId: 'ab\ncd1234-1111-2222-3333-444455556666',
        orderNumber: null,
      }),
    );
    expect(body).toContain('Order: ab cd123');
    expect(body).toContain(
      'Order link: https://app.stockpilotusa.com/dashboard/orders/ab cd1234-1111-2222-3333-444455556666',
    );
    expect(body).not.toContain('\ncd1234');
    expect(body).not.toContain('\n\n\n');
  });

  it('reports condensed:false and a real character count for a normal order', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    expect(draft.condensed).toBe(false);
    expect(draft.lineCount).toBe(2);
    expect(draft.unitCount).toBe(7);
  });
});

describe('buildDeliveryRequestDraft — condensed mode', () => {
  it('keeps both recipients, the subject, the counts and the link', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput(), { condensed: true });
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
    expect(draft.subject).toBe('Delivery Request — StockPilot Order SO-000049 — CVW Clovis');
    expect(draft.condensed).toBe(true);
    expect(draft.body).toContain('ITEMS (2 lines, 7 units)');
    expect(draft.body).toContain(
      'Order link: https://app.stockpilotusa.com/dashboard/orders/b3f1c2d4-1111-2222-3333-444455556666',
    );
  });

  it('DISCLOSES the truncation in the body rather than silently dropping lines', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput(), { condensed: true });
    expect(draft.body).toContain(
      'This message was shortened because the full item list did not fit in a compose link. The complete order is at the link above.',
    );
  });

  it('drops the per-line list and the address, which is what makes it short', () => {
    // The 2-item default fixture is too small to demonstrate this on its
    // own once condensed mode also discloses the dropped notes (Finding 2):
    // that fixed second sentence can outweigh the savings from condensing
    // just two lines and one address. A realistic multi-item order still
    // condenses smaller, which is the property under test — so this widens
    // the fixture rather than touching the assertions.
    const base = makeDraftInput();
    const extraLines = Array.from({ length: 8 }, (_, i) => ({ itemId: `extra-${i}`, quantity: 1 }));
    const extraItems = new Map(
      extraLines.map((l, i) => [
        l.itemId,
        makeItem({ id: l.itemId, sku: `EXTRA-SKU-${i}`, name: `Extra Condensed Fixture Item ${i}` }),
      ]),
    );
    const input: DeliveryRequestInput = {
      ...base,
      lines: [...base.lines, ...extraLines],
      itemMap: new Map([...base.itemMap, ...extraItems]),
    };
    const draft = buildDeliveryRequestDraft(input, { condensed: true });
    expect(draft.body).not.toContain('APP-POLO-W');
    expect(draft.body).not.toContain('1295 Shaw Ave');
    expect(draft.body.length).toBeLessThan(buildDeliveryRequestDraft(input).body.length);
  });

  it('keeps the site name so DC4 still knows where it goes', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput(), { condensed: true });
    expect(draft.body).toContain('CVW Clovis');
  });

  it('still adapts to pickup', () => {
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({ fulfillmentType: 'pickup', destination: null }),
      { condensed: true },
    );
    expect(draft.body).toContain('Pickup / will-call');
    expect(draft.body).not.toContain('DELIVERY DESTINATION');
  });

  it('discloses that order notes were also dropped, when there were notes to drop', () => {
    // Condensed mode already drops ORDER NOTES silently; the disclosure used
    // to mention only the shortened item list, so a real requester note (e.g.
    // "dock closes at 3pm") vanished with no signal at all.
    const draft = buildDeliveryRequestDraft(makeDraftInput(), { condensed: true });
    expect(draft.body).toContain(
      'This message was shortened because the full item list did not fit in a compose link. The complete order is at the link above. Order notes were also omitted and are available at the link above.',
    );
    expect(draft.body).not.toContain('Please stage these by Friday.');
  });

  it('does not claim notes were dropped when there were none to begin with', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput({ notes: '' }), { condensed: true });
    expect(draft.body).toContain(
      'This message was shortened because the full item list did not fit in a compose link. The complete order is at the link above.',
    );
    expect(draft.body).not.toContain('Order notes were also omitted');
  });
});

describe('buildDeliveryRequestDraft — a 100-line order (the zod maximum)', () => {
  const bigInput = () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `big-${i}`, quantity: 4 }));
    const itemMap = new Map(
      lines.map((l, i) => [
        l.itemId,
        makeItem({ id: l.itemId, sku: `SKU-BIG-${i}`, name: `Bulk Item Number ${i}` }),
      ]),
    );
    return makeDraftInput({ lines, itemMap });
  };

  it('renders all 100 lines in full mode', () => {
    const { body, lineCount, unitCount } = buildDeliveryRequestDraft(bigInput());
    expect(lineCount).toBe(100);
    expect(unitCount).toBe(400);
    expect(body).toContain('ITEMS (100 lines, 400 units)');
    expect(body).toContain('100. Bulk Item Number 99 — SKU-BIG-99 — qty 4');
  });

  it('keeps both recipients at that size', () => {
    const draft = buildDeliveryRequestDraft(bigInput(), { condensed: true });
    expect(draft.to).toBe('dc4@learn4life.org');
    expect(draft.cc).toBe('arosas@cvwest.org');
  });
});

/**
 * Decodes the two-layer `mailtouri` wrapper produced by
 * `buildOutlookComposeUrl`.
 *
 * Layer 1 is the outer OWA URL's own query string (`?mailtouri=<encoded
 * mailto: URI>`), undone by `URL#searchParams`, which reverses exactly one
 * `encodeURIComponent`. Layer 2 is the DECODED value's own mailto: query
 * string (cc/subject/body) — parsed by slicing at the first '?' rather than
 * `new URL()`, the same technique the `buildMailtoUrl` tests below use,
 * because the WHATWG URL parser treats `mailto:` as an opaque-path scheme
 * and never populates `.searchParams` for it.
 */
function decodeCompose(url: string): { to: string; cc: string; subject: string; body: string } {
  const mailtouri = new URL(url).searchParams.get('mailtouri') ?? '';
  const queryStart = mailtouri.indexOf('?');
  const to = mailtouri.slice('mailto:'.length, queryStart);
  const inner = new URLSearchParams(mailtouri.slice(queryStart + 1));
  return {
    to,
    cc: inner.get('cc') ?? '',
    subject: inner.get('subject') ?? '',
    body: inner.get('body') ?? '',
  };
}

describe('buildOutlookComposeUrl', () => {
  it('targets the OWA deep-link compose endpoint, unchanged by the mailtouri rewrite', () => {
    const url = new URL(buildOutlookComposeUrl(buildDeliveryRequestDraft(makeDraftInput())));
    expect(url.origin).toBe('https://outlook.office.com');
    expect(url.pathname).toBe('/mail/deeplink/compose');
  });

  it('carries the WHOLE draft as a single mailtouri param — an inner mailto: URI, never plain to/cc/subject/body params', () => {
    // The owner's live-tenant test (2026-08-01) proved OWA silently drops a
    // plain `cc=` param on this endpoint; `mailtouri` routes through the
    // browser's mailto protocol handler instead, whose parser must honor cc
    // per RFC 6068. The old plain-param shape must be GONE, not merely
    // duplicated alongside the new one — a lingering `cc=` would be a trap
    // that looks correct but silently drops Andrew again.
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    const url = new URL(buildOutlookComposeUrl(draft));
    const mailtouri = url.searchParams.get('mailtouri');
    expect(mailtouri).not.toBeNull();
    expect(mailtouri!.startsWith('mailto:dc4@learn4life.org?')).toBe(true);

    expect(url.searchParams.get('to')).toBeNull();
    expect(url.searchParams.get('cc')).toBeNull();
    expect(url.searchParams.get('subject')).toBeNull();
    expect(url.searchParams.get('body')).toBeNull();

    const inner = new URLSearchParams(mailtouri!.slice(mailtouri!.indexOf('?') + 1));
    expect(inner.get('cc')).toBe('arosas@cvwest.org');
    expect(inner.get('subject')).toBe(draft.subject);
    expect(inner.get('body')).toBe(draft.body);
  });

  it('the mailtouri param itself appears exactly once', () => {
    const url = new URL(buildOutlookComposeUrl(buildDeliveryRequestDraft(makeDraftInput())));
    expect(url.searchParams.getAll('mailtouri')).toHaveLength(1);
  });

  it('carries the CC exactly once, inside the inner mailto QUERY — never in its path (To) segment', () => {
    const url = buildOutlookComposeUrl(buildDeliveryRequestDraft(makeDraftInput()));
    const mailtouri = new URL(url).searchParams.get('mailtouri')!;
    const queryStart = mailtouri.indexOf('?');
    const path = mailtouri.slice(0, queryStart);
    const query = mailtouri.slice(queryStart + 1);
    expect(path).toBe('mailto:dc4@learn4life.org');
    expect(query.match(/(?:^|&)cc=/g)).toHaveLength(1);
    expect(new URLSearchParams(query).getAll('cc')).toEqual(['arosas@cvwest.org']);
  });

  it('never concatenates the CC into the To address', () => {
    const url = buildOutlookComposeUrl(buildDeliveryRequestDraft(makeDraftInput()));
    const to = decodeCompose(url).to;
    expect(to).toBe('dc4@learn4life.org');
    expect(to).not.toContain('arosas');
    expect(to).not.toContain(',');
  });

  it('encodes exactly twice — once per layer, each applied once — and a full decode round-trips to the original body', () => {
    const draft = buildDeliveryRequestDraft(
      makeDraftInput({ notes: 'Ampersand & plus + hash # question ? equals =' }),
    );
    const url = buildOutlookComposeUrl(draft);
    const decoded = decodeCompose(url);
    expect(decoded.body).toBe(draft.body);
    expect(decoded.body).toContain('Ampersand & plus + hash # question ? equals =');
    expect(decoded.subject).toBe(draft.subject);
    expect(decoded.cc).toBe('arosas@cvwest.org');
  });

  it('keeps the CC when every optional field is missing', () => {
    const url = buildOutlookComposeUrl(
      buildDeliveryRequestDraft(
        makeDraftInput({
          orderNumber: null,
          destination: null,
          neededByLocal: '',
          notes: '',
          requesterEmail: null,
          orderUrlBase: '',
          lines: [],
          itemMap: new Map(),
        }),
      ),
    );
    const decoded = decodeCompose(url);
    expect(decoded.to).toBe('dc4@learn4life.org');
    expect(decoded.cc).toBe('arosas@cvwest.org');
  });

  it('keeps the CC in condensed mode', () => {
    const url = buildOutlookComposeUrl(buildDeliveryRequestDraft(makeDraftInput(), { condensed: true }));
    expect(decodeCompose(url).cc).toBe('arosas@cvwest.org');
  });

  it('the RAW outer URL never contains a literal "+" — both encoding layers use %20-style encoding, never form-encoding', () => {
    const url = buildOutlookComposeUrl(buildDeliveryRequestDraft(makeDraftInput()));
    expect(url).not.toContain('+');
    // Spaces still survive the full round trip as real spaces, not '+'.
    expect(decodeCompose(url).body).toContain(' ');
  });

  it('a literal + in the order notes survives BOTH encoding layers intact, never misread as a space', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput({ notes: 'Size L+ jerseys' }));
    const url = buildOutlookComposeUrl(draft);
    expect(url).not.toContain('+');
    expect(decodeCompose(url).body).toContain('Size L+ jerseys');
  });
});

describe('buildMailtoUrl', () => {
  it('puts the To address in the PATH and the cc in the query string', () => {
    const url = buildMailtoUrl(buildDeliveryRequestDraft(makeDraftInput()));
    expect(url.startsWith('mailto:dc4@learn4life.org?')).toBe(true);
  });

  it('carries cc, subject and body, decodable back to the originals', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    const url = buildMailtoUrl(draft);
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(params.get('cc')).toBe('arosas@cvwest.org');
    expect(params.get('subject')).toBe(draft.subject);
    expect(params.get('body')).toBe(draft.body);
  });

  it('carries the CC exactly once and never inside the To path segment', () => {
    const url = buildMailtoUrl(buildDeliveryRequestDraft(makeDraftInput()));
    expect(url.match(/[?&]cc=/g)).toHaveLength(1);
    expect(url.slice(0, url.indexOf('?'))).toBe('mailto:dc4@learn4life.org');
  });

  it('keeps the CC in condensed mode and with everything optional missing', () => {
    const bare = buildDeliveryRequestDraft(
      makeDraftInput({ destination: null, notes: '', neededByLocal: '', lines: [] }),
      { condensed: true },
    );
    const params = new URLSearchParams(buildMailtoUrl(bare).slice(buildMailtoUrl(bare).indexOf('?') + 1));
    expect(params.get('cc')).toBe('arosas@cvwest.org');
  });

  it('encodes spaces as %20, never as + — RFC 6068 mailto clients render a literal + as a plus sign, not a space', () => {
    const url = buildMailtoUrl(buildDeliveryRequestDraft(makeDraftInput()));
    expect(url).toContain('%20');
    expect(url).not.toContain('+');
  });

  it('a literal + in the order notes round-trips through the query string as %2B, not as a space', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput({ notes: 'Size L+ jerseys' }));
    const url = buildMailtoUrl(draft);
    expect(url).toContain('%2B');
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(params.get('body')).toContain('Size L+ jerseys');
  });
});

describe('buildClipboardText', () => {
  it('emits labelled TO / CC / SUBJECT / MESSAGE blocks', () => {
    const draft = buildDeliveryRequestDraft(makeDraftInput());
    const text = buildClipboardText(draft);
    expect(text).toContain('TO: dc4@learn4life.org');
    expect(text).toContain('CC: arosas@cvwest.org');
    expect(text).toContain(`SUBJECT: ${draft.subject}`);
    expect(text).toContain('MESSAGE:');
    expect(text).toContain(draft.body);
  });

  it('orders the blocks TO, CC, SUBJECT, MESSAGE', () => {
    const text = buildClipboardText(buildDeliveryRequestDraft(makeDraftInput()));
    expect(text.indexOf('TO:')).toBeLessThan(text.indexOf('CC:'));
    expect(text.indexOf('CC:')).toBeLessThan(text.indexOf('SUBJECT:'));
    expect(text.indexOf('SUBJECT:')).toBeLessThan(text.indexOf('MESSAGE:'));
  });

  it('names BOTH recipients — copy instructions that omit the CC are non-compliant', () => {
    const text = buildClipboardText(buildDeliveryRequestDraft(makeDraftInput()));
    expect(text).toContain('dc4@learn4life.org');
    expect(text).toContain('arosas@cvwest.org');
  });

  it('keeps both recipients in condensed mode', () => {
    const text = buildClipboardText(buildDeliveryRequestDraft(makeDraftInput(), { condensed: true }));
    expect(text).toContain('TO: dc4@learn4life.org');
    expect(text).toContain('CC: arosas@cvwest.org');
  });
});

describe('prepareDeliveryRequest', () => {
  it('returns the full draft and both URLs for a normal order', () => {
    const prepared = prepareDeliveryRequest(makeDraftInput());
    expect(prepared.draft.condensed).toBe(false);
    expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(prepared.mailtoUrl.startsWith('mailto:dc4@learn4life.org?')).toBe(true);
    expect(prepared.clipboardText).toContain('CC: arosas@cvwest.org');
    expect(prepared.linkFits).toBe(true);
  });

  it('CONDENSES automatically when the full body would exceed the link limit', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `big-${i}`, quantity: 4 }));
    const itemMap = new Map(
      lines.map((l, i) => [
        l.itemId,
        makeItem({ id: l.itemId, sku: `SKU-BIG-${i}`, name: `Bulk Item Number ${i}` }),
      ]),
    );
    const prepared = prepareDeliveryRequest(makeDraftInput({ lines, itemMap }));
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.outlookUrl.length).toBeLessThanOrEqual(DRAFT_URL_LIMIT);
    expect(prepared.draft.body).toContain(
      'This message was shortened because the full item list did not fit in a compose link.',
    );
    // The condensed 100-line order is well within DRAFT_URL_LIMIT once
    // condensed, so the CHOSEN (condensed) urls honestly fit — measured at
    // 1458 chars against a 1800 limit (2026-08-01, mailtouri wrapping),
    // 342 chars of headroom even after both encoding layers.
    expect(prepared.linkFits).toBe(true);
  });

  it('linkFits is FALSE when even the condensed URL exceeds the limit — a pathological warehouse name, not the line count, is the cause', () => {
    // Site/warehouse/requester names are unbounded database strings.
    // Condensing drops the per-line list, the address and the notes, but it
    // does NOT shorten the warehouse name — so a pathological name alone can
    // push even the condensed link past DRAFT_URL_LIMIT. That must produce an
    // honest signal, not a silently truncated mail-client draft.
    const prepared = prepareDeliveryRequest(
      makeDraftInput({ warehouseName: 'W'.repeat(3000), destination: null }),
    );
    expect(prepared.draft.condensed).toBe(true);
    // Measured at 7557 chars against the 1800 limit (2026-08-01) — the
    // mailtouri wrapping inflates length, but this fixture was already
    // pathologically oversized before the rewrite and stays so after it.
    expect(prepared.linkFits).toBe(false);
    // The clipboard path has no URL-length limit and must still carry the
    // complete body — recipients plus content that condensing would have
    // dropped (the order notes).
    expect(prepared.clipboardText).toContain('TO: dc4@learn4life.org');
    expect(prepared.clipboardText).toContain('CC: arosas@cvwest.org');
    expect(prepared.clipboardText).toContain('Please stage these by Friday.');
    expect(prepared.clipboardText).toContain('APP-POLO-W');
  });

  it('the CLIPBOARD text is always the FULL body, even when the links are condensed', () => {
    // The clipboard has no URL-length limit, so degrading it too would lose
    // detail for no reason. This is the path that always carries everything.
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `big-${i}`, quantity: 4 }));
    const itemMap = new Map(
      lines.map((l, i) => [l.itemId, makeItem({ id: l.itemId, sku: `SKU-BIG-${i}`, name: `Bulk ${i}` })]),
    );
    const prepared = prepareDeliveryRequest(makeDraftInput({ lines, itemMap }));
    expect(prepared.draft.condensed).toBe(true);
    expect(prepared.clipboardText).toContain('SKU-BIG-99');
    expect(prepared.clipboardText).toContain('CC: arosas@cvwest.org');
  });

  it('keeps both recipients on a condensed 100-line order', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ itemId: `big-${i}`, quantity: 4 }));
    const itemMap = new Map(
      lines.map((l, i) => [l.itemId, makeItem({ id: l.itemId, sku: `SKU-BIG-${i}`, name: `Bulk ${i}` })]),
    );
    const prepared = prepareDeliveryRequest(makeDraftInput({ lines, itemMap }));
    const decoded = decodeCompose(prepared.outlookUrl);
    expect(decoded.to).toBe('dc4@learn4life.org');
    expect(decoded.cc).toBe('arosas@cvwest.org');
  });

  it('no user-controlled field can move the recipients, at any size or mode', () => {
    const prepared = prepareDeliveryRequest(
      makeDraftInput({
        notes: '?cc=attacker@evil.test&to=attacker@evil.test',
        requestedFor: '"><script>x</script>attacker@evil.test',
        destination: { id: 'x', name: '&cc=attacker@evil.test', code: null, address: null },
      }),
    );
    const url = new URL(prepared.outlookUrl);
    // The mailtouri wrapper leaves no plain to/cc params on the outer URL at
    // all — a hostile value would have to land IN the inner mailto: URI to
    // move a recipient, and buildDeliveryRequestDraft never reads any of
    // these fields into `to`/`cc` in the first place.
    expect(url.searchParams.getAll('to')).toEqual([]);
    expect(url.searchParams.getAll('cc')).toEqual([]);
    const decoded = decodeCompose(prepared.outlookUrl);
    expect(decoded.to).toBe('dc4@learn4life.org');
    expect(decoded.cc).toBe('arosas@cvwest.org');
  });
});
