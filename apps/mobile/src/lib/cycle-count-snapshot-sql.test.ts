import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  CYCLE_COUNT_HEADER_UPSERT_SQL,
  CYCLE_COUNT_LINE_UPSERT_SQL,
  CYCLE_COUNT_STALE_LINES_DELETE_SQL,
} from './cycle-count-snapshot-sql';

/**
 * Runs the real snapshot SQL against a real SQLite with the real db.ts DDL
 * for the two tables. This is the regression test for SP-011: before the
 * fix, one snapshot pull turned a fully cached count (cached_at set, names
 * present, an unsynced dirty line) into an uncached shell with the operator's
 * count overwritten by the server's stale value.
 */

// Verbatim from db.ts SCHEMA_SQL for these two tables.
const DDL = `
  create table cycle_counts (
    id text primary key, organization_id text, status text, warehouse_id text,
    warehouse_name text, started_at text, posted_at text, assigned_to text,
    notes text, last_synced_at integer not null, cached_at integer
  );
  create table cycle_count_lines (
    id text primary key, count_id text not null, item_id text not null,
    item_name text, item_sku text, item_barcode text, item_variant_label text,
    expected real not null default 0, counted real, updated_at text,
    local_dirty integer not null default 0
  );`;

let db: DatabaseSync;

function snapshotPull(lines: { id: string; itemId: string; expected: number; counted: number | null }[]) {
  db.prepare(CYCLE_COUNT_HEADER_UPSERT_SQL).run('c1', 'in_progress', 'wh1', '2026-09-01T00:00:00Z', 'user-assignee', 'note', 999);
  for (const l of lines) db.prepare(CYCLE_COUNT_LINE_UPSERT_SQL).run(l.id, 'c1', l.itemId, l.expected, l.counted);
  db.prepare(CYCLE_COUNT_STALE_LINES_DELETE_SQL).run('c1', JSON.stringify(lines.map((l) => l.id)));
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(DDL);
  // A count the operator opened offline: fully cached, one line edited locally.
  db.prepare(
    `insert into cycle_counts (id, organization_id, status, warehouse_id, warehouse_name, started_at, posted_at, assigned_to, notes, last_synced_at, cached_at)
     values ('c1', 'org1', 'in_progress', 'wh1', 'DC4', '2026-09-01T00:00:00Z', null, null, null, 1, 123)`,
  ).run();
  db.prepare(
    `insert into cycle_count_lines (id, count_id, item_id, item_name, item_sku, item_barcode, item_variant_label, expected, counted, updated_at, local_dirty)
     values ('dirty', 'c1', 'i1', 'Widget', 'W-1', '111', 'Size 10', 10, 7, 't0', 1),
            ('clean', 'c1', 'i2', 'Gadget', 'G-1', null, null, 5, 5, 't0', 0),
            ('gone-clean', 'c1', 'i3', 'Old', 'O-1', null, null, 1, null, 't0', 0),
            ('gone-dirty', 'c1', 'i4', 'Kept', 'K-1', null, null, 1, 3, 't0', 1)`,
  ).run();
});

describe('cycle-count snapshot SQL (SP-011)', () => {
  it('a snapshot pull keeps the full cache: cached_at, warehouse_name, org, posted_at survive', () => {
    snapshotPull([{ id: 'dirty', itemId: 'i1', expected: 10, counted: 4 }, { id: 'clean', itemId: 'i2', expected: 5, counted: 6 }]);
    const h = db.prepare('select * from cycle_counts where id = ?').get('c1') as Record<string, unknown>;
    expect(h.cached_at).toBe(123); // the old insert-or-replace nulled this -> "never cached"
    expect(h.warehouse_name).toBe('DC4');
    expect(h.organization_id).toBe('org1');
    // ... while what the snapshot DOES carry is refreshed.
    expect(h.assigned_to).toBe('user-assignee');
    expect(h.last_synced_at).toBe(999);
    expect(h.notes).toBe('note');
  });

  it('LOCAL wins for a dirty line: the unsynced count and item metadata are untouched', () => {
    snapshotPull([{ id: 'dirty', itemId: 'i1', expected: 12, counted: 4 }, { id: 'clean', itemId: 'i2', expected: 5, counted: 6 }]);
    const l = db.prepare('select * from cycle_count_lines where id = ?').get('dirty') as Record<string, unknown>;
    expect(l.counted).toBe(7); // NOT the server's 4
    expect(l.local_dirty).toBe(1);
    expect(l.item_name).toBe('Widget');
    expect(l.item_variant_label).toBe('Size 10');
    expect(l.expected).toBe(12); // expected is the server's to refresh
  });

  it('server wins for a clean line, without blanking its names', () => {
    snapshotPull([{ id: 'dirty', itemId: 'i1', expected: 10, counted: 4 }, { id: 'clean', itemId: 'i2', expected: 5, counted: 6 }]);
    const l = db.prepare('select * from cycle_count_lines where id = ?').get('clean') as Record<string, unknown>;
    expect(l.counted).toBe(6);
    expect(l.local_dirty).toBe(0);
    expect(l.item_name).toBe('Gadget');
  });

  it('removes a clean line the server no longer lists, but keeps a dirty one', () => {
    snapshotPull([{ id: 'dirty', itemId: 'i1', expected: 10, counted: 4 }, { id: 'clean', itemId: 'i2', expected: 5, counted: 6 }]);
    const ids = (db.prepare('select id from cycle_count_lines where count_id = ? order by id').all('c1') as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(['clean', 'dirty', 'gone-dirty']);
  });

  it('inserts a brand-new line as clean with the server value', () => {
    snapshotPull([{ id: 'new', itemId: 'i9', expected: 2, counted: null }]);
    const l = db.prepare('select * from cycle_count_lines where id = ?').get('new') as Record<string, unknown>;
    expect(l.counted).toBeNull();
    expect(l.local_dirty).toBe(0);
    expect(l.count_id).toBe('c1');
  });
});
