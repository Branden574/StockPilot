import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  askForSetUpRead,
  askForSetUpReadOnRefusal,
  beginSetUpRead,
  forgetSetUpInputs,
  noteMembershipReadFailed,
  noteServerReadUser,
  noteSetUpReadOutcome,
  readSetUpInputsForHold,
  recordMembershipInputs,
  registerSetUpInputsSource,
  requestSetUpInputsRead,
  resetSetUpInputsForTests,
  SET_UP_ASK_MIN_INTERVAL_MS,
  setUpAnswerAfterRefusal,
  setUpInputsReadInFlight,
  setUpInputsView,
  setUpOwedIn,
  subscribeSetUpInputs,
  type MembershipRowForSetUp,
} from './set-up-inputs';
import {
  createHoldPushUnbinder,
  decideSetUpHold,
  noteHoldWorkspace,
  noteSavedHoldWorkspace,
  resetSetUpHoldForTests,
  setUpHoldDetails,
  setUpHoldFor,
  setUpHoldQueuedLine,
  subscribeSetUpHold,
} from './set-up-hold';

/**
 * The holding screen's decision (set-up-hold.ts) over the set-up inputs store
 * (set-up-inputs.ts): every row of the states table, the policy turned on and
 * off, a workspace switch, two accounts on one phone, and the store's reads
 * for the screen, which leave the queue's own reads as they are.
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

const org = (mfa_policy: string, name = 'North Depot') => ({ name, mfa_policy });

function readMemberships(rows: MembershipRowForSetUp[], userId = 'u1'): void {
  recordMembershipInputs(userId, rows, beginSetUpRead());
}

/** The stored session's user, as auth-context holds it. */
const sessionUser = (id = 'u1', factors: { status: string }[] = []) => ({ id, factors });

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getAllKeys: vi.fn(async () => [...items.keys()]),
    getItem: vi.fn(async (k: string) => items.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => {
      items.set(k, v);
    }),
  };
}

const saved = (orgs: Record<string, { policy: string; role: string; name: string | null }>) =>
  JSON.stringify({ v: 1, orgs });

/** An earlier run saved these inputs for u1; this run has read nothing yet. */
async function savedByEarlierRun(orgs: Parameters<typeof saved>[0], userId = 'u1') {
  await registerSetUpInputsSource({
    storage: memoryStorage({ [`workspace.setUpInputs.${userId}`]: saved(orgs) }),
    read: async () => undefined,
  });
}

beforeEach(() => {
  resetSetUpInputsForTests();
  resetSetUpHoldForTests();
});
afterEach(() => {
  resetSetUpInputsForTests();
  resetSetUpHoldForTests();
});

describe('the states table', () => {
  beforeEach(() => noteHoldWorkspace('u1', 'org-a'));

  it('read answered: a policy that requires the role and no verified factor holds', () => {
    readMemberships([row('org-a', org('all_required'))]);
    noteServerReadUser({ id: 'u1', factors: [] });
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'answered');
    expect(setUpHoldFor(sessionUser())).toBe('owed');
  });

  it.each([
    ['optional', 'staff', [], null],
    ['admins_required', 'staff', [], null],
    ['admins_required', 'admin', [], 'owed'],
    ['admins_required', 'owner', [], 'owed'],
    ['all_required', 'staff', [{ status: 'verified' }], null],
    ['all_required', 'staff', [{ status: 'unverified' }], 'owed'],
  ] as const)('read answered: %s, %s, factors %j -> %s', (policy, role, factors, expected) => {
    readMemberships([row('org-a', org(policy), role)]);
    noteServerReadUser({ id: 'u1', factors: [...factors] });
    expect(setUpHoldFor(sessionUser())).toBe(expected);
  });

  it('read answered: the embed as an object and as an array of one decide the same', () => {
    readMemberships([row('org-a', [org('all_required')])]);
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpHoldFor(sessionUser())).toBe('owed');
    readMemberships([row('org-a', org('optional'))]);
    expect(setUpHoldFor(sessionUser())).toBeNull();
  });

  it('read answered, organization row hidden: the could-not-check hold, never the organization sentence', () => {
    readMemberships([row('org-a', null)]);
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpHoldFor(sessionUser())).toBe('unknown');
    const details = setUpHoldDetails(sessionUser());
    expect(details.hold).toBe('unknown');
    expect(details.name).toBeNull();
    expect(details.policy).toBeNull();
  });

  it('read answered, organization row hidden, with a verified factor: the app', () => {
    readMemberships([row('org-a', null)]);
    noteServerReadUser({ id: 'u1', factors: [{ status: 'verified' }] });
    expect(setUpHoldFor(sessionUser())).toBeNull();
  });

  it('read answered: a workspace missing from the read holds nothing (the workspace load chooses again)', () => {
    readMemberships([row('org-b', org('all_required'))]);
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpHoldFor(sessionUser())).toBeNull();
  });

  it('saved owed, no connection: holds offline, from the stored session factor list', async () => {
    await savedByEarlierRun({
      'org-a': { policy: 'all_required', role: 'staff', name: 'North Depot' },
    });
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'no-answer');
    expect(setUpHoldFor(sessionUser('u1', []))).toBe('owed');
    // The session copy lists a verified factor: the app.
    expect(setUpHoldFor(sessionUser('u1', [{ status: 'verified' }]))).toBeNull();
  });

  it('saved clear, no connection: the app', async () => {
    await savedByEarlierRun({
      'org-a': { policy: 'optional', role: 'staff', name: 'North Depot' },
    });
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'no-answer');
    expect(setUpHoldFor(sessionUser())).toBeNull();
  });

  it('nothing saved, no connection (or no HTTP answer): the app as today', () => {
    expect(setUpHoldFor(sessionUser())).toBeNull();
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'no-answer');
    expect(setUpHoldFor(sessionUser())).toBeNull();
  });

  it('nothing saved, the read failed with an answer: the could-not-check hold', () => {
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'failed');
    expect(setUpHoldFor(sessionUser())).toBe('unknown');
  });

  it('nothing saved, a membership read that failed with an HTTP answer, or with none', () => {
    noteMembershipReadFailed('u1', beginSetUpRead(), false);
    expect(setUpHoldFor(sessionUser())).toBeNull();
    noteMembershipReadFailed('u1', beginSetUpRead(), true);
    expect(setUpHoldFor(sessionUser())).toBe('unknown');
  });

  it('nothing saved, read in flight: the app until it answers, then as it says', async () => {
    let finish: () => void = () => undefined;
    await registerSetUpInputsSource({
      storage: memoryStorage(),
      read: () =>
        new Promise<void>((resolve) => {
          finish = () => {
            readMemberships([row('org-a', org('all_required'))]);
            noteServerReadUser({ id: 'u1', factors: [] }, 1);
            resolve();
          };
        }),
    });
    const read = readSetUpInputsForHold('u1');
    expect(setUpInputsReadInFlight()).not.toBeNull();
    expect(setUpHoldFor(sessionUser())).toBeNull();
    finish();
    await read;
    expect(setUpHoldFor(sessionUser())).toBe('owed');
  });

  it('a saved hidden row: could-not-check only after a failed read with an answer, the app offline', async () => {
    await savedByEarlierRun({ 'org-a': { policy: 'hidden', role: 'staff', name: null } });
    expect(setUpHoldFor(sessionUser())).toBeNull();
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'no-answer');
    expect(setUpHoldFor(sessionUser())).toBeNull();
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'failed');
    expect(setUpHoldFor(sessionUser())).toBe('unknown');
  });

  it("the server's list read this run decides over the stored session's copy, both ways", () => {
    readMemberships([row('org-a', org('all_required'))]);
    noteServerReadUser({ id: 'u1', factors: [{ status: 'verified' }] });
    expect(setUpHoldFor(sessionUser('u1', []))).toBeNull();
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpHoldFor(sessionUser('u1', [{ status: 'verified' }]))).toBe('owed');
  });

  it('a fresh read stands over a later read that failed', () => {
    readMemberships([row('org-a', org('all_required'))]);
    noteServerReadUser({ id: 'u1', factors: [] });
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'failed');
    expect(setUpHoldFor(sessionUser())).toBe('owed');
  });

  it('no session, or no workspace known: nothing held', () => {
    readMemberships([row('org-a', org('all_required'))]);
    noteServerReadUser({ id: 'u1', factors: [] });
    expect(setUpHoldFor(null)).toBeNull();
    noteHoldWorkspace('u1', null);
    expect(setUpHoldFor(sessionUser())).toBeNull();
  });
});

describe('decideSetUpHold, the rule alone', () => {
  const base = {
    inputs: { policy: 'all_required' as const, role: 'staff', name: 'North Depot' },
    membershipsFrom: 'this-run' as const,
    hasVerified: false,
    lastRead: 'answered' as const,
  };
  it('each source of memberships', () => {
    expect(decideSetUpHold(base)).toBe('owed');
    expect(decideSetUpHold({ ...base, membershipsFrom: 'saved', lastRead: null })).toBe('owed');
    expect(decideSetUpHold({ ...base, inputs: null })).toBeNull();
    expect(
      decideSetUpHold({ ...base, inputs: null, membershipsFrom: null, lastRead: 'failed' }),
    ).toBe('unknown');
    expect(
      decideSetUpHold({ ...base, inputs: null, membershipsFrom: 'saved', lastRead: 'failed' }),
    ).toBe('unknown');
    expect(
      decideSetUpHold({ ...base, inputs: null, membershipsFrom: null, lastRead: null }),
    ).toBeNull();
  });
});

describe('the policy turned on and off, a switch, two accounts', () => {
  it('turned on: the next read holds; turned off: the next read releases', () => {
    noteHoldWorkspace('u1', 'org-a');
    noteServerReadUser({ id: 'u1', factors: [] });
    readMemberships([row('org-a', org('optional'))]);
    expect(setUpHoldFor(sessionUser())).toBeNull();
    readMemberships([row('org-a', org('all_required'))]);
    expect(setUpHoldFor(sessionUser())).toBe('owed');
    readMemberships([row('org-a', org('optional'))]);
    expect(setUpHoldFor(sessionUser())).toBeNull();
  });

  it('a switch to a workspace that does not require one releases; back again holds', () => {
    noteServerReadUser({ id: 'u1', factors: [] });
    readMemberships([row('org-a', org('all_required')), row('org-b', org('optional', 'South'))]);
    noteHoldWorkspace('u1', 'org-a');
    expect(setUpHoldFor(sessionUser())).toBe('owed');
    noteHoldWorkspace('u1', 'org-b');
    expect(setUpHoldFor(sessionUser())).toBeNull();
    noteHoldWorkspace('u1', 'org-a');
    expect(setUpHoldDetails(sessionUser())).toEqual({
      hold: 'owed',
      orgId: 'org-a',
      name: 'North Depot',
      policy: 'all_required',
    });
  });

  it('with no workspace shown, the saved workspace of THIS account is the one held', () => {
    noteServerReadUser({ id: 'u1', factors: [] });
    readMemberships([row('org-a', org('all_required'))]);
    noteSavedHoldWorkspace({ orgId: 'org-a', ownerId: 'u2' });
    expect(setUpHoldFor(sessionUser())).toBeNull();
    noteSavedHoldWorkspace({ orgId: 'org-a', ownerId: 'u1' });
    expect(setUpHoldFor(sessionUser())).toBe('owed');
    // A workspace shown for this account wins over the saved one.
    readMemberships([row('org-a', org('all_required')), row('org-b', org('optional'))]);
    noteHoldWorkspace('u1', 'org-b');
    expect(setUpHoldFor(sessionUser())).toBeNull();
  });

  it("two accounts on one phone: one account's inputs, workspace and outcome never answer for the other", () => {
    noteServerReadUser({ id: 'u1', factors: [] });
    readMemberships([row('org-a', org('all_required'))], 'u1');
    noteHoldWorkspace('u1', 'org-a');
    expect(setUpHoldFor(sessionUser('u1'))).toBe('owed');
    // u2 signs in on the same phone: nothing of u1 holds u2.
    expect(setUpHoldFor(sessionUser('u2'))).toBeNull();
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'failed');
    noteHoldWorkspace('u2', 'org-a');
    expect(setUpHoldFor(sessionUser('u2'))).toBeNull();
    readMemberships([row('org-a', org('all_required'), 'staff')], 'u2');
    noteServerReadUser({ id: 'u2', factors: [{ status: 'verified' }] });
    expect(setUpHoldFor(sessionUser('u2'))).toBeNull();
  });

  it('a sign-out forgets the outcome and the saved workspace with the inputs', async () => {
    noteSavedHoldWorkspace({ orgId: 'org-a', ownerId: null });
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'failed');
    expect(setUpHoldFor(sessionUser())).toBe('unknown');
    await forgetSetUpInputs();
    expect(setUpHoldFor(sessionUser())).toBeNull();
    expect(setUpInputsView('u1', 'org-a').lastRead).toBeNull();
  });
});

describe('listeners', () => {
  it('each change of inputs, outcome or workspace tells the hold subscribers', async () => {
    const heard = vi.fn();
    const stop = subscribeSetUpHold(heard);
    readMemberships([row('org-a', org('all_required'))]);
    noteServerReadUser({ id: 'u1', factors: [] });
    noteSetUpReadOutcome('u1', beginSetUpRead(), 'failed');
    noteHoldWorkspace('u1', 'org-a');
    noteSavedHoldWorkspace({ orgId: 'org-a', ownerId: 'u1' });
    await forgetSetUpInputs();
    expect(heard).toHaveBeenCalledTimes(6);
    stop();
    noteHoldWorkspace('u1', 'org-b');
    expect(heard).toHaveBeenCalledTimes(6);
  });

  it('the end of loading saved inputs tells them too', async () => {
    const heard = vi.fn();
    subscribeSetUpInputs(heard);
    await registerSetUpInputsSource({
      storage: memoryStorage({ 'workspace.setUpInputs.u1': saved({}) }),
      read: async () => undefined,
    });
    expect(heard).toHaveBeenCalled();
  });

  it('a listener that throws does not stop the others or the store', () => {
    const later = vi.fn();
    subscribeSetUpInputs(() => {
      throw new Error('boom');
    });
    subscribeSetUpInputs(later);
    expect(() => readMemberships([row('org-a', org('optional'))])).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe("the screen's reads", () => {
  it('awaited and not throttled: each call reads, and the reader is told whose read it is', async () => {
    const read = vi.fn(async (_forUserId?: string | null) => undefined);
    await registerSetUpInputsSource({ storage: memoryStorage(), read });
    await readSetUpInputsForHold('u1');
    await readSetUpInputsForHold('u1');
    await readSetUpInputsForHold('u1');
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.every((c) => c[0] === 'u1')).toBe(true);
  });

  it('one already in flight: one more read after it, shared by every caller meanwhile', async () => {
    const ends: (() => void)[] = [];
    const read = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          ends.push(resolve);
        }),
    );
    await registerSetUpInputsSource({ storage: memoryStorage(), read });
    requestSetUpInputsRead(0); // the queue's own read, in flight
    expect(read).toHaveBeenCalledTimes(1);
    const a = readSetUpInputsForHold('u1');
    const b = readSetUpInputsForHold('u1');
    expect(read).toHaveBeenCalledTimes(1);
    ends[0]!();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    let settled = false;
    void Promise.all([a, b]).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    ends[1]!();
    await Promise.all([a, b]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("the screen's read writes into the store the queue asks, so a held row is released by it", async () => {
    await registerSetUpInputsSource({
      storage: memoryStorage(),
      read: async () => {
        const n = beginSetUpRead();
        noteServerReadUser({ id: 'u1', factors: [{ status: 'verified' }] }, n);
        recordMembershipInputs('u1', [row('org-a', org('all_required'))], beginSetUpRead());
      },
    });
    noteServerReadUser({ id: 'u1', factors: [] });
    readMemberships([row('org-a', org('all_required'))]);
    expect(setUpOwedIn('u1', 'org-a')).toBe('owed');
    await readSetUpInputsForHold('u1');
    expect(setUpOwedIn('u1', 'org-a')).toBe('clear');
  });

  it("the stored session's copy never reaches the queue's answers", () => {
    noteHoldWorkspace('u1', 'org-a');
    readMemberships([row('org-a', org('all_required'))]);
    // No server list this run: the screen decides by the session's copy...
    expect(setUpHoldFor(sessionUser('u1', [{ status: 'verified' }]))).toBeNull();
    expect(setUpHoldFor(sessionUser('u1', []))).toBe('owed');
    // ...and the queue still knows nothing of the factors.
    expect(setUpOwedIn('u1', 'org-a')).toBe('unknown');
    expect(setUpInputsView('u1', 'org-a').serverHasVerified).toBeNull();
  });

  it("leaves the queue's 30 s interval and marks as they were", async () => {
    const read = vi.fn(async () => undefined);
    await registerSetUpInputsSource({ storage: memoryStorage(), read });
    await readSetUpInputsForHold('u1');
    // The queue's first ask after a screen read still starts a read...
    requestSetUpInputsRead(1_000);
    expect(read).toHaveBeenCalledTimes(2);
    await setUpInputsReadInFlight();
    // ...and its own interval still holds the next.
    requestSetUpInputsRead(2_000);
    expect(read).toHaveBeenCalledTimes(2);
    // A screen read sets no refusal mark.
    expect(setUpAnswerAfterRefusal('u1', 'org-a', 'k1')).toBe('unknown');
  });

  it('with no reader registered: resolves at once, nothing thrown', async () => {
    await expect(readSetUpInputsForHold('u1')).resolves.toBeUndefined();
    expect(() => askForSetUpRead()).not.toThrow();
  });

  it('a reader that throws or rejects: the read resolves, the next one runs', async () => {
    const read = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => {
        throw new Error('boom');
      })
      .mockRejectedValueOnce(new Error('no'))
      .mockResolvedValue(undefined);
    await registerSetUpInputsSource({ storage: memoryStorage(), read });
    await expect(readSetUpInputsForHold('u1')).resolves.toBeUndefined();
    await expect(readSetUpInputsForHold('u1')).resolves.toBeUndefined();
    await readSetUpInputsForHold('u1');
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('asking for a read after an authenticator answer', () => {
  it('a 403 whose details.reason is mfa_required asks; nothing else does', async () => {
    const read = vi.fn(async () => undefined);
    await registerSetUpInputsSource({ storage: memoryStorage(), read });
    askForSetUpReadOnRefusal(403, { reason: 'aal2_required' }, 0);
    askForSetUpReadOnRefusal(403, null, 0);
    askForSetUpReadOnRefusal(401, { reason: 'mfa_required' }, 0);
    askForSetUpReadOnRefusal(409, { reason: 'mfa_required' }, 0);
    askForSetUpReadOnRefusal(403, 'mfa_required', 0);
    expect(read).not.toHaveBeenCalled();
    askForSetUpReadOnRefusal(403, { reason: 'mfa_required' }, 0);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('never raises the hold by itself: only what the read finds does', async () => {
    noteHoldWorkspace('u1', 'org-a');
    noteServerReadUser({ id: 'u1', factors: [] });
    readMemberships([row('org-a', org('optional'))]);
    await registerSetUpInputsSource({ storage: memoryStorage(), read: async () => undefined });
    askForSetUpReadOnRefusal(403, { reason: 'mfa_required' }, 0);
    await setUpInputsReadInFlight();
    expect(setUpHoldFor(sessionUser())).toBeNull();
  });

  it('at most one per interval, and none while a read is in flight', async () => {
    let end: () => void = () => undefined;
    const read = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          end = resolve;
        }),
    );
    await registerSetUpInputsSource({ storage: memoryStorage(), read });
    askForSetUpRead(0);
    askForSetUpRead(1);
    expect(read).toHaveBeenCalledTimes(1);
    end();
    await setUpInputsReadInFlight();
    askForSetUpRead(SET_UP_ASK_MIN_INTERVAL_MS - 1);
    expect(read).toHaveBeenCalledTimes(1);
    askForSetUpRead(SET_UP_ASK_MIN_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("an ask leaves the queue's 30 s interval as it was", async () => {
    const read = vi.fn(async () => undefined);
    await registerSetUpInputsSource({ storage: memoryStorage(), read });
    askForSetUpRead(0);
    await setUpInputsReadInFlight();
    requestSetUpInputsRead(1);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('outcomes by start number', () => {
  it('a slower read that started earlier does not replace a later outcome', () => {
    const first = beginSetUpRead();
    const second = beginSetUpRead();
    noteSetUpReadOutcome('u1', second, 'failed');
    noteSetUpReadOutcome('u1', first, 'no-answer');
    expect(setUpInputsView('u1', 'org-a').lastRead).toBe('failed');
  });

  it('a membership read that answers is an answered read', () => {
    readMemberships([row('org-a', org('optional'))]);
    expect(setUpInputsView('u1', 'org-a').lastRead).toBe('answered');
  });

  it('a read that started before a sign-out records nothing', async () => {
    const n = beginSetUpRead();
    await forgetSetUpInputs();
    noteSetUpReadOutcome('u1', n, 'failed');
    noteMembershipReadFailed('u1', n, true);
    expect(setUpInputsView('u1', 'org-a').lastRead).toBeNull();
  });
});

describe('push while held', () => {
  it('unbinds once when the hold turns on, again only after a release; nothing for no hold', () => {
    const unbind = vi.fn();
    const push = createHoldPushUnbinder(unbind);
    push.update(null);
    expect(unbind).not.toHaveBeenCalled();
    push.update('u1');
    push.update('u1');
    push.update('u1');
    expect(unbind).toHaveBeenCalledTimes(1);
    push.update(null); // released: the push hook registers again (dataUser)
    push.update('u1');
    expect(unbind).toHaveBeenCalledTimes(2);
    push.update('u2');
    expect(unbind).toHaveBeenCalledTimes(3);
  });

  it('an unbind that throws or rejects is swallowed', () => {
    const push = createHoldPushUnbinder(() => {
      throw new Error('boom');
    });
    expect(() => push.update('u1')).not.toThrow();
    const rejecting = createHoldPushUnbinder(() => Promise.reject(new Error('no')));
    expect(() => rejecting.update('u1')).not.toThrow();
  });
});

describe('the queued work line', () => {
  it('says how many changes wait and that they are kept', () => {
    expect(setUpHoldQueuedLine('owed', 0)).toBeNull();
    expect(setUpHoldQueuedLine('owed', 1)).toBe(
      '1 change has not synced. It stays on this phone and is sent after you set up your authenticator.',
    );
    expect(setUpHoldQueuedLine('owed', 3)).toBe(
      '3 changes have not synced. They stay on this phone and are sent after you set up your authenticator.',
    );
    expect(setUpHoldQueuedLine('unknown', 2)).toBe(
      '2 changes have not synced. They stay on this phone until they can be sent.',
    );
    for (const s of [setUpHoldQueuedLine('owed', 2), setUpHoldQueuedLine('unknown', 2)]) {
      expect(s).not.toMatch(/MFA|2FA|two-factor|multi-factor/i);
    }
  });
});
