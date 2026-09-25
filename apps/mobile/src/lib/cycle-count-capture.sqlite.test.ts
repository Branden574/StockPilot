import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';
import { recordCountBody } from './cycle-count-record-body';

/**
 * The capture time (server 0369) against the REAL outbox schema: db.ts runs
 * its own ensureSchema on node:sqlite, and cycle-count-cache.ts runs its real
 * statements. A count queued now carries capturedAt in its payload; a row an
 * older build queued has none, and outboxQueued hands the drain its created_at
 * so the send still says when the count was taken.
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

beforeEach(async () => {
  raw = new DatabaseSync(':memory:');
  const handle = nodeExpoDb(raw);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  vi.resetModules();
  cache = await import('./cycle-count-cache');
  await (await import('./db')).getDb();
  raw
    .prepare(
      `insert into cycle_count_lines (id, count_id, item_id, expected, counted, local_dirty)
       values ('l1', 'cc1', 'i1', 10, null, 0), ('l2', 'cc1', 'i2', 10, null, 0)`,
    )
    .run();
});

describe('capture time in the outbox (0369)', () => {
  it('updateLocalLine stamps capturedAt into the payload, at the row\'s own enqueue time', async () => {
    const res = await cache.updateLocalLine('l1', 7);
    const row = raw
      .prepare('select payload_json, created_at from pending_actions where id = ?')
      .get(res?.outboxId ?? -1) as { payload_json: string; created_at: number };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({ cycleCountId: 'cc1', lineId: 'l1', countedQuantity: 7 });
    expect(payload.capturedAt).toBe(new Date(row.created_at).toISOString());
  });

  it('outboxQueued hands the drain each row\'s created_at', async () => {
    await cache.updateLocalLine('l1', 7);
    const [row] = await cache.outboxQueued();
    const stored = raw.prepare('select created_at from pending_actions').get() as { created_at: number };
    expect(row?.createdAt).toBe(stored.created_at);
  });

  it('a row queued by an older build (no capturedAt) is sent with its created_at', async () => {
    const queuedAt = Date.parse('2026-09-24T09:15:00.000Z');
    raw
      .prepare(
        `insert into pending_actions (kind, idempotency_key, payload_json, created_at, organization_id, user_id)
         values ('record_count', 'legacy', ?, ?, 'org-a', 'u1')`,
      )
      .run(JSON.stringify({ cycleCountId: 'cc1', lineId: 'l2', countedQuantity: 4 }), queuedAt);
    const [row] = await cache.outboxQueued();
    expect(row?.payload.capturedAt).toBeUndefined();
    const body = recordCountBody(row!.payload, 4, row!.createdAt, Date.parse('2026-09-24T12:00:00.000Z'));
    expect(body.capturedAt).toBe('2026-09-24T09:15:00.000Z');
    expect(body.clientSentAt).toBe('2026-09-24T12:00:00.000Z');
  });
});

/**
 * The capture time on the phone's count screen (0369, D7): the web review says
 * "Counted offline <time>" and so must a manager reviewing on the phone. The
 * cache carries offline_captured_at (a display column added in place).
 */
describe('offline capture time in the count cache (0369, D7)', () => {
  const header = {
    id: 'cc1',
    organizationId: 'org-a',
    warehouseId: null,
    warehouseName: null,
    status: 'in_progress',
    startedAt: '2026-09-24T08:00:00.000Z',
  };
  const line = (id: string, offlineCapturedAt: string | null, counted: number | null = 7) => ({
    id,
    itemId: `i-${id}`,
    itemName: `Item ${id}`,
    itemSku: `SKU-${id}`,
    itemBarcode: null,
    expected: 10,
    counted,
    updatedAt: null,
    offlineCapturedAt,
  });

  it('stores and reads back the capture time of a line counted offline', async () => {
    await cache.cacheCycleCount(header, [line('l1', '2026-09-24T09:15:00.000Z'), line('l2', null)]);
    const snap = await cache.getCycleCount('cc1');
    const byId = Object.fromEntries((snap?.lines ?? []).map((l) => [l.id, l.offlineCapturedAt]));
    // Mutation: drop the column from the insert or the read, and l1 is null.
    expect(byId).toEqual({ l1: '2026-09-24T09:15:00.000Z', l2: null });
  });

  it('a line with a pending local edit keeps what it had (the server capture is about to be replaced)', async () => {
    await cache.updateLocalLine('l1', 3); // dirty, no capture time
    await cache.cacheCycleCount(header, [line('l1', '2026-09-24T09:15:00.000Z')]);
    const snap = await cache.getCycleCount('cc1');
    const l1 = snap?.lines.find((l) => l.id === 'l1');
    expect(l1?.localDirty).toBe(true);
    expect(l1?.counted).toBe(3);
    expect(l1?.offlineCapturedAt).toBeNull();
  });
});
