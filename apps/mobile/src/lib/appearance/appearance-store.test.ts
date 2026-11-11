import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { accountScopedStorageKeys } from '../account-eviction';
import { FakeStorage } from './__fixtures__/fake-storage';
import {
  PHONE_APPEARANCE_KEYS,
  markIntroSeen,
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
 * Where the phone keeps the appearance (plan 3.3, revision R2 and item 29),
 * and what it never touches.
 */
const USER_A = '6f1c2a9e-1b2c-4d3e-8f40-0a1b2c3d4e5f';

describe('appearance storage keys', () => {
  it('the device record is device-level, under the v2 key: it survives sign-out like the theme always did', () => {
    expect(PHONE_APPEARANCE_KEYS.device).toBe('stockpilot.appearance.v2');
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

  it('the one-time "new look" card is device-level: closed once per phone (R13)', () => {
    expect(PHONE_APPEARANCE_KEYS.introSeen).toBe('stockpilot.appearance.intro.v1');
    expect(accountScopedStorageKeys([PHONE_APPEARANCE_KEYS.introSeen])).toEqual([]);
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
      'holds.ts',
      'adoption-holds.ts',
      'use-adoption-hold.ts',
      'device-class.ts',
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
  it('reads the four appearance keys, and only those', async () => {
    const storage = new FakeStorage({
      [PHONE_APPEARANCE_KEYS.device]: '{"v":2,"style":"classic","theme":"dark"}',
      [PHONE_APPEARANCE_KEYS.introSeen]: '1',
      'workspace.orderDraft.v1.u1.o1.w1': '{"lines":[]}',
    });
    const stored = await readStoredAppearance(storage);
    expect(stored).toEqual({
      device: '{"v":2,"style":"classic","theme":"dark"}',
      sync: null,
      fallback: false,
      introSeen: true,
    });
    expect([...storage.touched].sort()).toEqual(
      [
        PHONE_APPEARANCE_KEYS.device,
        PHONE_APPEARANCE_KEYS.fallback,
        PHONE_APPEARANCE_KEYS.introSeen,
        PHONE_APPEARANCE_KEYS.sync,
      ].sort(),
    );
  });

  it('never reads the stage 2 v1 key: its words meant something else (R2)', async () => {
    const storage = new FakeStorage({
      'stockpilot.appearance.v1': '{"v":1,"mode":"dark","lastClassic":"dark"}',
    });
    const stored = await readStoredAppearance(storage);
    expect(stored.device).toBeNull();
    expect(storage.touched.has('stockpilot.appearance.v1')).toBe(false);
  });

  it('a storage that refuses to read reads as nothing stored (the rollout default), never a throw', async () => {
    const storage = new FakeStorage();
    storage.failReads = true;
    await expect(readStoredAppearance(storage)).resolves.toEqual({
      device: null,
      sync: null,
      fallback: false,
      // A refused read never shows the card: unknown is not "not seen".
      introSeen: true,
    });
  });

  it('round-trips the v2 device record, each axis on its own, and drops a v1 or malformed one', async () => {
    const storage = new FakeStorage();
    await writeDeviceRecord(storage, { v: 2, style: 'classic', theme: 'dark', anonAt: 5 });
    expect(storage.json(PHONE_APPEARANCE_KEYS.device)).toEqual({
      v: 2,
      style: 'classic',
      theme: 'dark',
      anonAt: 5,
    });
    expect(await readDeviceRecord(storage, 10)).toEqual({
      v: 2,
      style: 'classic',
      theme: 'dark',
      anonAt: 5,
    });
    // Only the axes chosen are written: a Theme alone stays a Theme alone.
    await writeDeviceRecord(storage, { v: 2, theme: 'system' });
    expect(storage.json(PHONE_APPEARANCE_KEYS.device)).toEqual({ v: 2, theme: 'system' });
    storage.data.set(PHONE_APPEARANCE_KEYS.device, '{"v":1,"mode":"dark","lastClassic":"dark"}');
    expect(await readDeviceRecord(storage, 10)).toBeNull();
    storage.data.set(PHONE_APPEARANCE_KEYS.device, '{"v":2,"style":"Liquid Glass"}');
    expect(await readDeviceRecord(storage, 10)).toBeNull();
  });

  it('writes the v2 sync record with its dirty axes, and removes it for null (sign-out, another person)', async () => {
    const storage = new FakeStorage();
    await writeSyncRecord(storage, {
      v: 2,
      userId: USER_A,
      dirtyAxes: ['style'],
      syncedAt: null,
    });
    expect(storage.json(PHONE_APPEARANCE_KEYS.sync)).toEqual({
      v: 2,
      userId: USER_A,
      dirtyAxes: ['style'],
      syncedAt: null,
    });
    expect(await readSyncRecord(storage)).toEqual({
      v: 2,
      userId: USER_A,
      dirtyAxes: ['style'],
      syncedAt: null,
    });
    await writeSyncRecord(storage, null);
    expect(storage.data.has(PHONE_APPEARANCE_KEYS.sync)).toBe(false);
  });

  it('a v1 sync record from stage 2 is dropped, never pushed', async () => {
    const storage = new FakeStorage({
      [PHONE_APPEARANCE_KEYS.sync]: JSON.stringify({
        v: 1,
        userId: USER_A,
        dirty: true,
        syncedAt: null,
      }),
    });
    expect(await readSyncRecord(storage)).toBeNull();
  });

  it('marks the one-time card seen', async () => {
    const storage = new FakeStorage();
    expect((await readStoredAppearance(storage)).introSeen).toBe(false);
    await markIntroSeen(storage);
    expect((await readStoredAppearance(storage)).introSeen).toBe(true);
  });
});
