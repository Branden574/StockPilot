/**
 * The appearance model shared by the web and the phone (Liquid Glass plan,
 * stockpilot-work/liquid-glass/IMPLEMENTATION-PLAN.md sections 1.2, 3.3, 3.4,
 * as revised by plans/REVISION-DEFAULT.md R1-R5).
 *
 * A person makes two separate choices:
 *   - a DESIGN (`style` in code): Liquid Glass or Classic;
 *   - a THEME: Light, Dark or System.
 * Switching the Design never changes the Theme. Liquid Glass with Light is Day
 * glass, with Dark Night glass, and with System it follows the device. Every
 * API that only understands light and dark (next-themes, sonner, the CSS
 * color-scheme property, the native StatusBar, BlurView tints) is given a
 * scheme, never a Design.
 *
 * Which Design a person who never chose one sees is the rollout's business
 * (`defaultStyle`), not the stored value's: nothing here writes a default.
 *
 * PURE: no React, no platform imports, so web, phone and server read one
 * definition.
 */

/** The two Designs, in the order the selector offers them. */
export const APPEARANCE_STYLES = ['liquid-glass', 'classic'] as const;
export type AppearanceStyle = (typeof APPEARANCE_STYLES)[number];

/** The three Themes, in the order the selector offers them. */
export const THEME_SETTINGS = ['light', 'dark', 'system'] as const;
export type ThemeSetting = (typeof THEME_SETTINGS)[number];

/** What an API that accepts only light or dark is given. */
export type ColorScheme = 'light' | 'dark';

/**
 * The kill switch per platform (NEXT_PUBLIC_LIQUID_GLASS on the web,
 * EXPO_PUBLIC_LIQUID_GLASS on the phone):
 *   off      classic for everyone; every stored choice kept, none shown;
 *   opt-in   classic unless the person chose Liquid Glass;
 *   default  Liquid Glass unless the person chose Classic.
 * Anything else, unset included, reads as 'off' (parseRollout).
 */
export const GLASS_ROLLOUTS = ['off', 'opt-in', 'default'] as const;
export type GlassRollout = (typeof GLASS_ROLLOUTS)[number];

/** The Design a person who never chose one sees under this rollout. */
export function defaultStyle(rollout: GlassRollout): AppearanceStyle {
  return rollout === 'default' ? 'liquid-glass' : 'classic';
}

/** The two things a person can choose, each saved on its own. */
export const APPEARANCE_AXES = ['style', 'theme'] as const;
export type AppearanceAxis = (typeof APPEARANCE_AXES)[number];

/** A value for each axis; null means "not chosen". */
export interface AppearanceValues {
  style: AppearanceStyle | null;
  theme: ThemeSetting | null;
}

/** Only the axes being written (a save sends only the axes the person chose). */
export interface AppearancePatch {
  style?: AppearanceStyle;
  theme?: ThemeSetting;
}

/**
 * A choice made while signed out reaches the account that signs in only if it
 * was made less than this long before (plan 3.4 rule 4a, owner Q20), and only
 * in the same sign-in flow (SR4).
 */
export const PRE_SIGN_IN_CHOICE_WINDOW_MS = 30 * 60 * 1000;

/**
 * How far in the future a stored stamp may be before it is treated as broken
 * (SR2): a clock a little behind another tab's or the server's is tolerated;
 * a stamp further ahead is dropped instead of staying fresh for ever.
 */
export const PRE_SIGN_IN_CLOCK_SKEW_MS = 60 * 1000;

/**
 * Where each platform keeps the records (plan 3.3, revision R2). The device
 * record survives sign-out, like today's theme; the account sync record does
 * not (on the phone it sits under `workspace.`, which sign-out erases). The
 * stage 2 names (`sp_appearance`, `stockpilot.appearance.v1`) meant one of
 * four words and are not read: they only ever existed on lab and preview
 * devices.
 */
export const APPEARANCE_STORAGE_KEYS = {
  /** Web cookie read by the first-paint head script; holds the bare Design. */
  webCookie: 'sp_style',
  /** Web localStorage: the device record (also the cross-tab storage event). */
  webDevice: 'sp-appearance',
  /** Web localStorage: the account sync record, removed at sign-out. */
  webSync: 'sp-appearance-sync',
  /** Web sessionStorage: the one-time crash fallback for this tab (plan 5.6). */
  webFallback: 'sp-lg-fallback',
  /** Web sessionStorage: this tab's signed-out choices (SR4 continuity stamp). */
  webAnonFlow: 'sp-appearance-anon',
  /** Web localStorage: the one-time "new look" notice was closed (R13). */
  webIntroSeen: 'sp-lg-intro-seen',
  /** Web localStorage: when the server last re-issued the Design cookie (R6). */
  webServerCookieAt: 'sp-style-server-at',
  /** Phone AsyncStorage: the device record (device-level, not `workspace.`). */
  phoneDevice: 'stockpilot.appearance.v2',
  /** Phone AsyncStorage: the account sync record (erased with every `workspace.` key). */
  phoneSync: 'workspace.appearance-sync',
  /** Phone AsyncStorage: the one-time crash fallback flag (plan 5.6). */
  phoneFallback: 'stockpilot.appearance.fallback',
  /** Phone AsyncStorage: the one-time "new look" card was closed (R13). */
  phoneIntroSeen: 'stockpilot.appearance.intro.v1',
} as const;

/**
 * The device record: what this device shows. Survives sign-out.
 *   style   the Design chosen through the selector (or adopted from the
 *           person's own account row); absent = never chose;
 *   theme   the same for the Theme; absent = the platform's own value
 *           (next-themes' stored theme on the web) applies, inherited and
 *           never uploaded;
 *   anonAt  only for a choice made while signed out: when it was made
 *           (milliseconds since the epoch), for rule 4a.
 */
export interface DeviceAppearanceRecord {
  v: 2;
  style?: AppearanceStyle;
  theme?: ThemeSetting;
  anonAt?: number;
}

/**
 * The account sync record: whose account this device last synced with, and
 * which axes this device holds that the account has not stored yet. Erased at
 * sign-out and ignored when it names a different person.
 *   dirtyAxes  the axes waiting to be saved;
 *   syncedAt   the account row's updated_at (the server's clock) at the last
 *              confirmed read or write, or null when nothing is confirmed. A
 *              stored dirty axis is pushed without reading the row first only
 *              when this is set (SR1).
 */
export interface AccountSyncRecord {
  v: 2;
  userId: string;
  dirtyAxes: AppearanceAxis[];
  syncedAt: string | null;
}

/**
 * This tab's signed-out choices (web sessionStorage; the phone keeps the same
 * thing in memory for the app run). It ties a choice made on the sign-in page
 * to the sign-in that follows in the same tab (SR4): a choice someone else
 * left in another tab or an earlier visit never reaches an account.
 *   anonAt  the device record's anonAt when the stamp was written; the stamp
 *           counts only while the two are equal;
 *   axes    the axes chosen signed out in this flow.
 */
export interface AnonFlowRecord {
  v: 1;
  anonAt: number;
  axes: AppearanceAxis[];
}

/** The account row as the apps read it (public.user_appearance); null = not chosen. */
export interface AccountAppearanceRow extends AppearanceValues {
  /** updated_at as Postgres returns it (ISO 8601, microseconds, offset). */
  updatedAt: string;
}
