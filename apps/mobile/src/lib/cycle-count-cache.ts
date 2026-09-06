import { getDb } from './db';
import { markRejected } from './queue';

/**
 * Offline cycle-count cache + outbox helpers.
 *
 * Reads/writes go through SQLite first; the sync engine drains the
 * outbox table (pending_actions, kind='record_count') back to the
 * server when network is up.
 *
 * Conflict policy:
 *   - Server wins for lines the user hasn't touched locally.
 *     `cacheCycleCount` only overwrites a line when local_dirty=0.
 *   - Local wins for lines the user has touched. The dirty flag
 *     stays set until the matching outbox row succeeds (`outboxAck`).
 */

export interface CachedCycleCountHeader {
  id: string;
  organizationId: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  status: string;
  startedAt: string;
  postedAt: string | null;
  /** Manager-set assignee (null = unassigned). Drives the read-only gate so a
   *  non-assignee sees the count read-only, mirroring the server 0282 lock.
   *  Optional for back-compat with cache entries written before this field. */
  assignedTo?: string | null;
  cachedAt: number;
}

export interface CachedCycleCountLine {
  id: string;
  cycleCountId: string;
  itemId: string;
  itemName: string;
  itemSku: string;
  itemBarcode: string | null;
  /** WHICH VARIANT this line is: "Size 10", "#12 · Size XL". Null for every
   *  item in a non-sports org, and on rows cached before this column existed
   *  — they re-cache on the next online open of the count. */
  itemVariantLabel: string | null;
  expected: number;
  counted: number | null;
  updatedAt: string | null;
  localDirty: boolean;
}

export interface CycleCountSnapshot {
  header: CachedCycleCountHeader;
  lines: CachedCycleCountLine[];
}

/**
 * Upsert a cycle count + lines into the local cache. Lines that are
 * locally dirty are NOT overwritten — those carry the user's pending
 * edit until the sync engine flushes it.
 */
export async function cacheCycleCount(
  header: {
    id: string;
    organizationId: string | null;
    warehouseId: string | null;
    warehouseName: string | null;
    status: string;
    startedAt: string;
    postedAt?: string | null;
    /** Manager-set assignee. MUST round-trip through the cache: the detail
     *  screen re-hydrates from getCycleCount() right after caching, so a
     *  header cached without it un-locks the count for every non-assignee and
     *  hides Release from the assignee (the 0282 lock was dead on mobile). */
    assignedTo?: string | null;
  },
  lines: Array<{
    id: string;
    itemId: string;
    itemName: string;
    itemSku: string;
    itemBarcode: string | null;
    itemVariantLabel?: string | null;
    expected: number;
    counted: number | null;
    updatedAt: string | null;
  }>,
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `insert or replace into cycle_counts
         (id, organization_id, status, warehouse_id, warehouse_name,
          started_at, posted_at, assigned_to, last_synced_at, cached_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        header.id,
        header.organizationId,
        header.status,
        header.warehouseId,
        header.warehouseName,
        header.startedAt,
        header.postedAt ?? null,
        header.assignedTo ?? null,
        now,
        now,
      ],
    );

    for (const line of lines) {
      // Server-wins for clean lines, local-wins for dirty lines.
      const existing = await db.getFirstAsync<{ local_dirty: number }>(
        'select local_dirty from cycle_count_lines where id = ?',
        [line.id],
      );
      if (existing && existing.local_dirty === 1) {
        // Refresh metadata + expected, but leave counted alone.
        await db.runAsync(
          `update cycle_count_lines
             set item_name = ?, item_sku = ?, item_barcode = ?,
                 item_variant_label = ?, expected = ?, updated_at = ?
           where id = ?`,
          [
            line.itemName,
            line.itemSku,
            line.itemBarcode,
            line.itemVariantLabel ?? null,
            line.expected,
            line.updatedAt,
            line.id,
          ],
        );
        continue;
      }

      await db.runAsync(
        `insert or replace into cycle_count_lines
           (id, count_id, item_id, item_name, item_sku, item_barcode,
            item_variant_label, expected, counted, updated_at, local_dirty)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          line.id,
          header.id,
          line.itemId,
          line.itemName,
          line.itemSku,
          line.itemBarcode,
          line.itemVariantLabel ?? null,
          line.expected,
          line.counted,
          line.updatedAt,
        ],
      );
    }
  });
}

export async function getCycleCount(
  id: string,
): Promise<CycleCountSnapshot | null> {
  const db = await getDb();
  const headerRow = await db.getFirstAsync<{
    id: string;
    organization_id: string | null;
    status: string | null;
    warehouse_id: string | null;
    warehouse_name: string | null;
    started_at: string | null;
    posted_at: string | null;
    assigned_to: string | null;
    cached_at: number | null;
  }>(
    `select id, organization_id, status, warehouse_id, warehouse_name,
            started_at, posted_at, assigned_to, cached_at
       from cycle_counts where id = ?`,
    [id],
  );
  if (!headerRow) return null;
  // A row exists but was created by an old snapshot pull before the
  // user opened the count in detail — treat as "not yet fully cached"
  // only if cached_at is null (meaning we never wrote a full snapshot
  // for offline use).
  if (!headerRow.cached_at) return null;

  const lineRows = await db.getAllAsync<{
    id: string;
    count_id: string;
    item_id: string;
    item_name: string | null;
    item_sku: string | null;
    item_barcode: string | null;
    item_variant_label: string | null;
    expected: number;
    counted: number | null;
    updated_at: string | null;
    local_dirty: number;
  }>(
    `select id, count_id, item_id, item_name, item_sku, item_barcode,
            item_variant_label, expected, counted, updated_at, local_dirty
       from cycle_count_lines where count_id = ?`,
    [id],
  );

  return {
    header: {
      id: headerRow.id,
      organizationId: headerRow.organization_id,
      warehouseId: headerRow.warehouse_id,
      warehouseName: headerRow.warehouse_name,
      status: headerRow.status ?? 'in_progress',
      startedAt: headerRow.started_at ?? '',
      postedAt: headerRow.posted_at,
      assignedTo: headerRow.assigned_to ?? null,
      cachedAt: headerRow.cached_at,
    },
    lines: lineRows.map((r) => ({
      id: r.id,
      cycleCountId: r.count_id,
      itemId: r.item_id,
      itemName: r.item_name ?? 'Unknown',
      itemSku: r.item_sku ?? '',
      itemBarcode: r.item_barcode,
      itemVariantLabel: r.item_variant_label,
      expected: r.expected,
      counted: r.counted,
      updatedAt: r.updated_at,
      localDirty: r.local_dirty === 1,
    })),
  };
}

/**
 * Apply a local edit to a counted-qty line. Marks the line dirty and
 * enqueues a `record_count` row in the outbox. Both writes happen
 * inside a single transaction so we never end up with a dirty line
 * that has no matching outbox entry (or vice versa).
 */
export async function updateLocalLine(
  lineId: string,
  counted: number,
): Promise<{ outboxId: number; idempotencyKey: string } | null> {
  const db = await getDb();
  const line = await db.getFirstAsync<{
    id: string;
    count_id: string;
  }>(
    'select id, count_id from cycle_count_lines where id = ?',
    [lineId],
  );
  if (!line) return null;

  const idempotencyKey = uuid();
  let outboxId = 0;
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `update cycle_count_lines
         set counted = ?, local_dirty = 1
       where id = ?`,
      [counted, lineId],
    );
    // ═══ ONE LIVE OUTBOX ROW PER LINE ═══
    //
    // Every edit used to append a fresh record_count row and the drain sent
    // them oldest-first, so an operator who counted 5, then corrected to 7
    // while offline, could have the 5 land AFTER the 7 when a retry
    // reordered them — the correction was lost to the server. An edit
    // supersedes every earlier queued edit for the same line; a row already
    // 'sending' is in flight and must not be touched (the drain-side
    // newest-wins check in cycle-count-sync covers that window).
    await db.runAsync(
      `delete from pending_actions
        where kind = 'record_count'
          and status in ('pending','failed')
          and json_extract(payload_json, '$.lineId') = ?`,
      [lineId],
    );
    const result = await db.runAsync(
      `insert into pending_actions
         (kind, idempotency_key, payload_json, created_at)
       values (?, ?, ?, ?)`,
      [
        'record_count',
        idempotencyKey,
        JSON.stringify({
          cycleCountId: line.count_id,
          lineId: line.id,
          countedQuantity: counted,
        }),
        Date.now(),
      ],
    );
    outboxId = result.lastInsertRowId as number;
  });
  return { outboxId, idempotencyKey };
}

/**
 * How many `record_count` outbox rows are pending or failed for a
 * given cycle count? UI uses this for the "N pending" badge.
 */
export async function pendingCountFor(cycleCountId: string): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `select count(*) as n from pending_actions
       where kind = 'record_count'
         and status in ('pending','failed','sending')
         and json_extract(payload_json, '$.cycleCountId') = ?`,
    [cycleCountId],
  );
  return row?.n ?? 0;
}

export async function totalPendingCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `select count(*) as n from pending_actions
       where status in ('pending','failed','sending')`,
  );
  return row?.n ?? 0;
}

export interface OutboxRow {
  id: number;
  kind: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  lastAttemptAt: number | null;
  status: string;
}

/**
 * Pending outbox rows that are due for retry. Rows in 'failed' state
 * use exponential backoff: a row with N attempts must wait
 * min(2^N * 1s, 5min) before being eligible again.
 */
export async function outboxPending(now: number = Date.now()): Promise<OutboxRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    kind: string;
    idempotency_key: string;
    payload_json: string;
    attempts: number;
    last_attempt_at: number | null;
    status: string;
  }>(
    `select id, kind, idempotency_key, payload_json, attempts,
            last_attempt_at, status
       from pending_actions
      where status in ('pending','failed')
      order by created_at asc`,
  );
  return rows
    .filter((r) => isDue(r.attempts, r.last_attempt_at, r.status, now))
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      idempotencyKey: r.idempotency_key,
      payload: safeParse(r.payload_json),
      attempts: r.attempts,
      lastAttemptAt: r.last_attempt_at,
      status: r.status,
    }));
}

function isDue(
  attempts: number,
  lastAttemptAt: number | null,
  status: string,
  now: number,
): boolean {
  if (status === 'pending') return true;
  if (!lastAttemptAt) return true;
  const delay = Math.min(2 ** attempts * 1000, 5 * 60 * 1000);
  return now - lastAttemptAt >= delay;
}

/**
 * Mark an outbox row as successfully synced: delete the outbox row
 * and clear the matching line's local_dirty flag — both inside a
 * single transaction so a crash mid-ack can't leave dirty=1 with
 * no outbox row.
 */
export async function outboxAck(id: number): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ payload_json: string }>(
      'select payload_json from pending_actions where id = ?',
      [id],
    );
    if (row) {
      const payload = safeParse(row.payload_json);
      const lineId = typeof payload.lineId === 'string' ? payload.lineId : null;
      if (lineId) {
        // Only clear dirty if no other outbox row is pending for
        // this line — handles the case where the user edited the
        // same line twice while offline.
        const other = await db.getFirstAsync<{ n: number }>(
          `select count(*) as n from pending_actions
             where kind = 'record_count'
               and id != ?
               and status in ('pending','failed','sending')
               and json_extract(payload_json, '$.lineId') = ?`,
          [id, lineId],
        );
        if (!other || other.n === 0) {
          await db.runAsync(
            'update cycle_count_lines set local_dirty = 0 where id = ?',
            [lineId],
          );
        }
      }
    }
    await db.runAsync('delete from pending_actions where id = ?', [id]);
  });
}

/**
 * TERMINAL rejection of a cycle-count outbox row — the counterpart to
 * `outboxAck` for a write the server will never accept (today: a 401 while the
 * account is known disabled).
 *
 * Two things must happen, and they must happen TOGETHER:
 *
 *   1. the row goes to 'rejected', so neither drain re-reads it — this is what
 *      stops the count edit replaying the moment the account is re-enabled;
 *   2. the line's `local_dirty` flag is cleared, exactly as `outboxAck` does.
 *
 * Without (2) the count screen shows a line flagged unsynced forever with no
 * outbox row left that could ever move it. Without the shared transaction, a
 * crash in between leaves precisely that state. So this mirrors `outboxAck`'s
 * bookkeeping — including its guard: if the user edited the same line twice
 * offline, the flag stays set until the LAST live row for that line settles.
 *
 * Unlike `outboxAck` the row is NOT deleted. It is the local record of work the
 * counter believed they had saved, and it is the only way to tell them what
 * became of it.
 */
export async function outboxReject(id: number, error: string): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ payload_json: string }>(
      'select payload_json from pending_actions where id = ?',
      [id],
    );
    if (row) {
      const payload = safeParse(row.payload_json);
      const lineId = typeof payload.lineId === 'string' ? payload.lineId : null;
      if (lineId) {
        const other = await db.getFirstAsync<{ n: number }>(
          `select count(*) as n from pending_actions
             where kind = 'record_count'
               and id != ?
               and status in ('pending','failed','sending')
               and json_extract(payload_json, '$.lineId') = ?`,
          [id, lineId],
        );
        if (!other || other.n === 0) {
          await db.runAsync(
            'update cycle_count_lines set local_dirty = 0 where id = ?',
            [lineId],
          );
        }
      }
    }
    // Same terminal write engine 1 uses. Called inside this transaction on the
    // same memoized connection, so the status change and the dirty clear commit
    // as one unit.
    await markRejected(id, error);
  });
}

export async function outboxBumpFailure(id: number, error: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `update pending_actions
        set status = 'failed',
            attempts = attempts + 1,
            last_attempt_at = ?,
            last_error = ?
      where id = ?`,
    [Date.now(), error.slice(0, 1000), id],
  );
}

export async function outboxMarkSending(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `update pending_actions
        set status = 'sending',
            last_attempt_at = ?
      where id = ?`,
    [Date.now(), id],
  );
}

/**
 * Per-cycle-count "any unsynced edit" check. Used by the list page
 * to show a "N pending sync" pill.
 */
export async function dirtyLineCounts(): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ count_id: string; n: number }>(
    `select count_id, count(*) as n
       from cycle_count_lines
      where local_dirty = 1
      group by count_id`,
  );
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.count_id, r.n);
  return out;
}

export async function listCachedCycleCounts(): Promise<CachedCycleCountHeader[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: string;
    organization_id: string | null;
    status: string | null;
    warehouse_id: string | null;
    warehouse_name: string | null;
    started_at: string | null;
    posted_at: string | null;
    assigned_to: string | null;
    cached_at: number | null;
  }>(
    `select id, organization_id, status, warehouse_id, warehouse_name,
            started_at, posted_at, assigned_to, cached_at
       from cycle_counts
      where status = 'in_progress' or status is null
      order by started_at desc`,
  );
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    warehouseId: r.warehouse_id,
    warehouseName: r.warehouse_name,
    status: r.status ?? 'in_progress',
    startedAt: r.started_at ?? '',
    postedAt: r.posted_at,
    assignedTo: r.assigned_to ?? null,
    cachedAt: r.cached_at ?? 0,
  }));
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
