import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { readBookStorage, readItemRack, resolvePlacement } from '@stockpilot/core';

import type { InventoryTableItem } from '@/components/inventory/inventory-table';
import {
  INVENTORY_CLIENT_CUSTOM_FIELD_KEYS,
  INVENTORY_CLIENT_ROW_FIELDS,
  packInventoryClientRows,
  toInventoryClientRows,
  withoutFlatTrends,
  type InventoryClientRowField,
} from '@/lib/inventory/client-row';
import { rowMatchesRack } from '@/lib/inventory/instant-mode';
import { syntheticListView, type PayloadProfile } from '@/test/inventory-payload.test.fixture';

// THE WEIGHT OF THE ITEMS AND BOOKS PAGES. A manager's Items or Books page
// carries the whole view (instant mode, up to INSTANT_MODE_MAX_ROWS rows):
// the rows, their placement lines and their 14-day trends. These tests weigh
// what the pages send for that dataset, per row, as JSON (React's Flight
// format writes plain data at the same length), raw and gzipped, and hold it
// under a bound. They also keep the lists in lib/inventory/client-row.ts equal
// to what the table reads, so a column the table needs cannot be left behind.

const WEB_SRC = join(__dirname, '..', '..');

/**
 * The Books page now resolves covers with the payload diet and the LQIP kept
 * (resolveInventoryListImages { payloadDiet, keepLqip }): a row with a thumb
 * ships no master URL, which the hover preview fetches when needed. The
 * Items rows already arrive that way.
 */
function booksCoverDiet<T extends { image_url: string | null; image_thumb_url: string | null }>(
  rows: T[],
): T[] {
  return rows.map((r) => (r.image_thumb_url ? { ...r, image_url: null } : r));
}

/** The dataset as the pages send it now (see the two list pages). */
function sentDataset(profile: PayloadProfile, n: number) {
  const view = syntheticListView(n, profile);
  const rows = toInventoryClientRows(profile === 'books' ? booksCoverDiet(view.items) : view.items);
  return {
    items: packInventoryClientRows(rows),
    placement: profile === 'books' ? undefined : view.placement,
    trends: [...withoutFlatTrends(view.trends, rows)],
  };
}

/** The dataset as the pages sent it before: whole rows, every trend. */
function wholeDataset(profile: PayloadProfile, n: number) {
  const view = syntheticListView(n, profile);
  return {
    items: view.items,
    placement: profile === 'books' ? undefined : view.placement,
    trends: [...view.trends],
  };
}

function weigh(value: unknown, n: number) {
  const json = JSON.stringify(value);
  const raw = Buffer.byteLength(json);
  const gzip = gzipSync(json).length;
  return { raw, gzip, rawPerRow: raw / n, gzipPerRow: gzip / n };
}

// Bytes per row of the sent dataset, raw / gzip. Whole rows with every trend
// (wholeDataset) weigh: seeded 1420 / 69, items 1977 / 100, books 3147 / 128;
// as sent: seeded 633 / 53, items 1097 / 75, books 1252 / 69 (1,000 and
// 2,000 rows alike, per row).
const BOUNDS: Record<PayloadProfile, { raw: number; gzip: number }> = {
  seeded: { raw: 700, gzip: 58 },
  items: { raw: 1200, gzip: 85 },
  books: { raw: 1350, gzip: 80 },
};

describe('the Items and Books dataset stays light', () => {
  for (const profile of ['seeded', 'items', 'books'] as PayloadProfile[]) {
    for (const n of [1000, 2000]) {
      it(`${profile}, ${n} rows: under ${BOUNDS[profile].raw} bytes per row raw and ${BOUNDS[profile].gzip} gzipped`, () => {
        const sent = weigh(sentDataset(profile, n), n);
        expect(sent.rawPerRow).toBeLessThan(BOUNDS[profile].raw);
        expect(sent.gzipPerRow).toBeLessThan(BOUNDS[profile].gzip);
      });
    }
  }

  it('writes the before and after table when PAYLOAD_REPORT_FILE is set', () => {
    const file = process.env.PAYLOAD_REPORT_FILE;
    if (!file) return;
    const lines = ['profile | rows | before raw | before gzip | after raw | after gzip'];
    for (const profile of ['seeded', 'items', 'books'] as PayloadProfile[]) {
      for (const n of [1000, 2000]) {
        const b = weigh(wholeDataset(profile, n), n);
        const a = weigh(sentDataset(profile, n), n);
        lines.push(
          `${profile} | ${n} | ${b.raw} (${b.rawPerRow.toFixed(0)}/row) | ${b.gzip} (${b.gzipPerRow.toFixed(0)}/row) | ${a.raw} (${a.rawPerRow.toFixed(0)}/row) | ${a.gzip} (${a.gzipPerRow.toFixed(0)}/row)`,
        );
      }
    }
    writeFileSync(file, `${lines.join('\n')}\n`);
  });
});

describe('the rows carry every column the table reads', () => {
  it('INVENTORY_CLIENT_ROW_FIELDS is exactly the table row type, less the fields the page derives', () => {
    // Expanded per holding by expandPlacementRows / expandInstantPlacementRows.
    type Derived = 'rowKey' | 'line_quantity' | 'placement_label' | 'placement_kind';
    type Read = Exclude<keyof InventoryTableItem, Derived>;
    // A field the table's row type gains must be added to the list, and the
    // list holds nothing the table does not read.
    expectTypeOf<InventoryClientRowField>().toEqualTypeOf<Read>();
  });

  it('a loader row keeps exactly the listed columns', () => {
    const [row] = syntheticListView(1, 'items').items;
    const slim = toInventoryClientRows([row!])[0]!;
    const expected = INVENTORY_CLIENT_ROW_FIELDS.filter((f) => f !== 'elsewhere_quantity');
    expect(Object.keys(slim).sort()).toEqual([...expected].sort());
  });

  it('every custom_fields key the list helpers read is kept, and nothing else', () => {
    const read = new Set<string>();
    const recording = (cf: Record<string, unknown>) =>
      new Proxy(cf, {
        get(target, key, receiver) {
          if (typeof key === 'string') read.add(key);
          return Reflect.get(target, key, receiver);
        },
      });
    const cf = {
      rack_number: '12',
      rack_row: 'B',
      book_rack_number: '38',
      book_rack_row: 'A',
      book_crate_color: 'blue',
      book_crate_number: '4',
      book_grade: '3',
    };
    // The helpers the table and the instant derivation read custom_fields
    // through (inventory-table.tsx, lib/inventory/instant-mode.ts).
    readBookStorage(recording(cf));
    readItemRack(recording(cf));
    for (const itemType of ['book', 'product'] as const) {
      resolvePlacement({ itemType, customFields: recording(cf), holdings: [] });
    }
    for (const view of ['items', 'books'] as const) {
      rowMatchesRack(recording(cf), '12-B', view);
      rowMatchesRack(recording(cf), '12', view);
    }
    expect([...read].sort()).toEqual([...INVENTORY_CLIENT_CUSTOM_FIELD_KEYS].sort());
  });

  it('the client reads custom_fields only through those helpers', () => {
    // Every line of the table's code that names custom_fields: a type, a
    // comment, or a call of one of the helpers above. A new direct read
    // (item.custom_fields?.author) fails here: add its key to
    // INVENTORY_CLIENT_CUSTOM_FIELD_KEYS, then to the allowed lines.
    const allowed = [
      /^\s*(\/\/|\*|\/\*\*)/, // comments
      /custom_fields\?: Record<string, unknown> \| null;/, // type declarations
      /readBookStorage\(\w+\.custom_fields\)/,
      /readItemRack\(\w+\.custom_fields\)/,
      /customFields: item\.custom_fields \?\? null,/, // resolvePlacement's input
      /rowMatchesRack\(r\.custom_fields, state\.rack, view\)/,
    ];
    const files = [
      'components/inventory/inventory-table.tsx',
      'components/inventory/inventory-grid.tsx',
      'components/inventory/use-instant-filters.ts',
      'components/books/books-glass-columns.tsx',
      'components/books/books-inventory-table.tsx',
      'lib/inventory/instant-mode.ts',
    ];
    const unexpected: string[] = [];
    for (const f of files) {
      const lines = readFileSync(join(WEB_SRC, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!line.includes('custom_fields')) return;
        if (!allowed.some((re) => re.test(line))) unexpected.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(unexpected).toEqual([]);
  });

  it('no client file that receives the rows reads a column that is no longer sent', () => {
    // Typed reads are held by the type check above (tsc). This covers what tsc
    // cannot see: a cast past the row type, `(i as { supplier_id?: string })`,
    // and a property read off a value typed loosely, in every client file the
    // rows reach. The columns the loaders select and the table does not read:
    const row = syntheticListView(1, 'items').items[0]! as unknown as Record<string, unknown>;
    const dropped = Object.keys(row).filter(
      (k) => !(INVENTORY_CLIENT_ROW_FIELDS as readonly string[]).includes(k),
    );
    expect(dropped.sort()).toEqual(
      [
        'created_by',
        'description',
        'is_rental',
        'jersey_number',
        'retail_price',
        'supplier_id',
        'tracking_type',
        'updated_by',
        'variant_key',
        'variant_size_system',
      ].sort(),
    );
    const names = dropped.join('|');
    // A cast naming a dropped column, on any identifier.
    const cast = new RegExp(String.raw`as\s+\{[^}]*\b(${names})\??\s*:`);
    // A property read of a dropped column. `description` is left out here:
    // the empty states and dialogs these files render take a `description`
    // prop of their own; the cast check above still covers it.
    const read = new RegExp(
      String.raw`\.(${dropped.filter((d) => d !== 'description').join('|')})\b`,
    );
    const files = [
      'components/inventory/inventory-table.tsx',
      'components/inventory/inventory-grid.tsx',
      'components/inventory/use-instant-filters.ts',
      'components/inventory/selection-utils.ts',
      'components/books/books-glass-columns.tsx',
      'components/books/books-inventory-table.tsx',
      'lib/inventory/instant-mode.ts',
      'lib/inventory/group-by-sku.ts',
      'lib/inventory/rack-holdings.ts',
      'lib/orders/start-order-prefill.ts',
      'lib/placements.ts',
    ];
    const found: string[] = [];
    for (const f of files) {
      const lines = readFileSync(join(WEB_SRC, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*\*)/.test(line)) return;
        if (cast.test(line) || read.test(line)) found.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
