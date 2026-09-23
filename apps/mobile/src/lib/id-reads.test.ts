import { describe, expect, it } from 'vitest';

import {
  fakePostgrest,
  filterValue,
  inValues,
  rowsServer,
  uuid,
  type RecordedCall,
} from './__fixtures__/fake-postgrest';
import { IdBatchReadError, IN_FILTER_MAX_VALUES } from './id-batches';
import {
  readItemRefs,
  readOnHand,
  readOpenReservations,
  readPoRunGroups,
  readPrimaryPhotos,
  readProfilesByIds,
  readRackHoldings,
  readReceiptTotals,
  sumReservedByItem,
} from './id-reads';

const ORG = 'org-1';
const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));

/** Every call sends at most 100 values in its one `.in()` id filter. */
function expectBatched(calls: RecordedCall[], column: string) {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    const vals = inValues(c, column);
    expect(vals, `${c.table} must filter ${column} with .in()`).toBeDefined();
    expect(vals!.length).toBeLessThanOrEqual(IN_FILTER_MAX_VALUES);
  }
}

/** A server that fails the batch containing `poison`. */
function failingOn(column: string, poison: string, rows: (c: RecordedCall) => unknown[] = () => []) {
  return (call: RecordedCall) =>
    (inValues(call, column) ?? []).includes(poison)
      ? { data: null, error: { message: 'fetch failed' }, status: 0 }
      : { data: rows(call).slice(call.from, call.to + 1), error: null };
}

describe('readOpenReservations', () => {
  it('reads open reservations org-scoped, in batches of at most 100, ordered by id', async () => {
    const client = fakePostgrest(
      rowsServer((call) => (inValues(call, 'item_id') ?? []).map((id) => ({ id: `r-${String(id)}`, item_id: id, quantity: 2 }))),
    );
    const rows = await readOpenReservations(client, ORG, ids(250));
    expect(client.calls).toHaveLength(3);
    expectBatched(client.calls, 'item_id');
    for (const c of client.calls) {
      expect(c.table).toBe('stock_reservations');
      expect(filterValue(c, 'eq', 'organization_id')).toBe(ORG);
      expect(c.filters).toContainEqual(['is', 'released_at', null]);
      expect(c.order).toEqual([['id', true]]);
    }
    expect(rows).toHaveLength(250);
    expect(rows[0]).toEqual({ item_id: uuid(0), quantity: 2 });
  });

  it('rethrows a failed batch rather than answering "nothing reserved"', async () => {
    const client = fakePostgrest(failingOn('item_id', uuid(150)));
    await expect(readOpenReservations(client, ORG, ids(250))).rejects.toBeInstanceOf(IdBatchReadError);
  });

  it('makes no request for no items', async () => {
    const client = fakePostgrest(rowsServer(() => []));
    expect(await readOpenReservations(client, ORG, [])).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });
});

describe('sumReservedByItem', () => {
  it('sums per item and skips quantities that are not numbers', () => {
    const m = sumReservedByItem([
      { item_id: 'a', quantity: 2 },
      { item_id: 'a', quantity: '3' },
      { item_id: 'b', quantity: 'x' },
      { item_id: 'b', quantity: null },
    ]);
    expect(m.get('a')).toBe(5);
    expect(m.get('b')).toBe(0);
  });
});

describe('readOnHand', () => {
  it('250 ids make 3 org-scoped calls and return on hand per id', async () => {
    const client = fakePostgrest(
      rowsServer((call) => (inValues(call, 'id') ?? []).map((id, i) => ({ id, quantity_on_hand: String(i) }))),
    );
    const onHand = await readOnHand(client, ORG, ids(250));
    expect(client.calls).toHaveLength(3);
    expectBatched(client.calls, 'id');
    for (const c of client.calls) {
      expect(c.table).toBe('inventory_items');
      expect(filterValue(c, 'eq', 'organization_id')).toBe(ORG);
    }
    expect(onHand.size).toBe(250);
    expect(onHand.get(uuid(101))).toBe(1);
  });

  it('rethrows a failed batch', async () => {
    const client = fakePostgrest(failingOn('id', uuid(5)));
    await expect(readOnHand(client, ORG, ids(20))).rejects.toBeInstanceOf(IdBatchReadError);
  });
});

describe('readPrimaryPhotos', () => {
  it('is org-scoped, keeps the photo order, and picks the first row per item across pages', async () => {
    // Item 0 has 1500 photos: its batch spans two pages, and only the very
    // first row (the primary) may win.
    const photosFor = (call: RecordedCall) => {
      const out: unknown[] = [];
      for (const id of inValues(call, 'item_id') ?? []) {
        const n = id === uuid(0) ? 1500 : 1;
        for (let k = 0; k < n; k += 1) {
          out.push({ item_id: id, storage_path: `${String(id)}/${k}.jpg`, thumb_path: k === 0 ? `${String(id)}/t.jpg` : null });
        }
      }
      return out;
    };
    const client = fakePostgrest(rowsServer(photosFor));
    const photos = await readPrimaryPhotos(client, ORG, ids(3));
    expect(client.calls.map((c) => [c.from, c.to])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    for (const c of client.calls) {
      expect(c.table).toBe('item_images');
      expect(c.select).toBe('item_id, storage_path, thumb_path, is_primary, sort_order');
      expect(filterValue(c, 'eq', 'organization_id')).toBe(ORG);
      expect(c.order).toEqual([
        ['is_primary', false],
        ['sort_order', true],
        ['id', true],
      ]);
    }
    expect(photos.get(uuid(0))).toEqual({ storage_path: `${uuid(0)}/0.jpg`, thumb_path: `${uuid(0)}/t.jpg` });
    expect(photos.size).toBe(3);
  });

  it('an item with no photo has no entry', async () => {
    const client = fakePostgrest(rowsServer(() => []));
    const photos = await readPrimaryPhotos(client, ORG, ['a']);
    expect(photos.has('a')).toBe(false);
  });

  it('rethrows a failed batch rather than answering "no photos"', async () => {
    const client = fakePostgrest(failingOn('item_id', uuid(120)));
    await expect(readPrimaryPhotos(client, ORG, ids(200))).rejects.toBeInstanceOf(IdBatchReadError);
  });
});

describe('readRackHoldings', () => {
  it('keeps the rack/crate kind filter, the quantity filter, and the org scope', async () => {
    const client = fakePostgrest(
      rowsServer((call) =>
        (inValues(call, 'item_id') ?? []).flatMap((id) => [
          { item_id: id, quantity: '5', locations: { name: '38-A', kind: 'rack' } },
          { item_id: id, quantity: 2, locations: [{ name: 'Blue Shelf', kind: 'crate' }] },
          { item_id: id, quantity: 1, locations: null },
        ]),
      ),
    );
    const holdings = await readRackHoldings(client, ORG, ids(150));
    expect(client.calls).toHaveLength(2);
    expectBatched(client.calls, 'item_id');
    for (const c of client.calls) {
      expect(c.table).toBe('item_stock_levels');
      expect(c.select).toBe('item_id, quantity, locations!inner(name, kind)');
      expect(filterValue(c, 'eq', 'organization_id')).toBe(ORG);
      expect(inValues(c, 'locations.kind')).toEqual(['rack', 'crate']);
      expect(filterValue(c, 'gt', 'quantity')).toBe(0);
    }
    expect(holdings.get(uuid(0))).toEqual([
      { name: '38-A', quantity: 5, kind: 'rack' },
      { name: 'Blue Shelf', quantity: 2, kind: 'crate' },
    ]);
  });

  it('rethrows a failed batch rather than answering "no holdings" (which would show the stale rack label)', async () => {
    const client = fakePostgrest(failingOn('item_id', uuid(210)));
    await expect(readRackHoldings(client, ORG, ids(300))).rejects.toBeInstanceOf(IdBatchReadError);
  });
});

describe('readProfilesByIds', () => {
  it('batches profile ids and keys the rows by id', async () => {
    const client = fakePostgrest(
      rowsServer((call) => (inValues(call, 'id') ?? []).map((id) => ({ id, full_name: `n-${String(id)}` }))),
    );
    const m = await readProfilesByIds<{ id: string; full_name: string }>(client, ids(250), 'id, full_name');
    expect(client.calls).toHaveLength(3);
    expectBatched(client.calls, 'id');
    expect(client.calls[0]!.select).toBe('id, full_name');
    expect(m.get(uuid(249))?.full_name).toBe(`n-${uuid(249)}`);
  });

  it('rethrows a failed batch', async () => {
    const client = fakePostgrest(failingOn('id', uuid(0)));
    await expect(readProfilesByIds(client, ids(3), 'id')).rejects.toBeInstanceOf(IdBatchReadError);
  });
});

describe('readItemRefs', () => {
  it('batches up to 1000 ids org-scoped', async () => {
    const client = fakePostgrest(
      rowsServer((call) => (inValues(call, 'id') ?? []).map((id) => ({ id, name: 'N', sku: 'S' }))),
    );
    const refs = await readItemRefs(client, ORG, ids(1000));
    expect(client.calls).toHaveLength(10);
    expectBatched(client.calls, 'id');
    expect(filterValue(client.calls[0]!, 'eq', 'organization_id')).toBe(ORG);
    expect(Object.keys(refs)).toHaveLength(1000);
  });

  it('rethrows a failed batch', async () => {
    const client = fakePostgrest(failingOn('id', uuid(999)));
    await expect(readItemRefs(client, ORG, ids(1000))).rejects.toBeInstanceOf(IdBatchReadError);
  });
});

describe('readPoRunGroups', () => {
  const server = (opts: { failScales?: boolean } = {}) =>
    fakePostgrest((call) => {
      if (call.table === 'product_groups') {
        const rows = (inValues(call, 'id') ?? []).map((id) => ({
          id,
          name: `Group ${String(id)}`,
          default_counting_unit: 'pair',
          size_scale_id: id === 'g1' ? 'scale-1' : null,
        }));
        return { data: rows.slice(call.from, call.to + 1), error: null };
      }
      if (opts.failScales) return { data: null, error: { message: 'scale read failed' } };
      // Returned in sort_order, as the server orders them.
      return {
        data: [
          { size_scale_id: 'scale-1', value: 'S', normalized: 's', sort_order: 1 },
          { size_scale_id: 'scale-1', value: 'M', normalized: 'm', sort_order: 2 },
          { size_scale_id: 'scale-1', value: 'L', normalized: null, sort_order: '3' },
        ],
        error: null,
      };
    });

  it('builds each group with its sizes in sort order, org-scoped, deleted groups excluded', async () => {
    const client = server();
    const groups = await readPoRunGroups(client, ORG, ['g1', 'g2', null, 'g1']);
    const groupCall = client.calls.find((c) => c.table === 'product_groups')!;
    expect(inValues(groupCall, 'id')).toEqual(['g1', 'g2']);
    expect(filterValue(groupCall, 'eq', 'organization_id')).toBe(ORG);
    expect(groupCall.filters).toContainEqual(['is', 'deleted_at', null]);
    const scaleCall = client.calls.find((c) => c.table === 'size_scale_values')!;
    expect(inValues(scaleCall, 'size_scale_id')).toEqual(['scale-1']);
    expect(scaleCall.order).toEqual([
      ['sort_order', true],
      ['id', true],
    ]);
    expect(groups.g1).toEqual({
      name: 'Group g1',
      countingUnit: 'pair',
      sizeValues: [
        { value: 'S', normalized: 's', sortOrder: 1 },
        { value: 'M', normalized: 'm', sortOrder: 2 },
        { value: 'L', normalized: null, sortOrder: 3 },
      ],
    });
    expect(groups.g2).toEqual({ name: 'Group g2', countingUnit: 'pair', sizeValues: [] });
  });

  it('a failed size-scale read rejects: sizes are never returned unordered', async () => {
    await expect(readPoRunGroups(server({ failScales: true }), ORG, ['g1'])).rejects.toBeInstanceOf(
      IdBatchReadError,
    );
  });
});

describe('readReceiptTotals', () => {
  it('sums accepted and rejected across every page of receipt lines', async () => {
    const client = fakePostgrest(
      rowsServer(() =>
        Array.from({ length: 1200 }, (_, i) => ({
          receipt_id: i % 2 === 0 ? 'r1' : 'r2',
          qty_accepted_base: 1,
          qty_rejected_base: i === 0 ? '2' : 0,
        })),
      ),
    );
    const totals = await readReceiptTotals(client, ['r1', 'r2']);
    expect(client.calls).toHaveLength(2);
    expect(totals.get('r1')).toEqual({ accepted: 600, rejected: 2 });
    expect(totals.get('r2')).toEqual({ accepted: 600, rejected: 0 });
  });

  it('rethrows a failed page rather than showing zero totals', async () => {
    const client = fakePostgrest(() => ({ data: null, error: { message: 'nope' } }));
    await expect(readReceiptTotals(client, ['r1'])).rejects.toBeInstanceOf(IdBatchReadError);
  });
});
