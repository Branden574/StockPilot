/**
 * The three statements the 60 s snapshot pull runs for cycle counts.
 *
 * WHY THEY LIVE HERE, ALONE: sync.ts imports expo-sqlite and cannot be loaded
 * in the node test runner, but the exact SQL is where the bug was, so the SQL
 * is exported from a module with no imports and exercised against a real
 * SQLite (node:sqlite) in cycle-count-snapshot-sql.test.ts.
 *
 * THE BUG (SP-011): the pull did `insert or replace into cycle_counts` with
 * seven columns and `delete from cycle_count_lines where count_id = ?` before
 * re-inserting five. `insert or replace` is a DELETE + INSERT in SQLite, so
 * every column not in the list — cached_at, warehouse_name, organization_id,
 * posted_at — went NULL, and every line lost item_name / sku / barcode /
 * variant and, worst, local_dirty and the operator's counted value. Every
 * minute, on every open count, the offline cache a counter had just built was
 * destroyed (getCycleCount() treats cached_at NULL as "never cached") and any
 * unsynced count was overwritten by the server's stale value.
 *
 * THE RULES ENCODED BELOW:
 *   header: update only what the snapshot carries; never touch cached_at,
 *           warehouse_name, organization_id or posted_at (the detail screen's
 *           full cache owns those).
 *   lines:  server wins for clean lines, LOCAL wins for dirty lines
 *           (counted is kept when local_dirty = 1) — the same policy
 *           cacheCycleCount already applies — and item metadata is never
 *           blanked by a snapshot that does not carry it.
 *   stale:  lines the server no longer lists are removed ONLY when clean; a
 *           dirty line is the operator's unsynced work and stays until the
 *           outbox settles it.
 */

export const CYCLE_COUNT_HEADER_UPSERT_SQL = `
  insert into cycle_counts
    (id, status, warehouse_id, started_at, assigned_to, notes, last_synced_at)
  values (?, ?, ?, ?, ?, ?, ?)
  on conflict(id) do update set
    status         = excluded.status,
    warehouse_id   = excluded.warehouse_id,
    started_at     = excluded.started_at,
    assigned_to    = excluded.assigned_to,
    notes          = excluded.notes,
    last_synced_at = excluded.last_synced_at`;

export const CYCLE_COUNT_LINE_UPSERT_SQL = `
  insert into cycle_count_lines (id, count_id, item_id, expected, counted, local_dirty)
  values (?, ?, ?, ?, ?, 0)
  on conflict(id) do update set
    count_id = excluded.count_id,
    item_id  = excluded.item_id,
    expected = excluded.expected,
    counted  = case
                 when cycle_count_lines.local_dirty = 1 then cycle_count_lines.counted
                 else excluded.counted
               end`;

/** Params: (count_id, json array of the snapshot's line ids). */
export const CYCLE_COUNT_STALE_LINES_DELETE_SQL = `
  delete from cycle_count_lines
   where count_id = ?
     and local_dirty = 0
     and id not in (select value from json_each(?))`;
