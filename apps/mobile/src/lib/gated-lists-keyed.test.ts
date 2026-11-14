import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { effectCallback, screenCallback, screenFunction } from './__fixtures__/screen-functions';
import {
  distributeKeyFor,
  distributeNotSavedAlert,
  distributeSignature,
} from './bundle-distribute-attempt';
import { createSequenceGuard } from './debounced-list-load';
import { joinMemberProfiles } from './org-members';

/**
 * THE OTHER SCREENS THIS CHANGE GATES: AN ANSWER READ FOR ONE ACCOUNT OR
 * WORKSPACE IS NEVER DRAWN FOR ANOTHER.
 *
 * Their reads already dropped an answer that a newer read of the same screen
 * replaced. What they missed was a change of account with no change of
 * workspace (a sign-out and another account's sign-in, with the screen still
 * mounted under the sign-in screen): no new read started, so an answer still
 * out for the first account landed and was drawn for the second, and rows
 * kept for a workspace were drawn for any account in it. Now:
 *   - the Cycle counts tab starts the account's own view when the account
 *     changes, as it does for a workspace switch (the newer load drops the
 *     older answer);
 *   - the Bundles list notes whose kits it read (account and workspace),
 *     drops an answer read for another, and draws only its own;
 *   - a bundle's screen drops a read that the account, workspace, bundle or
 *     access changed under, and a distribution confirmed or answered after
 *     the account or workspace changed is not sent, queued or said;
 *   - Users, Team and Accounts keep their rows with the account and the
 *     workspace they were read for, read again when either changes, and
 *     draw only rows read for both.
 *
 * The screens' own functions and effects are RUN here (screen-functions.ts).
 */

const TAB = 'app/(drawer)/(tabs)/cycle-counts.tsx';
const BUNDLES = 'app/bundles/index.tsx';
const BUNDLE = 'app/bundles/[id].tsx';
const USERS = 'app/(drawer)/admin/users.tsx';
const TEAM = 'app/(drawer)/team.tsx';
const CUSTOMERS = 'app/(drawer)/customers.tsx';
const ORG = '0c000000-0000-0000-0000-0000000000e9';
const FIRST_ATTEMPT = 'attempt-1';

const flat = (file: string) =>
  readFileSync(path.resolve(__dirname, '../..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s+/g, ' ');

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('the Cycle counts tab', () => {
  it("another account in the same workspace starts that account's own view; the older answer is dropped", () => {
    const loads: unknown[] = [];
    const cleared: string[] = [];
    effectCallback<() => void>(TAB, 'lastOrg.current = orgId', {
      lastOrg: { current: ORG },
      lastUser: { current: 'user-a' },
      orgId: ORG,
      userId: 'user-b',
      recallListView: () => ({ q: '', status: null, page: 1 }),
      debounce: { current: { cancel: () => undefined } },
      setPage: () => cleared.push('page'),
      setSummary: () => cleared.push('summary'),
      setDownloaded: () => cleared.push('downloaded'),
      setError: () => cleared.push('error'),
      setDraftQ: () => undefined,
      setView: () => undefined,
      load: (...a: unknown[]) => loads.push(a),
    })();
    expect(cleared).toEqual(['page', 'summary', 'downloaded', 'error']);
    expect(loads).toHaveLength(1);
    // Every load takes a new turn of the sequence guard, so the answer still
    // out for the first account is dropped when it lands.
    expect(flat(TAB)).toContain('const token = guard.current.next();');
  });
});

describe('the Bundles list', () => {
  it('kits read for one account that land after another signed in are dropped, and only its own kits are drawn', async () => {
    const answer = deferred<{ id: string }[]>();
    const set: string[] = [];
    const readForRef = { current: `user-a:${ORG}` };
    const load = screenCallback<() => Promise<void>>(BUNDLES, 'load', {
      readFor: `user-a:${ORG}`,
      readForRef,
      listBundles: () => answer.promise,
      setHeld: () => set.push('held'),
      // What the list set before it kept whose kits they are.
      setRows: () => set.push('rows'),
      setRead: () => set.push('read'),
      console: { warn: vi.fn() },
    });
    const run = load();
    readForRef.current = `user-b:${ORG}`;
    answer.resolve([{ id: 'kit-of-a' }]);
    await run;
    expect(set).toEqual([]);
    const code = flat(BUNDLES);
    expect(code).toContain(
      'const shownRows = held !== null && held.key === readFor ? held.rows : NO_BUNDLES;',
    );
    expect(code).toContain(
      "const shownRead: CacheRead = held !== null && held.key === readFor ? held.read : 'pending';",
    );
    expect(code).toContain('(allowed ? shownRows : []).map((b) => (');
  });
});

describe("a bundle's screen", () => {
  it('a read the account, workspace, bundle or access changed under draws nothing', async () => {
    const answer = deferred<{ id: string }[]>();
    const set: string[] = [];
    const effect = effectCallback<() => unknown>(BUNDLE, 'await listBundles()', {
      id: 'kit-1',
      access: 'allowed',
      listBundles: () => answer.promise,
      getBundleComponents: async () => [],
      getItemById: async () => null,
      listWarehouses: async () => [],
      defaultDistributeWarehouseId: () => null,
      setBundle: () => set.push('bundle'),
      setComponents: () => set.push('components'),
      setItems: () => set.push('items'),
      setWarehouses: () => set.push('warehouses'),
      setWarehouseId: () => set.push('warehouse'),
      setFailedRead: () => set.push('failed'),
      setLooked: () => set.push('looked'),
      console: { warn: vi.fn() },
    });
    const cleanup = effect();
    expect(typeof cleanup).toBe('function');
    (cleanup as () => void)();
    answer.resolve([{ id: 'kit-1' }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(set).toEqual([]);
    expect(flat(BUNDLE)).toContain('}, [id, access, userId, orgId]);');
  });

  /** The screen's own distribute(), with the account and workspace on screen in `shownFor`. */
  function distributeOn(opts: {
    shortage: boolean;
    send: () => Promise<unknown>;
    confirm?: Promise<void>;
  }) {
    const shownForRef = { current: `user-a:${ORG}` };
    const alert = vi.fn((_t: string, _m?: string, buttons?: { onPress?: () => void }[]) => {
      // The shortage confirm: Distribute is pressed once `confirm` settles.
      if (buttons && buttons.length === 2) void opts.confirm?.then(() => buttons[1]!.onPress!());
    });
    const api = vi.fn(opts.send);
    const enqueue = vi.fn(async () => undefined);
    const syncNow = vi.fn();
    const run = screenFunction<() => Promise<void>>(BUNDLE, 'distribute', {
      bundle: { id: 'kit-1' },
      preview: { hasShortage: opts.shortage, totalShortageUnits: opts.shortage ? 2 : 0 },
      warehouseId: 'wh-1',
      qty: '2',
      Alert: { alert },
      distributeSignature,
      distributeKeyFor,
      distributeNotSavedAlert,
      keptKey: { current: null },
      newIdempotencyKey: () => FIRST_ATTEMPT,
      setBusy: vi.fn(),
      api,
      ApiError: class extends Error {
        status = 500;
      },
      router: { back: vi.fn() },
      enqueue,
      syncNow,
      reportPhoneSaveFailure: vi.fn(),
      shownForRef,
    });
    return { run, shownForRef, alert, api, enqueue, syncNow };
  }

  it('a shortage confirm answered after another account signed in, or the workspace changed, sends nothing', async () => {
    for (const next of [`user-b:${ORG}`, `user-a:0c000000-0000-0000-0000-0000000000f0`, ':']) {
      const pressed = deferred<void>();
      const d = distributeOn({
        shortage: true,
        send: async () => undefined,
        confirm: pressed.promise,
      });
      const done = d.run();
      d.shownForRef.current = next;
      pressed.resolve();
      await done;
      expect(d.api).not.toHaveBeenCalled();
      expect(d.enqueue).not.toHaveBeenCalled();
    }
  });

  it('a send that fails after the change is not queued under the next account, and nothing is said', async () => {
    const answer = deferred<void>();
    const d = distributeOn({
      shortage: false,
      send: () => answer.promise.then(() => Promise.reject(new Error('Network request failed'))),
    });
    const done = d.run();
    d.shownForRef.current = `user-b:${ORG}`;
    answer.resolve();
    await done;
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.alert).not.toHaveBeenCalled();
  });

  it('a distribution answered after the change is not said to the next account', async () => {
    const answer = deferred<void>();
    const d = distributeOn({ shortage: false, send: () => answer.promise });
    const done = d.run();
    d.shownForRef.current = `user-b:${ORG}`;
    answer.resolve();
    await done;
    expect(d.api).toHaveBeenCalledTimes(1);
    expect(d.alert).not.toHaveBeenCalled();
  });
});

describe.each([
  ['Users', USERS],
  ['Team', TEAM],
])('%s', (_label, file) => {
  it('keeps its rows with the account and workspace they were read for, and draws only those', async () => {
    const lists: { orgId: string; userId: string | null }[] = [];
    const load = screenCallback<() => Promise<void>>(file, 'load', {
      orgId: ORG,
      userId: 'user-a',
      isAdmin: true,
      supabase: {},
      loadOrgMembers: async () => ({ members: [], profiles: new Map() }),
      joinMemberProfiles,
      setList: (v: { orgId: string; userId: string | null }) => lists.push(v),
      setLoadFailed: () => undefined,
      setLoading: () => undefined,
      guard: { current: createSequenceGuard() },
      console: { warn: vi.fn() },
    });
    await load();
    expect(lists).toEqual([{ orgId: ORG, userId: 'user-a', rows: [] }]);
    const code = flat(file);
    expect(code).toContain(
      'const rows = list !== null && list.orgId === orgId && list.userId === userId ? list.rows : NO_ROWS;',
    );
    expect(code).toMatch(/\}, \[orgId, userId(, isAdmin)?\]\);/);
  });
});

describe('Users: the role sheet and a role change', () => {
  it('a role sheet opened by one account is not shown to another account in the same workspace', () => {
    const editing = (now: { orgId: string; userId: string }) =>
      screenFunction<() => unknown>(USERS, 'roleSheetRow', {
        editingFor: { orgId: ORG, userId: 'user-a', row: { user_id: 'member-1' } },
        orgId: now.orgId,
        userId: now.userId,
      })();
    expect(editing({ orgId: ORG, userId: 'user-a' })).toEqual({ user_id: 'member-1' });
    expect(editing({ orgId: ORG, userId: 'user-b' })).toBeNull();
    expect(editing({ orgId: 'another-org', userId: 'user-a' })).toBeNull();
  });

  it('a role change answered after another account signed in says nothing to it', async () => {
    const answer = deferred<{ data: null; error: { message: string } }>();
    const alert = vi.fn();
    const shownForRef = { current: `user-a:${ORG}` };
    const q: Record<string, unknown> = {};
    for (const k of ['update', 'eq', 'select']) q[k] = () => q;
    q.maybeSingle = () => answer.promise;
    const change = screenFunction<(m: unknown, r: string) => Promise<void>>(USERS, 'changeRole', {
      orgId: ORG,
      userId: 'user-a',
      user: { id: 'user-a' },
      canChangeRoles: true,
      setEditing: () => undefined,
      supabase: { from: () => q },
      interpretMemberRoleWrite: () => ({ ok: false, message: 'Could not change the role.' }),
      Alert: { alert },
      console: { warn: vi.fn() },
      setList: vi.fn(),
      shownForRef,
    });
    const done = change({ user_id: 'member-1', role: 'staff' }, 'manager');
    shownForRef.current = `user-b:${ORG}`;
    answer.resolve({ data: null, error: { message: 'refused' } });
    await done;
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('Accounts', () => {
  it('keeps its accounts with the account and workspace they were read for, and draws only those', async () => {
    const lists: unknown[] = [];
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order']) q[k] = () => q;
    q.limit = async () => ({ data: [], error: null });
    const load = screenCallback<() => Promise<void>>(CUSTOMERS, 'load', {
      user: { id: 'user-a' },
      userId: 'user-a',
      activeOrgId: ORG,
      supabase: { from: () => q },
      setList: (v: unknown) => lists.push(v),
      setLoadFailed: () => undefined,
      setLoading: () => undefined,
      guard: { current: createSequenceGuard() },
    });
    await load();
    expect(lists).toEqual([{ orgId: ORG, userId: 'user-a', rows: [] }]);
    expect(flat(CUSTOMERS)).toContain(
      'const rows = list !== null && list.orgId === activeOrgId && list.userId === userId ? list.rows : NO_ROWS;',
    );
  });
});
