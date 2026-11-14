import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { can, ROLE_PERMISSIONS, type Permission, type Role } from '@stockpilot/core';
import { describe, expect, it, vi } from 'vitest';

import { callbackStatements, unguardedCommits } from './__fixtures__/load-commit-audit';
import { screenCallback, stateInitializer } from './__fixtures__/screen-functions';
import { createSequenceGuard } from './debounced-list-load';
import { profileFromEmbed, resolveRequesterLabel } from './requester-label';
import { orderExchangeChip } from './returns-view';
import { permissionsOnceRead, type EffectivePermissionsState } from './use-effective-permissions';

// use-effective-permissions reads the device store and the API; only its
// pure permissionsOnceRead is used here.
vi.mock('./db', () => ({ getMeta: vi.fn(), setMeta: vi.fn() }));
vi.mock('./api', () => ({ api: vi.fn() }));

/**
 * THE ORDERS LIST WAITS FOR THE SAVED PERMISSIONS AND SHOWS ONLY ITS NEWEST
 * READ (review of the S2 follow-up, F6; the builder's lead 1).
 *
 * Which orders the list reads follows orders:approve: an approver reads the
 * whole queue, everyone else their own requests (web parity). The list read
 * `can({ role: role ?? 'staff', permissions }, 'orders:approve')` with
 * useEffectivePermissions(), so before the saved set was read the static
 * role defaults decided, and its load set what it read after each await with
 * no check of which read it was. A staff approver granted orders:approve by a
 * per-user exception could be left with only their own requests, and a
 * manager whose orders:approve was revoked with the whole queue, whichever
 * read finished last, until they came back to the list.
 *
 * Now the list's load waits for the saved set, like the order screen's, and
 * numbers its reads with the sequence guard: only the newest one started
 * changes the list. The behaviour tests run the list's own `load`, compiled
 * from src/screens/orders.tsx (screen-functions); the render is played by
 * hand with the rule the wiring pins below hold the screen to.
 */

const FILE = 'src/screens/orders.tsx';
const ORG = '0c000000-0000-0000-0000-0000000000c1';
const ME = '0d000000-0000-0000-0000-0000000000d1';
const SOMEONE_ELSE = '0d000000-0000-0000-0000-0000000000d2';

const orderRow = (n: number, requester: string) => ({
  id: `0e000000-0000-0000-0000-00000000000${n}`,
  order_number: 100 + n,
  status: 'pending_approval',
  requester_name: null,
  requester_email: null,
  requester_user_id: requester,
  requester_org_label: null,
  approved_at: null,
  delivered_at: null,
  created_at: '2026-11-02T18:00:00Z',
  replacement_for_return_id: null,
  fulfillment_type: 'delivery',
  warehouse: { name: 'A warehouse' },
  requester: null,
  lines: [],
});
const MINE = [orderRow(1, ME)];
const RMA = '0f000000-0000-0000-0000-0000000000f1';
const EVERYONE = [orderRow(1, ME), orderRow(2, SOMEONE_ELSE), orderRow(3, SOMEONE_ELSE)];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * The list's client: the order read answers the viewer's own requests when
 * filtered to them, else every order, after `hold`; with `exchange`, the
 * first row is a replacement order, so the list reads return_overview too,
 * after `overviewHold`.
 */
function listClient(hold?: Promise<void>, exchange?: { overviewHold: Promise<void> }) {
  const reads: ('own' | 'all' | 'overview')[] = [];
  const replacementRows = (rows: ReturnType<typeof orderRow>[]) =>
    exchange ? rows.map((r, i) => (i === 0 ? { ...r, replacement_for_return_id: RMA } : r)) : rows;
  return {
    reads,
    from(table: string) {
      if (table === 'return_overview') {
        reads.push('overview');
        const overview = {
          select: () => overview,
          eq: () => overview,
          in: () => overview,
          then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
            (async () => {
              await exchange?.overviewHold;
              return { data: [], error: null };
            })().then(ok, fail),
        };
        return overview;
      }
      let own = false;
      let sent = false;
      const chain = {
        select: () => chain,
        neq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        eq: (column: string) => {
          if (column === 'requester_user_id') own = true;
          return chain;
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          if (!sent) {
            sent = true;
            reads.push(own ? 'own' : 'all');
          }
          return (async () => {
            await hold;
            return { data: replacementRows(own ? MINE : EVERYONE), error: null };
          })().then(ok, fail);
        },
      };
      return chain;
    },
  };
}

/** The list for the signed-in member: its own state and its own load, built per render. */
function ordersList() {
  const state = { rows: undefined as { id: string }[] | undefined, loading: true, failed: false };
  const loads = (() => {
    try {
      return stateInitializer<() => ReturnType<typeof createSequenceGuard>>(FILE, 'loads', {
        createSequenceGuard,
      })();
    } catch {
      return undefined;
    }
  })();
  /** One render: the role and the saved set as read so far. */
  function render(
    role: Role,
    saved: EffectivePermissionsState,
    client: ReturnType<typeof listClient>,
  ) {
    // The screen's rule (pinned below): orders:approve from the saved set
    // once read, nothing before.
    const canApprove = can({ role, permissions: permissionsOnceRead(saved) }, 'orders:approve');
    return screenCallback<() => Promise<void>>(FILE, 'load', {
      orgId: ORG,
      userId: ME,
      canApprove,
      permissionsRead: saved.read,
      loads,
      supabase: client,
      unsettledSendsOnDevice: async () => 0,
      setUnconfirmed: () => undefined,
      setFailed: (v: boolean) => {
        state.failed = v;
      },
      setLoading: (v: boolean) => {
        state.loading = v;
      },
      setRows: (v: { id: string }[]) => {
        state.rows = v;
      },
      resolveRequesterLabel,
      profileFromEmbed,
      orderExchangeChip,
    });
  }
  return { state, render };
}

const read = (permissions: Iterable<Permission>): EffectivePermissionsState => ({
  permissions: new Set(permissions),
  read: true,
  answered: true,
});
const UNREAD: EffectivePermissionsState = {
  permissions: undefined,
  read: false,
  answered: false,
};
const STAFF_APPROVER = read([...ROLE_PERMISSIONS.staff, 'orders:approve']);
const STAFF = read(ROLE_PERMISSIONS.staff);
const REVOKED_MANAGER = read(ROLE_PERMISSIONS.manager.filter((p) => p !== 'orders:approve'));

describe('the Orders list reads with the saved permissions, and shows its newest read', () => {
  it('nothing is read before the saved set is (mutation: the wait removed)', async () => {
    const list = ordersList();
    const client = listClient();
    // A manager whose orders:approve is revoked: the static defaults would read the whole queue.
    await list.render('manager', UNREAD, client)();
    expect(client.reads).toEqual([]);
    expect(list.state.rows).toBeUndefined();
    expect(list.state.loading).toBe(true);
    const after = listClient();
    await list.render('manager', REVOKED_MANAGER, after)();
    expect(after.reads).toEqual(['own']);
    expect(list.state.rows?.map((r) => r.id)).toEqual(MINE.map((r) => r.id));
  });

  it('a grant of orders:approve lands while the own-requests read is on its way: the whole queue stays (mutation: a check taken out of load)', async () => {
    const list = ordersList();
    const older = deferred();
    const olderClient = listClient(older.promise);
    const first = list.render('staff', STAFF, olderClient)();
    const newerClient = listClient();
    await list.render('staff', STAFF_APPROVER, newerClient)();
    expect(list.state.rows).toHaveLength(EVERYONE.length);
    older.resolve();
    await first;
    expect(olderClient.reads).toEqual(['own']);
    expect(newerClient.reads).toEqual(['all']);
    expect(list.state.rows).toHaveLength(EVERYONE.length);
    expect(list.state.loading).toBe(false);
  });

  // The second check: the older read is past the first one, reading the
  // Exchange chip's words for a replacement order, when the newer starts.
  it('a newer read starts while the older one reads the Exchange chips: the newer list stays (mutation: the check after that read taken out)', async () => {
    const list = ordersList();
    const overview = deferred();
    const olderClient = listClient(undefined, { overviewHold: overview.promise });
    const first = list.render('staff', STAFF, olderClient)();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(olderClient.reads).toEqual(['own', 'overview']);
    await list.render('staff', STAFF_APPROVER, listClient())();
    expect(list.state.rows).toHaveLength(EVERYONE.length);
    overview.resolve();
    await first;
    expect(list.state.rows).toHaveLength(EVERYONE.length);
  });

  it('orders:approve revoked while the whole-queue read is on its way: only their own requests stay', async () => {
    const list = ordersList();
    const older = deferred();
    const first = list.render(
      'manager',
      read(ROLE_PERMISSIONS.manager),
      listClient(older.promise),
    )();
    await list.render('manager', REVOKED_MANAGER, listClient())();
    older.resolve();
    await first;
    expect(list.state.rows?.map((r) => r.id)).toEqual(MINE.map((r) => r.id));
  });
});

const SOURCE = readFileSync(path.resolve(__dirname, '../..', FILE), 'utf8');
const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('wiring: the Orders list', () => {
  it('decides orders:approve from the saved set once read, and waits for it', () => {
    expect(code).toContain(
      "import { permissionsOnceRead, useEffectivePermissionsState } from '@/lib/use-effective-permissions';",
    );
    expect(code).toContain('const savedPermissions = useEffectivePermissionsState();');
    expect(code).toContain('const permissions = savedPermissions.permissions;');
    expect(code).toContain('const permissionsRead = savedPermissions.read === true;');
    expect(code).toMatch(
      /const canApprove = can\(\s*\{ role: role \?\? 'staff', permissions: permissionsOnceRead\(savedPermissions\) \},\s*'orders:approve',\s*\);/,
    );
    expect(code).not.toMatch(/useEffectivePermissions\(\)/);
  });

  // Mutation caught: the number taken after the read, or the wait removed.
  it('reads nothing before the saved set, and takes its number before its read', () => {
    expect(code).toContain('const [loads] = React.useState(() => createSequenceGuard());');
    expect(code).toMatch(
      /const load = React\.useCallback\(async \(\) => \{\s*if \(!orgId \|\| !userId\) return;\s*if \(!permissionsRead\) return;\s*const seq = loads\.next\(\);\s*let query = supabase/,
    );
    expect(code).toMatch(/\}, \[orgId, canApprove, userId, permissionsRead, loads\]\);/);
  });

  // Mutation caught: any check taken out, or a set moved after a read.
  it('changes nothing after a read unless it is still the newest read', () => {
    const found = callbackStatements(SOURCE, FILE, 'load');
    expect(found).not.toBeNull();
    const { unguarded, guards } = unguardedCommits(
      found!.sf,
      found!.statements,
      new Set(['setRows', 'setLoading', 'setFailed', 'setUnconfirmed']),
      '!loads.isCurrent(seq)',
    );
    expect(unguarded).toEqual([]);
    expect(guards).toBe(2);
  });

  it('still reads on every focus, through the same load', () => {
    expect(code).toMatch(
      /useFocusEffect\(\s*React\.useCallback\(\(\) => \{\s*void load\(\);\s*\}, \[load\]\),?\s*\);/,
    );
  });
});
