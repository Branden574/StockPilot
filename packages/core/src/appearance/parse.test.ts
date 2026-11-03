import { describe, expect, it } from 'vitest';

import {
  effectiveAppearance,
  isLaterTimestamp,
  isMissingAppearanceTableError,
  legacyAppearance,
  parseAccountRow,
  parseAppearance,
  parseClassicAppearance,
  parseDeviceRecord,
  parseSyncRecord,
  resolveScheme,
  schemeSettingOf,
  styleOf,
  timestampMicros,
} from './parse';
import { APPEARANCE_MODES, APPEARANCE_STORAGE_KEYS, DEFAULT_APPEARANCE } from './types';

describe('parseAppearance', () => {
  it('accepts exactly the four words', () => {
    for (const mode of APPEARANCE_MODES) expect(parseAppearance(mode)).toBe(mode);
  });

  it('drops everything else: labels, case, spacing, other types', () => {
    for (const bad of [
      'Liquid Glass',
      'liquid glass',
      'liquid_glass',
      'LIQUID-GLASS',
      'Dark',
      ' dark',
      'dark ',
      '',
      'auto',
      'glass',
      null,
      undefined,
      1,
      true,
      {},
      ['dark'],
      { mode: 'dark' },
    ]) {
      expect(parseAppearance(bad)).toBeNull();
    }
  });

  it('classic parsing never admits Liquid Glass', () => {
    expect(parseClassicAppearance('liquid-glass')).toBeNull();
    expect(parseClassicAppearance('dark')).toBe('dark');
    expect(parseClassicAppearance('light')).toBe('light');
    expect(parseClassicAppearance('system')).toBe('system');
  });

  it('the default is System, today’s default, never Liquid Glass', () => {
    expect(DEFAULT_APPEARANCE).toBe('system');
  });
});

describe('style and scheme', () => {
  it('only liquid-glass is the glass style', () => {
    expect(styleOf('liquid-glass')).toBe('liquid-glass');
    expect(styleOf('dark')).toBe('classic');
    expect(styleOf('light')).toBe('classic');
    expect(styleOf('system')).toBe('classic');
  });

  it('a light/dark/system API never receives liquid-glass', () => {
    expect(schemeSettingOf('liquid-glass')).toBe('system');
    expect(schemeSettingOf('dark')).toBe('dark');
    expect(schemeSettingOf('light')).toBe('light');
    expect(schemeSettingOf('system')).toBe('system');
    for (const mode of APPEARANCE_MODES) {
      expect(['light', 'dark', 'system']).toContain(schemeSettingOf(mode));
    }
  });

  it('resolveScheme: Dark and Light are fixed; System and Liquid Glass follow the device', () => {
    expect(resolveScheme('dark', false)).toBe('dark');
    expect(resolveScheme('dark', true)).toBe('dark');
    expect(resolveScheme('light', false)).toBe('light');
    expect(resolveScheme('light', true)).toBe('light');
    expect(resolveScheme('system', false)).toBe('light');
    expect(resolveScheme('system', true)).toBe('dark');
    expect(resolveScheme('liquid-glass', false)).toBe('light');
    expect(resolveScheme('liquid-glass', true)).toBe('dark');
  });

  it('the kill switch renders a stored Liquid Glass as classic System and leaves the rest alone', () => {
    expect(effectiveAppearance('liquid-glass', false)).toBe('system');
    expect(effectiveAppearance('liquid-glass', true)).toBe('liquid-glass');
    for (const mode of ['dark', 'light', 'system'] as const) {
      expect(effectiveAppearance(mode, false)).toBe(mode);
      expect(effectiveAppearance(mode, true)).toBe(mode);
    }
  });

  it('a legacy next-themes value keeps its classic look; anything else is System', () => {
    expect(legacyAppearance('dark')).toBe('dark');
    expect(legacyAppearance('light')).toBe('light');
    expect(legacyAppearance('system')).toBe('system');
    expect(legacyAppearance(null)).toBe('system');
    expect(legacyAppearance(undefined)).toBe('system');
    expect(legacyAppearance('liquid-glass')).toBe('system');
    expect(legacyAppearance('"dark"')).toBe('system');
  });
});

describe('parseDeviceRecord', () => {
  it('reads a full record, as an object or as JSON text', () => {
    const record = { v: 1, mode: 'liquid-glass', lastClassic: 'dark', anonAt: 1_700_000_000_000 };
    expect(parseDeviceRecord(record)).toEqual(record);
    expect(parseDeviceRecord(JSON.stringify(record))).toEqual(record);
  });

  it('reads the bare cookie value', () => {
    expect(parseDeviceRecord('dark')).toEqual({ v: 1, mode: 'dark', lastClassic: 'dark' });
    expect(parseDeviceRecord('liquid-glass')).toEqual({
      v: 1,
      mode: 'liquid-glass',
      lastClassic: 'system',
    });
  });

  it('drops a record with an unknown or missing mode, an unknown version, or broken JSON', () => {
    expect(parseDeviceRecord({ v: 1, mode: 'Liquid Glass', lastClassic: 'dark' })).toBeNull();
    expect(parseDeviceRecord({ v: 1, lastClassic: 'dark' })).toBeNull();
    expect(parseDeviceRecord({ v: 2, mode: 'dark', lastClassic: 'dark' })).toBeNull();
    expect(parseDeviceRecord({ mode: 'dark' })).toBeNull();
    expect(parseDeviceRecord('{"v":1,"mode":')).toBeNull();
    expect(parseDeviceRecord('')).toBeNull();
    expect(parseDeviceRecord(null)).toBeNull();
    expect(parseDeviceRecord([])).toBeNull();
  });

  it('repairs a bad lastClassic and drops a bad anonAt instead of failing the whole record', () => {
    expect(parseDeviceRecord({ v: 1, mode: 'light', lastClassic: 'liquid-glass' })).toEqual({
      v: 1,
      mode: 'light',
      lastClassic: 'light',
    });
    expect(parseDeviceRecord({ v: 1, mode: 'liquid-glass', lastClassic: 'nope' })).toEqual({
      v: 1,
      mode: 'liquid-glass',
      lastClassic: 'system',
    });
    for (const anonAt of ['1700000000000', Number.NaN, Number.POSITIVE_INFINITY, -5, 0, null]) {
      expect(parseDeviceRecord({ v: 1, mode: 'dark', lastClassic: 'dark', anonAt })).toEqual({
        v: 1,
        mode: 'dark',
        lastClassic: 'dark',
      });
    }
  });
});

describe('parseSyncRecord', () => {
  const good = { v: 1, userId: 'u-1', dirty: true, syncedAt: '2026-11-02T10:00:00.123456+00:00' };

  it('reads a well-formed record, as an object or as JSON text', () => {
    expect(parseSyncRecord(good)).toEqual(good);
    expect(parseSyncRecord(JSON.stringify(good))).toEqual(good);
    expect(parseSyncRecord({ ...good, syncedAt: null })).toEqual({ ...good, syncedAt: null });
  });

  it('drops anything malformed', () => {
    expect(parseSyncRecord({ ...good, v: 2 })).toBeNull();
    expect(parseSyncRecord({ ...good, userId: '' })).toBeNull();
    expect(parseSyncRecord({ ...good, userId: 7 })).toBeNull();
    expect(parseSyncRecord({ ...good, dirty: 'true' })).toBeNull();
    expect(parseSyncRecord({ ...good, syncedAt: 'yesterday' })).toBeNull();
    expect(parseSyncRecord({ ...good, syncedAt: undefined })).toBeNull();
    expect(parseSyncRecord('not json')).toBeNull();
    expect(parseSyncRecord(undefined)).toBeNull();
  });
});

describe('parseAccountRow', () => {
  it('reads the row as PostgREST returns it', () => {
    expect(
      parseAccountRow({ appearance: 'liquid-glass', updated_at: '2026-11-02T10:00:00.5+00:00' }),
    ).toEqual({ mode: 'liquid-glass', updatedAt: '2026-11-02T10:00:00.5+00:00' });
  });

  it('treats a missing, unknown or malformed row as no row', () => {
    expect(parseAccountRow(null)).toBeNull();
    expect(parseAccountRow(undefined)).toBeNull();
    expect(
      parseAccountRow({ appearance: 'Liquid Glass', updated_at: '2026-11-02T10:00:00Z' }),
    ).toBeNull();
    expect(parseAccountRow({ appearance: 'dark' })).toBeNull();
    expect(parseAccountRow({ appearance: 'dark', updated_at: 'soon' })).toBeNull();
    expect(
      parseAccountRow([{ appearance: 'dark', updated_at: '2026-11-02T10:00:00Z' }]),
    ).toBeNull();
  });
});

describe('timestamps', () => {
  it('keeps the microseconds Postgres returns', () => {
    const a = '2026-11-02T10:00:00.123456+00:00';
    const b = '2026-11-02T10:00:00.123457+00:00';
    expect(timestampMicros(b)! - timestampMicros(a)!).toBe(1);
    expect(isLaterTimestamp(b, a)).toBe(true);
    expect(isLaterTimestamp(a, b)).toBe(false);
    expect(isLaterTimestamp(a, a)).toBe(false);
  });

  it('reads every offset form and the Postgres space separator as the same instant', () => {
    const utc = timestampMicros('2026-11-02T10:00:00Z');
    expect(timestampMicros('2026-11-02T10:00:00+00:00')).toBe(utc);
    expect(timestampMicros('2026-11-02 10:00:00+00')).toBe(utc);
    expect(timestampMicros('2026-11-02T03:00:00-07:00')).toBe(utc);
    expect(timestampMicros('2026-11-02T15:30:00+0530')).toBe(utc);
    expect(timestampMicros('2026-11-02T10:00:00.000000000Z')).toBe(utc);
  });

  it('rejects text that is not a timestamp with an offset', () => {
    for (const bad of ['', 'now', '2026-11-02', '2026-11-02T10:00:00', '2026-13-45T10:00:00Z']) {
      expect(timestampMicros(bad)).toBeNull();
    }
  });

  it('a missing or unreadable earlier stamp is always earlier; an unreadable later one never wins', () => {
    expect(isLaterTimestamp('2026-11-02T10:00:00Z', null)).toBe(true);
    expect(isLaterTimestamp('2026-11-02T10:00:00Z', 'garbage')).toBe(true);
    expect(isLaterTimestamp('garbage', null)).toBe(false);
  });
});

describe('missing table', () => {
  it('recognises PostgREST PGRST205 and Postgres 42P01 only', () => {
    expect(
      isMissingAppearanceTableError({ code: 'PGRST205', message: 'not in schema cache' }),
    ).toBe(true);
    expect(isMissingAppearanceTableError({ code: '42P01' })).toBe(true);
    expect(isMissingAppearanceTableError({ code: '42501' })).toBe(false);
    expect(isMissingAppearanceTableError({ code: 'PGRST116' })).toBe(false);
    expect(isMissingAppearanceTableError(new Error('relation does not exist'))).toBe(false);
    expect(isMissingAppearanceTableError(null)).toBe(false);
  });
});

describe('storage keys', () => {
  it('the device records survive sign-out; the sync record on the phone is a workspace key', () => {
    expect(APPEARANCE_STORAGE_KEYS.phoneDevice.startsWith('workspace.')).toBe(false);
    expect(APPEARANCE_STORAGE_KEYS.phoneFallback.startsWith('workspace.')).toBe(false);
    expect(APPEARANCE_STORAGE_KEYS.phoneSync.startsWith('workspace.')).toBe(true);
    expect(APPEARANCE_STORAGE_KEYS.webCookie).toBe('sp_appearance');
  });
});
