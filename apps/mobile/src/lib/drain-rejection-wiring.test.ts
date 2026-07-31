import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Offline outbox rejection — WIRING PINS.
 *
 * `classifyDrainFailure` is pure and tested next door. What it cannot reach is
 * the wiring, and the wiring is where this feature is actually won or lost:
 *
 * TWO engines drain `pending_actions`, not one.
 *
 *   - `sync.ts::drainQueue` drains everything EXCEPT `record_count` (it skips
 *     those explicitly at the top of the loop).
 *   - `CycleCountSyncEngine` (cycle-count-sync.ts) drains the `record_count`
 *     rows — the app's flagship offline flow — reading through `outboxPending`
 *     and, on failure, writing status='failed' via `outboxBumpFailure`.
 *
 * Fixing only the first leaves every offline cycle-count edit retrying on 401
 * and replaying the instant the account is re-enabled, which is precisely what
 * this work exists to prevent. So both engines are pinned here, and so is the
 * one thing that makes 'rejected' terminal: every selector that feeds a drain
 * must exclude it.
 *
 * These are source-level pins because the modules they guard import expo-sqlite
 * / expo-network at the top level and cannot be loaded in this node vitest
 * environment (vitest.config.ts includes src/**\/*.test.ts only, by design).
 */

const read = (rel: string) => readFileSync(path.resolve(__dirname, rel), 'utf8');

/** Comments explain the rules; only the CODE can satisfy them. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Collapse formatting so a prettier line-break cannot fail a wiring pin. */
const flat = (src: string) => code(src).replace(/\s+/g, ' ');

/** The one call both engines must make, however the formatter wraps it. */
const CLASSIFY_CALL = 'classifyDrainFailure(e, { accountDisabled: getAccountDisabled(), })';
const classifies = (src: string) =>
  flat(src).includes(CLASSIFY_CALL) ||
  flat(src).includes('classifyDrainFailure(e, { accountDisabled: getAccountDisabled() })');

const sync = read('./sync.ts');
const cycleSync = read('./cycle-count-sync.ts');
const queue = read('./queue.ts');
const cache = read('./cycle-count-cache.ts');
const db = read('./db.ts');
const gate = read('./use-account-gate.ts');

/** The one method of the cycle-count engine that owns failure handling. */
const drainOutbox = (() => {
  const src = code(cycleSync);
  const start = src.indexOf('private async drainOutbox');
  const end = src.indexOf('private async sendRecordCount');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
})();

describe('engine 1 — sync.ts drainQueue', () => {
  it('classifies every drain failure against the live account state', () => {
    expect(sync).toContain("import { classifyDrainFailure } from './drain-failure'");
    expect(sync).toContain("import { getAccountDisabled } from './account-disabled-state'");
    expect(classifies(sync)).toBe(true);
  });

  it('writes the TERMINAL status on a rejection, not another retryable failure', () => {
    expect(sync).toContain('markRejected');
    const drain = code(sync).slice(
      code(sync).indexOf('export async function drainQueue'),
      code(sync).indexOf('async function sendOne'),
    );
    expect(drain).toMatch(/if \(outcome === 'rejected'\)[\s\S]*markRejected\(action\.id, msg\)/);
    // The retryable branch must still exist — a 5xx must not be discarded.
    expect(drain).toContain('markFailed(action.id, msg)');
  });

  it('reports rejections separately so a caller can never read them as successes', () => {
    expect(sync).toContain('rejected: number');
    expect(sync).toContain('return { ok: 0, failed: 0, rejected: 0 }');
  });
});

describe('engine 2 — CycleCountSyncEngine (the flagship offline flow)', () => {
  it('classifies its failures with the SAME predicate as engine 1', () => {
    expect(cycleSync).toContain("import { classifyDrainFailure } from './drain-failure'");
    expect(cycleSync).toContain(
      "import { getAccountDisabled } from './account-disabled-state'",
    );
    expect(classifies(cycleSync)).toBe(true);
  });

  it('does NOT bump the retry counter on a rejection — that is the forever-retry path', () => {
    expect(drainOutbox).toContain('outboxReject(row.id, msg)');
    expect(drainOutbox).toMatch(/outcome === 'rejected'/);
    // outboxBumpFailure must survive, but only on the retryable branch: a 5xx
    // during a disable window is still real work that has to be re-sent.
    expect(drainOutbox).toContain('outboxBumpFailure(row.id, msg)');
    const rejectAt = drainOutbox.indexOf('outboxReject(row.id, msg)');
    const bumpAt = drainOutbox.indexOf('outboxBumpFailure(row.id, msg)');
    expect(rejectAt).toBeGreaterThan(-1);
    expect(rejectAt).toBeLessThan(bumpAt);
  });

  it('separates a rejection from a retryable failure in the engine state', () => {
    // `failing` means "retrying"; a terminal rejection is not retrying, so it
    // must not raise that state — and it must not stamp a successful sync.
    expect(drainOutbox).toMatch(/anyFailed = true/);
    expect(drainOutbox).toMatch(/anyRejected = true/);
    expect(drainOutbox).toContain('if (!anyFailed && !anyRejected)');
  });

  it('keeps its exponential backoff for the RETRYABLE path — nothing to add there', () => {
    // Correction to the original plan text: only sync.ts's drainQueue lacks
    // backoff. This engine already has it, in outboxPending's isDue filter.
    expect(code(cache)).toContain('function isDue(');
    expect(code(cache)).toContain('Math.min(2 ** attempts * 1000, 5 * 60 * 1000)');
  });
});

describe('rejected is TERMINAL — no drain may ever re-read it', () => {
  it('engine 1 selectors skip it', () => {
    expect(queue).toContain(
      "select * from pending_actions where status in ('pending','failed')",
    );
    expect(code(queue)).not.toMatch(/where status in \([^)]*'rejected'/);
  });

  it('engine 2 selectors skip it', () => {
    const pending = code(cache).slice(code(cache).indexOf('export async function outboxPending'));
    expect(pending).toContain("where status in ('pending','failed')");
    expect(code(cache)).not.toMatch(/where status in \([^)]*'rejected'/);
  });

  it('the unsynced badge stops counting a row nobody will ever send', () => {
    for (const fn of ['pendingCountFor', 'totalPendingCount']) {
      const body = code(cache).slice(code(cache).indexOf(`export async function ${fn}`));
      expect(body.slice(0, 500)).toContain("status in ('pending','failed','sending')");
    }
  });

  it('the startup reclaim resurrects only orphaned in-flight rows, never rejected ones', () => {
    expect(db).toContain(
      "update pending_actions set status = 'pending' where status = 'sending'",
    );
    expect(code(db)).not.toMatch(/set status = 'pending' where status = 'rejected'/);
  });
});

describe('the local record survives', () => {
  it('markRejected UPDATES the row — it never deletes the operator work', () => {
    const body = code(queue).slice(
      code(queue).indexOf('export async function markRejected'),
      code(queue).indexOf('export async function listRejected'),
    );
    expect(body).toContain("set status = 'rejected'");
    expect(body).toContain('last_error');
    expect(body).not.toContain('delete from');
  });

  it('exposes the rejected rows so the user can be told what happened', () => {
    expect(queue).toContain('export async function listRejected');
    expect(queue).toContain("where status = 'rejected'");
  });

  it('widens the status union rather than lying about the row state', () => {
    expect(queue).toContain(
      "status: 'pending' | 'sending' | 'ok' | 'failed' | 'rejected'",
    );
  });

  it('costs no SCHEMA_VERSION bump — a bump DROPS the outbox we are protecting', () => {
    expect(db).toContain('const SCHEMA_VERSION = 2;');
    // 'rejected' is a new VALUE in an existing text column, so no migration is
    // needed at all; if one ever is, it goes through addColumnIfMissing.
    expect(db).toContain('export async function addColumnIfMissing');
  });
});

describe('the eviction cannot silently destroy the queued work', () => {
  /**
   * Task 10's eviction runs `wipeForSignOut()`, which deleted `pending_actions`
   * WHOLESALE. That satisfies "never replays" by brute force, but it also means
   * the operator's queued work vanishes with no trace and `listRejected()` — the
   * interface this task publishes — could never return a single row.
   *
   * So the eviction must first REJECT what is queued (terminal, preserved),
   * and the wipe must spare exactly those rows.
   */
  it('marks the whole outbox rejected before the caches are wiped', () => {
    expect(gate).toContain('rejectAllPending');
    const clearCaches = code(gate).slice(
      code(gate).indexOf('clearCaches:'),
      code(gate).indexOf('clearAccountStorage:'),
    );
    expect(clearCaches).toContain('rejectAllPending');
    expect(clearCaches).toContain('wipeForSignOut()');
    expect(clearCaches.indexOf('rejectAllPending')).toBeLessThan(
      clearCaches.indexOf('wipeForSignOut()'),
    );
  });

  it('wipes even if the bulk rejection throws — losing the record beats a replay', () => {
    const clearCaches = code(gate).slice(
      code(gate).indexOf('clearCaches:'),
      code(gate).indexOf('clearAccountStorage:'),
    );
    expect(clearCaches).toContain('catch');
  });

  it('rejectAllPending moves every non-terminal row, and only those', () => {
    const body = code(queue).slice(code(queue).indexOf('export async function rejectAllPending'));
    expect(body).toContain("set status = 'rejected'");
    expect(body).toContain("where status in ('pending','sending','failed')");
  });

  it('the sign-out wipe spares rejected rows', () => {
    const body = code(db).slice(code(db).indexOf('export async function wipeForSignOut'));
    expect(body).toContain("delete from pending_actions where status <> 'rejected'");
    expect(body).not.toContain('delete from pending_actions;');
  });
});

describe('the cycle-count line is not left flagged unsynced forever', () => {
  it('outboxReject clears local_dirty in the SAME transaction as the status write', () => {
    const body = code(cache).slice(code(cache).indexOf('export async function outboxReject'));
    expect(body).toContain('withTransactionAsync');
    expect(body).toContain('update cycle_count_lines set local_dirty = 0 where id = ?');
    expect(body).toContain('markRejected');
  });

  it('keeps the flag while another edit for the same line is still live', () => {
    // Mirrors outboxAck: the user may have edited one line twice offline.
    const body = code(cache).slice(code(cache).indexOf('export async function outboxReject'));
    expect(body).toContain("status in ('pending','failed','sending')");
    expect(body).toContain("json_extract(payload_json, '$.lineId')");
  });

  it('does not delete the row the way an ack does', () => {
    const body = code(cache).slice(code(cache).indexOf('export async function outboxReject'));
    expect(body).not.toContain('delete from pending_actions');
  });
});
