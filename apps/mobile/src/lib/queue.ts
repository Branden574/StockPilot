import { getDb } from './db';

/**
 * Pending-actions queue. Every offline-capable write goes through
 * `enqueue()` → SQLite. The sync worker (sync.ts) drains the queue
 * when network is available, hitting the matching server endpoint
 * with the action's idempotency key so retries are safe.
 *
 * Idempotency keys are UUIDs generated locally so the server can
 * dedupe replays from a network-flaky client.
 */

export type PendingActionKind =
  | 'adjust_stock'
  | 'receive_po_line'
  | 'record_count'
  | 'create_book'
  | 'distribute_bundle'
  | 'upload_image'
  | 'size_count_event';

export interface PendingActionRow {
  id: number;
  kind: PendingActionKind;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  status: 'pending' | 'sending' | 'ok' | 'failed' | 'rejected';
}

function uuid(): string {
  // Lightweight v4 UUID. Doesn't need crypto-grade randomness — these
  // keys identify request replays, not secrets.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function enqueue(
  kind: PendingActionKind,
  payload: Record<string, unknown>,
): Promise<{ id: number; idempotencyKey: string }> {
  const db = await getDb();
  const idempotencyKey = uuid();
  const result = await db.runAsync(
    `insert into pending_actions (kind, idempotency_key, payload_json, created_at)
     values (?, ?, ?, ?)`,
    [kind, idempotencyKey, JSON.stringify(payload), Date.now()],
  );
  return { id: result.lastInsertRowId as number, idempotencyKey };
}

export async function listPending(): Promise<PendingActionRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    kind: string;
    idempotency_key: string;
    payload_json: string;
    created_at: number;
    attempts: number;
    last_attempt_at: number | null;
    last_error: string | null;
    status: string;
  }>(`select * from pending_actions where status in ('pending','failed')
      order by created_at asc`);
  return rows.map(rowFromDb);
}

export async function listAll(limit = 100): Promise<PendingActionRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    kind: string;
    idempotency_key: string;
    payload_json: string;
    created_at: number;
    attempts: number;
    last_attempt_at: number | null;
    last_error: string | null;
    status: string;
  }>(`select * from pending_actions order by created_at desc limit ?`, [limit]);
  return rows.map(rowFromDb);
}

export async function pendingCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    `select count(*) as n from pending_actions where status in ('pending','failed')`,
  );
  return row?.n ?? 0;
}

export async function markSending(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `update pending_actions
        set status = 'sending',
            attempts = attempts + 1,
            last_attempt_at = ?
      where id = ?`,
    [Date.now(), id],
  );
}

export async function markOk(id: number): Promise<void> {
  const db = await getDb();
  // Settled-ok rows are deleted to keep the queue tight. If a paper
  // trail is needed later, swap to a soft-delete flag.
  await db.runAsync(`delete from pending_actions where id = ?`, [id]);
}

export async function markFailed(id: number, error: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `update pending_actions
        set status = 'failed',
            last_error = ?,
            last_attempt_at = ?
      where id = ?`,
    [error.slice(0, 1000), Date.now(), id],
  );
}

/**
 * Terminal rejection. Used when the server will NEVER accept this write —
 * today, only when the account was disabled while the row was queued.
 *
 * The row is KEPT, not deleted: it is a local record of work the operator
 * believed they had completed, and both they and support need to be able to see
 * it. It is simply never sent again, because every drain selector reads only
 * 'pending' and 'failed'. That is what stops the write from landing the moment
 * the account is re-enabled — re-enabling must not resurrect a rejected queue.
 *
 * `attempts` is deliberately NOT bumped: the row is not being retried, and
 * leaving the counter alone keeps it a truthful record of how many times this
 * write was actually attempted.
 *
 * No SCHEMA_VERSION bump is involved. 'rejected' is a new VALUE in the existing
 * `status` text column (no CHECK constraint), so nothing migrates. A bump would
 * DROP pending_actions, destroying the very outbox this is protecting; a column,
 * if one were ever needed, would go through db.ts's addColumnIfMissing.
 */
export async function markRejected(id: number, error: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `update pending_actions
        set status = 'rejected',
            last_error = ?,
            last_attempt_at = ?
      where id = ?`,
    [error.slice(0, 1000), Date.now(), id],
  );
}

/**
 * Reject the WHOLE outbox at once. Called from the account eviction, where the
 * account has been confirmed disabled out of band: nothing queued will ever be
 * accepted, and the drain will not get another chance to say so per row —
 * eviction cancels the in-flight requests and drops the session first.
 *
 * Without this, eviction's `wipeForSignOut()` deleted every queued write with
 * no trace, so the operator was never told what became of the work they
 * believed they had saved.
 *
 * Unlike the per-row `outboxReject`, this does NOT clear
 * `cycle_count_lines.local_dirty`: the caller wipes that whole table
 * immediately afterwards, so there is no line left to strand.
 *
 * @returns how many rows were rejected (for logging / the hand-test).
 */
export async function rejectAllPending(error: string): Promise<number> {
  const db = await getDb();
  const result = await db.runAsync(
    `update pending_actions
        set status = 'rejected',
            last_error = ?,
            last_attempt_at = ?
      where status in ('pending','sending','failed')`,
    [error.slice(0, 1000), Date.now()],
  );
  return result.changes;
}

/** Rejected rows, newest first — the local record for the user and support. */
export async function listRejected(limit = 100): Promise<PendingActionRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    kind: string;
    idempotency_key: string;
    payload_json: string;
    created_at: number;
    attempts: number;
    last_attempt_at: number | null;
    last_error: string | null;
    status: string;
  }>(
    `select * from pending_actions where status = 'rejected'
      order by created_at desc limit ?`,
    [limit],
  );
  return rows.map(rowFromDb);
}

/**
 * Hand a row back to the drain. Only ever called from an explicit user action —
 * a rejected row must never be re-armed automatically, least of all by the
 * account being re-enabled.
 */
export async function retry(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `update pending_actions set status = 'pending', last_error = null
     where id = ?`,
    [id],
  );
}

function rowFromDb(r: {
  id: number;
  kind: string;
  idempotency_key: string;
  payload_json: string;
  created_at: number;
  attempts: number;
  last_attempt_at: number | null;
  last_error: string | null;
  status: string;
}): PendingActionRow {
  return {
    id: r.id,
    kind: r.kind as PendingActionKind,
    idempotencyKey: r.idempotency_key,
    payload: safeParse(r.payload_json),
    createdAt: r.created_at,
    attempts: r.attempts,
    lastAttemptAt: r.last_attempt_at,
    lastError: r.last_error,
    status: r.status as PendingActionRow['status'],
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
