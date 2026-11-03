import { describe, expect, it } from 'vitest';

import { parseItemId } from './scan-item-label';

// B65: the Scan tab read the item by id with any 36 hex digits or hyphens it
// found after an item-label path, so a near-miss (36 hyphens, 36 digits with
// no hyphens) went to a database read that could never find it. Only a uuid
// is a label id now; anything else reads as no label id, as a cut-off label
// always did, and the scan looks the whole code up as a barcode or SKU.
//
// Synthetic ids and a placeholder origin only (the repository is public).

const ORIGIN = 'https://app.example';
const ID = '11111111-2222-4333-8444-555555555555';

describe('parseItemId: a StockPilot item label', () => {
  it.each([
    ['the current label', `${ORIGIN}/p/items/${ID}`],
    ['a legacy inventory label', `${ORIGIN}/dashboard/inventory/${ID}`],
    ['a legacy books label', `${ORIGIN}/dashboard/books/${ID}`],
    ['a query after the id', `${ORIGIN}/p/items/${ID}?ref=x`],
    ['a slash after the id', `${ORIGIN}/p/items/${ID}/`],
    ['text after the id (its 36-character head)', `${ORIGIN}/p/items/${ID}extra`],
  ])('reads the id from %s', (_label, scanned) => {
    expect(parseItemId(scanned)).toBe(ID);
  });

  it('keeps an upper-case id as it was scanned (never rewritten)', () => {
    const upper = ID.toUpperCase();
    expect(parseItemId(`${ORIGIN}/p/items/${upper}`)).toBe(upper);
  });
});

describe('parseItemId: anything that is not a label id', () => {
  // Mutation caught: the 36-character pattern without isUuid returns the
  // first two, which then went to an item read that could never work.
  it.each([
    ['36 hyphens', `${ORIGIN}/p/items/${'-'.repeat(36)}`],
    ['36 hex digits with no hyphens', `${ORIGIN}/p/items/${'a'.repeat(36)}`],
    ['hyphens in the wrong places', `${ORIGIN}/dashboard/inventory/${'1'.repeat(32)}----`],
    ['a 35-character cut-off', `${ORIGIN}/p/items/${ID.slice(0, 35)}`],
    ['a web page that is not an item', `${ORIGIN}/dashboard/inventory/staging`],
    ["another site's item path with a SKU", 'https://vendor.example/p/items/SKU-12345'],
    ['a UPC', '012345678905'],
    ['an ISBN', '9780306406157'],
    ['a bare id with no label path', ID],
  ])('returns null for %s', (_label, scanned) => {
    expect(parseItemId(scanned)).toBeNull();
  });
});
