import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addColumnIfMissing } from './db';

// db.ts pulls in expo-sqlite (native) — mocked wholesale, vitest runs in
// node. vi.mock is hoisted above the imports by vitest's transform, so
// declaring it after keeps import order lint-clean (same pattern as
// warehouse-scope.test.ts). The mock is never exercised: this file only
// calls the pure, already-exported `addColumnIfMissing` against a
// hand-built fake db object.
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));

/**
 * `addColumnIfMissing` (db.ts:216) is the NON-destructive alternative to
 * bumping SCHEMA_VERSION — the only other way to widen a cached table, and
 * that path drops `pending_actions`, the offline outbox. It had zero direct
 * coverage before this: a regression here (e.g. a typo'd `pragma table_info`
 * that always reports "missing", so every app launch re-issues an `alter
 * table` that then throws) would only ever surface as an app that mysteriously
 * fails to open its local DB, not as a failing test.
 *
 * Pure module test: a fake db object standing in for SQLite.SQLiteDatabase,
 * exercising only `getAllAsync` (pragma table_info) and `execAsync` (the
 * alter table) — no expo-sqlite, no React Native.
 */
function fakeDb(existingColumns: string[]) {
  const columns = new Set(existingColumns);
  const execAsync = vi.fn(async (sql: string) => {
    const m = /add column (\w+)/i.exec(sql);
    if (m?.[1]) columns.add(m[1]);
  });
  const getAllAsync = vi.fn(async () =>
    [...columns].map((name) => ({ name })),
  );
  return { columns, execAsync, getAllAsync };
}

describe('addColumnIfMissing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds the column to a fresh table that does not have it yet', async () => {
    const db = fakeDb(['id', 'count_id']);

    await addColumnIfMissing(db as never, 'cycle_count_lines', 'item_variant_label', 'text');

    expect(db.execAsync).toHaveBeenCalledExactlyOnceWith(
      'alter table cycle_count_lines add column item_variant_label text',
    );
    expect(db.columns.has('item_variant_label')).toBe(true);
  });

  it('is a no-op when the column already exists', async () => {
    const db = fakeDb(['id', 'item_variant_label']);

    await addColumnIfMissing(db as never, 'cycle_count_lines', 'item_variant_label', 'text');

    expect(db.execAsync).not.toHaveBeenCalled();
  });

  it('is idempotent across repeated calls — a second run does not re-alter', async () => {
    const db = fakeDb(['id']);

    await addColumnIfMissing(db as never, 'cycle_count_lines', 'item_variant_label', 'text');
    // Simulates the next app launch calling ensureSchema() again.
    await addColumnIfMissing(db as never, 'cycle_count_lines', 'item_variant_label', 'text');

    expect(db.execAsync).toHaveBeenCalledTimes(1);
  });

  it('swallows a racing "duplicate column" error from execAsync rather than throwing', async () => {
    // getAllAsync reports the column absent (a racing add from a concurrent
    // getDb() call hasn't committed to the connection's schema cache yet),
    // so execAsync fires and the SQLite driver rejects it as a duplicate.
    const db = {
      getAllAsync: vi.fn(async () => [{ name: 'id' }]),
      execAsync: vi.fn(async () => {
        throw new Error('duplicate column name: item_variant_label');
      }),
    };

    await expect(
      addColumnIfMissing(db as never, 'cycle_count_lines', 'item_variant_label', 'text'),
    ).resolves.toBeUndefined();
  });
});
