/**
 * "Use classic appearance" (Liquid Glass plan 5.6), with NO imports at all.
 *
 * Every error boundary offers it while Liquid Glass is selected, so a person
 * can always get back to the classic look, even when the glass layer itself is
 * what threw. app/global-error.tsx replaces the root layout and must not
 * depend on anything that could be what broke: it imports only modules that
 * import nothing themselves (global-error.sign-out.test.tsx). So the storage
 * keys and the four words are written out here, and
 * appearance-recovery-plain.test.ts pins them to core's
 * APPEARANCE_STORAGE_KEYS and APPEARANCE_MODES so they cannot drift.
 * components/theme/appearance-cookie.ts delegates to this file, so there is
 * one implementation.
 */

const COOKIE = 'sp_appearance';
const DEVICE = 'sp-appearance';
const SYNC = 'sp-appearance-sync';
const FALLBACK = 'sp-lg-fallback';
/** next-themes' storage key (theme-provider.tsx sets no storageKey). */
const THEME = 'theme';
const CLASSIC = ['dark', 'light', 'system'] as const;
type Classic = (typeof CLASSIC)[number];

const isClassic = (v: unknown): v is Classic =>
  typeof v === 'string' && (CLASSIC as readonly string[]).includes(v);

function cookieMode(): string | null {
  try {
    const m = new RegExp(`(?:^|; )${COOKIE}=([^;]*)`).exec(document.cookie);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

function readJson(store: Storage, key: string): Record<string, unknown> | null {
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The device's stored mode (localStorage record first, the cookie second), or null. */
export function storedAppearanceWord(): string | null {
  try {
    const record = readJson(window.localStorage, DEVICE);
    if (record && typeof record.mode === 'string') return record.mode;
  } catch {
    // Fall through to the cookie.
  }
  return cookieMode();
}

/** True when this device's stored choice is Liquid Glass. */
export function isLiquidGlassStored(): boolean {
  return storedAppearanceWord() === 'liquid-glass';
}

/**
 * Return this device to the person's last classic choice (System when none is
 * known): the device record and its cookie, next-themes' stored theme, the
 * account sync record marked dirty so the account is updated after the
 * reload, the crash fallback cleared, and data-appearance off <html>. The
 * caller reloads. Never throws.
 */
export function switchToClassicOnThisDevice(): Classic {
  let lastClassic: Classic = 'system';
  try {
    const record = readJson(window.localStorage, DEVICE);
    if (record && isClassic(record.lastClassic)) lastClassic = record.lastClassic;
  } catch {
    // System.
  }
  try {
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${COOKIE}=${lastClassic}; path=/; max-age=31536000; samesite=lax${secure}`;
  } catch {
    // A blocked cookie jar: localStorage below still remembers it.
  }
  try {
    window.localStorage.setItem(DEVICE, JSON.stringify({ v: 1, mode: lastClassic, lastClassic }));
    window.localStorage.setItem(THEME, lastClassic);
    const sync = readJson(window.localStorage, SYNC);
    if (sync && sync.v === 1 && typeof sync.userId === 'string' && sync.userId) {
      window.localStorage.setItem(SYNC, JSON.stringify({ ...sync, dirty: true }));
    }
  } catch {
    // Storage blocked: the cookie carries the choice.
  }
  try {
    window.sessionStorage.removeItem(FALLBACK);
  } catch {
    // Nothing to clear.
  }
  try {
    document.documentElement.removeAttribute('data-appearance');
  } catch {
    // Nothing to remove.
  }
  return lastClassic;
}

/**
 * Hold this tab in classic from the next load on (the one-time crash
 * fallback, plan 5.6), without changing the stored choice. For a boundary
 * that replaced the whole document (global-error.tsx), where glass is no
 * longer on screen to be detected: the stored choice is what counts there.
 */
export function holdClassicForThisTab(): void {
  try {
    if (!window.sessionStorage.getItem(FALLBACK))
      window.sessionStorage.setItem(FALLBACK, 'pending');
  } catch {
    // sessionStorage blocked: the button still offers the way back.
  }
}
