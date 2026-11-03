import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountScopedStorageKeys } from './account-eviction';

/**
 * This install's id (S5, plans/S5.md 3.3 step 5): what the server tells one
 * phone from another for the new-device email.
 *
 * The server keyed a device on the user agent with its version numbers taken
 * out, and every iPhone's app agent reads 'StockPilot/# CFNetwork/# Darwin/#',
 * so all of a person's phones were one device. One random id per install, in
 * the Keychain (after first unlock), never cleared by a sign-out or an
 * eviction. When the Keychain refuses, there is no id: no AsyncStorage copy,
 * and the server falls back to the agent.
 *
 * expo-secure-store is a native module, mocked; a fresh module is a relaunch.
 */

const store = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getFails: false,
  setFails: false,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock-constant',
  getItemAsync: (...a: unknown[]) => store.getItemAsync(...a),
  setItemAsync: (...a: unknown[]) => store.setItemAsync(...a),
}));

const asyncStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }));

async function relaunch() {
  vi.resetModules();
  return import('./install-id');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  store.values.clear();
  store.getFails = false;
  store.setFails = false;
  store.getItemAsync.mockReset();
  store.getItemAsync.mockImplementation(async (key: string) => {
    if (store.getFails) throw new Error('keychain unavailable');
    return store.values.get(key) ?? null;
  });
  store.setItemAsync.mockReset();
  store.setItemAsync.mockImplementation(async (key: string, value: string) => {
    if (store.setFails) throw new Error('keychain unavailable');
    store.values.set(key, value);
  });
  asyncStorage.getItem.mockReset();
  asyncStorage.setItem.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('getInstallId', () => {
  it('is made once: a random uuid, kept in the Keychain after first unlock, and the same on every call', async () => {
    const mod = await relaunch();
    const first = await mod.getInstallId();
    expect(first).toMatch(UUID);
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
    expect(store.setItemAsync).toHaveBeenCalledWith(mod.INSTALL_ID_STORAGE_KEY, first, {
      keychainAccessible: 'after-first-unlock-constant',
    });
    expect(await mod.getInstallId()).toBe(first);
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('two calls at once make one id', async () => {
    const mod = await relaunch();
    const [a, b] = await Promise.all([mod.getInstallId(), mod.getInstallId()]);
    expect(a).toBe(b);
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('is stable across a sign-out and a relaunch: read back, never made again', async () => {
    const first = await (await relaunch()).getInstallId();
    // A sign-out removes the account's `workspace.` keys from AsyncStorage;
    // the id is not there at all.
    expect(accountScopedStorageKeys([(await relaunch()).INSTALL_ID_STORAGE_KEY])).toEqual([]);
    const again = await (await relaunch()).getInstallId();
    expect(again).toBe(first);
    expect(store.setItemAsync).toHaveBeenCalledTimes(1);
  });

  it('nothing that signs out or evicts touches it', () => {
    const lib = (f: string) => readFileSync(path.join(__dirname, f), 'utf8');
    for (const f of [
      'auth-context.tsx',
      'sign-out-flow.ts',
      'account-eviction.ts',
      'use-account-gate.ts',
      'push-unbind.ts',
    ]) {
      expect(lib(f), f).not.toMatch(/INSTALL_ID_STORAGE_KEY|sp_install_id/);
    }
  });

  it('a stored value that is not an id is replaced', async () => {
    const mod = await relaunch();
    store.values.set(mod.INSTALL_ID_STORAGE_KEY, 'not-an-id');
    const id = await mod.getInstallId();
    expect(id).toMatch(UUID);
    expect(store.values.get(mod.INSTALL_ID_STORAGE_KEY)).toBe(id);
  });

  it('the Keychain refuses to read: no id, and no fallback anywhere else', async () => {
    store.getFails = true;
    const mod = await relaunch();
    expect(await mod.getInstallId()).toBeNull();
    expect(store.setItemAsync).not.toHaveBeenCalled();
    expect(asyncStorage.getItem).not.toHaveBeenCalled();
    expect(asyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('the Keychain refuses to write: no id (an id not kept would differ at the next launch)', async () => {
    store.setFails = true;
    const mod = await relaunch();
    expect(await mod.getInstallId()).toBeNull();
    expect(asyncStorage.setItem).not.toHaveBeenCalled();
    // A later call tries again rather than keeping the refusal.
    store.setFails = false;
    expect(await mod.getInstallId()).toMatch(UUID);
  });
});
