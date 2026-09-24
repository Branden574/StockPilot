import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';
import { REPLACED_BY_LATER_COUNT } from './outbox-scope';

/**
 * Outbox ownership in SQL (S4a), run against the REAL schema: db.ts opens a
 * node:sqlite database through the expo-sqlite stand-in and runs its own
 * ensureSchema, then queue.ts and cycle-count-cache.ts run their real
 * statements, and session-scope.ts reads the owner as it does in the app.
 * Only the STORED session and the saved workspace are faked, and
 * supabase.auth.getSession() is wired to answer what auth-js answers offline
 * once the access token has expired ("no session", with the session still
 * stored), so code that asked it instead of the stored session fails here.
 *
 * What is proven here:
 *   - both writers stamp the organization and the account;
 *   - every pending / badge / "Sync first" counter and the Unsent work lists
 *     see only the live account's rows (and legacy ones), never another's;
 *   - a legacy row is stamped at its first send, an owned row never re-stamped;
 *   - another account's held row is never deleted automatically, and only a
 *     held row can be discarded from Unsent work;
 *   - this code never writes a NULL owner, and a disabled account's eviction
 *     parks only that account's work (and legacy rows), never another's.
 */

const sqlite = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: sqlite.open }));

/**
 * The device right now: the saved workspace, and the account whose session is
 * STORED (userId null = none stored; `unreadable` = stored, owner unreadable).
 */
const live = vi.hoisted(() => ({
  orgId: 'org-a' as string | null,
  userId: 'u1' as string | null,
  unreadable: false,
}));
vi.mock('./supabase', async () => {
  const { AuthRetryableFetchError } = await import('@supabase/supabase-js');
  return {
    // What auth-js answers for an expired token it cannot refresh offline.
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: null },
          error: new AuthRetryableFetchError('Network request failed', 0),
        }),
      },
    },
    readDeviceAuthSession: async () =>
      live.unreadable
        ? { present: true, userId: null }
        : { present: live.userId !== null, userId: live.userId },
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => (key === 'workspace.activeOrgId' ? live.orgId : null),
  },
}));

type Queue = typeof import('./queue');
type Cache = typeof import('./cycle-count-cache');

let raw: DatabaseSync;
let queue: Queue;
let cache: Cache;

beforeEach(async () => {
  live.orgId = 'org-a';
  live.userId = 'u1';
  live.unreadable = false;
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
      JSON.stringify({
        cycleCountId: row.countId ?? 'cc1',
        lineId: row.lineId ?? `l${row.id}`,
        countedQuantity: 3,
      }),
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
  raw
    .prepare(
      'select id, status, organization_id, user_id, last_error from pending_actions order by id',
    )
    .all();

describe('both writers stamp the organization and the account', () => {
  it('enqueue() persists organization_id and user_id', async () => {
    const { id } = await queue.enqueue('distribute_bundle', { bundleId: 'b1', quantity: 1 });
    expect(
      raw.prepare('select organization_id, user_id from pending_actions where id = ?').get(id),
    ).toEqual({
      organization_id: 'org-a',
      user_id: 'u1',
    });
  });

  it('updateLocalLine() persists organization_id and user_id on the record_count row', async () => {
    cacheLine('l1');
    const res = await cache.updateLocalLine('l1', 7);
    expect(
      raw
        .prepare('select kind, organization_id, user_id from pending_actions where id = ?')
        .get(res?.outboxId ?? -1),
    ).toEqual({
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

  it('signed in as u2 the picture inverts; signed out only legacy rows count, and nothing is offered as "another account\'s"', async () => {
    live.userId = 'u2';
    expect(await cache.pendingCountFor('cc1')).toBe(3);
    expect(await queue.countHeld()).toBe(1);
    live.userId = null;
    expect(await cache.totalPendingCount()).toBe(1);
    // With no account, another's work cannot be told from the person's own.
    expect(await queue.countHeld()).toBe(0);
    expect(await queue.listHeld()).toEqual([]);
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

    const rows = owners() as {
      id: number;
      status: string;
      user_id: string;
      last_error: string | null;
    }[];
    expect(rows.find((r) => r.id === 1)).toMatchObject({
      status: 'rejected',
      user_id: 'u2',
      last_error: REPLACED_BY_LATER_COUNT,
    });
    expect(rows.find((r) => r.id === 2)).toBeUndefined();
    expect(rows.find((r) => r.id === 3)).toMatchObject({ status: 'pending', user_id: 'u2' });
    expect(rows.find((r) => r.id === res?.outboxId)).toMatchObject({
      status: 'pending',
      user_id: 'u1',
    });
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
    expect(raw.prepare("select local_dirty from cycle_count_lines where id = 'l5'").get()).toEqual({
      local_dirty: 0,
    });
  });
});

describe('sign-out keeps queued work, held for its account (S4b, owner decision D5)', () => {
  beforeEach(() => {
    raw.exec(
      `insert into items (id, sku, name, last_synced_at) values ('i1', 'SKU-1', 'Chair', 1);`,
    );
    seed({ id: 1, user: 'u1' }); // mine, pending
    seed({ id: 2, user: 'u1', status: 'failed' }); // mine, failed
    seed({ id: 3, user: null, org: null }); // legacy
    seed({ id: 4, user: 'u2' }); // another account's, held
    seed({ id: 5, user: 'u1', status: 'rejected' }); // my record
  });

  it('wipeForSignOut clears the cache and deletes NO outbox row', async () => {
    const { wipeForSignOut } = await import('./db');
    await wipeForSignOut();
    expect(raw.prepare('select count(*) as n from items').get()).toEqual({ n: 0 });
    expect(
      (raw.prepare('select id from pending_actions order by id').all() as { id: number }[]).map(
        (r) => r.id,
      ),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it('holding stamps only legacy rows with the leaving account; nobody else’s row is touched', async () => {
    expect(await queue.adoptLegacyRows({ userId: 'u1', orgId: 'org-a' })).toBe(1);
    expect((owners() as { id: number; user_id: string }[]).map((r) => [r.id, r.user_id])).toEqual([
      [1, 'u1'],
      [2, 'u1'],
      [3, 'u1'],
      [4, 'u2'],
      [5, 'u1'],
    ]);
    // The next account to sign in holds them instead of adopting them.
    live.userId = 'u3';
    expect(await cache.totalPendingCount()).toBe(0);
    expect(await queue.countHeld()).toBe(4);
  });

  it('"Sign out and discard" deletes this account’s unsynced rows only: never another account’s, never a rejected record', async () => {
    expect(await queue.discardUnsyncedFor('u1')).toBe(3); // 1, 2 and the legacy 3
    expect(
      (raw.prepare('select id from pending_actions order by id').all() as { id: number }[]).map(
        (r) => r.id,
      ),
    ).toEqual([4, 5]);
  });

  it('only the eviction of a disabled account drops unsent rows: ITS rows (and legacy), sparing rejected ones and every other account\'s', async () => {
    const { wipeForEviction } = await import('./db');
    await wipeForEviction('u1');
    expect(
      (raw.prepare('select id from pending_actions order by id').all() as { id: number }[]).map(
        (r) => r.id,
      ),
    ).toEqual([4, 5]);
  });
});

describe("a disabled account's eviction parks ITS work only (D4: another account's held work is never touched)", () => {
  beforeEach(() => {
    seed({ id: 1, user: 'u1' }); // the disabled account's, pending
    seed({ id: 2, user: 'u1', status: 'failed' });
    seed({ id: 3, user: null, org: null }); // legacy
    seed({ id: 4, user: 'u2' }); // held for another account
    seed({ id: 5, user: 'u2', status: 'failed' }); // held for another account
  });
  const statuses = () =>
    (owners() as { id: number; status: string }[]).map((r) => [r.id, r.status]);

  it('rejectAllPending rejects the evicted account\'s rows and legacy ones; the other account\'s stay pending/failed', async () => {
    expect(await queue.rejectAllPending('Account disabled', 'u1')).toBe(3);
    expect(statuses()).toEqual([
      [1, 'rejected'],
      [2, 'rejected'],
      [3, 'rejected'],
      [4, 'pending'],
      [5, 'failed'],
    ]);
    // The parked legacy row is the evicted account's record from now on.
    expect(raw.prepare('select user_id from pending_actions where id = 3').get()).toEqual({
      user_id: 'u1',
    });
    // u2's work still sends when u2 signs in here again.
    live.userId = 'u2';
    expect(await cache.totalPendingCount()).toBe(2);
    expect(await queue.countRejected()).toBe(0);
  });

  it('the fallback wipe (rejection failed) deletes the evicted account\'s unsent rows only', async () => {
    const { wipeForEviction } = await import('./db');
    await wipeForEviction('u1');
    expect(statuses()).toEqual([
      [4, 'pending'],
      [5, 'failed'],
    ]);
  });

  it('an account that cannot be named falls back to the whole device (a replay after re-enable is worse)', async () => {
    expect(await queue.rejectAllPending('Account disabled', null)).toBe(5);
    const { wipeForEviction } = await import('./db');
    seed({ id: 6, user: 'u2' });
    await wipeForEviction(null);
    expect(statuses().map(([id]) => id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('offline past token expiry (getSession() says "no session", the session is still stored)', () => {
  // The S4 review's scenario: u1 counts online, walks into a dead zone, and
  // keeps counting for more than an hour. The fake getSession() above answers
  // exactly what auth-js answers then; the owner must come from the stored
  // session regardless.
  it('saves stamp u1, u1\'s rows stay u1\'s, and another account\'s held count is parked, not deleted', async () => {
    cacheLine('l1');
    cacheLine('l2');
    seed({ id: 1, user: 'u2', lineId: 'l1' }); // another account's held count of l1
    await cache.updateLocalLine('l2', 5);
    await cache.updateLocalLine('l1', 9);

    const rows = owners() as { id: number; status: string; user_id: string | null }[];
    expect(rows.map((r) => r.user_id)).not.toContain(null);
    expect(rows.find((r) => r.id === 1)).toMatchObject({ status: 'rejected', user_id: 'u2' });
    expect(rows.filter((r) => r.status === 'pending').map((r) => r.user_id)).toEqual(['u1', 'u1']);

    // The badge, the Sync-first gate and Unsent work all see them as u1's own.
    expect(await cache.totalPendingCount()).toBe(2);
    expect(await cache.pendingCountFor('cc1')).toBe(2);
    expect(await queue.countHeld()).toBe(0);
    const own = rows.find((r) => r.status === 'pending')!;
    expect(await cache.discardHeldAction(own.id)).toBe(false);
  });
});

describe('this code never writes a NULL-owner row', () => {
  it('a count saved just after an involuntary sign-out is stamped with the account that typed it', async () => {
    cacheLine('l1');
    expect(await cache.totalPendingCount()).toBe(0); // the screen read its counters as u1
    live.userId = null; // revoked: auth-js removed the stored session
    const res = await cache.updateLocalLine('l1', 4);
    expect(
      raw.prepare('select user_id from pending_actions where id = ?').get(res?.outboxId ?? -1),
    ).toEqual({ user_id: 'u1' });
    // ...so the next account holds it instead of adopting it.
    live.userId = 'u3';
    expect(await cache.totalPendingCount()).toBe(0);
    expect(await queue.countHeld()).toBe(1);
  });

  it('while the stored entry is unreadable, a save is stamped with the account last seen', async () => {
    const { id } = await queue.enqueue('distribute_bundle', { bundleId: 'b1', quantity: 1 });
    live.unreadable = true;
    const second = await queue.enqueue('distribute_bundle', { bundleId: 'b2', quantity: 1 });
    expect(
      (raw.prepare('select id, user_id from pending_actions order by id').all() as unknown[]),
    ).toEqual([
      { id, user_id: 'u1' },
      { id: second.id, user_id: 'u1' },
    ]);
  });

  it('with no account at all this run, both writers refuse and write nothing', async () => {
    live.userId = null;
    cacheLine('l1');
    await expect(cache.updateLocalLine('l1', 2)).rejects.toMatchObject({
      name: 'OutboxOwnerUnknownError',
    });
    await expect(
      queue.enqueue('distribute_bundle', { bundleId: 'b1', quantity: 1 }),
    ).rejects.toMatchObject({ name: 'OutboxOwnerUnknownError' });
    expect(raw.prepare('select count(*) as n from pending_actions').get()).toEqual({ n: 0 });
    expect(raw.prepare("select counted, local_dirty from cycle_count_lines where id = 'l1'").get()).toEqual({
      counted: null,
      local_dirty: 0,
    });
  });

  it('Unsent work offers nothing for Discard while the owner is unreadable', async () => {
    seed({ id: 1, user: 'u1' });
    seed({ id: 2, user: 'u2' });
    live.unreadable = true;
    expect(await queue.listHeld()).toEqual([]);
    expect(await queue.countHeld()).toBe(0);
    expect(await cache.discardHeldAction(1)).toBe(false);
    expect(await cache.discardHeldAction(2)).toBe(false);
    expect(raw.prepare('select count(*) as n from pending_actions').get()).toEqual({ n: 2 });
  });
});

describe("an unrelated transaction's ROLLBACK cannot undo an outbox write (plain writes are queued)", () => {
  /**
   * Reproduced before the fix: enqueue() returned an id (the screen said
   * "Queued"), then a snapshot pull that was mid-transaction failed and rolled
   * back, and the row was gone. The single expo-sqlite connection ran the
   * plain insert INSIDE the pull's open transaction.
   */
  async function failingPullAround(write: () => Promise<unknown>) {
    const db = await import('./db');
    const conn = await db.getDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pull = db.withDbTransaction(conn, async () => {
      await conn.runAsync(
        `insert into items (id, sku, name, last_synced_at) values ('p1', 'P', 'Pulled', 1)`,
      );
      await gate; // the pull is between BEGIN and COMMIT, waiting on the network
      throw new Error('pull failed');
    });
    const written = write();
    // Give an UNqueued write every chance to execute inside the open pull.
    await new Promise((r) => setTimeout(r, 30));
    release();
    await expect(pull).rejects.toThrow('pull failed');
    return written;
  }

  it('enqueue() survives: the queued row is still there after the pull rolls back', async () => {
    const res = (await failingPullAround(() =>
      queue.enqueue('receive_po_line', { poId: 'po1', lineId: 'l1', quantity: 2 }),
    )) as { id: number };
    expect(raw.prepare('select id from pending_actions').all()).toEqual([{ id: res.id }]);
    // The pull's own write was rolled back, as it should be.
    expect(raw.prepare('select count(*) as n from items').get()).toEqual({ n: 0 });
  });

  it('markRejected survives: a terminal verdict is not reverted to a replayable row', async () => {
    seed({ id: 1, user: 'u1', kind: 'receive_po_line' });
    await failingPullAround(() => queue.markRejected(1, 'refused'));
    expect(raw.prepare('select status from pending_actions where id = 1').get()).toEqual({
      status: 'rejected',
    });
  });

  it('markOk survives: a sent row is not resurrected to be sent again', async () => {
    seed({ id: 1, user: 'u1', kind: 'receive_po_line', status: 'sending' });
    await failingPullAround(() => queue.markOk(1));
    expect(raw.prepare('select count(*) as n from pending_actions').get()).toEqual({ n: 0 });
  });
});
