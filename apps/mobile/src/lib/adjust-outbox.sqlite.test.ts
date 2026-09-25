import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';
import {
  queuedAdjustPayload,
  UNCONFIRMED_ADJUST_PREFIX,
  unconfirmedQueuedAdjustMessage,
} from './adjust-outbox';

/**
 * The offline stock adjustment's SQL, run against the REAL schema (db.ts
 * ensureSchema on node:sqlite through the expo-sqlite stand-in), with queue.ts
 * and db.ts running their real statements. Same harness as
 * outbox-owner.sqlite.test.ts; only the stored session and the saved workspace
 * are faked.
 *
 * Proven here:
 *   - an item-screen adjustment queued offline is stamped with its workspace
 *     and account (S4) and is one of the rows the drain reads;
 *   - the item screen's "queued offline" note counts only that item's unsent
 *     rows of the live account;
 *   - at app start a row the app died on while sending is PARKED as not
 *     confirmed (it may have reached the server), while every other kind is
 *     re-queued as before;
 *   - the Settings row counts the not-confirmed rows apart.
 */

const sqlite = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: sqlite.open }));

const live = vi.hoisted(() => ({
  orgId: 'org-a' as string | null,
  userId: 'u1' as string | null,
}));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null }, error: null }) } },
  readDeviceAuthSession: async () => ({ present: live.userId !== null, userId: live.userId }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => (key === 'workspace.activeOrgId' ? live.orgId : null),
  },
}));

type Queue = typeof import('./queue');
type Db = typeof import('./db');

let raw: DatabaseSync;
let queue: Queue;
let db: Db;

beforeEach(async () => {
  live.orgId = 'org-a';
  live.userId = 'u1';
  raw = new DatabaseSync(':memory:');
  const handle = nodeExpoDb(raw);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  vi.resetModules(); // a fresh getDb memo per test
  queue = await import('./queue');
  db = await import('./db');
  await db.getDb(); // the real ensureSchema
});

function adjustPayload(itemId: string, quantityChange: number) {
  return queuedAdjustPayload({
    itemId,
    body: {
      quantityChange,
      movementType: quantityChange > 0 ? 'add' : 'remove',
      reason: 'Mobile detail',
    },
    itemLabel: `Item ${itemId}`,
    queuedAt: 1_000,
  });
}

function seed(row: {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  status?: string;
  user?: string | null;
  lastError?: string | null;
}) {
  raw
    .prepare(
      `insert into pending_actions
         (id, kind, idempotency_key, payload_json, created_at, status, organization_id, user_id, last_error)
       values (?, ?, ?, ?, ?, ?, 'org-a', ?, ?)`,
    )
    .run(
      row.id,
      row.kind,
      `k${row.id}`,
      JSON.stringify(row.payload),
      row.id,
      row.status ?? 'pending',
      row.user === undefined ? 'u1' : row.user,
      row.lastError ?? null,
    );
}

const rows = () =>
  raw.prepare('select id, kind, status, last_error from pending_actions order by id').all() as {
    id: number;
    kind: string;
    status: string;
    last_error: string | null;
  }[];

describe('an adjustment queued offline is ordinary outbox work', () => {
  it('is stamped with the workspace and the account, and the drain lists it', async () => {
    const { id } = await queue.enqueue('adjust_stock', adjustPayload('item-1', -1));

    expect(
      raw
        .prepare('select kind, status, organization_id, user_id from pending_actions where id = ?')
        .get(id),
    ).toEqual({ kind: 'adjust_stock', status: 'pending', organization_id: 'org-a', user_id: 'u1' });
    const pending = await queue.listPending();
    expect(pending.map((r) => [r.kind, r.payload.itemId, r.payload.quantityChange])).toEqual([
      ['adjust_stock', 'item-1', -1],
    ]);
    expect(await queue.pendingCount()).toBe(1);
  });
});

describe('pendingAdjustFor (the item screen note)', () => {
  it("sums only this item's unsent rows of the live account", async () => {
    seed({ id: 1, kind: 'adjust_stock', payload: adjustPayload('item-1', 1) });
    seed({ id: 2, kind: 'adjust_stock', payload: adjustPayload('item-1', 5), status: 'failed' });
    seed({ id: 3, kind: 'adjust_stock', payload: adjustPayload('item-1', -1), status: 'sending' });
    seed({ id: 4, kind: 'adjust_stock', payload: adjustPayload('item-2', 9) }); // another item
    seed({ id: 5, kind: 'adjust_stock', payload: adjustPayload('item-1', 7), user: 'u2' }); // held
    seed({ id: 6, kind: 'adjust_stock', payload: adjustPayload('item-1', 3), status: 'rejected' });
    seed({ id: 7, kind: 'distribute_bundle', payload: { itemId: 'item-1', quantityChange: 4 } });

    expect(await queue.pendingAdjustFor('item-1')).toEqual({ count: 3, net: 5 });
    expect(await queue.pendingAdjustFor('item-3')).toEqual({ count: 0, net: 0 });
    live.userId = 'u2';
    expect(await queue.pendingAdjustFor('item-1')).toEqual({ count: 1, net: 7 });
  });
});

describe('app start: a row the app died on while sending', () => {
  it('an adjustment is PARKED as not confirmed; every other kind is re-queued', async () => {
    seed({ id: 1, kind: 'adjust_stock', payload: adjustPayload('item-1', -1), status: 'sending' });
    seed({ id: 2, kind: 'receive_po_line', payload: { poId: 'po1' }, status: 'sending' });
    seed({ id: 3, kind: 'adjust_stock', payload: adjustPayload('item-2', 2), status: 'pending' });

    await db.initDb();

    const after = rows();
    expect(after.map((r) => [r.id, r.status])).toEqual([
      [1, 'rejected'],
      [2, 'pending'],
      [3, 'pending'],
    ]);
    expect(after[0]!.last_error).toMatch(
      new RegExp(`^${UNCONFIRMED_ADJUST_PREFIX}−1 to Item item-1 was being sent when the app closed`),
    );
    // Never re-sent: no drain selector reads a rejected row.
    expect((await queue.listPending()).map((r) => r.id)).toEqual([2, 3]);
  });
});

describe('countUnconfirmedAdjust (the Settings row)', () => {
  it("counts only the live account's not-confirmed adjustments", async () => {
    const unconfirmed = unconfirmedQueuedAdjustMessage(adjustPayload('item-1', 1));
    seed({ id: 1, kind: 'adjust_stock', payload: {}, status: 'rejected', lastError: unconfirmed });
    seed({
      id: 2,
      kind: 'adjust_stock',
      payload: {},
      status: 'rejected',
      lastError: '+1 to Item item-1: Forbidden. Nothing was changed.',
    });
    seed({
      id: 3,
      kind: 'adjust_stock',
      payload: {},
      status: 'rejected',
      lastError: unconfirmed,
      user: 'u2',
    });
    seed({ id: 4, kind: 'distribute_bundle', payload: {}, status: 'rejected', lastError: unconfirmed });

    expect(await queue.countUnconfirmedAdjust()).toBe(1);
    expect(await queue.countRejected()).toBe(3);
  });
});
