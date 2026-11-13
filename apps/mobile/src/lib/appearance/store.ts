import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  APPEARANCE_STORAGE_KEYS,
  parseDeviceRecord,
  parseSyncRecord,
  type AccountSyncRecord,
  type DeviceAppearanceRecord,
} from '@stockpilot/core';

/**
 * Where the phone keeps the appearance (plan 3.3, revision R2, item 29). Two
 * records, split by lifetime, plus two one-time flags:
 *
 *   stockpilot.appearance.v2        the device record { v: 2, style?, theme?, anonAt? }:
 *                                   the Design and the Theme chosen on this phone (or
 *                                   adopted from the person's own account row); an axis
 *                                   absent was never chosen. Device-level, NOT under
 *                                   `workspace.`, so it survives sign-out like today's
 *                                   theme did (the same choice as stockpilot.update-prompt.v1).
 *                                   The stage 2 key stockpilot.appearance.v1 held one of four
 *                                   words that meant something else; it is never read.
 *   workspace.appearance-sync       the account sync record { v: 2, userId, dirtyAxes, syncedAt }.
 *                                   Under `workspace.`, so sign-out erases it with
 *                                   every other account-scoped key
 *                                   (account-eviction.ts ACCOUNT_SCOPED_STORAGE_PREFIXES).
 *   stockpilot.appearance.fallback  '1' after a render crash while Liquid Glass was
 *                                   showing: the next launch opens classic once (plan 5.6).
 *   stockpilot.appearance.intro.v1  '1' once the one-time "new look" card on Home was
 *                                   answered or closed (R13). Device-level.
 *
 * The signed-out "sign-in flow" stamp (SR4) is NOT stored on the phone: it is
 * the controller's memory for this app run, so a choice someone left in an
 * earlier run never reaches an account.
 *
 * Nothing here touches SQLite (the offline outbox `pending_actions`, the cache)
 * or any other AsyncStorage key: every read and write names one of these four
 * keys, and appearance-store.test.ts pins that.
 */

export const PHONE_APPEARANCE_KEYS = {
  device: APPEARANCE_STORAGE_KEYS.phoneDevice,
  sync: APPEARANCE_STORAGE_KEYS.phoneSync,
  fallback: APPEARANCE_STORAGE_KEYS.phoneFallback,
  introSeen: APPEARANCE_STORAGE_KEYS.phoneIntroSeen,
} as const;

/** The flag's stored value. Anything else is "no fallback owed". */
export const FALLBACK_FLAG_VALUE = '1';

/** The intro card's stored value once seen. */
export const INTRO_SEEN_VALUE = '1';

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
  /** The one-time "new look" card was answered or closed on this phone. */
  introSeen: boolean;
}

const UNREADABLE = Symbol('unreadable');

/** A read that fails reads as nothing stored: the rollout's default. */
async function readKey(
  storage: AppearanceStorage,
  key: string,
): Promise<string | null | typeof UNREADABLE> {
  try {
    return await storage.getItem(key);
  } catch {
    return UNREADABLE;
  }
}

const orNull = (value: string | null | typeof UNREADABLE): string | null =>
  value === UNREADABLE ? null : value;

export async function readStoredAppearance(storage: AppearanceStorage): Promise<StoredAppearance> {
  const [device, sync, fallback, introSeen] = await Promise.all([
    readKey(storage, PHONE_APPEARANCE_KEYS.device),
    readKey(storage, PHONE_APPEARANCE_KEYS.sync),
    readKey(storage, PHONE_APPEARANCE_KEYS.fallback),
    readKey(storage, PHONE_APPEARANCE_KEYS.introSeen),
  ]);
  return {
    device: orNull(device),
    sync: orNull(sync),
    fallback: fallback === FALLBACK_FLAG_VALUE,
    // A read that failed never shows the card: not knowing is not "not seen".
    introSeen: introSeen === UNREADABLE || introSeen === INTRO_SEEN_VALUE,
  };
}

/** Only the axes chosen are written; an absent axis stays "never chose". */
export function serializeDeviceRecord(record: DeviceAppearanceRecord): string {
  const out: DeviceAppearanceRecord = { v: 2 };
  if (record.style !== undefined) out.style = record.style;
  if (record.theme !== undefined) out.theme = record.theme;
  if (record.anonAt !== undefined) out.anonAt = record.anonAt;
  return JSON.stringify(out);
}

export function serializeSyncRecord(record: AccountSyncRecord): string {
  return JSON.stringify({
    v: 2,
    userId: record.userId,
    dirtyAxes: [...record.dirtyAxes],
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

/** The one-time "new look" card was answered or closed: never shown again on this phone. */
export async function markIntroSeen(storage: AppearanceStorage): Promise<void> {
  await storage.setItem(PHONE_APPEARANCE_KEYS.introSeen, INTRO_SEEN_VALUE);
}

/**
 * The stored device record, parsed (null when missing or malformed). `now`
 * (ms) lets the parser drop a signed-out stamp set in the future (SR2).
 */
export async function readDeviceRecord(
  storage: AppearanceStorage,
  now: number,
): Promise<DeviceAppearanceRecord | null> {
  return parseDeviceRecord(orNull(await readKey(storage, PHONE_APPEARANCE_KEYS.device)), now);
}

/** The stored sync record, parsed (null when missing or malformed). */
export async function readSyncRecord(
  storage: AppearanceStorage,
): Promise<AccountSyncRecord | null> {
  return parseSyncRecord(orNull(await readKey(storage, PHONE_APPEARANCE_KEYS.sync)));
}
