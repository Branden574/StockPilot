import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';
import { latestRowsPerLine } from './outbox-order';
import { REPLACED_BY_LATER_COUNT } from './outbox-scope';

/**
 * An emptied count box clears the line's saved count (B4a), against the REAL
 * outbox schema: db.ts runs its own ensureSchema on node:sqlite, and
 * cycle-count-cache.ts runs its real statements.
 *
 * Before this the count screen saved nothing for an emptied box, so the line
 * kept its count, and Post applied that count while the box showed nothing.
 * clearLocalLine is what the count screen's saver now calls for an emptied
 * box: the line is uncounted and unsynced on the phone, and a clear is queued
 * in the count outbox, so it supersedes and is superseded like a count, holds
 * Post until it syncs, and is sent in order with the line's counts.
 */

const sqlite = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: sqlite.open }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null }, error: null }) } },
  readDeviceAuthSession: async () => ({ present: true, userId: 'u1' }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async (key: string) => (key === 'workspace.activeOrgId' ? 'org-a' : null) },
}));

type Cache = typeof import('./cycle-count-cache');
let raw: DatabaseSync;
let cache: Cache;

const header = {
  id: 'cc1',
  organizationId: 'org-a',
  warehouseId: null,
  warehouseName: null,
  status: 'in_progress',
  startedAt: '2026-10-24T08:00:00.000Z',
};
const serverLine = (id: string, counted: number | null) => ({
  id,
  itemId: `i-${id}`,
  itemName: `Item ${id}`,
  itemSku: `SKU-${id}`,
  itemBarcode: null,
  expected: 10,
  counted,
  updatedAt: null,
});

type Row = {
  id: number;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  organization_id: string | null;
  user_id: string | null;
  last_error: string | null;
};
function rows(): Row[] {
  return (
    raw
      .prepare(
        'select id, kind, status, payload_json, organization_id, user_id, last_error from pending_actions order by id',
      )
      .all() as (Omit<Row, 'payload'> & { payload_json: string })[]
  ).map(({ payload_json, ...r }) => ({ ...r, payload: JSON.parse(payload_json) }));
}
function lineRow(id: string) {
  return raw.prepare('select counted, local_dirty from cycle_count_lines where id = ?').get(id);
}

beforeEach(async () => {
  raw = new DatabaseSync(':memory:');
  const handle = nodeExpoDb(raw);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  vi.resetModules();
  cache = await import('./cycle-count-cache');
  await (await import('./db')).getDb();
  // l1 holds a count already synced from the server (5); l2 has none.
  raw
    .prepare(
      `insert into cycle_count_lines (id, count_id, item_id, expected, counted, local_dirty)
       values ('l1', 'cc1', 'i1', 10, 5, 0), ('l2', 'cc1', 'i2', 10, null, 0)`,
    )
    .run();
});

describe('clearLocalLine: an emptied box over a saved count', () => {
  it('leaves the line uncounted and unsynced, and queues one clear that names no count', async () => {
    const res = await cache.clearLocalLine('l1');
    expect(res).not.toBeNull();
    expect(lineRow('l1')).toEqual({ counted: null, local_dirty: 1 });
    const queued = rows();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      id: res!.outboxId,
      kind: 'record_count',
      status: 'pending',
      organization_id: 'org-a',
      user_id: 'u1',
    });
    expect(queued[0]!.payload).toEqual({ cycleCountId: 'cc1', lineId: 'l1', clear: true });
    // Never a count: a build that does not know clears cannot send it as 0.
    expect('countedQuantity' in queued[0]!.payload).toBe(false);
    // The screen reads it back uncounted, and Post waits for it (Sync first).
    await cache.cacheCycleCount(header, []); // the count's header, no lines
    const snap = await cache.getCycleCount('cc1');
    expect(snap?.lines.find((l) => l.id === 'l1')).toMatchObject({
      counted: null,
      localDirty: true,
    });
    expect(await cache.pendingCountFor('cc1')).toBe(1);
  });

  it('over a line with no saved count, queues nothing and changes nothing (as on the web)', async () => {
    expect(await cache.clearLocalLine('l2')).toBeNull();
    expect(rows()).toEqual([]);
    expect(lineRow('l2')).toEqual({ counted: null, local_dirty: 0 });
    expect(await cache.pendingCountFor('cc1')).toBe(0);
    // A line this phone does not hold: nothing either.
    expect(await cache.clearLocalLine('nope')).toBeNull();
    expect(rows()).toEqual([]);
  });

  it('a count queued and then emptied: the clear replaces the queued count', async () => {
    await cache.updateLocalLine('l2', 7);
    await cache.clearLocalLine('l2');
    expect(lineRow('l2')).toEqual({ counted: null, local_dirty: 1 });
    const queued = rows();
    expect(queued.map((r) => r.payload)).toEqual([
      { cycleCountId: 'cc1', lineId: 'l2', clear: true },
    ]);
  });

  // Post (or leaving the screen) saves a waiting box at once, so a box
  // emptied right after its count's save started is cleared while that
  // count's write may still be waiting its turn. The clear decides inside
  // its own turn, after the count, so it sees the count and clears it.
  // Mutation caught: deciding from a read taken before the transaction (the
  // line then still reads uncounted, the clear is dropped, and the count
  // stays for Post to apply while the box shows nothing).
  it('a box emptied while its count is still being written: the count lands first, then the clear', async () => {
    const counting = cache.updateLocalLine('l2', 7);
    const clearing = cache.clearLocalLine('l2');
    const [counted, cleared] = await Promise.all([counting, clearing]);
    expect(counted).not.toBeNull();
    expect(cleared).not.toBeNull();
    expect(lineRow('l2')).toEqual({ counted: null, local_dirty: 1 });
    expect(rows().map((r) => r.payload)).toEqual([
      { cycleCountId: 'cc1', lineId: 'l2', clear: true },
    ]);
  });

  it('an emptied box and then a count: the count replaces the queued clear', async () => {
    await cache.clearLocalLine('l1');
    await cache.updateLocalLine('l1', 3);
    expect(lineRow('l1')).toEqual({ counted: 3, local_dirty: 1 });
    const queued = rows();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ lineId: 'l1', countedQuantity: 3 });
    expect(queued[0]!.payload.clear).toBeUndefined();
  });

  it('a clear made while the count is on the wire is the newer row: sent after it, and the line stays unsynced until both settle', async () => {
    const counted = await cache.updateLocalLine('l2', 7);
    await cache.outboxMarkSending(counted!.outboxId, { orgId: 'org-a', userId: 'u1' });
    const clear = await cache.clearLocalLine('l2');
    // The row in flight is never touched; the clear is queued behind it.
    expect(rows().map((r) => [r.id, r.status])).toEqual([
      [counted!.outboxId, 'sending'],
      [clear!.outboxId, 'pending'],
    ]);
    // The next drain sends the clear, the newest row for the line.
    const { send, superseded } = latestRowsPerLine(await cache.outboxQueued());
    expect(send.map((r) => r.id)).toEqual([clear!.outboxId]);
    expect(superseded).toEqual([]);
    // The count's answer arrives: the line is still unsynced (the clear is live).
    await cache.outboxAck(counted!.outboxId);
    expect(lineRow('l2')).toEqual({ counted: null, local_dirty: 1 });
    await cache.outboxAck(clear!.outboxId);
    expect(lineRow('l2')).toEqual({ counted: null, local_dirty: 0 });
  });

  it("another account's held count of the line is parked for its owner, never deleted", async () => {
    raw
      .prepare(
        `insert into pending_actions (kind, idempotency_key, payload_json, created_at, organization_id, user_id)
         values ('record_count', 'held', ?, 1, 'org-a', 'u9')`,
      )
      .run(JSON.stringify({ cycleCountId: 'cc1', lineId: 'l1', countedQuantity: 4 }));
    await cache.clearLocalLine('l1');
    const queued = rows();
    expect(queued[0]).toMatchObject({
      user_id: 'u9',
      status: 'rejected',
      last_error: REPLACED_BY_LATER_COUNT,
    });
    expect(queued[1]).toMatchObject({ user_id: 'u1', status: 'pending' });
    expect(queued[1]!.payload.clear).toBe(true);
  });
});

describe('a queued clear and the server read', () => {
  it('a fresh read of the count keeps the pending clear (the phone wins until it syncs), then shows the server once it has', async () => {
    const clear = await cache.clearLocalLine('l1');
    // Read again while the clear is queued: the server still has 5.
    await cache.cacheCycleCount(header, [serverLine('l1', 5), serverLine('l2', null)]);
    let snap = await cache.getCycleCount('cc1');
    expect(snap?.lines.find((l) => l.id === 'l1')).toMatchObject({
      counted: null,
      localDirty: true,
    });
    // The clear is acknowledged; the next read shows the server's uncounted line.
    await cache.outboxAck(clear!.outboxId);
    await cache.cacheCycleCount(header, [serverLine('l1', null), serverLine('l2', null)]);
    snap = await cache.getCycleCount('cc1');
    expect(snap?.lines.find((l) => l.id === 'l1')).toMatchObject({
      counted: null,
      localDirty: false,
    });
    expect(await cache.pendingCountFor('cc1')).toBe(0);
  });
});
