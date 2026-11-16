import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginSetUpRead,
  noteKeptRefusal,
  noteServerReadUser,
  parseSavedSetUpInputs,
  recordMembershipInputs,
  registerSetUpInputsSource,
  requestSetUpInputsRead,
  resetSetUpInputsForTests,
  SET_UP_INPUTS_STORAGE_KEY,
  SET_UP_READ_MIN_INTERVAL_MS,
  setUpAnswerAfterRefusal,
  setUpInputsReadInFlight,
  setUpOwedIn,
  type MembershipRowForSetUp,
} from './set-up-inputs';

/**
 * The inputs to core's set-up rule, per account and workspace: the policy as
 * read (or hidden), the role, and the server's factor list. The answer is
 * worked out when asked; only the inputs are saved.
 */

const row = (
  organizationId: string,
  organization: unknown,
  role = 'staff',
): MembershipRowForSetUp => ({
  organizationId,
  role,
  organization,
});

/** One membership read for u1 that answered with these rows. */
function readMemberships(rows: MembershipRowForSetUp[], userId = 'u1'): void {
  recordMembershipInputs(userId, rows, beginSetUpRead());
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: vi.fn(async (k: string) => items.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      items.set(k, v);
    }),
  };
}

beforeEach(() => resetSetUpInputsForTests());
afterEach(() => resetSetUpInputsForTests());

describe('setUpOwedIn: the rule, from the inputs', () => {
  it.each([
    ['all_required', 'staff', 'owed'],
    ['all_required', 'admin', 'owed'],
    ['admins_required', 'owner', 'owed'],
    ['admins_required', 'admin', 'owed'],
    ['admins_required', 'staff', 'clear'],
    ['optional', 'owner', 'clear'],
  ] as const)('%s, %s with no authenticator: %s', (policy, role, expected) => {
    readMemberships([row('org', { name: 'Org', mfa_policy: policy }, role)]);
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpOwedIn('u1', 'org')).toBe(expected);
  });

  it('the embed as an object and as an array of one read the same', () => {
    readMemberships([
      row('obj', { name: 'O', mfa_policy: 'optional' }),
      row('arr', [{ name: 'A', mfa_policy: 'optional' }]),
      row('arr-all', [{ name: 'B', mfa_policy: 'all_required' }]),
    ]);
    noteServerReadUser({ id: 'u1', factors: [] });
    // An array read as the row itself would have no mfa_policy and be held
    // to the strictest policy: a staff member under Optional held.
    expect(setUpOwedIn('u1', 'obj')).toBe('clear');
    expect(setUpOwedIn('u1', 'arr')).toBe('clear');
    expect(setUpOwedIn('u1', 'arr-all')).toBe('owed');
  });

  it('a verified factor clears it; an unverified one does not', () => {
    readMemberships([row('org', { mfa_policy: 'all_required' })]);
    noteServerReadUser({ id: 'u1', factors: [{ status: 'unverified' }] });
    expect(setUpOwedIn('u1', 'org')).toBe('owed');
    noteServerReadUser({ id: 'u1', factors: [{ status: 'unverified' }, { status: 'verified' }] });
    expect(setUpOwedIn('u1', 'org')).toBe('clear');
  });

  it("the server's latest list decides, both ways", () => {
    readMemberships([row('org', { mfa_policy: 'all_required' })]);
    noteServerReadUser({ id: 'u1', factors: [{ status: 'verified' }] });
    expect(setUpOwedIn('u1', 'org')).toBe('clear');
    // Removed on the website (a reset): owed again at the next server read.
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpOwedIn('u1', 'org')).toBe('owed');
    // An older answer arriving late does not replace a newer one.
    const early = beginSetUpRead();
    noteServerReadUser({ id: 'u1', factors: [] });
    noteServerReadUser({ id: 'u1', factors: [{ status: 'verified' }] }, early);
    expect(setUpOwedIn('u1', 'org')).toBe('owed');
  });

  it('a hidden organization row is never read as a policy: unknown with no factor, clear with one', () => {
    for (const hidden of [null, [], [null], 'x', { name: 'Org' }, { mfa_policy: 'sometimes' }]) {
      resetSetUpInputsForTests();
      readMemberships([row('org', hidden)]);
      noteServerReadUser({ id: 'u1', factors: [] });
      expect(setUpOwedIn('u1', 'org'), JSON.stringify(hidden)).toBe('unknown');
      noteServerReadUser({ id: 'u1', factors: [{ status: 'verified' }] });
      expect(setUpOwedIn('u1', 'org'), JSON.stringify(hidden)).toBe('clear');
    }
  });

  it('unknown until both are read: no membership read, or a requiring policy with no factor list', () => {
    expect(setUpOwedIn('u1', 'org')).toBe('unknown');
    readMemberships([
      row('org', { mfa_policy: 'all_required' }),
      row('opt', { mfa_policy: 'optional' }),
    ]);
    expect(setUpOwedIn('u1', 'org')).toBe('unknown');
    // A policy that does not ask this role needs no factor list.
    expect(setUpOwedIn('u1', 'opt')).toBe('clear');
  });

  it('a workspace this account is not a member of, by a read this run: nothing owed there', () => {
    readMemberships([row('org', { mfa_policy: 'all_required' })]);
    expect(setUpOwedIn('u1', 'left')).toBe('clear');
  });

  it('per account: another account on the phone never answers for this one', () => {
    readMemberships([row('org', { mfa_policy: 'all_required' })], 'u2');
    noteServerReadUser({ id: 'u2', factors: [] });
    expect(setUpOwedIn('u2', 'org')).toBe('owed');
    expect(setUpOwedIn('u1', 'org')).toBe('unknown');
    expect(setUpOwedIn(null, 'org')).toBe('unknown');
    expect(setUpOwedIn('u1', null)).toBe('unknown');
  });

  it('a newer membership read replaces the older one; a slower older one does not', () => {
    const older = beginSetUpRead();
    readMemberships([row('org', { mfa_policy: 'optional' })]);
    recordMembershipInputs('u1', [row('org', { mfa_policy: 'all_required' })], older);
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpOwedIn('u1', 'org')).toBe('clear');
  });
});

describe('setUpAnswerAfterRefusal: only reads made after the refusal count', () => {
  it('no refusal noted: unknown, whatever is known', () => {
    readMemberships([row('org', { mfa_policy: 'optional' })]);
    expect(setUpOwedIn('u1', 'org')).toBe('clear');
    expect(setUpAnswerAfterRefusal('u1', 'org')).toBe('unknown');
  });

  it('reads from before the refusal do not count; reads after it do', () => {
    readMemberships([row('org', { mfa_policy: 'all_required' })]);
    noteServerReadUser({ id: 'u1', factors: [] });
    noteKeptRefusal('u1', 'org');
    expect(setUpAnswerAfterRefusal('u1', 'org')).toBe('unknown');

    readMemberships([row('org', { mfa_policy: 'all_required' })]);
    // The policy asks this role, so the factor list must be newer too.
    expect(setUpAnswerAfterRefusal('u1', 'org')).toBe('unknown');
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpAnswerAfterRefusal('u1', 'org')).toBe('owed');
  });

  it('a policy that does not ask this role, read after the refusal, is clear without a factor list', () => {
    noteKeptRefusal('u1', 'org');
    readMemberships([row('org', { mfa_policy: 'admins_required' })]);
    expect(setUpAnswerAfterRefusal('u1', 'org')).toBe('clear');
  });

  it('a burst of refusals before the read answers does not move the mark past that read', () => {
    noteKeptRefusal('u1', 'org');
    const read = beginSetUpRead(); // the read asked for, under way
    noteKeptRefusal('u1', 'org'); // a second row of the same workspace refused meanwhile
    recordMembershipInputs('u1', [row('org', { mfa_policy: 'optional' })], read);
    expect(setUpAnswerAfterRefusal('u1', 'org')).toBe('clear');
  });

  it('a refusal after a read has answered sets a new mark', () => {
    noteKeptRefusal('u1', 'org');
    readMemberships([row('org', { mfa_policy: 'optional' })]);
    expect(setUpAnswerAfterRefusal('u1', 'org')).toBe('clear');
    noteKeptRefusal('u1', 'org');
    expect(setUpAnswerAfterRefusal('u1', 'org')).toBe('unknown');
  });

  it('per workspace: a refusal in one workspace sets no mark in another', () => {
    noteKeptRefusal('u1', 'org-a');
    readMemberships([
      row('org-a', { mfa_policy: 'optional' }),
      row('org-b', { mfa_policy: 'optional' }),
    ]);
    expect(setUpAnswerAfterRefusal('u1', 'org-a')).toBe('clear');
    expect(setUpAnswerAfterRefusal('u1', 'org-b')).toBe('unknown');
  });
});

describe('reads asked for', () => {
  it('a kept refusal asks for a read at once; one at a time', async () => {
    let release!: () => void;
    const read = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await registerSetUpInputsSource({ storage: memoryStorage(), read });
    noteKeptRefusal('u1', 'org');
    noteKeptRefusal('u1', 'org');
    expect(read).toHaveBeenCalledTimes(1);
    release();
    await setUpInputsReadInFlight();
    noteKeptRefusal('u1', 'org');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a held row asks at most once per interval', async () => {
    const read = vi.fn(async () => undefined);
    await registerSetUpInputsSource({ storage: memoryStorage(), read });
    requestSetUpInputsRead(1_000);
    await setUpInputsReadInFlight();
    requestSetUpInputsRead(1_000 + SET_UP_READ_MIN_INTERVAL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    requestSetUpInputsRead(1_000 + SET_UP_READ_MIN_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('a read that fails asks nothing of the caller and lets the next one run', async () => {
    const read = vi.fn(async () => {
      throw new Error('offline');
    });
    await registerSetUpInputsSource({ storage: memoryStorage(), read });
    expect(() => noteKeptRefusal('u1', 'org')).not.toThrow();
    await setUpInputsReadInFlight();
    expect(setUpInputsReadInFlight()).toBeNull();
  });

  it('with no reader registered nothing is asked and nothing throws', () => {
    expect(() => noteKeptRefusal('u1', 'org')).not.toThrow();
    expect(() => requestSetUpInputsRead()).not.toThrow();
    expect(setUpInputsReadInFlight()).toBeNull();
  });
});

describe('saved inputs', () => {
  it('saves the inputs per account and workspace, never the answer', async () => {
    const storage = memoryStorage();
    await registerSetUpInputsSource({ storage, read: async () => undefined });
    readMemberships([
      row('org', { name: 'Org', mfa_policy: 'all_required' }),
      row('hid', null, 'admin'),
    ]);
    noteServerReadUser({ id: 'u1', factors: [] });
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalled());
    const saved = JSON.parse(storage.items.get(SET_UP_INPUTS_STORAGE_KEY) ?? 'null');
    expect(saved).toEqual({
      v: 1,
      accounts: {
        u1: {
          org: { policy: 'all_required', role: 'staff', name: 'Org' },
          hid: { policy: 'hidden', role: 'admin', name: null },
        },
      },
    });
    expect(JSON.stringify(saved)).not.toMatch(/owed|clear|verified|factor/);
  });

  it('the key is account-scoped: a sign-out and an eviction remove it', () => {
    expect(SET_UP_INPUTS_STORAGE_KEY.startsWith('workspace.')).toBe(true);
  });

  it('an earlier run’s saved inputs answer until this run reads, and never override a read', async () => {
    const storage = memoryStorage({
      [SET_UP_INPUTS_STORAGE_KEY]: JSON.stringify({
        v: 1,
        accounts: { u1: { org: { policy: 'all_required', role: 'staff', name: 'Org' } } },
      }),
    });
    await registerSetUpInputsSource({ storage, read: async () => undefined });
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpOwedIn('u1', 'org')).toBe('owed');
    // Saved, not read this run: a workspace missing from it is not known.
    expect(setUpOwedIn('u1', 'other')).toBe('unknown');
    // Never "after a refusal".
    noteKeptRefusal('u1', 'org');
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpAnswerAfterRefusal('u1', 'org')).toBe('unknown');

    readMemberships([row('org', { mfa_policy: 'optional' })]);
    expect(setUpOwedIn('u1', 'org')).toBe('clear');
  });

  it('a read this run is not replaced by a load that finishes after it', async () => {
    let answerLoad!: (v: string) => void;
    const storage = {
      getItem: vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            answerLoad = resolve;
          }),
      ),
      setItem: vi.fn(async () => {}),
    };
    const loaded = registerSetUpInputsSource({ storage, read: async () => undefined });
    readMemberships([row('org', { mfa_policy: 'optional' })]);
    answerLoad(
      JSON.stringify({
        v: 1,
        accounts: { u1: { org: { policy: 'all_required', role: 'staff', name: null } } },
      }),
    );
    await loaded;
    expect(setUpOwedIn('u1', 'org')).toBe('clear');
  });

  it('a storage that fails is read as nothing saved and never throws', async () => {
    const storage = {
      getItem: vi.fn(async () => {
        throw new Error('disk');
      }),
      setItem: vi.fn(async () => {
        throw new Error('disk');
      }),
    };
    await expect(
      registerSetUpInputsSource({ storage, read: async () => undefined }),
    ).resolves.toBeUndefined();
    expect(() => readMemberships([row('org', { mfa_policy: 'optional' })])).not.toThrow();
  });

  it.each([
    ['nothing', null],
    ['not JSON', '{'],
    ['another version', JSON.stringify({ v: 2, accounts: {} })],
    ['no accounts', JSON.stringify({ v: 1 })],
  ])('parse: %s is nothing saved', (_name, raw) => {
    expect(parseSavedSetUpInputs(raw).size).toBe(0);
  });

  it('parse: drops a workspace with an unknown policy or no role, keeps the rest', () => {
    const parsed = parseSavedSetUpInputs(
      JSON.stringify({
        v: 1,
        accounts: {
          u1: {
            good: { policy: 'admins_required', role: 'admin', name: 'G' },
            badPolicy: { policy: 'sometimes', role: 'staff' },
            noRole: { policy: 'optional' },
          },
        },
      }),
    );
    expect(parsed.get('u1')).toEqual({
      good: { policy: 'admins_required', role: 'admin', name: 'G' },
    });
  });
});
