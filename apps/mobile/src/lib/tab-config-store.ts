import * as SecureStore from 'expo-secure-store';
import * as React from 'react';

import { sanitizeStoredSlots, type TabSlotId } from './tab-config';

/**
 * Per-user persistence for the customized bottom-tab config.
 *
 * Storage is expo-secure-store — a static import that predates runtime 1.1.0
 * (biometric.ts, supabase.ts, scanner-tip-flag.ts), so it is OTA-safe.
 *
 * Failure posture is identical to scanner-tip-flag.ts: storage must NEVER
 * crash or block navigation.
 *   • No exported function ever rejects.
 *   • Read failure / corrupt value → null → the caller renders defaults.
 *   • Write failure → the in-memory session cache still serves the new value
 *     for the rest of the session (the bar works; it just won't survive a
 *     relaunch while the keystore is broken).
 *   • The session cache is written BEFORE the keystore attempt and doubles as
 *     a synchronous initial value for useStoredTabSlots, so a remount never
 *     flashes the default bar over a loaded custom one.
 *
 * Key: canonically 'tab-config-v1:{userId}', but expo-secure-store rejects
 * ':' (keys must match [A-Za-z0-9._-] — see ensureValidKey), so the stored
 * key joins with '.' instead and defensively maps any other invalid
 * character in the user id to '_'.
 */

const KEY_PREFIX = 'tab-config-v1';

export function storageKeyForUser(userId: string): string {
  return `${KEY_PREFIX}.${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/**
 * Session cache. `undefined` (absent) = keystore not consulted yet;
 * `null` = known-absent (fresh default user, or reset-to-default) — the
 * explicit null tombstone keeps a reset honest even if the keystore delete
 * races or fails.
 */
const sessionCache = new Map<string, TabSlotId[] | null>();

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Subscribe to config changes (save/reset). Returns the unsubscribe fn. */
export function subscribeTabConfig(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Synchronous session-cache peek: a slot list, null (known-absent), or
 *  undefined (not read yet this session). */
export function getCachedTabSlots(
  userId: string | null,
): TabSlotId[] | null | undefined {
  if (!userId) return null;
  return sessionCache.get(userId);
}

/**
 * Reads (and caches) the persisted slot list for a user. Returns null for
 * missing/corrupt/unreadable values — never rejects. The value is sanitized
 * (unknown ids dropped, min-2 healed to null) before caching so every
 * consumer sees the same healed view.
 */
export async function readStoredTabSlots(
  userId: string,
): Promise<TabSlotId[] | null> {
  const cached = sessionCache.get(userId);
  if (cached !== undefined) return cached;
  try {
    const raw = await SecureStore.getItemAsync(storageKeyForUser(userId));
    if (raw == null) {
      sessionCache.set(userId, null);
      return null;
    }
    const slots = sanitizeStoredSlots(JSON.parse(raw) as unknown);
    sessionCache.set(userId, slots);
    return slots;
  } catch {
    // Keystore unreadable or corrupt JSON — fall back to defaults for now,
    // but do NOT cache the failure: a later read may succeed.
    return null;
  }
}

/**
 * Persists a customized slot list. The session cache + subscribers update
 * first (synchronously), so the tab bar reflects the change immediately even
 * when the keystore write fails. Never rejects.
 */
export async function saveTabSlots(
  userId: string,
  slots: readonly TabSlotId[],
): Promise<void> {
  sessionCache.set(userId, [...slots]);
  notify();
  try {
    await SecureStore.setItemAsync(storageKeyForUser(userId), JSON.stringify(slots));
  } catch {
    // Swallow — the session cache already serves this value; a broken
    // keystore must not surface as a settings failure.
  }
}

/**
 * Reset to default = forget the stored config entirely (rather than writing
 * the default list), so the user returns to the true out-of-the-box bar —
 * including any future changes to the default. Never rejects.
 */
export async function resetTabSlots(userId: string): Promise<void> {
  sessionCache.set(userId, null);
  notify();
  try {
    await SecureStore.deleteItemAsync(storageKeyForUser(userId));
  } catch {
    // Swallow — the null tombstone above already wins for this session.
  }
}

/**
 * React hook: the user's stored slot list (null → caller renders defaults).
 *
 * Initial state is the synchronous session cache, so after the first read a
 * remount starts on the custom config with no flash. The very first render
 * of a cold launch may show the default bar for one beat while the keystore
 * read resolves — default-flash-to-custom is the acceptable direction.
 * Re-reads on save/reset notifications so the bar updates live while the
 * customize screen edits it.
 */
export function useStoredTabSlots(userId: string | null): TabSlotId[] | null {
  const [slots, setSlots] = React.useState<TabSlotId[] | null>(
    () => getCachedTabSlots(userId) ?? null,
  );

  React.useEffect(() => {
    let cancelled = false;
    const reread = (): void => {
      if (!userId) {
        setSlots(null);
        return;
      }
      const cached = getCachedTabSlots(userId);
      if (cached !== undefined) {
        setSlots(cached);
        return;
      }
      void readStoredTabSlots(userId).then((stored) => {
        if (!cancelled) setSlots(stored);
      });
    };
    const unsubscribe = subscribeTabConfig(reread);
    reread();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [userId]);

  return slots;
}
