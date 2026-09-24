import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';
import { REPLACED_BY_LATER_COUNT } from './outbox-scope';

/**
 * Outbox ownership in SQL (S4a), run against the REAL schema: db.ts opens a
 * node:sqlite database through the expo-sqlite stand-in and runs its own
 * ensureSchema, then queue.ts and cycle-count-cache.ts run their real
 * statements. Only the live session/workspace is faked.
 *
 * What is proven here:
 *   - both writers stamp the organization and the account;
 *   - every pending / badge / "Sync first" counter and the Unsent work lists
 *     see only the live account's rows (and legacy ones), never another's;
 *   - a legacy row is stamped at its first send, an owned row never re-stamped;
 *   - another account's held row is never deleted automatically, and only a
 *     held row can be discarded from Unsent work.
 */

const sqlite = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: sqlite.open }));

const live = vi.hoisted(() => ({ orgId: 'org-a' as string | null, userId: 'u1' as string | null }));
vi.mock('./session-scope', () => ({ liveOutboxScope: vi.fn(async () => ({ ...live })) }));

type Queue = typeof import('./queue');
type Cache = typeof import('./cycle-count-cache');

let raw: DatabaseSync;
let queue: Queue;
let cache: Cache;

beforeEach(async () => {
  live.orgId = 'org-a';
  live.userId = 'u1';
  raw = new DatabaseSync(':memory:');
  const handle = nodeExpoDb(raw);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  vi.resetModules(); // a fresh getDb memo per test
  queue = await import('./queue');
  cache = await import('./cycle-count-cache');
  await (await import('./db')).getDb(); // the real ensureSchema
});

/** A queued row as a given account (or an older binary: user null) left it. */
function seed(row: {
  id: number;
  user: string | null;
  org?: string | null;
  status?: string;
  kind?: string;
  lineId?: string;
  countId?: string;
}) {
  raw
    .prepare(
      `insert into pending_actions
         (id, kind, idempotency_key, payload_json, created_at, status, organization_id, user_id)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.kind ?? 'record_count',
      `k${row.id}`,
      JSON.stringify({ cycleCountId: row.countId ?? 'cc1', lineId: row.lineId ?? `l${row.id}`, countedQuantity: 3 }),
      row.id,
      row.status ?? 'pending',
      row.org === undefined ? 'org-a' : row.org,
      row.user,
    );
}

function cacheLine(lineId: string, dirty = 0) {
  raw
    .prepare(
      `insert into cycle_count_lines (id, count_id, item_id, expected, counted, local_dirty)
       values (?, 'cc1', 'i1', 10, null, ?)`,
    )
    .run(lineId, dirty);
}

const owners = () =>
  raw.prepare('select id, status, organization_id, user_id, last_error from pending_actions order by id').all();

describe('both writers stamp the organization and the account', () => {
  it('enqueue() persists organization_id and user_id', async () => {
    const { id } = await queue.enqueue('distribute_bundle', { bundleId: 'b1', quantity: 1 });
    expect(raw.prepare('select organization_id, user_id from pending_actions where id = ?').get(id)).toEqual({
      organization_id: 'org-a',
      user_id: 'u1',
    });
  });

  it('updateLocalLine() persists organization_id and user_id on the record_count row', async () => {
    cacheLine('l1');
    const res = await cache.updateLocalLine('l1', 7);
    expect(raw.prepare('select kind, organization_id, user_id from pending_actions where id = ?').get(res?.outboxId ?? -1)).toEqual({
      kind: 'record_count',
      organization_id: 'org-a',
      user_id: 'u1',
    });
  });
});

describe("counters see the live account's rows only (the critic's correction 4)", () => {
  beforeEach(() => {
    seed({ id: 1, user: 'u1', countId: 'cc1' }); // mine
    seed({ id: 2, user: null, org: null, countId: 'cc1' }); // legacy: adoptable, counted as mine
    seed({ id: 3, user: 'u2', countId: 'cc1' }); // another account's, held
    seed({ id: 4, user: 'u2', countId: 'cc1', status: 'failed' }); // another's, held
  });

  it("pendingCountFor ignores another account's held rows, so the Sync-first gate cannot block this person forever", async () => {
    expect(await cache.pendingCountFor('cc1')).toBe(2);
  });

  it('totalPendingCount (the sync badge) and pendingCount ignore them too', async () => {
    expect(await cache.totalPendingCount()).toBe(2);
    expect(await queue.pendingCount()).toBe(2);
  });

  it('the held rows are exactly the other account’s, listed and counted for Unsent work', async () => {
    expect(await queue.countHeld()).toBe(2);
    expect((await queue.listHeld()).map((r) => [r.id, r.userId])).toEqual([
      [4, 'u2'],
      [3, 'u2'],
    ]);
  });

  it('signed in as u2 the picture inverts; signed out only legacy rows count and every stamped row is held', async () => {
    live.userId = 'u2';
    expect(await cache.pendingCountFor('cc1')).toBe(3);
    expect(await queue.countHeld()).toBe(1);
    live.userId = null;
    expect(await cache.totalPendingCount()).toBe(1);
    expect(await queue.countHeld()).toBe(3);
  });
});

describe('Unsent work: rejected rows are per account', () => {
  it('countRejected / listRejected / clearRejected touch only the live account’s record (and legacy rows)', async () => {
    seed({ id: 1, user: 'u1', status: 'rejected' });
    seed({ id: 2, user: null, org: null, status: 'rejected' });
    seed({ id: 3, user: 'u2', status: 'rejected' });

    expect(await queue.countRejected()).toBe(2);
    expect((await queue.listRejected()).map((r) => r.id).sort()).toEqual([1, 2]);
    expect(await queue.clearRejected()).toBe(2);
    // Another account's record is theirs to clear.
    expect(raw.prepare('select id from pending_actions').all()).toEqual([{ id: 3 }]);
  });
});

describe('a legacy row is stamped at its FIRST send, an owned row never re-stamped', () => {
  it('markSending adopts a legacy row and leaves an owned one alone', async () => {
    seed({ id: 1, user: null, org: null, kind: 'receive_po_line' });
    seed({ id: 2, user: 'u1', org: 'org-a', kind: 'receive_po_line' });

    await queue.markSending(1, { orgId: 'org-live', userId: 'u1' });
    await queue.markSending(2, { orgId: 'org-other', userId: 'u1' });
    await cache.outboxMarkSending(2, { orgId: 'org-other', userId: 'u1' });

    expect(owners()).toEqual([
      { id: 1, status: 'sending', organization_id: 'org-live', user_id: 'u1', last_error: null },
      { id: 2, status: 'sending', organization_id: 'org-a', user_id: 'u1', last_error: null },
    ]);
  });

  it('markHeld puts a row back only from sending', async () => {
    seed({ id: 1, user: 'u1', status: 'sending' });
    seed({ id: 2, user: 'u1', status: 'failed' });
    await queue.markHeld(1);
    await queue.markHeld(2);
    expect((owners() as { status: string }[]).map((r) => r.status)).toEqual(['pending', 'failed']);
  });
});

describe("another account's held row is never deleted automatically", () => {
  it('a newer count of the same line supersedes it as a REJECTED record (not deleted, never sent); my own older edit is replaced', async () => {
    cacheLine('l1');
    seed({ id: 1, user: 'u2', lineId: 'l1' }); // another counter's earlier count of this line
    seed({ id: 2, user: 'u1', lineId: 'l1' }); // my own earlier edit
    seed({ id: 3, user: 'u2', lineId: 'l9' }); // another line: untouched

    const res = await cache.updateLocalLine('l1', 8);

    const rows = owners() as { id: number; status: string; user_id: string; last_error: string | null }[];
    expect(rows.find((r) => r.id === 1)).toMatchObject({ status: 'rejected', user_id: 'u2', last_error: REPLACED_BY_LATER_COUNT });
    expect(rows.find((r) => r.id === 2)).toBeUndefined();
    expect(rows.find((r) => r.id === 3)).toMatchObject({ status: 'pending', user_id: 'u2' });
    expect(rows.find((r) => r.id === res?.outboxId)).toMatchObject({ status: 'pending', user_id: 'u1' });
    // The parked row is its owner's record, not this person's.
    expect(await queue.countRejected()).toBe(0);
    live.userId = 'u2';
    expect(await queue.countRejected()).toBe(1);
  });

  it('discardHeldAction removes a held row (clearing its line flag) and refuses the live account’s own work', async () => {
    cacheLine('l5', 1);
    seed({ id: 1, user: 'u2', lineId: 'l5' });
    seed({ id: 2, user: 'u1', lineId: 'l6' });

    expect(await cache.discardHeldAction(2)).toBe(false);
    expect(await cache.discardHeldAction(1)).toBe(true);

    expect(raw.prepare('select id from pending_actions').all()).toEqual([{ id: 2 }]);
    expect(raw.prepare("select local_dirty from cycle_count_lines where id = 'l5'").get()).toEqual({ local_dirty: 0 });
  });
});
