import { beforeEach, describe, expect, it, vi } from 'vitest';

// getPublicItem is wrapped in unstable_cache at module scope, which is not
// callable outside a request. Pass the fn straight through so the HI-8 guard
// below can be exercised directly.
vi.mock('next/cache', () => ({ unstable_cache: vi.fn((fn: unknown) => fn) }));
const { mockCreateAdminClient } = vi.hoisted(() => ({ mockCreateAdminClient: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mockCreateAdminClient }));

import { getPublicItem, toPublicItem, PUBLIC_ITEM_FIELDS } from './public-items';

/**
 * Critical security boundary: the public item page hits Supabase via
 * the SERVICE-ROLE client (no RLS), so the row-shaping function is the
 * ONLY thing standing between sensitive inventory data (qty, cost,
 * supplier, location, internal notes, audit metadata) and any random
 * person who scans a QR code.
 *
 * Every test in this file confirms what does NOT come out of
 * toPublicItem(). If you're tempted to add a field to the public
 * surface, you must also add a test asserting it shows up — and
 * justify it in code review.
 */

describe('toPublicItem', () => {
  const rawRow = {
    id: 'item-uuid',
    organization_id: 'org-uuid',
    warehouse_id: 'wh-uuid',
    charter_id: 'charter-uuid',
    primary_location_id: 'loc-uuid',
    sku: 'SP-ABC-123',
    barcode: '9780062315007',
    name: 'The Alchemist',
    description: 'Internal description',
    item_type: 'book',
    quantity_on_hand: 47,
    reorder_point: 10,
    reorder_quantity: 20,
    unit_cost: 8.5,
    retail_price: 16.99,
    supplier_id: 'sup-uuid',
    category_id: 'cat-uuid',
    bin_location: 'A-3',
    tracking_type: 'none',
    custom_fields: {
      author: 'Paulo Coelho',
      publisher: 'HarperOne',
      published_date: '2014',
      page_count: 197,
      thumbnail_url: 'https://example.com/cover.jpg',
      book_grade: '10',
      author_secret_phone: '555-INTERNAL',
    },
    status: 'active',
    notes: 'private staff notes',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-05-06T00:00:00Z',
    created_by: 'user-uuid',
    updated_by: 'user-uuid',
    deleted_at: null,
    image_url: 'https://example.com/photo.jpg',
    category_name: 'Fiction',
  };

  it('returns the safe public fields from a fully-populated row', () => {
    const result = toPublicItem(rawRow);
    expect(result).toEqual({
      id: 'item-uuid',
      name: 'The Alchemist',
      itemType: 'book',
      imageUrl: 'https://example.com/photo.jpg',
      quantityOnHand: 47,
      category: 'Fiction',
      bookAuthor: 'Paulo Coelho',
      bookPublisher: 'HarperOne',
      bookPublishedDate: '2014',
      bookGrade: '10',
    });
  });

  // Quantity is INTENTIONALLY exposed (per product decision: lending-
  // library / warehouse scanners want "is it in stock?" feedback).
  // Costs, prices, suppliers, locations, and internal notes remain
  // hidden — that boundary is enforced by the it.each block below.
  it.each([
    ['organization_id'],
    ['warehouse_id'],
    ['charter_id'],
    ['primary_location_id'],
    ['sku'],
    ['barcode'],
    ['description'],
    ['reorder_point'],
    ['reorder_quantity'],
    ['unit_cost'],
    ['retail_price'],
    ['supplier_id'],
    ['category_id'],
    ['bin_location'],
    ['tracking_type'],
    ['notes'],
    ['created_by'],
    ['updated_by'],
    ['custom_fields'],
  ])('NEVER leaks the %s field', (forbiddenKey) => {
    const result = toPublicItem(rawRow) as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty(forbiddenKey);
  });

  it('does not pass through unknown custom_fields keys (e.g. author_secret_phone)', () => {
    const result = toPublicItem(rawRow);
    const json = JSON.stringify(result);
    expect(json).not.toContain('555-INTERNAL');
    expect(json).not.toContain('author_secret_phone');
  });

  it('returns nulls for absent optional metadata', () => {
    const result = toPublicItem({
      id: 'i',
      name: 'Generic Product',
      item_type: 'product',
      image_url: null,
      quantity_on_hand: 0,
      category_name: null,
      custom_fields: null,
    });
    expect(result).toEqual({
      id: 'i',
      name: 'Generic Product',
      itemType: 'product',
      imageUrl: null,
      quantityOnHand: 0,
      category: null,
      bookAuthor: null,
      bookPublisher: null,
      bookPublishedDate: null,
      bookGrade: null,
    });
  });

  it('coerces non-numeric or missing quantity_on_hand to 0 (never NaN, never undefined)', () => {
    expect(
      toPublicItem({ id: 'i', name: 'X', item_type: 'product', quantity_on_hand: null })
        .quantityOnHand,
    ).toBe(0);
    expect(
      toPublicItem({ id: 'i', name: 'X', item_type: 'product' }).quantityOnHand,
    ).toBe(0);
    expect(
      toPublicItem({ id: 'i', name: 'X', item_type: 'product', quantity_on_hand: 'oops' })
        .quantityOnHand,
    ).toBe(0);
    expect(
      toPublicItem({ id: 'i', name: 'X', item_type: 'product', quantity_on_hand: 12 })
        .quantityOnHand,
    ).toBe(12);
  });

  it('coerces an unknown item_type to product so the page never breaks on bad data', () => {
    const result = toPublicItem({
      id: 'i',
      name: 'Mystery',
      item_type: 'something-weird',
      image_url: null,
      category_name: null,
      custom_fields: null,
    });
    expect(result.itemType).toBe('product');
  });

  it('exposes the column-list constant for the SQL select() call', () => {
    // The select() call must request exactly these columns and no
    // others. If you add a field to the output, also add it here AND
    // to a test that asserts it's exposed.
    expect(PUBLIC_ITEM_FIELDS).toEqual([
      'id',
      'name',
      'item_type',
      'image_url',
      'quantity_on_hand',
      'category_name',
      'custom_fields',
    ]);
  });
});

/**
 * HI-8 on the READ side. `resolvePublicImageUrl` runs the SERVICE-ROLE client
 * on an UNAUTHENTICATED page and does not know (or check) which org owns the
 * item — that is the point of a public item view. So the `storage_path` it
 * signs comes out of the database with no org context at all, and a poisoned
 * value would be resolved by the WHATWG URL parser inside
 * @supabase/storage-js: `<org>/../../<other-bucket>/<victim>/x.jpg` would mint
 * a service-role-signed URL for an object in a DIFFERENT bucket and hand it to
 * an anonymous visitor.
 *
 * The property: a stored path that is not structurally a legitimate item-image
 * path is never passed to the storage client at all, and the page falls back to
 * the external cover / placeholder — the same outcome as a failed signing call.
 */
describe('getPublicItem — HI-8 on the service-role image read', () => {
  const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG = '11111111-1111-4111-8111-111111111111';

  function stubAdmin(storagePath: string, customFields: unknown = null) {
    const createSignedUrl = vi.fn(async () => ({
      data: { signedUrl: 'https://signed.example/cover.jpg' },
      error: null,
    }));
    // Chainable builder: from(...).select(...).eq(...)... resolving to rows.
    function builder(rows: unknown) {
      const chain: Record<string, unknown> = {};
      const proxy: unknown = new Proxy(chain, {
        get(_t, prop: string) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve({ data: rows, error: null });
          }
          if (prop === 'maybeSingle') {
            return async () => ({
              data: Array.isArray(rows) ? (rows[0] ?? null) : rows,
              error: null,
            });
          }
          return () => proxy;
        },
      });
      return proxy;
    }
    const admin = {
      from: vi.fn((table: string) =>
        table === 'item_images'
          ? builder([{ storage_path: storagePath, is_primary: true, sort_order: 0 }])
          : builder([
              {
                id: ITEM,
                name: 'Public Item',
                item_type: 'product',
                quantity_on_hand: 3,
                custom_fields: customFields,
                status: 'active',
                deleted_at: null,
                category: { name: 'Fiction' },
              },
            ]),
      ),
      storage: { from: vi.fn(() => ({ createSignedUrl })) },
    };
    mockCreateAdminClient.mockReturnValue(admin);
    return { createSignedUrl };
  }

  beforeEach(() => vi.clearAllMocks());

  it('PAIRED POSITIVE — a legitimate stored path IS signed, so the refusals below are not vacuous', async () => {
    const { createSignedUrl } = stubAdmin(
      `${ORG}/items/${ITEM}/33333333-3333-4333-8333-333333333333.webp`,
    );
    const out = await getPublicItem(ITEM);
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
    expect(out?.imageUrl).toBe('https://signed.example/cover.jpg');
  });

  it('PAIRED POSITIVE — the books-import {org}/{item}/cover.jpg convention is also signed', async () => {
    const { createSignedUrl } = stubAdmin(`${ORG}/${ITEM}/cover.jpg`);
    const out = await getPublicItem(ITEM);
    expect(createSignedUrl).toHaveBeenCalledTimes(1);
    expect(out?.imageUrl).toBe('https://signed.example/cover.jpg');
  });

  it.each([
    `${ORG}/items/${ITEM}/../../../org-logos/victim-org/logo.png`,
    `${ORG}/%2e%2e/%2e%2e/maintenance-photos/victim/photo.jpg`,
    `${ORG}/%252e%252e/item-images/victim/x.jpg`,
    `/${ORG}/items/${ITEM}/x.jpg`,
    `${ORG}//items/${ITEM}/x.jpg`,
    `${ORG}\\..\\..\\po-imports\\victim\\invoice.pdf`,
  ])('REFUSES to service-role-sign the poisoned stored path %s', async (bad) => {
    const { createSignedUrl } = stubAdmin(bad);
    const out = await getPublicItem(ITEM);
    // The storage client must never see it.
    expect(createSignedUrl).not.toHaveBeenCalled();
    // And the page degrades to the placeholder rather than erroring.
    expect(out?.imageUrl).toBeNull();
  });

  it('a refused path still falls back to the external ISBN cover, so a poisoned row does not blank a book that has one', async () => {
    const { createSignedUrl } = stubAdmin(`${ORG}/items/${ITEM}/../../x/y.jpg`, {
      thumbnail_url: 'https://books.example/cover.jpg',
    });
    const out = await getPublicItem(ITEM);
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(out?.imageUrl).toBe('https://books.example/cover.jpg');
  });
});
