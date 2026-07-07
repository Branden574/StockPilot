import { beforeEach, describe, expect, it, vi } from 'vitest';

// expo-secure-store is a native module — mocked wholesale (vitest runs in
// node). The store keeps an in-memory session cache, so tests that need a
// "fresh app launch" re-import the module via vi.resetModules(), same pattern
// as scanner-tip-flag.test.ts. vi.hoisted keeps stable fn handles across
// resets.
const store = vi.hoisted(() => ({
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(),
  setItemAsync: vi.fn<(key: string, value: string) => Promise<void>>(),
  deleteItemAsync: vi.fn<(key: string) => Promise<void>>(),
}));

vi.mock('expo-secure-store', () => store);

const USER = 'a4f0c9c2-1234-4f0e-9a2b-abcdef012345';

/** expo-secure-store's ensureValidKey charset — an invalid key THROWS. */
const SECURE_STORE_VALID_KEY = /^[A-Za-z0-9._-]+$/;

/** Import a fresh copy of the module — simulates a new app session. */
async function freshSession() {
  vi.resetModules();
  return import('./tab-config-store');
}

beforeEach(() => {
  store.getItemAsync.mockReset().mockResolvedValue(null);
  store.setItemAsync.mockReset().mockResolvedValue(undefined);
  store.deleteItemAsync.mockReset().mockResolvedValue(undefined);
});

describe('storageKeyForUser', () => {
  it('is per-user, versioned, and valid for expo-secure-store (":" is rejected by ensureValidKey, so "." joins instead)', async () => {
    const mod = await freshSession();
    const key = mod.storageKeyForUser(USER);
    expect(key).toBe(`tab-config-v1.${USER}`);
    expect(key).toMatch(SECURE_STORE_VALID_KEY);
  });

  it('maps any invalid character in the user id to "_" so a write can never throw on the key', async () => {
    const mod = await freshSession();
    expect(mod.storageKeyForUser('weird:user/id!')).toBe('tab-config-v1.weird_user_id_');
    expect(mod.storageKeyForUser('weird:user/id!')).toMatch(SECURE_STORE_VALID_KEY);
  });
});

describe('readStoredTabSlots', () => {
  it('returns null on a fresh install (no stored value) → caller renders the default bar', async () => {
    const mod = await freshSession();
    await expect(mod.readStoredTabSlots(USER)).resolves.toBeNull();
    expect(store.getItemAsync).toHaveBeenCalledWith(`tab-config-v1.${USER}`);
  });

  it('returns the sanitized stored list', async () => {
    store.getItemAsync.mockResolvedValue(
      JSON.stringify(['scan', 'inventory', 'orders-tab']),
    );
    const mod = await freshSession();
    await expect(mod.readStoredTabSlots(USER)).resolves.toEqual([
      'scan',
      'inventory',
      'orders-tab',
    ]);
  });

  it('drops unknown/stale ids on read and heals a below-minimum survivor to null (defaults)', async () => {
    store.getItemAsync.mockResolvedValue(
      JSON.stringify(['scan', 'tab-that-no-longer-exists']),
    );
    const mod = await freshSession();
    await expect(mod.readStoredTabSlots(USER)).resolves.toBeNull();
  });

  it('treats corrupt JSON as absent — never rejects', async () => {
    store.getItemAsync.mockResolvedValue('{not json');
    const mod = await freshSession();
    await expect(mod.readStoredTabSlots(USER)).resolves.toBeNull();
  });

  it('treats a keystore read failure as absent — never rejects, never blocks the bar', async () => {
    store.getItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    const mod = await freshSession();
    await expect(mod.readStoredTabSlots(USER)).resolves.toBeNull();
  });

  it('caches per session: the keystore is read once per user', async () => {
    store.getItemAsync.mockResolvedValue(JSON.stringify(['scan', 'inventory']));
    const mod = await freshSession();
    await mod.readStoredTabSlots(USER);
    await mod.readStoredTabSlots(USER);
    expect(store.getItemAsync).toHaveBeenCalledTimes(1);
  });
});

describe('saveTabSlots', () => {
  it('persists JSON under the versioned per-user key', async () => {
    const mod = await freshSession();
    await mod.saveTabSlots(USER, ['scan', 'inventory', 'reports-tab']);
    expect(store.setItemAsync).toHaveBeenCalledWith(
      `tab-config-v1.${USER}`,
      JSON.stringify(['scan', 'inventory', 'reports-tab']),
    );
  });

  it('never rejects when the write fails, and the session cache still serves the new value', async () => {
    store.setItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    const mod = await freshSession();
    await expect(
      mod.saveTabSlots(USER, ['scan', 'inventory']),
    ).resolves.toBeUndefined();
    // In-memory fallback: the bar keeps the customization for this session.
    await expect(mod.readStoredTabSlots(USER)).resolves.toEqual(['scan', 'inventory']);
    expect(mod.getCachedTabSlots(USER)).toEqual(['scan', 'inventory']);
    // …and the keystore was never consulted for it (cache answered).
    expect(store.getItemAsync).not.toHaveBeenCalled();
  });

  it('notifies subscribers synchronously so the live bar updates before any await', async () => {
    const mod = await freshSession();
    const seen: unknown[] = [];
    const unsubscribe = mod.subscribeTabConfig(() => {
      seen.push(mod.getCachedTabSlots(USER));
    });
    const pending = mod.saveTabSlots(USER, ['books', 'scan']);
    expect(seen).toEqual([['books', 'scan']]); // fired before the write settled
    await pending;
    unsubscribe();
  });
});

describe('resetTabSlots', () => {
  it('deletes the stored key and tombstones the cache — subsequent reads are default even if the delete raced', async () => {
    // Keystore still holds an old custom config…
    store.getItemAsync.mockResolvedValue(JSON.stringify(['scan', 'inventory']));
    const mod = await freshSession();
    await mod.resetTabSlots(USER);
    expect(store.deleteItemAsync).toHaveBeenCalledWith(`tab-config-v1.${USER}`);
    // …but the session sees the reset immediately (null tombstone wins).
    await expect(mod.readStoredTabSlots(USER)).resolves.toBeNull();
  });

  it('never rejects when the delete fails — the tombstone still wins for this session', async () => {
    store.deleteItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    const mod = await freshSession();
    await mod.saveTabSlots(USER, ['scan', 'inventory']);
    await expect(mod.resetTabSlots(USER)).resolves.toBeUndefined();
    await expect(mod.readStoredTabSlots(USER)).resolves.toBeNull();
  });

  it('notifies subscribers', async () => {
    const mod = await freshSession();
    const fn = vi.fn();
    mod.subscribeTabConfig(fn);
    await mod.resetTabSlots(USER);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never WRITES on reset — deleting means the raw default ids apply, so a module that happens to be gated off at reset time can never be baked into a stored snapshot', async () => {
    const mod = await freshSession();
    await mod.resetTabSlots(USER);
    expect(store.setItemAsync).not.toHaveBeenCalled();
    expect(store.deleteItemAsync).toHaveBeenCalledTimes(1);
  });
});

describe('getCachedTabSlots', () => {
  it('is undefined before any read (unknown), null for a signed-out user, and the list after a save', async () => {
    const mod = await freshSession();
    expect(mod.getCachedTabSlots(USER)).toBeUndefined();
    expect(mod.getCachedTabSlots(null)).toBeNull();
    await mod.saveTabSlots(USER, ['scan', 'books']);
    expect(mod.getCachedTabSlots(USER)).toEqual(['scan', 'books']);
  });
});
