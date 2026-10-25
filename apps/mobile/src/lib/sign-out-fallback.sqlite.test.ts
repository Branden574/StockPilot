import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeExpoDb } from './__fixtures__/expo-sqlite-node';

/**
 * "Use password instead" and "Use a different account" (auth-context.tsx
 * signOutToFallback) end this phone's session only. B25, the #242 follow-up
 * "signOutToFallback does not wipe the cache".
 *
 * THE DEFECT. The fallback ended the session and did nothing else, so the
 * next person to sign in on the phone got:
 *   - the previous account's cache: its downloaded counts and their lines
 *     (item names, SKUs, expected quantities), shown until the new account's
 *     first pull reset a cache that was not its own, and for as long as that
 *     pull kept failing;
 *   - its LEGACY queued rows (no owner: written by an older binary or bundle),
 *     which belong to whoever drains them first, so the new account's session
 *     sent them as its own counts.
 * The deliberate sign-out (runSignOutFlow) already stamps the legacy rows
 * before the session goes and clears the cache after; the fallback now does
 * the same through runFallbackSignOut.
 *
 * EXECUTED on a real SQLite: the real schema, the real wipe (db.ts
 * wipeForSignOut), the real stamp (queue.ts adoptLegacyRows) and the real
 * cycle-count drain. Only the network, api(), the stored session and the saved
 * workspace are faked.
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

const net = vi.hoisted(() => ({ sent: [] as { lineId: unknown; asUserId: unknown }[] }));
vi.mock('./api', () => ({
  api: vi.fn(async (_path: string, opts: { body?: unknown; asUserId?: string } = {}) => {
    const body = (
      typeof opts.body === 'function' ? (opts.body as () => unknown)() : opts.body
    ) as Record<string, unknown>;
    net.sent.push({ lineId: body.lineId, asUserId: opts.asUserId });
    return {};
  }),
}));

let raw: DatabaseSync;

beforeEach(async () => {
  live.orgId = 'org-a';
  live.userId = 'u1';
  net.sent = [];
  raw = new DatabaseSync(':memory:');
  const handle = nodeExpoDb(raw);
  sqlite.open.mockReset().mockImplementation(async () => handle);
  vi.resetModules();
  await (await import('./db')).getDb(); // the real ensureSchema

  // u1's downloaded count, and two queued counts of its lines: one u1's own,
  // one a legacy row an older bundle wrote with no owner.
  raw.exec(`
    insert into cycle_counts (id, organization_id, status, warehouse_id, started_at, last_synced_at)
      values ('cc1', 'org-a', 'in_progress', 'wh1', '2026-10-01T00:00:00Z', 100);
    insert into cycle_count_lines (id, count_id, item_id, item_name, item_sku, expected, counted, local_dirty)
      values ('L1', 'cc1', 'i1', 'Placeholder one', 'SKU-1', 10, 4, 1),
             ('L2', 'cc1', 'i2', 'Placeholder two', 'SKU-2', 10, 6, 1);
    insert into meta (key, value) values ('cache_user_id', 'u1');
  `);
  const queue = raw.prepare(
    `insert into pending_actions
       (id, kind, idempotency_key, payload_json, created_at, status, organization_id, user_id)
     values (?, 'record_count', ?, ?, ?, 'pending', ?, ?)`,
  );
  queue.run(
    1,
    'k1',
    JSON.stringify({ cycleCountId: 'cc1', lineId: 'L1', countedQuantity: 4 }),
    1,
    'org-a',
    'u1',
  );
  queue.run(
    2,
    'k2',
    JSON.stringify({ cycleCountId: 'cc1', lineId: 'L2', countedQuantity: 6 }),
    2,
    null,
    null,
  );
});

/** The fallback as auth-context.tsx wires it, on the real modules. */
async function fallbackSignOut(opts: { serverReachable: boolean }) {
  const { runFallbackSignOut } = await import('./sign-out-flow');
  const { adoptLegacyRows } = await import('./queue');
  const { wipeForSignOut } = await import('./db');
  return runFallbackSignOut({
    holdForAccount: async () => {
      await adoptLegacyRows({ userId: 'u1', orgId: live.orgId });
    },
    // auth-js removes the stored session only when /logout answered.
    signOut: async () => {
      if (!opts.serverReachable) return { error: new Error('Network request failed') };
      live.userId = null;
      return { error: null };
    },
    hasSession: async () => live.userId !== null,
    wipeCache: wipeForSignOut,
  });
}

const tableCount = (table: string) =>
  (raw.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
const owners = () =>
  raw.prepare('select id, status, organization_id, user_id from pending_actions order by id').all();

describe('the fallback sign-out ("Use password instead", "Use a different account")', () => {
  it('clears the cache once the session has ended and keeps every queued count, held for the account that left', async () => {
    expect(await fallbackSignOut({ serverReachable: true })).toBe(true);

    expect(tableCount('cycle_counts')).toBe(0);
    expect(tableCount('cycle_count_lines')).toBe(0);
    expect(raw.prepare("select value from meta where key = 'cache_user_id'").get()).toBeUndefined();
    // Nothing queued was lost, and the legacy row is now u1's.
    expect(owners()).toEqual([
      { id: 1, status: 'pending', organization_id: 'org-a', user_id: 'u1' },
      { id: 2, status: 'pending', organization_id: 'org-a', user_id: 'u1' },
    ]);
  });

  it('the next account to sign in sends none of it; the account that left sends both when it is back', async () => {
    await fallbackSignOut({ serverReachable: true });
    const { cycleCountSync } = await import('./cycle-count-sync');

    live.userId = 'u2';
    await cycleCountSync.forceSync();
    expect(net.sent).toEqual([]);
    expect(owners()).toHaveLength(2);

    live.userId = 'u1';
    await cycleCountSync.forceSync();
    expect(net.sent).toEqual([
      { lineId: 'L1', asUserId: 'u1' },
      { lineId: 'L2', asUserId: 'u1' },
    ]);
    expect(owners()).toEqual([]);
  });

  it('a sign-out that could not reach the server (the session is still here) clears nothing', async () => {
    expect(await fallbackSignOut({ serverReachable: false })).toBe(false);

    expect(tableCount('cycle_counts')).toBe(1);
    expect(tableCount('cycle_count_lines')).toBe(2);
    expect(owners()).toHaveLength(2);
  });
});

describe('auth-context.tsx wires the fallback (source: React Native cannot load under node)', () => {
  const source = readFileSync(path.join(__dirname, 'auth-context.tsx'), 'utf8');
  const fallback = source.slice(
    source.indexOf("const signOutToFallback: AuthState['signOutToFallback']"),
    source.indexOf("const unlock: AuthState['unlock']"),
  );
  const deliberate = source.slice(
    source.indexOf("const signOut: AuthState['signOut']"),
    source.indexOf("const signOutToFallback: AuthState['signOutToFallback']"),
  );

  it('signOutToFallback runs runFallbackSignOut, and ends the session nowhere else', () => {
    expect(fallback).toMatch(/await runFallbackSignOut\(\{/);
    expect(fallback).not.toMatch(/endSession\(|supabase\.auth\.signOut\(/);
    expect(fallback).toMatch(
      /holdForAccount: async \(\) => \{\s*if \(userId\) await adoptLegacyRows\(\{ userId, orgId: scope\.orgId \}\);/,
    );
    expect(fallback).toMatch(/hasSession: hasStoredSession,/);
  });

  it('clears exactly what the deliberate sign-out clears', () => {
    const wipeOf = (body: string) => body.match(/wipeCache: ([^\n]+?),?\n/)?.[1];
    expect(wipeOf(deliberate)).toBeTruthy();
    expect(wipeOf(fallback)).toBe(wipeOf(deliberate));
  });
});
