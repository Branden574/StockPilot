/**
 * The appearance model shared by the web and the phone (Liquid Glass plan,
 * stockpilot-work/liquid-glass/IMPLEMENTATION-PLAN.md sections 1.2, 3.3, 3.4).
 *
 * A person chooses one of four appearances. Inside the apps that choice is two
 * separate things:
 *   - a STYLE: the classic look or Liquid Glass;
 *   - a COLOUR SCHEME: light or dark.
 * Every API that only understands light and dark (next-themes, sonner, the
 * CSS color-scheme property, the native StatusBar, BlurView tints) is given a
 * scheme, never the word 'liquid-glass'.
 *
 * PURE: no React, no platform imports, so web, phone and server read one
 * definition.
 */

/** Every appearance a person can choose, in the order the selector offers them. */
export const APPEARANCE_MODES = ['dark', 'light', 'liquid-glass', 'system'] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

/** The three classic choices: today's Dark, Light and System. */
export const CLASSIC_APPEARANCE_MODES = ['dark', 'light', 'system'] as const;
export type ClassicAppearanceMode = (typeof CLASSIC_APPEARANCE_MODES)[number];

export type AppearanceStyle = 'classic' | 'liquid-glass';
export type ColorScheme = 'light' | 'dark';
/** What a light/dark/system theme API (next-themes) is handed. */
export type ColorSchemeSetting = ColorScheme | 'system';

/**
 * Today's default, unchanged: follow the device in the classic look. Nobody
 * lands in Liquid Glass without choosing it.
 */
export const DEFAULT_APPEARANCE: AppearanceMode = 'system';

/**
 * A choice made while signed out is pushed to the account that signs in only
 * if it was made less than this long before (plan 3.4 rule 4a, owner Q20). It
 * keeps a choice someone else left on a shared computer out of a later
 * person's account.
 */
export const PRE_SIGN_IN_CHOICE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Where each platform keeps the two records (plan 3.3). The device record
 * survives sign-out, like today's theme; the account sync record does not
 * (on the phone it sits under `workspace.`, which sign-out erases).
 */
export const APPEARANCE_STORAGE_KEYS = {
  /** Web cookie read by the first-paint head script; holds the bare mode. */
  webCookie: 'sp_appearance',
  /** Web localStorage: the device record (also the cross-tab storage event). */
  webDevice: 'sp-appearance',
  /** Web localStorage: the account sync record, removed at sign-out. */
  webSync: 'sp-appearance-sync',
  /** Web sessionStorage: the one-time crash fallback for this tab (plan 5.6). */
  webFallback: 'sp-lg-fallback',
  /** Phone AsyncStorage: the device record (device-level, not `workspace.`). */
  phoneDevice: 'stockpilot.appearance.v1',
  /** Phone AsyncStorage: the account sync record (erased with every `workspace.` key). */
  phoneSync: 'workspace.appearance-sync',
  /** Phone AsyncStorage: the one-time crash fallback flag (plan 5.6). */
  phoneFallback: 'stockpilot.appearance.fallback',
} as const;

/**
 * The device record: what this device shows. Survives sign-out.
 *   mode        the validated choice;
 *   lastClassic the last classic choice, which the "Use classic appearance"
 *               recovery action returns to (plan 5.6);
 *   anonAt      only for a choice made while signed out: when it was made
 *               (milliseconds since the epoch), for rule 4a.
 */
export interface DeviceAppearanceRecord {
  v: 1;
  mode: AppearanceMode;
  lastClassic: ClassicAppearanceMode;
  anonAt?: number;
}

/**
 * The account sync record: whose account this device last synced with, and
 * whether this device holds a choice the account has not stored yet. Erased
 * at sign-out and ignored when it names a different person.
 *   syncedAt  the account row's updated_at (the server's clock) at the last
 *             confirmed read or write, or null when nothing is confirmed.
 */
export interface AccountSyncRecord {
  v: 1;
  userId: string;
  dirty: boolean;
  syncedAt: string | null;
}

/** The account row as the apps read it (public.user_appearance). */
export interface AccountAppearanceRow {
  mode: AppearanceMode;
  /** updated_at as Postgres returns it (ISO 8601, microseconds, offset). */
  updatedAt: string;
}
