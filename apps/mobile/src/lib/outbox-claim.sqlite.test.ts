import { DatabaseSync } from 'node:sqlite';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';

/**
 * A drain sends a queued row only if the row is STILL what the drain decided
 * on when its turn comes (B25, the #242 follow-up "a sync's outbox drain that
 * is already running keeps sending its in-memory list after a sign-out or
 * eviction"). EXECUTED end to end: the real schema, the real outbox writes
 * (queue.ts, cycle-count-cache.ts), the real session scope and both real
 * drain loops. Only the network, api(), the stored session and the saved
 * workspace are faked.
 *
 * THE DEFECT. Both drains read the queue ONCE per pass and then send row by
 * row, each send taking up to api()'s 20 s. Marking a row 'sending' was an
 * unconditional UPDATE by id and its result was not read, so a row whose turn
 * came after it had been replaced, discarded, parked or re-owned was sent from
 * the drain's stale copy anyway:
 *   - a count of a line the AI scan had just saved directly (and acked) was
 *     sent after it, so the server kept the older count and lost the scan link;
 *   - work the person chose "Sign out and discard" for went out when the same
 *     account signed in again inside the pass;
 *   - a legacy row the sign-out stamped as the leaving account's was still a
 *     legacy row in the pass's copy, so the NEXT account adopted it and sent it
 *     under its own session.
 * And the cycle-count drain's failure write (outboxBumpFailure) was not
 * limited to a row still 'sending' as engine 1's markFailed is: a send that
 * failed after an account eviction had parked its row put the row back in the
 * queue, to replay the moment the account was re-enabled.
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
// sync.ts's meta-backed nav caches pull in React; the drain never touches them.
vi.mock('./enabled-modules', () => ({
  ENABLED_MODULES_META_KEY: 'enabled_modules',
  refreshEnabledModules: vi.fn(),
}));
vi.mock('./use-effective-permissions', () => ({
  EFFECTIVE_PERMISSIONS_META_KEY: 'effective_permissions',
  refreshEffectivePermissions: vi.fn(),
}));
vi.mock('./warehouse-scope', () => ({
  WAREHOUSE_SCOPE_META_KEY: 'warehouse_scope',
  refreshWarehouseScope: vi.fn(),
}));

/** The device right now: the saved workspace and the STORED session's account. */
const live = vi.hoisted(() => ({ orgId: 'org-a' as string | null, userId: 'u1' as string | null }));
vi.mock('./supabase', () => ({
  readDeviceAuthSession: async () => ({ present: live.userId !== null, userId: live.userId }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => (key === 'workspace.activeOrgId' ? live.orgId : null),
  },
}));

interface Sent {
  path: string;
  asUserId: string | undefined;
  orgId: string | null | undefined;
  body: Record<string, unknown>;
}
/** Every request the drains hand to api(), and what runs while it is "on the wire". */
const net = vi.hoisted(() => ({
  sent: [] as Sent[],
  during: null as null | ((n: number) => Promise<void>),
  fail: null as null | ((n: number) => Error | null),
}));
vi.mock('./api', () => ({
  api: vi.fn(
    async (
      path: string,
      opts: { body?: unknown; asUserId?: string; orgId?: string | null } = {},
    ) => {
      const body = (
        typeof opts.body === 'function' ? (opts.body as () => unknown)() : opts.body
      ) as Record<string, unknown>;
      net.sent.push({ path, asUserId: opts.asUserId, orgId: opts.orgId, body });
      const n = net.sent.length;
      if (net.during) await net.during(n);
      const err = net.fail?.(n) ?? null;
      if (err) throw err;
      return {};
    },
  ),
}));

let raw: DatabaseSync;

beforeEach(async () => {
  live.orgId = 'org-a';
  live.userId = 'u1';
  net.sent = [];
  net.during = null;
  net.fail = null;
  raw = new DatabaseSync(':memory:');
  const handle = nodeExpoDb(raw);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  vi.resetModules(); // a fresh getDb memo and a fresh engine per test
  await (await import('./db')).getDb(); // the real ensureSchema
});

/** A queued row as a given account (or an older binary: user null) left it. */
function seed(row: {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  user: string | null;
  org?: string | null;
  status?: string;
}) {
  raw
    .prepare(
      `insert into pending_actions
         (id, kind, idempotency_key, payload_json, created_at, status, organization_id, user_id)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.kind,
      `k${row.id}`,
      JSON.stringify(row.payload),
      row.id,
      row.status ?? 'pending',
      row.org === undefined ? 'org-a' : row.org,
      row.user,
    );
}

function line(id: string, counted: number) {
  raw
    .prepare(
      `insert into cycle_count_lines (id, count_id, item_id, expected, counted, local_dirty)
       values (?, 'cc1', ?, 10, ?, 1)`,
    )
    .run(id, `i-${id}`, counted);
}

const count = (
  id: number,
  lineId: string,
  counted: number,
  user: string | null,
  org?: string | null,
) =>
  seed({
    id,
    kind: 'record_count',
    payload: { cycleCountId: 'cc1', lineId, countedQuantity: counted },
    user,
    org,
  });

const rows = () =>
  raw
    .prepare(
      'select id, status, attempts, last_error, organization_id, user_id from pending_actions order by id',
    )
    .all();

describe('the cycle-count drain (engine 2) claims a row before it sends it', () => {
  it('a count the AI scan saved directly while the drain was on another line is never overwritten by the older queued count', async () => {
    line('L2', 3);
    line('L1', 5);
    count(1, 'L2', 3, 'u1');
    count(2, 'L1', 5, 'u1'); // queued offline: 5
    const cache = await import('./cycle-count-cache');
    // While L2's count is on the wire, the AI scan screen records 7 for L1
    // directly on the server and mirrors it here, acked at once
    // (app/cycle-count/ai-scan/[id].tsx): the queued 5 is replaced.
    net.during = async (n) => {
      if (n !== 1) return;
      const mirrored = await cache.updateLocalLine('L1', 7);
      if (mirrored) await cache.outboxAck(mirrored.outboxId);
    };

    const { cycleCountSync } = await import('./cycle-count-sync');
    await cycleCountSync.forceSync();

    // Only L2's count left the phone; the replaced 5 never did.
    expect(net.sent.map((s) => [s.body.lineId, s.body.countedQuantity])).toEqual([['L2', 3]]);
    expect(rows()).toEqual([]);
    expect(
      raw.prepare("select counted, local_dirty from cycle_count_lines where id = 'L1'").get(),
    ).toEqual({
      counted: 7,
      local_dirty: 0,
    });
  });

  it('a send that fails after an account eviction parked its row leaves the row parked: it never replays after a re-enable', async () => {
    line('L1', 5);
    count(1, 'L1', 5, 'u1');
    const queue = await import('./queue');
    const db = await import('./db');
    const { ACCOUNT_DISABLED_REJECTION } = await import('./drain-failure');
    // The eviction runs while the count is on the wire (use-account-gate.ts:
    // the local sign-out, then the outbox parked, then the cache wiped), and
    // the request then ends with no answer (no status: a timeout or the
    // eviction's own abort).
    net.during = async () => {
      live.userId = null;
      await queue.rejectAllPending(ACCOUNT_DISABLED_REJECTION, 'u1');
      await db.wipeForEviction('u1');
    };
    net.fail = () => new Error('Request timed out. Check your connection and try again.');

    const { cycleCountSync } = await import('./cycle-count-sync');
    await cycleCountSync.forceSync();

    expect(rows()).toEqual([
      {
        id: 1,
        status: 'rejected',
        attempts: 0,
        last_error: ACCOUNT_DISABLED_REJECTION,
        organization_id: 'org-a',
        user_id: 'u1',
      },
    ]);
  });

  it('a legacy count the sign-out stamped as the leaving account’s is never sent under the next account', async () => {
    line('L2', 3);
    line('L1', 5);
    count(1, 'L2', 3, 'u1');
    count(2, 'L1', 5, null, null); // queued by an older binary: no owner
    const queue = await import('./queue');
    // While row 1 is on the wire, u1 signs out ("Sign out": its legacy rows
    // are stamped as its own, sign-out-flow.ts holdForAccount) and u2 signs in
    // to another workspace before the pass reaches row 2.
    net.during = async (n) => {
      if (n !== 1) return;
      await queue.adoptLegacyRows({ userId: 'u1', orgId: 'org-a' });
      live.userId = 'u2';
      live.orgId = 'org-b';
    };

    const { cycleCountSync } = await import('./cycle-count-sync');
    await cycleCountSync.forceSync();

    expect(net.sent.map((s) => [s.body.lineId, s.asUserId])).toEqual([['L2', 'u1']]);
    // Held for u1, untouched: it sends when u1 signs in here again.
    expect(rows()).toEqual([
      {
        id: 2,
        status: 'pending',
        attempts: 0,
        last_error: null,
        organization_id: 'org-a',
        user_id: 'u1',
      },
    ]);
  });

  it('a row still queued is claimed and sent as before, a legacy one stamped with the sender', async () => {
    line('L1', 5);
    count(1, 'L1', 5, null, null);
    const { cycleCountSync } = await import('./cycle-count-sync');
    await cycleCountSync.forceSync();
    expect(net.sent.map((s) => [s.body.lineId, s.asUserId, s.orgId])).toEqual([
      ['L1', 'u1', 'org-a'],
    ]);
    expect(rows()).toEqual([]);
  });
});

describe('the other drain (engine 1) claims a row before it sends it', () => {
  const RECEIPT = { poId: 'po1', lineId: 'pl1', quantity: 2 };
  const KIT = { bundleId: 'b1', quantity: 1 };

  it('work the person discarded at sign-out is not sent when the same account signs in again inside the pass', async () => {
    seed({ id: 1, kind: 'receive_po_line', payload: RECEIPT, user: 'u1' });
    seed({ id: 2, kind: 'distribute_bundle', payload: KIT, user: 'u1' });
    const queue = await import('./queue');
    // While the receipt is on the wire the person signs out with "Sign out and
    // discard" (sign-out-flow.ts: after the session has ended), then signs in
    // again as the same account before the pass reaches row 2.
    net.during = async (n) => {
      if (n !== 1) return;
      live.userId = null;
      await queue.discardUnsyncedFor('u1');
      live.userId = 'u1';
    };

    const { drainQueue } = await import('./sync');
    await drainQueue();

    expect(net.sent.map((s) => s.path)).toEqual(['/api/v1/po/po1/receive-line']);
    expect(rows()).toEqual([]);
  });

  it('a legacy row the sign-out stamped as the leaving account’s is never sent under the next account', async () => {
    seed({ id: 1, kind: 'receive_po_line', payload: RECEIPT, user: 'u1' });
    seed({ id: 2, kind: 'distribute_bundle', payload: KIT, user: null, org: null });
    const queue = await import('./queue');
    net.during = async (n) => {
      if (n !== 1) return;
      await queue.adoptLegacyRows({ userId: 'u1', orgId: 'org-a' });
      live.userId = 'u2';
      live.orgId = 'org-b';
    };

    const { drainQueue } = await import('./sync');
    await drainQueue();

    expect(net.sent.map((s) => [s.path, s.asUserId])).toEqual([
      ['/api/v1/po/po1/receive-line', 'u1'],
    ]);
    expect(rows()).toEqual([
      {
        id: 2,
        status: 'pending',
        attempts: 0,
        last_error: null,
        organization_id: 'org-a',
        user_id: 'u1',
      },
    ]);
  });

  it('a row still queued is claimed and sent as before: attempts counted, a legacy row stamped with the sender', async () => {
    seed({ id: 1, kind: 'distribute_bundle', payload: KIT, user: null, org: null });
    net.fail = () => Object.assign(new Error('boom'), { status: 503 });
    const { drainQueue } = await import('./sync');
    await drainQueue();
    expect(net.sent.map((s) => [s.path, s.asUserId, s.orgId])).toEqual([
      ['/api/v1/bundles/b1/distribute', 'u1', 'org-a'],
    ]);
    expect(rows()).toEqual([
      {
        id: 1,
        status: 'failed',
        attempts: 1,
        last_error: 'boom',
        organization_id: 'org-a',
        user_id: 'u1',
      },
    ]);
  });
});
