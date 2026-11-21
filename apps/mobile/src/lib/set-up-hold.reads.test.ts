import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { setUpHoldDetails, setUpHoldFor, setUpHoldIn, setUpRecheckDue } from './set-up-hold';
import {
  readSetUpInputsForHold,
  setUpAnswerAfterRefusal,
  setUpInputsView,
  setUpOwedIn,
} from './set-up-inputs';
import { connectSetUpInputs } from './set-up-inputs-source';
import { setActiveOrg, useWorkspace } from './use-workspace';

/**
 * The holding screen's reads, EXECUTED through the app's own reader
 * (set-up-inputs-source.ts) and membership read (use-workspace.ts loadOrgs),
 * with supabase answering as it does: how each read ends (answered, failed
 * with an answer, no answer) reaches the decision, the saved workspace is
 * the one held before a workspace is shown, and the workspace shown and a
 * switch move it. No warehouse is read for a workspace that holds the
 * account, by a workspace load or by a switch.
 */

const published = vi.hoisted(() => [] as { activeOrgId: string | null; loading: boolean }[]);
vi.mock('react', () => ({
  useState: (v: unknown) => [
    v,
    (next: { activeOrgId: string | null; loading: boolean }) => published.push(next),
  ],
  useEffect: (fn: () => unknown) => {
    fn();
  },
}));

const auth = vi.hoisted(() => ({
  listener: null as null | ((event: string, session: { user: { id: string } } | null) => void),
}));
vi.mock('./auth-context', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getAllKeys: vi.fn(async () => [...store.keys()]),
    getItem: vi.fn(async (k: string) => store.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      if (k === 'workspace.savedOrg') answers.holdAtSave.push(holdNow());
      store.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      store.delete(k);
    }),
  },
}));
vi.mock('./db', () => ({ deleteOrgData: vi.fn(async () => {}) }));
vi.mock('./enabled-modules', () => ({ refreshEnabledModules: vi.fn() }));
vi.mock('./use-effective-permissions', () => ({ refreshEffectivePermissions: async () => {} }));
vi.mock('./warehouse-scope', () => ({ refreshWarehouseScope: async () => {} }));
vi.mock('./use-cache-owner', () => ({ refreshCacheOwner: async () => {} }));
vi.mock('./sync', () => ({
  syncNow: vi.fn(async () => {}),
  syncAfterRunning: vi.fn(async () => {}),
}));
vi.mock('./cycle-count-sync', () => ({ cycleCountSync: { forceSync: vi.fn(async () => {}) } }));

/** What the next reads answer. */
const answers = vi.hoisted(() => ({
  user: { kind: 'ok' as 'ok' | 'offline' | 'http-error', factors: [] as { status: string }[] },
  members: {
    kind: 'ok' as 'ok' | 'offline' | 'http-error',
    policy: 'all_required' as string | null,
  },
  getUserCalls: 0,
  memberCalls: 0,
  /** Each warehouse read, by the workspace it names. */
  warehouseReads: [] as string[],
  /** What the hold answered for the workspace at the moment its save was written. */
  holdAtSave: [] as (string | null)[],
}));
vi.mock('./supabase', () => {
  const members = {
    select: () => members,
    eq: () => members,
    not: async () => {
      answers.memberCalls += 1;
      const m = answers.members;
      if (m.kind === 'offline') {
        return { data: null, error: { message: 'TypeError: Network request failed' }, status: 0 };
      }
      if (m.kind === 'http-error') {
        return { data: null, error: { message: 'upstream' }, status: 503 };
      }
      return {
        data: [
          {
            role: 'staff',
            organization_id: 'org-a',
            organizations: m.policy === null ? null : { name: 'North Depot', mfa_policy: m.policy },
          },
          {
            role: 'staff',
            organization_id: 'org-b',
            organizations: [{ name: 'South Yard', mfa_policy: 'optional' }],
          },
        ],
        error: null,
        status: 200,
      };
    },
  };
  const profiles = {
    select: () => profiles,
    eq: () => profiles,
    maybeSingle: async () => ({ data: { default_organization_id: 'org-a' }, error: null }),
  };
  const warehouses = {
    select: () => warehouses,
    eq: (_col: string, orgId: string) => {
      answers.warehouseReads.push(orgId);
      return warehouses;
    },
    order: async () => ({ data: [{ id: 'wh-1', name: 'Dock 4', status: 'active' }], error: null }),
  };
  return {
    supabase: {
      from: (t: string) =>
        t === 'organization_members' ? members : t === 'user_profiles' ? profiles : warehouses,
      auth: {
        getUser: async () => {
          answers.getUserCalls += 1;
          const u = answers.user;
          if (u.kind === 'offline') {
            return { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0 } };
          }
          if (u.kind === 'http-error') {
            return {
              data: { user: null },
              error: { name: 'AuthRetryableFetchError', status: 502 },
            };
          }
          return { data: { user: { id: 'u1', factors: u.factors } }, error: null };
        },
        onAuthStateChange: (cb: typeof auth.listener) => {
          auth.listener = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
    },
  };
});

const session = { id: 'u1', factors: [] as { status: string }[] };

/** The hold for u1 in the workspace held for it, as the load's callers outside React read it. */
function holdNow(): string | null {
  return setUpHoldIn('u1');
}

beforeAll(async () => {
  // Saved by an earlier run: this account's workspace is org-a.
  store.set('workspace.savedOrg', JSON.stringify({ orgId: 'org-a', ownerId: 'u1' }));
  auth.listener?.('SIGNED_IN', { user: { id: 'u1' } });
  connectSetUpInputs();
  await vi.waitFor(() => expect(setUpHoldDetails(session).orgId).toBe('org-a'));
});

afterEach(() => {
  answers.user = { kind: 'ok', factors: [] };
  answers.members = { kind: 'ok', policy: 'all_required' };
  vi.restoreAllMocks();
});

describe('how each read ends reaches the decision (nothing else read for the account yet)', () => {
  it('no answer to the user read (offline): the app, and no membership read is made', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answers.user = { kind: 'offline', factors: [] };
    const before = answers.memberCalls;
    await readSetUpInputsForHold('u1');
    expect(setUpInputsView('u1', 'org-a').lastRead).toBe('no-answer');
    expect(answers.memberCalls).toBe(before);
    expect(setUpHoldFor(session)).toBeNull();
  });

  it('the user read answered with an error (502): the app, as with no answer, and the re-check stays due', async () => {
    answers.user = { kind: 'http-error', factors: [] };
    await readSetUpInputsForHold('u1');
    expect(setUpInputsView('u1', 'org-a').lastRead).toBe('failed');
    expect(setUpHoldFor(session)).toBeNull();
    expect(setUpRecheckDue(session)).toBe(true);
  });

  it('the membership read with no answer, or with an error answer: the app', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    answers.members = { kind: 'offline', policy: 'all_required' };
    await readSetUpInputsForHold('u1');
    expect(setUpInputsView('u1', 'org-a').lastRead).toBe('no-answer');
    expect(setUpHoldFor(session)).toBeNull();
    answers.members = { kind: 'http-error', policy: 'all_required' };
    await readSetUpInputsForHold('u1');
    expect(setUpInputsView('u1', 'org-a').lastRead).toBe('failed');
    expect(setUpHoldFor(session)).toBeNull();
    expect(setUpRecheckDue(session)).toBe(true);
  });
});

describe('a read that answers', () => {
  it("holds by the policy as read and the server's list, which the queue then follows too", async () => {
    await readSetUpInputsForHold('u1');
    expect(setUpRecheckDue(session)).toBe(false);
    expect(setUpInputsView('u1', 'org-a').lastRead).toBe('answered');
    expect(setUpHoldDetails(session)).toEqual({
      hold: 'owed',
      orgId: 'org-a',
      name: 'North Depot',
      policy: 'all_required',
    });
    expect(setUpOwedIn('u1', 'org-a')).toBe('owed');
    // The screen's read sets no refusal mark for any row.
    expect(setUpAnswerAfterRefusal('u1', 'org-a', 'row-1')).toBe('unknown');
  });

  it('after set-up on the website, Check again releases the screen and the queue alike', async () => {
    answers.user = { kind: 'ok', factors: [{ status: 'verified' }] };
    await readSetUpInputsForHold('u1');
    // The session's copy still lists no factor: the server's list decides.
    expect(setUpHoldFor(session)).toBeNull();
    expect(setUpOwedIn('u1', 'org-a')).toBe('clear');
  });

  it('a hidden organization row: the could-not-check hold, with no name', async () => {
    answers.members = { kind: 'ok', policy: null };
    await readSetUpInputsForHold('u1');
    expect(setUpHoldDetails(session)).toEqual({
      hold: 'unknown',
      orgId: 'org-a',
      name: null,
      policy: null,
    });
  });

  it('the policy turned off: the next read releases', async () => {
    await readSetUpInputsForHold('u1');
    expect(setUpHoldFor(session)).toBe('owed');
    answers.members = { kind: 'ok', policy: 'optional' };
    await readSetUpInputsForHold('u1');
    expect(setUpHoldFor(session)).toBeNull();
  });
});

describe('the workspace held: the one shown, and a switch', () => {
  it('the workspace load shows a workspace; a switch moves the hold to it and reads again', async () => {
    await readSetUpInputsForHold('u1');
    useWorkspace();
    await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
    expect(setUpHoldDetails(session).orgId).toBe('org-a');
    expect(setUpHoldFor(session)).toBe('owed');
    const reads = answers.getUserCalls;
    await setActiveOrg('org-b');
    expect(setUpHoldDetails(session).orgId).toBe('org-b');
    expect(setUpHoldFor(session)).toBeNull();
    await vi.waitFor(() => expect(answers.getUserCalls).toBe(reads + 1));
  });
});

describe('no warehouse is read for a workspace that holds the account', () => {
  it('a workspace load for a held account: the hold is told before the save, and no warehouse read', async () => {
    await readSetUpInputsForHold('u1');
    // A fresh choice that is saved: nothing saved for this account.
    store.set('workspace.savedOrg', JSON.stringify({ orgId: null, ownerId: null }));
    await setActiveOrg('org-b');
    await vi.waitFor(() => expect(setUpHoldDetails(session).orgId).toBe('org-b'));
    store.delete('workspace.savedOrg');
    answers.warehouseReads.length = 0;
    answers.holdAtSave.length = 0;
    useWorkspace(); // a screen mounts with no workspace shown for the account
    published.length = 0;
    await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
    expect(setUpHoldDetails(session).orgId).toBe('org-a');
    expect(setUpHoldFor(session)).toBe('owed');
    expect(answers.holdAtSave).toEqual(['owed']);
    expect(answers.warehouseReads).toEqual([]);
  });

  it('a switch into a held workspace reads none; a switch into one that lets the account in does', async () => {
    await readSetUpInputsForHold('u1');
    await setActiveOrg('org-b');
    await vi.waitFor(() => expect(answers.warehouseReads).toContain('org-b'));
    answers.warehouseReads.length = 0;
    await setActiveOrg('org-a');
    expect(setUpHoldFor(session)).toBe('owed');
    expect(answers.warehouseReads).toEqual([]);
    await setActiveOrg('org-b');
    expect(setUpHoldFor(session)).toBeNull();
    expect(answers.warehouseReads).toEqual(['org-b']);
  });

  it('once released, a load reads them again', async () => {
    await setActiveOrg('org-a');
    answers.warehouseReads.length = 0;
    answers.user = { kind: 'ok', factors: [{ status: 'verified' }] };
    await readSetUpInputsForHold('u1');
    expect(setUpHoldFor(session)).toBeNull();
    useWorkspace();
    published.length = 0;
    await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
    expect(answers.warehouseReads).toEqual(['org-a']);
  });

  it('the could-not-check hold reads none either, by a switch or by a load', async () => {
    answers.members = { kind: 'ok', policy: null };
    await readSetUpInputsForHold('u1');
    await setActiveOrg('org-b');
    answers.warehouseReads.length = 0;
    await setActiveOrg('org-a');
    expect(setUpHoldFor(session)).toBe('unknown');
    expect(answers.warehouseReads).toEqual([]);
    useWorkspace();
    published.length = 0;
    await vi.waitFor(() => expect(published.at(-1)?.loading).toBe(false));
    expect(setUpHoldDetails(session).orgId).toBe('org-a');
    expect(setUpHoldFor(session)).toBe('unknown');
    expect(answers.warehouseReads).toEqual([]);
  });
});
