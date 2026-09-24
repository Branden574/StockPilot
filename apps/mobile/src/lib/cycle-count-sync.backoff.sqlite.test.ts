import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';

/**
 * A correction is never overwritten by the count it corrected (S4 review,
 * pre-existing on main), EXECUTED end to end: the real schema, the real
 * outbox reads and writes (cycle-count-cache.ts), the real newest-wins rule
 * and the real drain loop. Only the network, api() and the device session are
 * faked.
 *
 * THE DEFECT. The drain read only rows whose retry backoff had elapsed, and
 * judged newest-wins among those. On weak Wi-Fi: the operator enters 5, the
 * drain starts sending it; they correct to 7 (a new row, because the 5 is
 * 'sending'); the 5 times out and backs off. The next drain saw only the 7,
 * sent and acked it; when the 5's backoff ran out it was the line's only row,
 * so it was sent, and the server ended at 5 while the phone showed 7.
 */

const sqlite = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: sqlite.open }));
vi.mock('react-native', () => ({
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));
vi.mock('expo-network', () => ({
  getNetworkStateAsync: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
  addNetworkStateListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock('./account-disabled-state', () => ({ getAccountDisabled: () => false }));
const sent = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }));
vi.mock('./api', () => ({
  api: vi.fn(async (_path: string, opts: { body: Record<string, unknown> }) => {
    sent.bodies.push(opts.body);
  }),
}));
vi.mock('./supabase', () => ({
  readDeviceAuthSession: async () => ({ present: true, userId: 'u1' }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => 'org-a' },
}));

let raw: DatabaseSync;

beforeEach(async () => {
  sent.bodies = [];
  raw = new DatabaseSync(':memory:');
  const handle = nodeExpoDb(raw);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  vi.resetModules();
  await (await import('./db')).getDb();
  raw
    .prepare(
      `insert into cycle_count_lines (id, count_id, item_id, expected, counted, local_dirty)
       values ('L1', 'cc1', 'i1', 10, 7, 1)`,
    )
    .run();
});
afterEach(() => {
  vi.useRealTimers();
});

function queueCount(row: {
  id: number;
  counted: number;
  status: 'pending' | 'failed';
  attempts?: number;
  lastAttemptAt?: number | null;
}) {
  raw
    .prepare(
      `insert into pending_actions
         (id, kind, idempotency_key, payload_json, created_at, status, attempts,
          last_attempt_at, organization_id, user_id)
       values (?, 'record_count', ?, ?, ?, ?, ?, ?, 'org-a', 'u1')`,
    )
    .run(
      row.id,
      `k${row.id}`,
      JSON.stringify({ cycleCountId: 'cc1', lineId: 'L1', countedQuantity: row.counted }),
      row.id,
      row.status,
      row.attempts ?? 0,
      row.lastAttemptAt ?? null,
    );
}

describe('an older count still in retry backoff never lands after its correction', () => {
  it('the 5 in backoff is superseded by the 7; only the 7 is ever sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-09-24T12:00:00Z').getTime();
    vi.setSystemTime(t0);
    // The 5: its send timed out just now, third attempt, so it backs off 8 s.
    queueCount({ id: 5, counted: 5, status: 'failed', attempts: 3, lastAttemptAt: t0 });
    // The 7: the correction, queued while the 5 was on the wire.
    queueCount({ id: 8, counted: 7, status: 'pending' });

    const { cycleCountSync } = await import('./cycle-count-sync');
    await cycleCountSync.forceSync();

    expect(sent.bodies.map((b) => b.countedQuantity)).toEqual([7]);
    expect(raw.prepare('select count(*) as n from pending_actions').get()).toEqual({ n: 0 });

    // The 5's backoff runs out: there is nothing left to send.
    vi.setSystemTime(t0 + 60_000);
    await cycleCountSync.forceSync();
    expect(sent.bodies.map((b) => b.countedQuantity)).toEqual([7]);
    // And the line reads as synced at the corrected value.
    expect(raw.prepare("select counted, local_dirty from cycle_count_lines where id = 'L1'").get()).toEqual({
      counted: 7,
      local_dirty: 0,
    });
  });

  it('a line whose only newer row is still backing off sends nothing yet, and supersedes the older one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = new Date('2026-09-24T12:00:00Z').getTime();
    vi.setSystemTime(t0);
    queueCount({ id: 5, counted: 5, status: 'pending' });
    queueCount({ id: 8, counted: 7, status: 'failed', attempts: 3, lastAttemptAt: t0 });

    const { cycleCountSync } = await import('./cycle-count-sync');
    await cycleCountSync.forceSync();
    expect(sent.bodies).toEqual([]);
    expect(raw.prepare('select id from pending_actions').all()).toEqual([{ id: 8 }]);
    // The line stays flagged unsynced while the 7 is still queued.
    expect(raw.prepare("select local_dirty from cycle_count_lines where id = 'L1'").get()).toEqual({
      local_dirty: 1,
    });

    vi.setSystemTime(t0 + 60_000);
    await cycleCountSync.forceSync();
    expect(sent.bodies.map((b) => b.countedQuantity)).toEqual([7]);
  });
});
