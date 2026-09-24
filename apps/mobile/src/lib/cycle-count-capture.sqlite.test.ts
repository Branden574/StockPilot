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
