import { z } from 'zod';

import {
  APPEARANCE_AXES,
  APPEARANCE_STYLES,
  PRE_SIGN_IN_CLOCK_SKEW_MS,
  THEME_SETTINGS,
  defaultStyle,
  type AccountAppearanceRow,
  type AccountSyncRecord,
  type AnonFlowRecord,
  type AppearanceAxis,
  type AppearanceStyle,
  type ColorScheme,
  type DeviceAppearanceRecord,
  type GlassRollout,
  type ThemeSetting,
} from './types';

/**
 * Reading and resolving appearances. Every value that comes from storage, a
 * cookie, the account row, an environment variable or a form goes through one
 * of these parsers, and anything that is not exactly one of the known words is
 * dropped (null). A dropped Design means "never chose", so the rollout's
 * default applies (revision R2): under the 'default' rollout that is Liquid
 * Glass, under 'opt-in' and 'off' Classic.
 */

export const appearanceStyleSchema = z.enum(APPEARANCE_STYLES);
export const themeSettingSchema = z.enum(THEME_SETTINGS);

/** The Design, or null for anything else (case, spacing and labels included). */
export function parseStyle(value: unknown): AppearanceStyle | null {
  const parsed = appearanceStyleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The Theme (light, dark, system), or null for anything else. */
export function parseThemeSetting(value: unknown): ThemeSetting | null {
  const parsed = themeSettingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The kill switch value: exactly 'opt-in' or 'default'; anything else, unset,
 * empty and the stage 2 value '1' included, is 'off' (revision R5).
 */
export function parseRollout(value: unknown): GlassRollout {
  return value === 'opt-in' || value === 'default' ? value : 'off';
}

/**
 * The Design to show. The rollout decides only what is shown, never what is
 * stored:
 *   off            Classic, whatever was chosen (the choice is kept);
 *   crash fallback Classic for this tab or run (plan 5.6);
 *   otherwise      the person's choice, or the rollout's default when there is
 *                  none (Liquid Glass under 'default', Classic under 'opt-in').
 */
export function shownStyle(
  style: AppearanceStyle | null,
  rollout: GlassRollout,
  crashFallback: boolean,
): AppearanceStyle {
  if (rollout === 'off' || crashFallback) return 'classic';
  return style ?? defaultStyle(rollout);
}

/**
 * The adapter for every API that accepts only light or dark. Light and Dark
 * are fixed in both Designs; System, or a Theme never chosen, follows the
 * device.
 */
export function resolveScheme(theme: ThemeSetting | null, deviceIsDark: boolean): ColorScheme {
  if (theme === 'light' || theme === 'dark') return theme;
  return deviceIsDark ? 'dark' : 'light';
}

/**
 * The Theme an existing web user already has: next-themes' own stored `theme`
 * (light, dark or system), read as it is and never rewritten. Anything else,
 * or nothing, is null: the device is followed. Inherited, so it is applied but
 * never uploaded (Q11).
 */
export function legacyTheme(value: unknown): ThemeSetting | null {
  return parseThemeSetting(value);
}

function fromJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * A list of axes, each known and none twice (it stands for a set), in the
 * canonical order; null for anything else.
 */
function parseAxes(value: unknown): AppearanceAxis[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<AppearanceAxis>();
  for (const item of value) {
    if (!(APPEARANCE_AXES as readonly unknown[]).includes(item)) return null;
    if (seen.has(item as AppearanceAxis)) return null;
    seen.add(item as AppearanceAxis);
  }
  return APPEARANCE_AXES.filter((axis) => seen.has(axis));
}

/**
 * The device record from storage (object or JSON text). Version 2 only: the
 * stage 2 version 1 record meant something else and is ignored. Each axis is
 * read on its own, so a bad Theme does not lose a good Design. Returns null
 * when neither axis holds a known value. `now` (milliseconds) is passed in so
 * the parser stays pure: an anonAt more than PRE_SIGN_IN_CLOCK_SKEW_MS in the
 * future is dropped (SR2), like any other unreadable stamp.
 */
export function parseDeviceRecord(value: unknown, now: number): DeviceAppearanceRecord | null {
  const raw = fromJsonString(value);
  if (!isRecord(raw) || raw.v !== 2) return null;
  const style = parseStyle(raw.style);
  const theme = parseThemeSetting(raw.theme);
  if (!style && !theme) return null;
  const record: DeviceAppearanceRecord = { v: 2 };
  if (style) record.style = style;
  if (theme) record.theme = theme;
  const anonAt = raw.anonAt;
  if (isStamp(anonAt) && anonAt - now <= PRE_SIGN_IN_CLOCK_SKEW_MS) record.anonAt = anonAt;
  return record;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A Supabase auth user id (a UUID in its 8-4-4-4-12 text form). */
export function isUserId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * The account sync record from storage (object or JSON text), or null.
 * Version 2 only. The userId must be a UUID and dirtyAxes a subset of the two
 * axes (SR1): a record that cannot name a real person, or says something this
 * code does not understand, is dropped whole and never pushed.
 */
export function parseSyncRecord(value: unknown): AccountSyncRecord | null {
  const raw = fromJsonString(value);
  if (!isRecord(raw) || raw.v !== 2) return null;
  const { userId, syncedAt } = raw;
  if (!isUserId(userId)) return null;
  const dirtyAxes = parseAxes(raw.dirtyAxes);
  if (!dirtyAxes) return null;
  if (syncedAt !== null && (typeof syncedAt !== 'string' || timestampMicros(syncedAt) === null)) {
    return null;
  }
  return { v: 2, userId, dirtyAxes, syncedAt };
}

/** This tab's signed-out choices (the SR4 continuity stamp), or null. */
export function parseAnonFlowRecord(value: unknown): AnonFlowRecord | null {
  const raw = fromJsonString(value);
  if (!isRecord(raw) || raw.v !== 1 || !isStamp(raw.anonAt)) return null;
  const axes = parseAxes(raw.axes);
  if (!axes || axes.length === 0) return null;
  return { v: 1, anonAt: raw.anonAt, axes };
}

/**
 * The account row ({ style, theme, updated_at } from public.user_appearance),
 * or null when it is missing or malformed. Each column is read on its own: an
 * unknown value counts as not chosen and is never adopted. A row in which
 * neither column holds a known value is treated as no row.
 */
export function parseAccountRow(value: unknown): AccountAppearanceRow | null {
  if (!isRecord(value)) return null;
  const updatedAt = value.updated_at;
  if (typeof updatedAt !== 'string' || timestampMicros(updatedAt) === null) return null;
  const style = parseStyle(value.style);
  const theme = parseThemeSetting(value.theme);
  if (!style && !theme) return null;
  return { style, theme, updatedAt };
}

const TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/u;

/**
 * Microseconds since the epoch for a Postgres or ISO timestamp, or null.
 * Postgres keeps microseconds and Date.parse keeps milliseconds, so two
 * writes inside one millisecond would compare equal through Date alone.
 */
export function timestampMicros(value: string): number | null {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const [, date, time, fraction = '', zone] = match;
  let offset = zone!;
  if (offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    offset = `${offset[0]}${digits.slice(0, 2)}:${digits.length > 2 ? digits.slice(2, 4) : '00'}`;
  }
  const ms = Date.parse(`${date}T${time}${offset}`);
  if (!Number.isFinite(ms)) return null;
  const micros = Number(fraction.padEnd(6, '0').slice(0, 6));
  return ms * 1000 + micros;
}

/** a is later than b; an unreadable a is never later, an unreadable or missing b always earlier. */
export function isLaterTimestamp(a: string, b: string | null): boolean {
  const left = timestampMicros(a);
  if (left === null) return false;
  if (b === null) return true;
  const right = timestampMicros(b);
  return right === null || left > right;
}

/**
 * The read or write failed because public.user_appearance does not exist yet
 * (the web shipped before the migration): PostgREST answers PGRST205, and
 * Postgres 42P01. The app then says "saved on this device only" and never
 * claims sync.
 */
export function isMissingAppearanceTableError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === 'PGRST205' || error.code === '42P01';
}
