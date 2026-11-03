import {
  APPEARANCE_STORAGE_KEYS,
  parseDeviceRecord,
  parseStyle,
  type AccountSyncRecord,
  type AnonFlowRecord,
  type AppearanceStyle,
  type DeviceAppearanceRecord,
} from '@stockpilot/core';

import { switchToClassicOnThisDevice } from './appearance-recovery-plain';
import { APPEARANCE_ATTRIBUTE } from './appearance-script';

/**
 * The web's appearance records (plans/REVISION-DEFAULT.md R2, R4, R6) and the
 * one-time crash fallback (plan 5.6). Plain functions over document.cookie,
 * localStorage, sessionStorage and one fire-and-forget request, with no React,
 * so the provider, the selectors, every error boundary and the tests share one
 * definition.
 *
 *   Design cookie   `sp_style=<liquid-glass|classic>`, read by the head script
 *                   and the marketing rewrites. Written only for a Design the
 *                   person chose, and only when it differs; every client write
 *                   is followed at once by POST /api/appearance/style, whose
 *                   answer sets the same cookie for 400 days (WebKit caps a
 *                   cookie written by script at 7 days; a server cookie is not
 *                   capped). A matching cookie is never written again, which
 *                   would put the 7-day cap back.
 *   Device record   localStorage `sp-appearance` ({v:2, style?, theme?, anonAt?},
 *                   also the cross-tab `storage` event). Survives sign-out.
 *   Account sync    localStorage `sp-appearance-sync` ({v:2, userId, dirtyAxes,
 *                   syncedAt}). Removed at sign-out; ignored when it names
 *                   someone else.
 *   Signed-out flow sessionStorage `sp-appearance-anon`: this tab's signed-out
 *                   choices (SR4), so a choice another person left in another
 *                   tab never reaches an account.
 *   Intro notice    localStorage `sp-lg-intro-seen` (R13).
 *   Server stamp    localStorage `sp-style-server-at`: when the server last
 *                   re-issued the cookie (written only after a 2xx answer).
 *   Crash fallback  sessionStorage `sp-lg-fallback`.
 *
 * Every read goes through core's parsers. A malformed or stage 2 value is
 * dropped and means "never chose", so the rollout's default applies (R2).
 * Storage that throws (private modes, a full quota, a blocked cookie jar) is
 * treated as empty and never breaks a page. This module owns only these keys
 * and the `data-appearance` attribute; the colour scheme stays next-themes'
 * (localStorage `theme`).
 */

const KEYS = APPEARANCE_STORAGE_KEYS;

/** next-themes' own storage key (theme-provider.tsx sets no storageKey). */
export const NEXT_THEMES_STORAGE_KEY = 'theme';

/** 400 days, Chrome's cap on a cookie's lifetime; the server route uses the same. */
export const STYLE_COOKIE_MAX_AGE = 34560000;

/** The route that re-issues the Design cookie from the server (R6). */
export const STYLE_COOKIE_ROUTE = '/api/appearance/style';

/** How often a load asks the server to re-issue a matching cookie. */
export const SERVER_COOKIE_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * `document.cookie` string that stores the Design for the head script:
 * path=/, 400 days, samesite=lax, and secure on https. Not HttpOnly, because
 * the head script reads it. It holds only the validated word.
 */
export function appearanceCookieString(style: AppearanceStyle, secure: boolean): string {
  return `${KEYS.webCookie}=${style}; path=/; max-age=${STYLE_COOKIE_MAX_AGE}; samesite=lax${secure ? '; secure' : ''}`;
}

/** The Design cookie's raw value, or null. */
export function readAppearanceCookie(cookie: string): string | null {
  const match = new RegExp(`(?:^|; )${KEYS.webCookie}=([^;]*)`).exec(cookie);
  return match ? match[1]! : null;
}

function currentCookie(): string | null {
  if (typeof document === 'undefined') return null;
  try {
    return readAppearanceCookie(document.cookie);
  } catch {
    return null;
  }
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

/** Returns false when the write threw (storage full or blocked). */
function setItem(store: Storage | null, key: string, value: string): boolean {
  try {
    store?.setItem(key, value);
    return true;
  } catch {
    // Storage full or blocked: the choice still applies to this page.
    return false;
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
 * The device record as stored, raw, for the reducer's hydrate: localStorage
 * first; when it holds nothing, the cookie's Design (the record may have been
 * dropped after a full quota, while the cookie kept the choice).
 */
export function readDeviceRecordRaw(): unknown {
  const stored = getItem(local(), KEYS.webDevice);
  if (stored !== null) return stored;
  const style = parseStyle(currentCookie());
  return style ? { v: 2, style } : null;
}

export function readDeviceRecord(now: number): DeviceAppearanceRecord | null {
  return parseDeviceRecord(readDeviceRecordRaw(), now);
}

/** The Design the person chose on this device (record first, then the cookie), or null. */
function storedStyle(): AppearanceStyle | null {
  return readDeviceRecord(Date.now())?.style ?? null;
}

/**
 * Ask the server to set the 400-day cookie (R6). Fire-and-forget: it never
 * throws, and stamps `sp-style-server-at` only after a 2xx answer, so a failed
 * or offline call is tried again on the next load. Resolves to whether the
 * server answered 2xx.
 */
export async function postStyleCookie(style: AppearanceStyle): Promise<boolean> {
  try {
    const response = await fetch(STYLE_COOKIE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sp-appearance': '1' },
      body: JSON.stringify({ style }),
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: true,
    });
    if (!response.ok) return false;
    setItem(local(), KEYS.webServerCookieAt, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the Design cookie on the client when it differs, then let the server
 * replace it with its 400-day cookie at once. Returns whether it wrote.
 */
function writeStyleCookie(style: AppearanceStyle): boolean {
  if (typeof document === 'undefined') return false;
  if (currentCookie() === style) return false;
  try {
    document.cookie = appearanceCookieString(
      style,
      typeof location !== 'undefined' && location.protocol === 'https:',
    );
  } catch {
    // A blocked cookie jar: localStorage still remembers the choice.
    return false;
  }
  void postStyleCookie(style);
  return true;
}

/**
 * Write the device record: localStorage first, then, for a Design the person
 * chose, the cookie the head script paints from. The two must never disagree,
 * because the head script paints from the cookie and the provider then applies
 * the localStorage record: a disagreement is a flash on every load and, worse,
 * an older record undoing the person's choice. So when the localStorage write
 * fails (a full quota), the older record is removed and the next load reads
 * the cookie, which holds this choice. If even that fails, the cookie says
 * what the next load will read. A record with no Design writes no cookie.
 */
export function writeDeviceRecord(record: DeviceAppearanceRecord): void {
  const store = local();
  if (!setItem(store, KEYS.webDevice, JSON.stringify(record))) removeItem(store, KEYS.webDevice);
  const kept = getItem(store, KEYS.webDevice);
  const style = kept === null ? record.style : parseDeviceRecord(kept, Date.now())?.style;
  if (style) writeStyleCookie(style);
}

/**
 * On load (the provider's hydrate): make the cookie say the stored Design when
 * it is missing or says something else (cleared cookies, an expired script
 * cookie). A matching cookie is never touched, and a person who never chose a
 * Design gets no cookie. Returns whether it wrote (and so called the route).
 */
export function repairAppearanceCookie(): boolean {
  const style = storedStyle();
  if (!style) return false;
  return writeStyleCookie(style);
}

/**
 * The load's cookie upkeep: repair the cookie, or, when it already matches,
 * ask the server to re-issue it at most once a day. Returns whether it called
 * the route.
 */
export function ensureStyleCookie(now: number): boolean {
  if (repairAppearanceCookie()) return true;
  const style = storedStyle();
  if (!style) return false;
  const last = Number(getItem(local(), KEYS.webServerCookieAt));
  if (Number.isFinite(last) && last > 0 && now - last < SERVER_COOKIE_REFRESH_MS && now >= last) {
    return false;
  }
  void postStyleCookie(style);
  return true;
}

export function readSyncRecordRaw(): unknown {
  return getItem(local(), KEYS.webSync);
}

/** Write the account sync record, or remove it (null). */
export function writeSyncRecord(record: AccountSyncRecord | null): void {
  if (record === null) removeItem(local(), KEYS.webSync);
  else setItem(local(), KEYS.webSync, JSON.stringify(record));
}

/** This tab's signed-out choices (SR4), raw. */
export function readAnonFlowRaw(): unknown {
  return getItem(session(), KEYS.webAnonFlow);
}

/** Write this tab's signed-out stamp, or remove it (null). */
export function writeAnonFlow(record: AnonFlowRecord | null): void {
  if (record === null) removeItem(session(), KEYS.webAnonFlow);
  else setItem(session(), KEYS.webAnonFlow, JSON.stringify(record));
}

/** next-themes' stored `theme` (light, dark or system): inherited, applied, never uploaded. */
export function readLegacyTheme(): string | null {
  return getItem(local(), NEXT_THEMES_STORAGE_KEY);
}

// ── One-time "new look" notice (R13) ───────────────────────────────────────

export function readIntroSeen(): boolean {
  return getItem(local(), KEYS.webIntroSeen) !== null;
}

export function markIntroSeen(): void {
  setItem(local(), KEYS.webIntroSeen, '1');
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

/** True when this document is showing Liquid Glass right now (the attribute on <html>). */
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
 * The "Use classic design" recovery action (plan 5.6, R13): the Design
 * becomes Classic on this device and the Theme is kept; the account sync
 * record marks the Design dirty so the account is updated after the reload;
 * the crash fallback is cleared and the glass attributes come off <html>. One
 * implementation, in appearance-recovery-plain.ts, which imports nothing so
 * app/global-error.tsx can use it too. The caller reloads.
 */
export function chooseClassicFromRecovery(): void {
  switchToClassicOnThisDevice();
}

/**
 * Sign-out (plan 3.3, rule 5): the account sync record goes, so nothing that
 * names an account outlives the session.
 * The device keeps its appearance. Tells a mounted AppearanceProvider through
 * a window event so its state forgets the account too.
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
