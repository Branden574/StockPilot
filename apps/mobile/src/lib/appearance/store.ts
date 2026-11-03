import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  APPEARANCE_STORAGE_KEYS,
  parseDeviceRecord,
  parseSyncRecord,
  type AccountSyncRecord,
  type DeviceAppearanceRecord,
} from '@stockpilot/core';

/**
 * Where the phone keeps the appearance (plan 3.3). Two records, split by
 * lifetime, plus the one-time crash fallback flag:
 *
 *   stockpilot.appearance.v1        the device record { v, mode, lastClassic, anonAt? }.
 *                                   Device-level, NOT under `workspace.`, so it
 *                                   survives sign-out like today's theme did
 *                                   (the same choice as stockpilot.update-prompt.v1).
 *   workspace.appearance-sync       the account sync record { v, userId, dirty, syncedAt }.
 *                                   Under `workspace.`, so sign-out erases it with
 *                                   every other account-scoped key
 *                                   (account-eviction.ts ACCOUNT_SCOPED_STORAGE_PREFIXES).
 *   stockpilot.appearance.fallback  '1' after a render crash while Liquid Glass was
 *                                   showing: the next launch opens classic once (plan 5.6).
 *
 * Nothing here touches SQLite (the offline outbox `pending_actions`, the cache)
 * or any other AsyncStorage key: every read and write names one of these three
 * keys, and appearance-store.test.ts pins that.
 */

export const PHONE_APPEARANCE_KEYS = {
  device: APPEARANCE_STORAGE_KEYS.phoneDevice,
  sync: APPEARANCE_STORAGE_KEYS.phoneSync,
  fallback: APPEARANCE_STORAGE_KEYS.phoneFallback,
} as const;

/** The flag's stored value. Anything else is "no fallback owed". */
export const FALLBACK_FLAG_VALUE = '1';

/** The slice of AsyncStorage the appearance uses (injectable for tests). */
export interface AppearanceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const asyncStorageAppearance: AppearanceStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

/** What a launch reads before its first paint, raw (the reducer parses it). */
export interface StoredAppearance {
  device: string | null;
  sync: string | null;
  fallback: boolean;
}

/** A read that fails reads as nothing stored: System, today's behaviour. */
async function readKey(storage: AppearanceStorage, key: string): Promise<string | null> {
  try {
    return await storage.getItem(key);
  } catch {
    return null;
  }
}

export async function readStoredAppearance(storage: AppearanceStorage): Promise<StoredAppearance> {
  const [device, sync, fallback] = await Promise.all([
    readKey(storage, PHONE_APPEARANCE_KEYS.device),
    readKey(storage, PHONE_APPEARANCE_KEYS.sync),
    readKey(storage, PHONE_APPEARANCE_KEYS.fallback),
  ]);
  return { device, sync, fallback: fallback === FALLBACK_FLAG_VALUE };
}

export function serializeDeviceRecord(record: DeviceAppearanceRecord): string {
  const out: DeviceAppearanceRecord = { v: 1, mode: record.mode, lastClassic: record.lastClassic };
  if (record.anonAt !== undefined) out.anonAt = record.anonAt;
  return JSON.stringify(out);
}

export function serializeSyncRecord(record: AccountSyncRecord): string {
  return JSON.stringify({
    v: 1,
    userId: record.userId,
    dirty: record.dirty,
    syncedAt: record.syncedAt,
  });
}

export async function writeDeviceRecord(
  storage: AppearanceStorage,
  record: DeviceAppearanceRecord,
): Promise<void> {
  await storage.setItem(PHONE_APPEARANCE_KEYS.device, serializeDeviceRecord(record));
}

/** Write the sync record, or remove it (null: signed out, or another person). */
export async function writeSyncRecord(
  storage: AppearanceStorage,
  record: AccountSyncRecord | null,
): Promise<void> {
  if (record === null) {
    await storage.removeItem(PHONE_APPEARANCE_KEYS.sync);
    return;
  }
  await storage.setItem(PHONE_APPEARANCE_KEYS.sync, serializeSyncRecord(record));
}

export async function setFallbackFlag(storage: AppearanceStorage): Promise<void> {
  await storage.setItem(PHONE_APPEARANCE_KEYS.fallback, FALLBACK_FLAG_VALUE);
}

export async function clearFallbackFlag(storage: AppearanceStorage): Promise<void> {
  await storage.removeItem(PHONE_APPEARANCE_KEYS.fallback);
}

/** The stored device record, parsed (null when missing or malformed). */
export async function readDeviceRecord(
  storage: AppearanceStorage,
): Promise<DeviceAppearanceRecord | null> {
  return parseDeviceRecord(await readKey(storage, PHONE_APPEARANCE_KEYS.device));
}

/** The stored sync record, parsed (null when missing or malformed). */
export async function readSyncRecord(
  storage: AppearanceStorage,
): Promise<AccountSyncRecord | null> {
  return parseSyncRecord(await readKey(storage, PHONE_APPEARANCE_KEYS.sync));
}
