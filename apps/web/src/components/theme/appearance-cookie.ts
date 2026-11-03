import {
  APPEARANCE_STORAGE_KEYS,
  parseDeviceRecord,
  type AccountSyncRecord,
  type AppearanceMode,
  type ClassicAppearanceMode,
  type DeviceAppearanceRecord,
} from '@stockpilot/core';

import { switchToClassicOnThisDevice } from './appearance-recovery-plain';
import { APPEARANCE_ATTRIBUTE } from './appearance-script';

/**
 * The web's two appearance records (Liquid Glass plan 3.3) and the one-time
 * crash fallback (plan 5.6). Plain functions over document.cookie,
 * localStorage and sessionStorage, with no React, so the provider, the
 * selectors, every error boundary (global-error.tsx included, which renders
 * outside every provider) and the tests share one definition.
 *
 *   Device choice   cookie `sp_appearance=<mode>` (read by the head script) +
 *                   localStorage `sp-appearance` ({v, mode, lastClassic, anonAt?},
 *                   also the cross-tab `storage` event). Survives sign-out.
 *   Account sync    localStorage `sp-appearance-sync` ({v, userId, dirty, syncedAt}).
 *                   Removed at sign-out; ignored when it names someone else.
 *   Crash fallback  sessionStorage `sp-lg-fallback`: this tab shows classic
 *                   until it is closed or the person turns glass back on.
 *
 * Every read goes through core's parsers, so a malformed value is dropped and
 * can never turn Liquid Glass on. Storage that throws (private modes, a full
 * quota, a blocked cookie jar) is treated as empty and never breaks a page.
 * This module owns only these keys and the `data-appearance` attribute; the
 * colour scheme stays next-themes' (localStorage `theme`).
 */

const KEYS = APPEARANCE_STORAGE_KEYS;

/** next-themes' own storage key (theme-provider.tsx sets no storageKey). */
export const NEXT_THEMES_STORAGE_KEY = 'theme';

/** One year, like every shell preference cookie (components/dashboard/sidebar-pref.ts). */
const ONE_YEAR = 31536000;

/**
 * `document.cookie` string that stores the device choice for the head script:
 * path=/, one year, samesite=lax, and secure on https. Not HttpOnly, because
 * the head script reads it. It holds only the validated word.
 */
export function appearanceCookieString(mode: AppearanceMode, secure: boolean): string {
  return `${KEYS.webCookie}=${mode}; path=/; max-age=${ONE_YEAR}; samesite=lax${secure ? '; secure' : ''}`;
}

/** The device cookie's raw value, or null. */
export function readAppearanceCookie(cookie: string): string | null {
  const match = new RegExp(`(?:^|; )${KEYS.webCookie}=([^;]*)`).exec(cookie);
  return match ? match[1]! : null;
}

function local(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function getItem(store: Storage | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function setItem(store: Storage | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // Storage full or blocked: the choice still applies to this page.
  }
}

function removeItem(store: Storage | null, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // Nothing to do.
  }
}

/**
 * The device record as stored: localStorage first (it carries lastClassic and
 * anonAt), the cookie second (a bare mode). Raw, for the reducer's hydrate.
 */
export function readDeviceRecordRaw(): unknown {
  const stored = getItem(local(), KEYS.webDevice);
  if (stored !== null) return stored;
  if (typeof document === 'undefined') return null;
  try {
    return readAppearanceCookie(document.cookie);
  } catch {
    return null;
  }
}

export function readDeviceRecord(): DeviceAppearanceRecord | null {
  return parseDeviceRecord(readDeviceRecordRaw());
}

/** Write the device record: the cookie for the head script and the localStorage mirror. */
export function writeDeviceRecord(record: DeviceAppearanceRecord): void {
  if (typeof document !== 'undefined') {
    try {
      document.cookie = appearanceCookieString(
        record.mode,
        typeof location !== 'undefined' && location.protocol === 'https:',
      );
    } catch {
      // A blocked cookie jar: localStorage below still remembers it.
    }
  }
  setItem(local(), KEYS.webDevice, JSON.stringify(record));
}

export function readSyncRecordRaw(): unknown {
  return getItem(local(), KEYS.webSync);
}

/** Write the account sync record, or remove it (null). */
export function writeSyncRecord(record: AccountSyncRecord | null): void {
  if (record === null) removeItem(local(), KEYS.webSync);
  else setItem(local(), KEYS.webSync, JSON.stringify(record));
}

/** next-themes' stored `theme` (light, dark or system), for the legacy migration. */
export function readLegacyTheme(): string | null {
  return getItem(local(), NEXT_THEMES_STORAGE_KEY);
}

// ── One-time crash fallback (plan 5.6) ─────────────────────────────────────

/** `pending`: the classic load still owes the person its notice; `shown`: told. */
type FallbackState = 'pending' | 'shown';

export function readCrashFallback(): FallbackState | null {
  const value = getItem(session(), KEYS.webFallback);
  if (value === null) return null;
  return value === 'shown' ? 'shown' : 'pending';
}

/** True while this tab is held in classic after a glass crash. */
export function isCrashFallbackActive(): boolean {
  return readCrashFallback() !== null;
}

export function markCrashFallbackShown(): void {
  if (isCrashFallbackActive()) setItem(session(), KEYS.webFallback, 'shown');
}

export function clearCrashFallback(): void {
  removeItem(session(), KEYS.webFallback);
}

/** True when this document is showing Liquid Glass right now. */
export function isGlassShowing(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute(APPEARANCE_ATTRIBUTE) === 'liquid-glass';
}

/**
 * An error boundary caught a render error. When Liquid Glass is on screen,
 * hold this tab in classic from the next load on, until the person turns it
 * back on or closes the tab. The stored choice is NOT changed: a temporary
 * fault never switches anyone's appearance for good. Returns whether it did.
 */
export function noteGlassCrash(): boolean {
  if (!isGlassShowing()) return false;
  if (!isCrashFallbackActive()) setItem(session(), KEYS.webFallback, 'pending');
  return true;
}

/**
 * The "Use classic appearance" recovery action (plan 5.6): the device returns
 * to the person's last classic choice, next-themes' stored theme follows, the
 * account sync record is marked dirty so the account is updated after the
 * reload (rule 4b), the crash fallback is cleared and data-appearance comes
 * off <html>. One implementation, in appearance-recovery-plain.ts, which
 * imports nothing so app/global-error.tsx can use it too. The caller reloads.
 */
export function chooseClassicFromRecovery(): ClassicAppearanceMode {
  return switchToClassicOnThisDevice();
}

/**
 * Sign-out (plan 3.3, rule 5): the account sync record goes, so nothing that
 * names an account outlives the session. The device keeps its appearance.
 * Tells a mounted AppearanceProvider through a window event so its state
 * forgets the account too.
 */
export const APPEARANCE_SIGNED_OUT_EVENT = 'sp-appearance-signed-out';

export function forgetAppearanceAccount(): void {
  writeSyncRecord(null);
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new Event(APPEARANCE_SIGNED_OUT_EVENT));
    } catch {
      // No listener can be told; the record is already gone.
    }
  }
}
