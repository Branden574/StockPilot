import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { accountScopedStorageKeys } from '../account-eviction';
import { FakeStorage } from './__fixtures__/fake-storage';
import {
  PHONE_APPEARANCE_KEYS,
  readDeviceRecord,
  readStoredAppearance,
  readSyncRecord,
  writeDeviceRecord,
  writeSyncRecord,
} from './store';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
}));

/**
 * Where the phone keeps the appearance (plan 3.3), and what it never touches.
 */
describe('appearance storage keys', () => {
  it('the device record is device-level: it survives sign-out like the theme always did', () => {
    expect(PHONE_APPEARANCE_KEYS.device).toBe('stockpilot.appearance.v1');
    expect(PHONE_APPEARANCE_KEYS.device.startsWith('workspace.')).toBe(false);
    expect(accountScopedStorageKeys([PHONE_APPEARANCE_KEYS.device])).toEqual([]);
  });

  it('the account sync record is account-scoped: sign-out erases it with every workspace. key', () => {
    expect(PHONE_APPEARANCE_KEYS.sync).toBe('workspace.appearance-sync');
    expect(accountScopedStorageKeys([PHONE_APPEARANCE_KEYS.sync])).toEqual([
      PHONE_APPEARANCE_KEYS.sync,
    ]);
  });

  it('the crash-fallback flag is device-level', () => {
    expect(PHONE_APPEARANCE_KEYS.fallback).toBe('stockpilot.appearance.fallback');
    expect(accountScopedStorageKeys([PHONE_APPEARANCE_KEYS.fallback])).toEqual([]);
  });

  it('the appearance modules never reach the offline outbox, the cache or another key', () => {
    const dir = path.resolve(__dirname);
    for (const file of [
      'store.ts',
      'controller.ts',
      'recovery.ts',
      'account.ts',
      'provider.tsx',
      'session-bridge.tsx',
      'singleton.ts',
    ]) {
      // Code only: the doc comments name the outbox to say it is never touched.
      const code = readFileSync(path.join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const banned of [
        'expo-sqlite',
        "'../db'",
        "'../queue'",
        "'../adjust-outbox'",
        "'../outbox-scope'",
        'pending_actions',
        'workspace.',
        'deleteOrgData',
        'wipeForSignOut',
      ]) {
        expect(code, `${file} ${banned}`).not.toContain(banned);
      }
      // Only store.ts talks to AsyncStorage at all.
      if (file !== 'store.ts') expect(code, file).not.toContain('@react-native-async-storage');
    }
  });
});

describe('reading and writing the records', () => {
  it('reads all three keys, and only those', async () => {
    const storage = new FakeStorage({
      [PHONE_APPEARANCE_KEYS.device]: '{"v":1,"mode":"dark","lastClassic":"dark"}',
      'workspace.orderDraft.v1.u1.o1.w1': '{"lines":[]}',
    });
    const stored = await readStoredAppearance(storage);
    expect(stored).toEqual({
      device: '{"v":1,"mode":"dark","lastClassic":"dark"}',
      sync: null,
      fallback: false,
    });
    expect([...storage.touched].sort()).toEqual(
      [
        PHONE_APPEARANCE_KEYS.device,
        PHONE_APPEARANCE_KEYS.fallback,
        PHONE_APPEARANCE_KEYS.sync,
      ].sort(),
    );
  });

  it('a storage that refuses to read reads as nothing stored (System), never a throw', async () => {
    const storage = new FakeStorage();
    storage.failReads = true;
    await expect(readStoredAppearance(storage)).resolves.toEqual({
      device: null,
      sync: null,
      fallback: false,
    });
  });

  it('round-trips the device record, and drops a malformed one', async () => {
    const storage = new FakeStorage();
    await writeDeviceRecord(storage, {
      v: 1,
      mode: 'liquid-glass',
      lastClassic: 'dark',
      anonAt: 5,
    });
    expect(await readDeviceRecord(storage)).toEqual({
      v: 1,
      mode: 'liquid-glass',
      lastClassic: 'dark',
      anonAt: 5,
    });
    storage.data.set(PHONE_APPEARANCE_KEYS.device, '{"v":1,"mode":"Liquid Glass"}');
    expect(await readDeviceRecord(storage)).toBeNull();
  });

  it('writes the sync record, and removes it for null (sign-out, another person)', async () => {
    const storage = new FakeStorage();
    await writeSyncRecord(storage, { v: 1, userId: 'u1', dirty: true, syncedAt: null });
    expect(await readSyncRecord(storage)).toEqual({
      v: 1,
      userId: 'u1',
      dirty: true,
      syncedAt: null,
    });
    await writeSyncRecord(storage, null);
    expect(storage.data.has(PHONE_APPEARANCE_KEYS.sync)).toBe(false);
  });
});
