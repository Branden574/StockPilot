import { z } from 'zod';

import {
  APPEARANCE_MODES,
  CLASSIC_APPEARANCE_MODES,
  type AccountAppearanceRow,
  type AccountSyncRecord,
  type AppearanceMode,
  type AppearanceStyle,
  type ClassicAppearanceMode,
  type ColorScheme,
  type ColorSchemeSetting,
  type DeviceAppearanceRecord,
} from './types';

/**
 * Reading and resolving appearances. Every value that comes from storage, a
 * cookie, the account row or a form goes through one of these parsers, and
 * anything that is not exactly one of the known words is dropped (null), so a
 * malformed value can never turn Liquid Glass on.
 */

export const appearanceModeSchema = z.enum(APPEARANCE_MODES);
export const classicAppearanceModeSchema = z.enum(CLASSIC_APPEARANCE_MODES);

/** The appearance, or null for anything else (case, spacing and labels included). */
export function parseAppearance(value: unknown): AppearanceMode | null {
  const parsed = appearanceModeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A classic appearance (dark, light, system), or null. */
export function parseClassicAppearance(value: unknown): ClassicAppearanceMode | null {
  const parsed = classicAppearanceModeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isClassicAppearance(mode: AppearanceMode): mode is ClassicAppearanceMode {
  return mode !== 'liquid-glass';
}

/** 'liquid-glass' is the glass style; every other choice is classic. */
export function styleOf(mode: AppearanceMode): AppearanceStyle {
  return mode === 'liquid-glass' ? 'liquid-glass' : 'classic';
}

/**
 * What a light/dark/system theme API is given. Liquid Glass follows the
 * device for its Day or Night version (plan D3), so it hands over 'system'.
 */
export function schemeSettingOf(mode: AppearanceMode): ColorSchemeSetting {
  return mode === 'liquid-glass' ? 'system' : mode;
}

/**
 * The adapter for every API that accepts only light or dark. System and
 * Liquid Glass follow the device; Dark and Light are fixed.
 */
export function resolveScheme(mode: AppearanceMode, deviceIsDark: boolean): ColorScheme {
  const setting = schemeSettingOf(mode);
  if (setting === 'system') return deviceIsDark ? 'dark' : 'light';
  return setting;
}

/**
 * The appearance to render under the kill switch (plan D12). With Liquid
 * Glass turned off for this build, a stored 'liquid-glass' renders as classic
 * System. The stored value itself is kept, not rewritten: callers apply this
 * when rendering, never when saving.
 */
export function effectiveAppearance(mode: AppearanceMode, glassEnabled: boolean): AppearanceMode {
  return mode === 'liquid-glass' && !glassEnabled ? 'system' : mode;
}

/**
 * The mode a device starts in when it has no appearance record yet. On the
 * web that is next-themes' own stored `theme` (light, dark or system), so an
 * existing person's look does not change; anything else, or nothing, is
 * System. A legacy value never resolves to Liquid Glass.
 */
export function legacyAppearance(legacyTheme: unknown): ClassicAppearanceMode {
  return parseClassicAppearance(legacyTheme) ?? 'system';
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

/**
 * The device record from storage. Accepts the stored object, its JSON text,
 * or a bare mode (the web cookie holds only the mode). Returns null when the
 * mode is missing or unknown, or the record names a version this code does
 * not know. A bad lastClassic falls back to System; a bad anonAt is dropped.
 */
export function parseDeviceRecord(value: unknown): DeviceAppearanceRecord | null {
  const raw = fromJsonString(value);
  const bare = parseAppearance(raw);
  if (bare) {
    return { v: 1, mode: bare, lastClassic: isClassicAppearance(bare) ? bare : 'system' };
  }
  if (!isRecord(raw) || raw.v !== 1) return null;
  const mode = parseAppearance(raw.mode);
  if (!mode) return null;
  const lastClassic =
    parseClassicAppearance(raw.lastClassic) ?? (isClassicAppearance(mode) ? mode : 'system');
  const record: DeviceAppearanceRecord = { v: 1, mode, lastClassic };
  const anonAt = raw.anonAt;
  if (typeof anonAt === 'number' && Number.isFinite(anonAt) && anonAt > 0) record.anonAt = anonAt;
  return record;
}

/** The account sync record from storage (object or JSON text), or null. */
export function parseSyncRecord(value: unknown): AccountSyncRecord | null {
  const raw = fromJsonString(value);
  if (!isRecord(raw) || raw.v !== 1) return null;
  const { userId, dirty, syncedAt } = raw;
  if (typeof userId !== 'string' || userId.length === 0) return null;
  if (typeof dirty !== 'boolean') return null;
  if (syncedAt !== null && (typeof syncedAt !== 'string' || timestampMicros(syncedAt) === null)) {
    return null;
  }
  return { v: 1, userId, dirty, syncedAt };
}

/**
 * The account row ({ appearance, updated_at } from public.user_appearance),
 * or null when it is missing or malformed. A row with an unknown appearance
 * is treated as no row: it is never adopted.
 */
export function parseAccountRow(value: unknown): AccountAppearanceRow | null {
  if (!isRecord(value)) return null;
  const mode = parseAppearance(value.appearance);
  const updatedAt = value.updated_at;
  if (!mode || typeof updatedAt !== 'string' || timestampMicros(updatedAt) === null) return null;
  return { mode, updatedAt };
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
