import { beforeEach, describe, expect, it, vi } from 'vitest';

import { shouldRunEviction } from './account-eviction';

// expo-secure-store is a native module — mocked wholesale (vitest runs in
// node), same pattern as scanner-tip-flag.test.ts.
const store = vi.hoisted(() => ({
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(),
}));

vi.mock('expo-secure-store', () => store);

/** Import a fresh copy of the module — simulates a new app session. */
async function freshSession() {
  vi.resetModules();
  return import('./remembered-identity');
}

beforeEach(() => {
  store.getItemAsync.mockReset().mockResolvedValue(null);
  store.setItemAsync.mockReset().mockResolvedValue(undefined);
});

/**
 * WHOSE device is this — the device's own durable memory of who last held a
 * session here, and the honest way a sign-in's `user_banned` rejection earns
 * 'session' evidence instead of trusting whatever address a passer-by typed.
 *
 * GoTrue evaluates the ban BEFORE the password (account-eviction.ts), so a
 * failed sign-in can never hand back a resolved user — only the raw typed
 * address. That is the only value this module's matching predicate can ever
 * compare against, which is why the comparison is by email, always.
 */
describe('normalizeIdentityEmail', () => {
  it('trims and lowercases', async () => {
    const mod = await freshSession();
    expect(mod.normalizeIdentityEmail('  Owner@Example.COM  ')).toBe('owner@example.com');
  });
});

describe('matchesRememberedIdentity', () => {
  it('matches a re-cased, padded retype of the remembered email', async () => {
    const mod = await freshSession();
    const remembered = { userId: 'u1', email: 'owner@example.com' };
    expect(mod.matchesRememberedIdentity('  Owner@Example.com ', remembered)).toBe(true);
  });

  it('refuses a different email entirely — the passer-by case', async () => {
    const mod = await freshSession();
    const remembered = { userId: 'u1', email: 'owner@example.com' };
    expect(mod.matchesRememberedIdentity('stranger@example.com', remembered)).toBe(false);
  });

  it('refuses when nothing is remembered — a fresh device never matches', async () => {
    const mod = await freshSession();
    expect(mod.matchesRememberedIdentity('owner@example.com', null)).toBe(false);
  });

  it('refuses a remembered record that only carries a userId', async () => {
    // A rejected sign-in never returns a user object, so a stored userId with
    // no email has nothing this predicate can compare it against. Failing
    // closed here is correct: no false attribution, ever.
    const mod = await freshSession();
    expect(mod.matchesRememberedIdentity('owner@example.com', { userId: 'u1', email: null })).toBe(
      false,
    );
  });
});

describe('getRememberedIdentity', () => {
  it('is null on a fresh install', async () => {
    const mod = await freshSession();
    await expect(mod.getRememberedIdentity()).resolves.toBeNull();
  });

  it('reads back a previously stored identity', async () => {
    store.getItemAsync.mockResolvedValue(
      JSON.stringify({ userId: 'u1', email: 'owner@example.com' }),
    );
    const mod = await freshSession();
    await expect(mod.getRememberedIdentity()).resolves.toEqual({
      userId: 'u1',
      email: 'owner@example.com',
    });
  });

  it('treats a corrupt record as nothing remembered, never throws', async () => {
    store.getItemAsync.mockResolvedValue('{not json');
    const mod = await freshSession();
    await expect(mod.getRememberedIdentity()).resolves.toBeNull();
  });

  it('treats a storage read failure as nothing remembered — never rejects', async () => {
    store.getItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    const mod = await freshSession();
    await expect(mod.getRememberedIdentity()).resolves.toBeNull();
  });
});

describe('rememberIdentity', () => {
  it('persists both fields under the versioned key', async () => {
    const mod = await freshSession();
    await mod.rememberIdentity({ userId: 'u1', email: 'owner@example.com' });
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
    const [key, value] = store.setItemAsync.mock.calls[0] as [string, string];
    expect(key).toMatch(/identity/i);
    expect(JSON.parse(value)).toEqual({ userId: 'u1', email: 'owner@example.com' });
  });

  it('never rejects when the write fails — recording must not block sign-in/sign-out', async () => {
    store.setItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    const mod = await freshSession();
    await expect(
      mod.rememberIdentity({ userId: 'u1', email: 'owner@example.com' }),
    ).resolves.toBeUndefined();
  });

  it('writes nothing for an empty identity (no userId, no email)', async () => {
    const mod = await freshSession();
    await mod.rememberIdentity({ userId: null, email: null });
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });

  it('a later call overwrites the earlier one — one slot per device, not per user', async () => {
    const mod = await freshSession();
    await mod.rememberIdentity({ userId: 'u1', email: 'first@example.com' });
    await mod.rememberIdentity({ userId: 'u2', email: 'second@example.com' });
    expect(store.setItemAsync).toHaveBeenCalledTimes(2);
    const [, secondValue] = store.setItemAsync.mock.calls[1] as [string, string];
    expect(JSON.parse(secondValue)).toEqual({ userId: 'u2', email: 'second@example.com' });
  });
});

/**
 * THE CONTRACT auth-context.tsx's `user_banned` branch relies on: a match
 * earns 'session' evidence, which the eviction precondition allows; anything
 * else earns 'sign-in', which it refuses. Chained here at the pure-logic
 * level — the same two functions the wiring pins in
 * account-disabled-wiring.test.ts check are actually called together.
 */
describe('the sign-in attribution contract', () => {
  it("the device's own owner (matching remembered email) earns eviction-eligible evidence", async () => {
    const mod = await freshSession();
    const remembered = { userId: 'u1', email: 'owner@example.com' };
    const how = mod.matchesRememberedIdentity('Owner@Example.com', remembered)
      ? 'session'
      : 'sign-in';
    expect(how).toBe('session');
    expect(shouldRunEviction({ state: 'disabled', evidence: how, alreadyEvicting: false })).toBe(
      true,
    );
  });

  it("a passer-by typing a colleague's address earns evidence the eviction refuses", async () => {
    const mod = await freshSession();
    const remembered = { userId: 'u1', email: 'owner@example.com' };
    const how = mod.matchesRememberedIdentity('owner@example.com', {
      userId: remembered.userId,
      email: 'someone-else@example.com',
    })
      ? 'session'
      : 'sign-in';
    expect(how).toBe('sign-in');
    expect(shouldRunEviction({ state: 'disabled', evidence: how, alreadyEvicting: false })).toBe(
      false,
    );
  });

  it('a device that has never held a session for this address cannot be attributed', async () => {
    const mod = await freshSession();
    const how = mod.matchesRememberedIdentity('owner@example.com', null) ? 'session' : 'sign-in';
    expect(how).toBe('sign-in');
    expect(shouldRunEviction({ state: 'disabled', evidence: how, alreadyEvicting: false })).toBe(
      false,
    );
  });
});
