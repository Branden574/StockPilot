import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakePostgrest, filterValue, inValues, uuid, type RecordedCall } from './__fixtures__/fake-postgrest';
import { IdBatchReadError, settleIdBatchRead, type PageResult } from './id-batches';
import {
  RENTAL_PICKER_ROW_CEILING,
  buildRentalItemRows,
  loadRentalItemsView,
  readRentalPickerItems,
  rentalItemsEyebrow,
  rentalItemsViewEyebrow,
  rentalPickerStatus,
} from './rental-items';

describe('buildRentalItemRows', () => {
  it('available = on hand minus every open reservation for that item', () => {
    const rows = buildRentalItemRows(
      [
        { id: 'table', name: '6 foot table', sku: 'T-1', quantity_on_hand: 10 },
        { id: 'audio', name: 'Audiometer', sku: null, quantity_on_hand: '2' },
      ],
      [
        { item_id: 'table', quantity: 3 },
        { item_id: 'table', quantity: 2 },
        { item_id: 'audio', quantity: '1' },
      ],
    );
    expect(rows).toEqual([
      { id: 'table', name: '6 foot table', sku: 'T-1', onHand: 10, reserved: 5, available: 5, overReserved: false },
      { id: 'audio', name: 'Audiometer', sku: null, onHand: 2, reserved: 1, available: 1, overReserved: false },
    ]);
  });

  it('an item nobody has borrowed is fully available', () => {
    const [row] = buildRentalItemRows([{ id: 'a', name: 'Canopy', sku: 'C', quantity_on_hand: 4 }], []);
    expect(row).toMatchObject({ onHand: 4, reserved: 0, available: 4, overReserved: false });
  });

  it('never shows a negative availability, and flags the broken promise instead', () => {
    const [row] = buildRentalItemRows(
      [{ id: 'a', name: 'Canopy', sku: 'C', quantity_on_hand: 1 }],
      [{ item_id: 'a', quantity: 3 }],
    );
    expect(row).toMatchObject({ available: 0, overReserved: true });
  });

  it('ignores reservations for items not on the list, and unreadable quantities', () => {
    const [row] = buildRentalItemRows(
      [{ id: 'a', name: 'Canopy', sku: 'C', quantity_on_hand: 5 }],
      [
        { item_id: 'someone-else', quantity: 5 },
        { item_id: 'a', quantity: null },
        { item_id: 'a', quantity: 'not a number' },
        { item_id: 'a', quantity: 1 },
      ],
    );
    // null reads as 0 (Number(null)), a non-number is skipped, never NaN.
    expect(row).toMatchObject({ reserved: 1, available: 4 });
  });

  it('keeps the fetched order (the query sorts it, like web)', () => {
    const rows = buildRentalItemRows(
      [
        { id: 'b', name: 'B', sku: null, quantity_on_hand: 1 },
        { id: 'a', name: 'A', sku: null, quantity_on_hand: 1 },
      ],
      [],
    );
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('rentalItemsEyebrow', () => {
  it('counts the items', () => {
    expect(rentalItemsEyebrow(2, 2)).toBe('RENTALS · 2 ITEMS');
    expect(rentalItemsEyebrow(1, 1)).toBe('RENTALS · 1 ITEM');
    expect(rentalItemsEyebrow(0, 0)).toBe('RENTALS · 0 ITEMS');
  });

  it('says when the list is only the first part of the fleet', () => {
    expect(rentalItemsEyebrow(200, 240)).toBe('RENTALS · SHOWING 200 OF 240 ITEMS');
  });

  it('falls back to what it has when the count is unknown', () => {
    expect(rentalItemsEyebrow(3, null)).toBe('RENTALS · 3 ITEMS');
  });
});

describe('rentalItemsViewEyebrow (what the Items view renders)', () => {
  it('quotes no count while the first load runs', () => {
    expect(rentalItemsViewEyebrow(null)).toBe('RENTALS · ITEMS');
  });

  it('quotes NO count after a failed load, never "0 ITEMS" from a read that did not answer', () => {
    // The failed state the screen sets: no rows, no total. It used to render
    // "RENTALS · 0 ITEMS" right above "Could not load rental items.".
    expect(rentalItemsViewEyebrow({ rows: [], total: null, failed: true })).toBe('RENTALS · ITEMS');
    // Even if a failed state ever carried rows or a total, it quotes none.
    expect(rentalItemsViewEyebrow({ rows: [{}, {}], total: 5, failed: true })).toBe('RENTALS · ITEMS');
  });

  it('counts a loaded view, including a genuinely empty one', () => {
    expect(rentalItemsViewEyebrow({ rows: [{}, {}], total: 2, failed: false })).toBe('RENTALS · 2 ITEMS');
    expect(rentalItemsViewEyebrow({ rows: [], total: 0, failed: false })).toBe('RENTALS · 0 ITEMS');
    expect(rentalItemsViewEyebrow({ rows: [{}], total: 3, failed: false })).toBe(
      'RENTALS · SHOWING 1 OF 3 ITEMS',
    );
  });
});

describe('rentalPickerStatus (new rental)', () => {
  const none = { warehousesError: null, itemsError: null, stockError: null };

  it('is not blocked when every read loaded', () => {
    expect(rentalPickerStatus(none)).toEqual({ blocked: false, message: null, detail: null });
  });

  it('a failed reservations read BLOCKS the picker: availability would read as on hand', () => {
    expect(rentalPickerStatus({ ...none, stockError: 'URI too long' })).toEqual({
      blocked: true,
      message: 'Could not check which units are already out on rental.',
      detail: 'URI too long',
    });
  });

  it('a failed items read blocks it, rather than claiming the warehouse has no rental items', () => {
    expect(rentalPickerStatus({ ...none, itemsError: 'offline' })).toEqual({
      blocked: true,
      message: 'Could not load rental items.',
      detail: 'offline',
    });
  });

  it('an EMPTY error message still blocks: a failure is not decided by its text', () => {
    // A gateway 502 or 504 with an empty body gives an empty message.
    for (const key of ['warehousesError', 'itemsError', 'stockError'] as const) {
      expect(rentalPickerStatus({ ...none, [key]: '' }).blocked, key).toBe(true);
    }
  });

  it('a failed warehouses read blocks it', () => {
    expect(rentalPickerStatus({ ...none, warehousesError: 'offline', stockError: 'x' })).toEqual({
      blocked: true,
      message: 'Could not load warehouses.',
      detail: 'offline',
    });
  });
});

describe('readRentalPickerItems (New rental picker)', () => {
  // The picker read one request with `.limit(500)` by name and searched the
  // rows it held, on the phone: an item past row 500 could not be found. It
  // now reads the web New rental page's query, filter for filter, in pages.
  const ORG = 'org-1';
  const WH = 'wh-1';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** inventory_items as PostgREST answers: the call's own eq/is filters, its
   *  order keys (the first primary, later ones tiebreaks), its range window,
   *  never more than max_rows. So dropping a filter or an order fails a test. */
  function servedLikePostgrest(rows: Record<string, unknown>[], fail?: (call: RecordedCall) => boolean) {
    return fakePostgrest((call): PageResult<unknown> => {
      if (fail?.(call)) return { data: null, error: { message: 'fetch failed' }, status: 503 };
      let out = rows.filter((r) =>
        call.filters.every(([op, col, val]) => {
          if (op === 'eq') return r[col] === val;
          if (op === 'is') return (r[col] ?? null) === val;
          throw new Error(`cannot evaluate .${op}()`);
        }),
      );
      out = [...out].sort((a, b) => {
        for (const [col, asc] of call.order) {
          const x = a[col] as string;
          const y = b[col] as string;
          if (x !== y) return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      return { data: out.slice(call.from, Math.min(call.to, call.from + 999) + 1), error: null, status: 200 };
    });
  }

  /** A rental item on the page's filters. Names repeat (two items share each)
   *  and ids run against the names, so only name THEN id gives one order. */
  function rental(i: number, over: Record<string, unknown> = {}) {
    return {
      id: uuid(9000 - i),
      name: `Rental ${String(Math.floor(((i * 7919) % 1234) / 2)).padStart(4, '0')}`,
      sku: `R-${i}`,
      quantity_on_hand: 1,
      organization_id: ORG,
      warehouse_id: WH,
      status: 'active',
      is_rental: true,
      deleted_at: null,
      ...over,
    };
  }

  const byNameThenId = (a: { name: string; id: string }, b: { name: string; id: string }) =>
    a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1;

  it("reads the web page's query, filter for filter, by name then id, 1000 rows a page", async () => {
    const client = servedLikePostgrest(Array.from({ length: 1234 }, (_, i) => rental(i)));
    await readRentalPickerItems(client, ORG, WH);
    expect(client.calls.map((c) => [c.from, c.to])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    for (const c of client.calls) {
      expect(c.table).toBe('inventory_items');
      expect(c.select).toBe('id, name, sku, quantity_on_hand');
      expect(c.filters).toEqual([
        ['eq', 'organization_id', ORG],
        ['eq', 'warehouse_id', WH],
        ['eq', 'status', 'active'],
        ['eq', 'is_rental', true],
        ['is', 'deleted_at', null],
      ]);
      expect(c.order).toEqual([
        ['name', true],
        ['id', true],
      ]);
    }
  });

  it('returns every rental item past row 500, in name-then-id order, and nothing another filter excludes', async () => {
    const matching = Array.from({ length: 1234 }, (_, i) => rental(i));
    // Each sorts FIRST by name, so a dropped filter would put it on page one.
    const excluded = [
      rental(0, { id: uuid(1), name: 'A other org', organization_id: 'org-2' }),
      rental(0, { id: uuid(2), name: 'A other warehouse', warehouse_id: 'wh-2' }),
      rental(0, { id: uuid(3), name: 'A not a rental', is_rental: false }),
      rental(0, { id: uuid(4), name: 'A archived', status: 'archived' }),
      rental(0, { id: uuid(5), name: 'A deleted', deleted_at: '2026-09-01T00:00:00Z' }),
    ];
    const client = servedLikePostgrest([...excluded, ...matching]);

    const rows = await readRentalPickerItems(client, ORG, WH);

    expect(rows).toHaveLength(1234);
    expect(rows.map((r) => r.id)).toEqual([...matching].sort(byNameThenId).map((r) => r.id));
    const excludedIds = new Set(excluded.map((r) => r.id));
    expect(rows.some((r) => excludedIds.has(r.id))).toBe(false);
  });

  it('a page that fails AFTER the first rejects the read, never the first page as the list', async () => {
    const client = servedLikePostgrest(
      Array.from({ length: 1234 }, (_, i) => rental(i)),
      (call) => call.from === 1000,
    );
    await expect(readRentalPickerItems(client, ORG, WH)).rejects.toBeInstanceOf(IdBatchReadError);
    // What the screen branches on: a failure with its reason, not a value.
    expect(await settleIdBatchRead(readRentalPickerItems(client, ORG, WH))).toEqual({
      ok: false,
      message: 'fetch failed',
    });
  });

  it("stops at RENTAL_PICKER_ROW_CEILING, the web's CATALOG_ROW_CEILING, and says so", async () => {
    // The phone cannot import the web constant; this keeps the two equal.
    const loader = readFileSync(
      path.resolve(__dirname, '../../../web/src/server/loaders/orders-new-catalog.ts'),
      'utf8',
    );
    const web = /export const CATALOG_ROW_CEILING = ([\d_]+);/.exec(loader)?.[1];
    expect(web, 'CATALOG_ROW_CEILING not found in the web loader').toBeDefined();
    expect(RENTAL_PICKER_ROW_CEILING).toBe(Number(web!.replace(/_/g, '')));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = servedLikePostgrest(
      Array.from({ length: RENTAL_PICKER_ROW_CEILING + 50 }, (_, i) => ({
        ...rental(i),
        id: uuid(i),
        name: `Rental ${String(i).padStart(5, '0')}`,
      })),
    );

    const rows = await readRentalPickerItems(client, ORG, WH);

    expect(rows).toHaveLength(RENTAL_PICKER_ROW_CEILING);
    expect(rows.at(-1)?.id).toBe(uuid(RENTAL_PICKER_ROW_CEILING - 1));
    expect(client.calls).toHaveLength(RENTAL_PICKER_ROW_CEILING / 1000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${RENTAL_PICKER_ROW_CEILING}-row ceiling`));
  });

  it('under the ceiling, says nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await readRentalPickerItems(servedLikePostgrest([rental(1)]), ORG, WH);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('loadRentalItemsView (Rentals -> Items)', () => {
  const ORG = 'org-1';
  const sources = Array.from({ length: 200 }, (_, i) => ({
    id: uuid(i),
    name: `Item ${i}`,
    sku: null,
    quantity_on_hand: 4,
  }));

  function server(fail?: 'stock_reservations' | 'item_images') {
    return fakePostgrest((call: RecordedCall): PageResult<unknown> => {
      if (call.table === fail) return { data: null, error: { message: 'URI too long' }, status: 414 };
      const ids = (inValues(call, 'item_id') ?? []) as string[];
      const rows =
        call.table === 'stock_reservations'
          ? ids.map((id) => ({ id: `r-${id}`, item_id: id, quantity: 1 }))
          : ids
              .filter((_, i) => i % 2 === 0)
              .map((id) => ({ item_id: id, storage_path: `${id}.jpg`, thumb_path: null }));
      return { data: rows.slice(call.from, call.to + 1), error: null, status: 200 };
    });
  }

  it('batches both reads (200 ids is right at the local URL limit) and folds reservations in', async () => {
    const client = server();
    const view = await loadRentalItemsView(client, ORG, sources);
    expect(view.failed).toBe(false);
    expect(view.rows).toHaveLength(200);
    expect(view.rows[0]).toMatchObject({ onHand: 4, reserved: 1, available: 3 });
    expect(view.photoByItem.size).toBe(100);
    for (const c of client.calls) {
      expect(inValues(c, 'item_id')!.length).toBeLessThanOrEqual(100);
      expect(filterValue(c, 'eq', 'organization_id')).toBe(ORG);
    }
    expect(client.calls.filter((c) => c.table === 'stock_reservations')).toHaveLength(2);
    expect(client.calls.filter((c) => c.table === 'item_images')).toHaveLength(2);
  });

  it('a failed reservations read FAILS the view: Available would silently equal On hand', async () => {
    const view = await loadRentalItemsView(server('stock_reservations'), ORG, sources);
    expect(view).toEqual({ failed: true, message: 'URI too long', rows: [], photoByItem: new Map() });
  });

  it('a failed photo read leaves glyphs, with the rows and their figures intact', async () => {
    const view = await loadRentalItemsView(server('item_images'), ORG, sources);
    expect(view.failed).toBe(false);
    expect(view.rows).toHaveLength(200);
    expect(view.rows[0]).toMatchObject({ reserved: 1, available: 3 });
    expect(view.photoByItem.size).toBe(0);
  });
});

describe('Rentals screen wiring', () => {
  const screen = readFileSync(path.resolve(__dirname, '../screens/rentals.tsx'), 'utf8');

  it('reads reservations and photos through loadRentalItemsView, never an unbatched in()', () => {
    expect(screen).toContain('await loadRentalItemsView(supabase, orgId, sources)');
    expect(screen).not.toContain(".from('stock_reservations')");
    expect(screen).not.toContain(".from('item_images')");
  });

  it('a failed view sets the failed state with no total, so the eyebrow quotes no count', () => {
    expect(screen).toMatch(
      /if \(view\.failed\) \{[\s\S]*?setItems\(\{ orgId, rows: \[\], total: null, images: new Map\(\), failed: true \}\);\s*return;/,
    );
  });

  it('renders the eyebrow from the whole view state, so a failed load quotes no count', () => {
    // Computing it from rows.length and total alone put "RENTALS · 0 ITEMS"
    // over a failed load (see rentalItemsViewEyebrow).
    expect(screen).toContain('eyebrow={rentalItemsViewEyebrow(current)}');
    expect(screen).not.toMatch(/rentalItemsEyebrow\(/);
  });

  it('a failed checkouts read says so instead of "No rentals yet.", on every load', () => {
    // The rentals read's own error is bound (it now shares a Promise.all with
    // the reminder context, which never fails the list).
    expect(screen).toContain(
      'const [{ data, error }, context] = await Promise.all([\n      supabase\n        .from(\'rentals\')',
    );
    expect(screen).toContain('setCheckoutsFailed(Boolean(error));');
    expect(screen).toContain("emptyTitle={checkoutsFailed ? 'Could not load rentals.' : 'No rentals yet.'}");
    expect(screen).toMatch(/checkoutsFailed\s*\? 'RENTALS · CHECKOUTS'/);
  });
});
