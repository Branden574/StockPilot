/**
 * "Use classic design" (Liquid Glass plan 5.6, plans/REVISION-DEFAULT.md R13),
 * with NO imports at all.
 *
 * Every error boundary offers it while Liquid Glass is shown, so a person can
 * always get back to the classic design, even when the glass layer itself is
 * what threw. app/global-error.tsx replaces the root layout and must not
 * depend on anything that could be what broke: it imports only modules that
 * import nothing themselves (global-error.sign-out.test.tsx). So the storage
 * keys, the route and the print-route pattern are written out here, and
 * appearance-recovery-plain.test.ts pins them to core's APPEARANCE_STORAGE_KEYS
 * and appearance-flag.ts's EXEMPT_PATHS so they cannot drift.
 * components/theme/appearance-cookie.ts delegates to this file, so there is
 * one implementation.
 */

const COOKIE = 'sp_style';
const DEVICE = 'sp-appearance';
const SYNC = 'sp-appearance-sync';
const FALLBACK = 'sp-lg-fallback';
/** appearance-flag.ts EXEMPT_PATHS, written out (pinned by the test). */
const EXEMPT = /^\/dashboard\/orders\/[^/]+\/print\/?$/u;
/** appearance-cookie.ts STYLE_COOKIE_ROUTE and STYLE_COOKIE_MAX_AGE, written out. */
const ROUTE = '/api/appearance/style';
const MAX_AGE = 34560000;

const THEMES = ['light', 'dark', 'system'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

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

/** The Design cookie's raw value, or null. */
export function readStyleCookie(): string | null {
  try {
    const m = new RegExp(`(?:^|; )${COOKIE}=([^;]*)`).exec(document.cookie);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Whether this build would show Liquid Glass on `pathname` for this cookie
 * value (core's shownStyle with the rollout's default, written out):
 *   off      never;
 *   default  unless the cookie says classic;
 *   opt-in   only when the cookie says liquid-glass;
 * and never on the print route. For global-error.tsx, which sits outside
 * every provider and decides from what the next load would paint.
 */
export function isGlassShown(
  rollout: 'off' | 'opt-in' | 'default',
  cookie: string | null,
  pathname: string,
): boolean {
  if (EXEMPT.test(pathname)) return false;
  if (rollout === 'default') return cookie !== 'classic';
  if (rollout === 'opt-in') return cookie === 'liquid-glass';
  return false;
}

/**
 * Set this device's Design to Classic and keep its Theme: the device record
 * (v2) and the Design cookie, then the server route that re-issues the cookie
 * for 400 days (fire-and-forget). For the signed-in person (a v2 sync record
 * naming them), the Design is marked dirty so the account is updated after
 * the reload. The crash fallback is cleared and the glass attributes come off
 * <html>. The caller reloads. Never throws.
 */
export function switchToClassicOnThisDevice(): void {
  // The record: Classic, the Theme kept. A signed-out stamp is dropped: this
  // is a recovery, not a choice to carry into a sign-in.
  try {
    const record = readJson(window.localStorage, DEVICE);
    const next: Record<string, unknown> = { v: 2, style: 'classic' };
    if (record && record.v === 2 && THEMES.includes(record.theme as string)) {
      next.theme = record.theme;
    }
    // localStorage first, then the cookie, so the two never disagree: the
    // head script paints from the cookie and the provider applies the
    // localStorage record. When the record cannot be written (a full quota),
    // the Liquid Glass record is removed so the next load reads the classic
    // cookie instead of putting glass back on.
    try {
      window.localStorage.setItem(DEVICE, JSON.stringify(next));
    } catch {
      window.localStorage.removeItem(DEVICE);
    }
  } catch {
    // Storage blocked: the cookie carries the choice.
  }
  try {
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${COOKIE}=classic; path=/; max-age=${MAX_AGE}; samesite=lax${secure}`;
  } catch {
    // A blocked cookie jar: localStorage above still remembers it.
  }
  try {
    void fetch(ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sp-appearance': '1' },
      body: JSON.stringify({ style: 'classic' }),
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: true,
    }).catch(() => {});
  } catch {
    // No fetch: the client cookie holds the choice for now.
  }
  try {
    const sync = readJson(window.localStorage, SYNC);
    if (sync && sync.v === 2 && typeof sync.userId === 'string' && UUID.test(sync.userId)) {
      const axes = Array.isArray(sync.dirtyAxes) ? sync.dirtyAxes : [];
      const dirtyAxes = ['style', 'theme'].filter((a) => a === 'style' || axes.includes(a));
      window.localStorage.setItem(SYNC, JSON.stringify({ ...sync, dirtyAxes }));
    }
  } catch {
    // Storage blocked: the device record and cookie carry the choice.
  }
  try {
    window.sessionStorage.removeItem(FALLBACK);
  } catch {
    // Nothing to clear.
  }
  try {
    document.documentElement.removeAttribute('data-appearance');
    document.documentElement.removeAttribute('data-lg-material');
  } catch {
    // Nothing to remove.
  }
}

/**
 * Hold this tab in classic from the next load on (the one-time crash
 * fallback, plan 5.6), without changing the stored choice. For a boundary
 * that replaced the whole document (global-error.tsx), where glass is no
 * longer on screen to be detected.
 */
export function holdClassicForThisTab(): void {
  try {
    if (!window.sessionStorage.getItem(FALLBACK))
      window.sessionStorage.setItem(FALLBACK, 'pending');
  } catch {
    // sessionStorage blocked: the button still offers the way back.
  }
}
